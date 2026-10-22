/**
 * The host-side bridge between the identity configuration and the Web GUI.
 *
 * DSH 0.2.x keys settings namespaces by *plugin entry id*, so the identity
 * document lives at `dsh-toolbox → identity` in the profile patch rather than in
 * a standalone `dsh-toolbox:identity:v1` document. That is the one deliberate
 * deviation from docs/request-identity.md; it is required because this host
 * generation has no API for registering a namespace outside a plugin entry.
 *
 * The Web GUI is a static plugin client with no host.call channel, so it reads
 * and writes through two same-origin HTTP routes — the same pattern
 * `dsh-provider-rate-limit` uses. Both routes refuse non-loopback and
 * cross-origin callers.
 *
 * @module dsh-toolbox/identity-host
 */

import {
  IDENTITY_LIMITS,
  emptyIdentityConfig,
  hostFromPattern,
  sanitizeIdentityConfig,
} from './identity-core.js'

export const IDENTITY_ROUTE = '/api/dsh-toolbox.identity'
export const IDENTITY_TEST_ROUTE = '/api/dsh-toolbox.identity-test'

/** Settings namespace (plugin entry id) that holds the identity document. */
export const IDENTITY_ENTRY_ID = 'dsh-toolbox'

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const MAX_BODY_BYTES = 65536

export function writeJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Refuse requests no local page could have sent honestly:
 *  - the Host header must be a loopback name (defeats DNS rebinding);
 *  - when an Origin is present it must equal Host (browsers attach Origin to
 *    every cross-site POST and cannot forge it from those paths);
 *  - a missing Origin means a non-browser caller.
 */
export function untrustedRequest(req) {
  const hostHeader = String(req.headers?.host ?? '')
  const hostname = hostHeader.replace(/:\d+$/u, '').toLowerCase()
  if (!LOOPBACK_HOSTNAMES.has(hostname)) return 'non-loopback-host'
  const origin = req.headers?.origin
  if (origin === undefined || origin === '') return null
  if (origin === 'null') return 'null-origin'
  try {
    return new URL(origin).host === hostHeader ? null : 'origin-mismatch'
  } catch {
    return 'origin-unparseable'
  }
}

async function readJsonBody(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > MAX_BODY_BYTES) throw new Error('request body too large')
  }
  if (raw.trim().length === 0) return {}
  return JSON.parse(raw)
}

/** Read at most `limit` bytes of a response body for the test result preview. */
async function readSnippet(response, limit = IDENTITY_LIMITS.testBodyBytes) {
  const body = response?.body
  if (!body || typeof body.getReader !== 'function') return ''
  const reader = body.getReader()
  const chunks = []
  let total = 0
  try {
    while (total < limit) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) break
      chunks.push(value)
      total += value.byteLength
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // The stream may already be closed; the preview is best-effort.
    }
  }
  const buffer = new Uint8Array(Math.min(total, limit))
  let offset = 0
  for (const chunk of chunks) {
    if (offset >= buffer.length) break
    const take = chunk.subarray(0, buffer.length - offset)
    buffer.set(take, offset)
    offset += take.byteLength
  }
  return new TextDecoder().decode(buffer)
}

/** Provider rows the settings card offers for one-click rule generation. */
export function describeProviders(getSettings, getLlm) {
  const rows = new Map()
  try {
    const settings = getSettings?.()
    const described = settings?.describe?.({ redactSecrets: true }) ?? []
    const piAi = described.find((row) => row.ns === 'llm-pi-ai')
    const profiles = piAi?.value?.providers
    for (const [provider, profile] of Object.entries(profiles ?? {})) {
      if (provider.length === 0) continue
      rows.set(provider, {
        provider,
        displayName: typeof profile?.displayName === 'string' && profile.displayName.length > 0 ? profile.displayName : provider,
        baseURL: typeof profile?.baseURL === 'string' ? profile.baseURL : '',
      })
    }
  } catch {
    // A broken unrelated plugin config must not hide the providers we do know.
  }
  try {
    const llm = getLlm?.()
    for (const entry of llm?.listConfigurableProviders?.() ?? []) {
      if (rows.has(entry.provider)) continue
      rows.set(entry.provider, {
        provider: entry.provider,
        displayName: entry.displayName ?? entry.provider,
        baseURL: typeof entry.defaultBaseURL === 'string' ? entry.defaultBaseURL : '',
      })
    }
  } catch {
    // Same: the provider directory is a convenience, not a requirement.
  }
  return [...rows.values()].sort((left, right) => left.provider.localeCompare(right.provider))
}

/**
 * Build the two route handlers.
 *
 * @param {object} deps
 * @param {() => object} deps.readConfig - live identity config from the plugin.
 * @param {() => object|undefined} deps.getSettings - the settings service, if present.
 * @param {() => object|undefined} deps.getLlm - the llm service, if present.
 * @param {object} deps.stats - hit accounting shared with the fetch patch.
 * @param {Function} [deps.fetchImpl] - test transport; defaults to global fetch.
 * @param {object} [deps.logger]
 * @param {string} [deps.entryId]
 * @param {number} [deps.timeoutMs]
 */
