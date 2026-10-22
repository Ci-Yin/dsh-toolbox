/**
 * DSH Toolbox — host entry.
 *
 * The plugin's first job on the host side is delivery of the request-identity
 * feature: an opt-in `globalThis.fetch` wrapper that rewrites the outgoing
 * `user-agent` (and optional static headers) for requests whose URL matches a
 * configured rule. The host writes its attribution `user-agent` after every
 * header merge, so this is the only layer where the identity can actually be
 * changed; see docs/request-identity.md.
 *
 * The identity document is a volatile settings section (`identity`) on this
 * plugin's own entry, which is what gives the Web GUI settings card live reads
 * and writes without restarting the host.
 */

import z from '@deepseek-ai/schemastery'

import { createIdentityStats, emptyIdentityConfig } from './src/identity-core.js'
import { IDENTITY_ROUTE, IDENTITY_TEST_ROUTE, createIdentityHandlers } from './src/identity-host.js'
import { installIdentityPatch } from './src/identity-patch.js'

export const name = 'dsh-toolbox'

const IdentityRule = z.object({
  /** Stable, unique (case-insensitive) id; generated from the pattern by the UI. */
  id: z.string().required(),
  enabled: z.boolean().default(true),
  /** Case-insensitive substring of the outbound URL, e.g. "agentrouter.org". */
  urlPattern: z.string().required(),
  /** Replacement `user-agent`; empty keeps the host's attribution value. */
  userAgent: z.string().default(''),
  headers: z
    .array(
      z.object({
        name: z.string().required(),
        value: z.string().default(''),
      }),
    )
    .default([]),
  note: z.string().default(''),
})

const IdentitySection = z
  .object({
    /**
     * Master switch. Defaults to on with zero rules, so installing the plugin
     * changes no request until the user creates a rule (C-8).
     */
    enabled: z.boolean().default(true),
    /** Diagnostic logging of matched hosts and rewritten user-agents. Off by default. */
    diagnostics: z.boolean().default(false),
    rules: z.array(IdentityRule).default([]),
  })
  .volatile()

/**
 * Plugin config. Only `identity` is exposed to the settings service; the
 * Web-GUI module preferences stay in localStorage as before.
 */
export const Config = z.object({ identity: IdentitySection })

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/**
 * Detach a config value from its live reference. DSH >= 0.2.0 hands volatile
 * fields to the plugin as `{ get() }` references; the fetch wrapper needs plain
 * data and must observe the newest snapshot on every request (FR-6/C-7).
 */
function plain(value) {
  if (value !== null && typeof value === 'object' && VOLATILE_WRITE in value) return plain(value.get())
  if (Array.isArray(value)) return value.map(plain)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, child] of Object.entries(value)) out[key] = plain(child)
    return out
  }
  return value
}

export function apply(ctx, config) {
  const logger = ctx.logger ?? console
  const stats = createIdentityStats()

  const readIdentity = () => {
    const value = plain(config?.identity)
    return value !== null && typeof value === 'object' ? value : emptyIdentityConfig()
  }

  // Install once per process; a reload re-attaches to the existing wrapper and
  // a dispose restores the native fetch (FR-4/FR-5).
  const disposePatch = installIdentityPatch({ read: readIdentity, logger, stats })
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => disposePatch, 'dsh-toolbox: identity fetch patch')
  }
  try {
    const installed = readIdentity()
    logger?.info?.(
      `[dsh-toolbox] identity patch installed (enabled=${installed.enabled !== false}, rules=${Array.isArray(installed.rules) ? installed.rules.length : 0})`,
    )
  } catch {
    // Diagnostics must never prevent the plugin from starting.
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (wctx) => {
      const handlers = createIdentityHandlers({
        readConfig: readIdentity,
        getSettings: () => ctx.get?.('settings'),
        getLlm: () => ctx.get?.('llm'),
        stats,
        logger,
      })
      const disposeConfig = wctx.webServer.register({
        kind: 'exact',
        path: IDENTITY_ROUTE,
        handler: (req, res) => handlers.config(req, res),
      })
      const disposeTest = wctx.webServer.register({
        kind: 'exact',
        path: IDENTITY_TEST_ROUTE,
        handler: (req, res) => handlers.test(req, res),
      })
      logger?.info?.(`[dsh-toolbox] identity routes registered: ${IDENTITY_ROUTE}, ${IDENTITY_TEST_ROUTE}`)
      wctx.effect(
        () => () => {
          try {
            disposeConfig?.()
          } catch {
            // The web server may already be gone during shutdown.
          }
          try {
            disposeTest?.()
          } catch {
            // Same.
          }
        },
        'dsh-toolbox: identity routes',
      )
    })
  }
}
