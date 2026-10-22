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

import { applicableHeaders, createIdentityStats, hostFromPattern, isRewritableUrl, matchRule } from './identity-core.js'

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

/**
 * Build the headers for a rewritten request.
 *
 * `init.headers` replaces a Request's headers wholesale per spec, so the seed
 * must come from whichever source actually carries the caller's header set.
 */
function rewrittenRequest(request, rule) {
  const headers = new Headers(request.headers)
  const beforeUserAgent = headers.get('user-agent')
  if (typeof rule.userAgent === 'string' && rule.userAgent.length > 0) {
    headers.set('user-agent', rule.userAgent)
  }
  for (const header of applicableHeaders(rule)) headers.set(header.name, header.value)
  const next = new Request(request, {
    headers,
    ...(request.body === null ? {} : { duplex: 'half' }),
  })
  return { next, beforeUserAgent, afterUserAgent: headers.get('user-agent') }
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

    host.wrap = function identityFetch(input, init) {
      if (!host.active) return host.native.call(this, input, init)
      const config = readSafely(host.read)
      if (config.enabled === false) return host.native.call(this, input, init)

      const url = requestUrl(input)
      const rule = matchRule(url, config.rules)
      if (rule === null) return host.native.call(this, input, init)
      if (!isRewritableUrl(url)) return host.native.call(this, input, init)

      let rewritten
      try {
        const request = input instanceof Request ? input : new Request(input, init)
        rewritten = rewrittenRequest(request, rule)
      } catch (error) {
        host.logger?.warn?.('[dsh-toolbox] identity rewrite failed; forwarding the original request', error)
        return host.native.call(this, input, init)
      }

      host.stats?.record?.(rule.id, url, rewritten.beforeUserAgent, rewritten.afterUserAgent)
      if (config.diagnostics === true && host.logger?.info) {
        // FR-10: the matched host plus the user-agent pair only. A full URL may
        // carry query secrets and header values must never reach the log.
        host.logger.info(
          `[dsh-toolbox] identity rule "${rule.id}" matched ${hostFromPattern(url)}: user-agent ${rewritten.beforeUserAgent ?? ''} -> ${rewritten.afterUserAgent ?? ''}`,
        )
      }
      return host.native.call(this, rewritten.next)
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
