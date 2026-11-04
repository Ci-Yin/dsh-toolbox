/**
 * The host-side request-identity patch.
 *
 * Why this layer: `dsh-llm-pi-ai` builds request headers in this order —
 * provider-profile headers first, then `attributionHeaders()` last — so the
 * host's own `user-agent` always overwrites anything a header-level plugin
 * writes. A wrapper around `globalThis.fetch` sits downstream of every header
 * merge, so it is the only seam that can rewrite the outgoing identity, and it
 * covers both model discovery (`GET {baseURL}/models`) and conversation
 * requests.
 *
 * Invariants:
 *  - a request that no rule matches is forwarded *unchanged*, with the original
 *    argument objects, so streaming and abort semantics are untouched;
 *  - a rewritten request keeps method, body, signal, redirect, and credentials;
 *  - a body-bearing `Request` is rebuilt with `duplex: "half"` (Node >= 18);
 *  - the wrapper is installed once per process and unwinds on dispose;
 *  - if another plugin has layered a wrapper above ours, disposing leaves ours
 *    transparent instead of clobbering the outer one.
 *
 * @module dsh-toolbox/identity-patch
 */

import {
  BODY_LIMITS,
  applicableHeaders,
  createIdentityStats,
  hostFromPattern,
  isRewritableUrl,
  matchRule,
  stripResponsesItemIds,
} from './identity-core.js'

/** Shared across ESM copies of this module and across plugin reloads. */
export const PATCH_KEY = Symbol.for('dsh-toolbox.identity-fetch')

const DEFAULT_CONFIG = Object.freeze({ enabled: true, diagnostics: false, rules: [] })

/** Cheap URL extraction: no Request construction on the pass-through path. */
function requestUrl(input) {
  try {
    if (typeof input === 'string') return input
    if (typeof URL !== 'undefined' && input instanceof URL) return input.href
    if (typeof Request !== 'undefined' && input instanceof Request) return input.url
    return String(input)
  } catch {
    return ''
  }
}

/** Read the live config without letting a bad read break every request. */
function readSafely(read) {
  try {
    const value = read()
    return value !== null && typeof value === 'object' ? value : DEFAULT_CONFIG
  } catch {
    return DEFAULT_CONFIG
  }
}

/** Diagnostics must never break a request or include an exception's body text. */
function warnSafely(logger, message) {
  try {
    logger?.warn?.(message)
  } catch {
    // A failing logger is not a reason to drop a request.
  }
}

/** Inspect effective metadata without transferring or teeing an inherited body. */
function requestView(input, init) {
  if (!(input instanceof Request) || init?.body != null) return new Request(input, init)
  if (init == null) return input
  return {
    url: input.url,
    method: String(init.method ?? input.method).toUpperCase(),
    headers: new Headers(init.headers === undefined ? input.headers : init.headers),
    body: input.body,
    signal: init.signal === undefined ? input.signal : init.signal,
    clone: () => input.clone(),
  }
}

/** A caller-owned stream in init cannot be cloned without locking the original. */
function hasStreamingBody(init) {
  const body = init?.body
  return body != null && (typeof body.getReader === 'function' || typeof body[Symbol.asyncIterator] === 'function')
}