export function createIdentityHandlers(deps) {
  const {
    readConfig,
    getSettings,
    getLlm,
    stats,
    logger,
    entryId = IDENTITY_ENTRY_ID,
    timeoutMs = 15000,
  } = deps
  const fetchImpl = deps.fetchImpl ?? ((url, init) => globalThis.fetch(url, init))

  const descriptorOf = (settings) => {
    try {
      const described = settings?.describe?.({ redactSecrets: true }) ?? []
      return described.find((row) => row.ns === entryId)
    } catch {
      // A broken config in an unrelated plugin must not make this route throw.
      return undefined
    }
  }

  const snapshot = () => {
    let value
    try {
      value = readConfig()
    } catch {
      value = emptyIdentityConfig()
    }
    return {
      enabled: value?.enabled !== false,
      diagnostics: value?.diagnostics === true,
      rules: Array.isArray(value?.rules) ? value.rules : [],
    }
  }

  /** The live document as the settings service sees it, falling back to the plugin config. */
  const liveValue = (descriptor) => {
    const fromDescriptor = descriptor?.value?.identity
    if (fromDescriptor !== null && typeof fromDescriptor === 'object') return fromDescriptor
    return snapshot()
  }

  async function config(req, res) {
    const distrust = untrustedRequest(req)
    if (distrust !== null) {
      writeJson(res, 403, { ok: false, code: 'untrusted-request', reason: distrust })
      return
    }
    const settings = getSettings?.()
    if (settings === undefined || settings === null) {
      writeJson(res, 503, { ok: false, code: 'settings-absent' })
      return
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const descriptor = descriptorOf(settings)
      if (descriptor === undefined) {
        writeJson(res, 404, { ok: false, code: 'namespace-missing', entryId })
        return
      }
      writeJson(res, 200, {
        ok: true,
        entryId,
        writable: settings.writable !== false,
        revision: descriptor.revision,
        value: liveValue(descriptor),
        providers: describeProviders(getSettings, getLlm),
        stats: stats?.snapshot?.() ?? {},
      })
      return
    }

    if (req.method !== 'POST') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed' })
      return
    }

    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      writeJson(res, 400, {
        ok: false,
        code: 'invalid-body',
        message: error instanceof Error ? error.message : String(error),
      })
      return
    }

    const sanitized = sanitizeIdentityConfig(body?.value ?? body)
    if (sanitized.errors.length > 0) {
      writeJson(res, 400, { ok: false, code: 'invalid-config', errors: sanitized.errors })
      return
    }

    try {
      await settings.replace(entryId, { identity: sanitized.value }, body?.expectedRevision)
    } catch (error) {
      if (error?.code === 'SETTINGS_CONFLICT') {
        const descriptor = descriptorOf(settings)
        writeJson(res, 409, {
          ok: false,
          code: 'settings-conflict',
          revision: descriptor?.revision,
        })
        return
      }
      if (/No configurable plugin entry|no volatile fields/iu.test(String(error?.message ?? ''))) {
        writeJson(res, 404, { ok: false, code: 'namespace-missing', entryId })
        return
      }
      logger?.error?.('[dsh-toolbox] identity config write failed', error)
      writeJson(res, 400, {
        ok: false,
        code: 'settings-rejected',
        message: error instanceof Error ? error.message : String(error),
      })
      return
    }

    const descriptor = descriptorOf(settings)
    writeJson(res, 200, {
      ok: true,
      entryId,
      writable: settings.writable !== false,
      revision: descriptor?.revision,
      // Echo the document we just wrote: the live config ref is updated by the
      // loader, but a response must not depend on that timing.
      value: sanitized.value,
      droppedHeaders: sanitized.droppedHeaders,
      providers: describeProviders(getSettings, getLlm),
      stats: stats?.snapshot?.() ?? {},
    })
  }

  async function test(req, res) {
    const distrust = untrustedRequest(req)
    if (distrust !== null) {
      writeJson(res, 403, { ok: false, code: 'untrusted-request', reason: distrust })
      return
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed' })
      return
    }

    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      writeJson(res, 400, {
        ok: false,
        code: 'invalid-body',
        message: error instanceof Error ? error.message : String(error),
      })
      return
    }

    let url
    try {
      url = new URL(String(body?.url ?? ''))
    } catch {
      writeJson(res, 400, { ok: false, code: 'invalid-url' })
      return
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      writeJson(res, 400, { ok: false, code: 'invalid-url' })
      return
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('identity test timed out')), timeoutMs)
    try {
      // Goes through globalThis.fetch on purpose: the wrapper is the thing under
      // test, so the probe must take the same path a real request takes.
      const response = await fetchImpl(url.href, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      })
      const snippet = await readSnippet(response)
      const record = stats?.lastForUrl?.(url.href) ?? null
      writeJson(res, 200, {
        ok: true,
        url: url.href,
        status: response.status,
        statusText: response.statusText ?? '',
        snippet: snippet.slice(0, 200),
        matchedRuleId: record?.ruleId ?? null,
        beforeUserAgent: record?.beforeUserAgent ?? '',
        afterUserAgent: record?.afterUserAgent ?? '',
      })
    } catch (error) {
      writeJson(res, 502, {
        ok: false,
        code: 'test-failed',
        message: error instanceof Error ? error.message : String(error),
        host: hostFromPattern(url.href),
      })
    } finally {
      clearTimeout(timer)
    }
  }

  return { config, test }
}