/** Read only a clone, with a byte cap even when content-length is absent or false. */
async function strippableBody(request, onTooLarge) {
  if (request.method !== 'POST' || request.body === null) return null
  if (!/\/responses\/?$/u.test(new URL(request.url).pathname)) return null
  const type = (request.headers.get('content-type') ?? '').toLowerCase()
  if (!type.includes('application/json')) return null
  const limit = BODY_LIMITS.maxJsonBodyBytes
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > limit) {
    onTooLarge()
    return null
  }

  const signal = request.signal
  signal?.throwIfAborted()
  const reader = request.clone().body.getReader()
  let onAbort
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  const decoder = new TextDecoder()
  const parts = []
  let bytes = 0
  let finished = false
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted])
      if (done) {
        finished = true
        break
      }
      bytes += value.byteLength
      if (bytes > limit) {
        onTooLarge()
        return null
      }
      parts.push(decoder.decode(value, { stream: true }))
    }
    parts.push(decoder.decode())
    return stripResponsesItemIds(parts.join(''))
  } finally {
    signal?.removeEventListener('abort', onAbort)
    // Awaiting cancellation of one tee branch can wait for native to consume
    // the other branch. Let native receive the original request immediately.
    if (!finished) void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Prepare headers independently so a body no-op can still use the original args. */
function rewrittenHeaders(request, rule) {
  const headers = new Headers(request.headers)
  const beforeUserAgent = headers.get('user-agent')
  if (typeof rule.userAgent === 'string' && rule.userAgent.length > 0) {
    headers.set('user-agent', rule.userAgent)
  }
  for (const header of applicableHeaders(rule)) headers.set(header.name, header.value)
  const changed = [...headers].some(([name, value]) => request.headers.get(name) !== value)
  return { headers, changed, beforeUserAgent, afterUserAgent: headers.get('user-agent') }
}

function rewrittenRequest(input, init, headers, body, hasBody) {
  if (body !== null) headers.delete('content-length')
  return new Request(input, {
    ...init,
    headers,
    ...(body === null ? {} : { body }),
    ...(hasBody ? { duplex: 'half' } : {}),
  })
}

/**
 * Install (or re-attach) the identity fetch wrapper.
 *
 * @param {object} options
 * @param {() => object} options.read - returns the live identity config.
 * @param {object} [options.logger] - host logger; used only for diagnostics/warnings.
 * @param {object} [options.stats] - hit accounting, shared with the settings card.
 * @returns {() => void} disposer
 */
export function installIdentityPatch(options = {}) {
  const read = typeof options.read === 'function' ? options.read : () => DEFAULT_CONFIG
  const logger = options.logger ?? null
  const stats = options.stats ?? createIdentityStats()

  let state = globalThis[PATCH_KEY]
  // A state whose wrap no longer occupies the fetch slot was superseded by
  // another reload or an external swap: its restore chain is severed.
  if (state !== undefined && globalThis.fetch !== state.wrap) state = undefined

  if (state === undefined) {
    const native = globalThis.fetch
    if (typeof native !== 'function') return () => {}
    const host = {
      native,
      wrap: null,
      read,
      logger,
      stats,
      active: true,
      refs: 0,
    }

    host.wrap = async function identityFetch(input, init) {
      if (!host.active) return host.native.call(this, input, init)
      const config = readSafely(host.read)
      if (config.enabled === false) return host.native.call(this, input, init)

      const url = requestUrl(input)
      const rule = matchRule(url, config.rules)
      if (rule === null) return host.native.call(this, input, init)
      if (!isRewritableUrl(url)) return host.native.call(this, input, init)

      let next = null
      let rewritten
      let stripped = 0
      try {
        const request = requestView(input, init)
        rewritten = rewrittenHeaders(request, rule)
        let body = null
        if (rule.stripResponsesItemIds === true && !hasStreamingBody(init)) {
          const result = await strippableBody(request, () => {
            if (config.diagnostics === true) {
              warnSafely(host.logger, '[dsh-toolbox] Responses body exceeds the rewrite byte limit; skipping item ids')
            }
          })
          if (result !== null && result.stripped > 0) {
            body = result.text
            stripped = result.stripped
          }
        }
        if (body !== null || rewritten.changed) {
          next = rewrittenRequest(input, init, rewritten.headers, body, body !== null || request.body !== null)
        }
      } catch {
        warnSafely(host.logger, '[dsh-toolbox] identity rewrite failed; forwarding the original request')
        return host.native.call(this, input, init)
      }

      try {
        host.stats?.record?.(rule.id, url, rewritten.beforeUserAgent, rewritten.afterUserAgent, Date.now(), {
          strippedItems: stripped,
        })
        if (config.diagnostics === true && host.logger?.info) {
          // Only host, rule, UA pair, and counts; never log body or parse errors.
          host.logger.info(
            `[dsh-toolbox] identity rule "${rule.id}" matched ${hostFromPattern(url)}: user-agent ${rewritten.beforeUserAgent ?? ''} -> ${rewritten.afterUserAgent ?? ''}; strippedItems=${stripped}`,
          )
        }
      } catch {
        // Observability must not lose a request after its body was transferred.
      }
      return next === null ? host.native.call(this, input, init) : host.native.call(this, next)
    }

    host.refs = 0
    globalThis.fetch = host.wrap
    globalThis[PATCH_KEY] = host
    state = host
  }

  state.read = read
  state.logger = logger ?? state.logger
  state.stats = options.stats ?? state.stats
  state.active = true
  state.refs += 1

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    const current = state
    current.refs -= 1
    if (current.refs > 0) return
    current.active = false
    if (globalThis.fetch === current.wrap) {
      globalThis.fetch = current.native
      if (globalThis[PATCH_KEY] === current) delete globalThis[PATCH_KEY]
    }
    // Otherwise an outer wrapper owns the slot: stay installed but transparent
    // so we never clobber a patch we did not install.
  }
}

/** Test/verification helper: whether the identity wrapper currently owns fetch. */
export function identityPatchInstalled() {
  const state = globalThis[PATCH_KEY]
  return state !== undefined && globalThis.fetch === state.wrap
}
