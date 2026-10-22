/**
 * Request-identity core: matching, validation, and hit accounting.
 *
 * This module is deliberately dependency-free and pure so the same rules run in
 * three places:
 *  - the host plugin (Node), which is the only place that can rewrite a real
 *    request, because the host writes its attribution `user-agent` after every
 *    header merge and only a `globalThis.fetch` wrapper sits downstream of it;
 *  - the Web GUI settings card (browser), which validates a draft before the
 *    round trip so a typo never reaches the host;
 *  - the tests.
 *
 * @module dsh-toolbox/identity-core
 */

/** Header names a rule may never override: credentials, framing, and cookies. */
export const RESERVED_HEADERS = Object.freeze([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'cookie',
  'set-cookie',
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
])

const RESERVED = new Set(RESERVED_HEADERS)

/** Hard caps; enforced on save so a config document can never grow unbounded. */
export const IDENTITY_LIMITS = Object.freeze({
  maxRules: 32,
  maxHeadersPerRule: 16,
  urlPattern: 200,
  userAgent: 300,
  headerName: 64,
  headerValue: 1024,
  note: 200,
  ruleId: 64,
  testBodyBytes: 8192,
})

/** RFC 7230 token: the only shape an HTTP header name may take. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u

/** C0 controls and DEL are never legal inside a header value. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u

/** The empty identity configuration, used before any profile config loads. */
export function emptyIdentityConfig() {
  return { enabled: true, diagnostics: false, rules: [] }
}

/** Coerce anything into a plain string without throwing on exotic values. */
function text(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** Trim and cap a URL pattern; the match itself is a case-insensitive substring. */
export function normalizeUrlPattern(value) {
  return text(value).trim().slice(0, IDENTITY_LIMITS.urlPattern)
}

/** Normalize a header name for storage (lowercase) without validating it. */
export function normalizeHeaderName(value) {
  return text(value).trim().toLowerCase()
}

/** Whether a header name is on the never-override list. */
export function isReservedHeader(name) {
  return RESERVED.has(normalizeHeaderName(name))
}

/** Whether a header name is a syntactically valid, non-reserved token. */
export function isValidHeaderName(name) {
  const normalized = normalizeHeaderName(name)
  return normalized.length > 0 && normalized.length <= IDENTITY_LIMITS.headerName && HEADER_NAME.test(normalized)
}

/**
 * Derive a stable, readable rule id from a URL pattern. Slugs are lowercase and
 * dash-joined so the id is safe in a YAML document and in a DOM attribute.
 */
export function suggestRuleId(urlPattern, existingIds = []) {
  const base =
    text(urlPattern)
      .trim()
      .toLowerCase()
      .replace(/^[a-z]+:\/\//u, '')
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 48) || 'rule'
  const used = new Set([...existingIds].map((id) => text(id).toLowerCase()))
  let candidate = base
  let suffix = 2
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }
  return candidate
}

/** Normalize an id read from a document, preserving its case for display. */
export function normalizeRuleId(value) {
  return text(value).trim().slice(0, IDENTITY_LIMITS.ruleId)
}

/**
 * Validate and normalize one rule.
 *
 * Reserved header names are *dropped*, not rejected: the plan requires the
 * save to succeed while the UI tells the user which entries were ignored.
 * Everything else that is malformed produces an error code the UI translates.
 *
 * @returns {{ rule: object, errors: Array<{field: string, code: string}>, droppedHeaders: string[] }}
 */
export function sanitizeRule(input, index = 0) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const errors = []
  const droppedHeaders = []

  const urlPattern = normalizeUrlPattern(source.urlPattern)
  if (urlPattern.length === 0) {
    errors.push({ field: 'urlPattern', code: 'url-pattern-required' })
  } else if (CONTROL_CHARS.test(urlPattern)) {
    errors.push({ field: 'urlPattern', code: 'url-pattern-control' })
  }

  const userAgent = text(source.userAgent).trim().slice(0, IDENTITY_LIMITS.userAgent)
  if (CONTROL_CHARS.test(userAgent)) errors.push({ field: 'userAgent', code: 'user-agent-control' })

  const note = text(source.note).trim().slice(0, IDENTITY_LIMITS.note)

  let id = normalizeRuleId(source.id)
  if (id.length === 0) id = suggestRuleId(urlPattern, [])

  const headers = []
  const rawHeaders = Array.isArray(source.headers) ? source.headers : []
  if (rawHeaders.length > IDENTITY_LIMITS.maxHeadersPerRule) {
    errors.push({ field: 'headers', code: 'too-many-headers' })
  }
  for (const [headerIndex, raw] of rawHeaders.slice(0, IDENTITY_LIMITS.maxHeadersPerRule).entries()) {
    const entry = raw !== null && typeof raw === 'object' ? raw : {}
    const name = normalizeHeaderName(entry.name)
    const value = text(entry.value)
    if (name.length === 0 && value.length === 0) continue
    if (!isValidHeaderName(name)) {
      errors.push({ field: `headers.${headerIndex}.name`, code: 'invalid-header-name' })
      continue
    }
    if (isReservedHeader(name)) {
      droppedHeaders.push(name)
      continue
    }
    if (value.length > IDENTITY_LIMITS.headerValue || CONTROL_CHARS.test(value)) {
      errors.push({ field: `headers.${headerIndex}.value`, code: 'invalid-header-value' })
      continue
    }
    headers.push({ name, value })
  }

  return {
    rule: {
      id,
      enabled: source.enabled !== false,
      urlPattern,
      userAgent,
      headers,
      note,
    },
    errors: errors.map((error) => ({ ...error, rule: index })),
    droppedHeaders,
  }
}

/**
 * Validate a whole identity document.
 *
 * @returns {{ value: object, errors: Array<{rule?: number, field: string, code: string}>, droppedHeaders: string[] }}
 */
export function sanitizeIdentityConfig(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const errors = []
  const droppedHeaders = []

  if (source.enabled !== undefined && typeof source.enabled !== 'boolean') {
    errors.push({ field: 'enabled', code: 'invalid-enabled' })
  }
  if (source.diagnostics !== undefined && typeof source.diagnostics !== 'boolean') {
    errors.push({ field: 'diagnostics', code: 'invalid-diagnostics' })
  }
  if (source.rules !== undefined && !Array.isArray(source.rules)) {
    errors.push({ field: 'rules', code: 'invalid-rules' })
  }

  const rawRules = Array.isArray(source.rules) ? source.rules : []
  if (rawRules.length > IDENTITY_LIMITS.maxRules) {
    errors.push({ field: 'rules', code: 'too-many-rules' })
  }

  const seen = new Set()
  const rules = []
  for (const [index, raw] of rawRules.slice(0, IDENTITY_LIMITS.maxRules).entries()) {
    const sanitized = sanitizeRule(raw, index)
    errors.push(...sanitized.errors)
    droppedHeaders.push(...sanitized.droppedHeaders)
    const key = sanitized.rule.id.toLowerCase()
    if (seen.has(key)) {
      errors.push({ rule: index, field: 'id', code: 'duplicate-rule-id' })
      continue
    }
    seen.add(key)
    rules.push(sanitized.rule)
  }

  return {
    value: {
      enabled: source.enabled !== false,
      diagnostics: source.diagnostics === true,
      rules,
    },
    errors,
    droppedHeaders,
  }
}

/**
 * Pick the identity rule for a URL.
 *
 * Case-insensitive substring match; the longest matching `urlPattern` wins so a
 * narrow rule always beats a broad one. Disabled and blank rules never match.
 */
export function matchRule(url, rules) {
  if (typeof url !== 'string' || url.length === 0 || !Array.isArray(rules)) return null
  const lower = url.toLowerCase()
  let best = null
  let bestLength = -1
  for (const rule of rules) {
    if (rule === null || typeof rule !== 'object' || rule.enabled === false) continue
    const pattern = text(rule.urlPattern)
    if (pattern.length === 0) continue
    if (!lower.includes(pattern.toLowerCase())) continue
    if (pattern.length > bestLength) {
      best = rule
      bestLength = pattern.length
    }
  }
  return best
}

/** The custom headers a rule actually applies, reserved names excluded. */
export function applicableHeaders(rule) {
  if (!rule || !Array.isArray(rule.headers)) return []
  return rule.headers.filter((header) => isValidHeaderName(header?.name) && !isReservedHeader(header.name))
}

/** Extract a host for a `urlPattern` so a provider rule can be identified in the UI. */
export function hostFromPattern(urlPattern) {
  const raw = text(urlPattern).trim()
  if (raw.length === 0) return ''
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).host
  } catch {
    return raw.replace(/^[a-z]+:\/\//iu, '').replace(/[/?#].*$/u, '')
  }
}

/** Join a provider baseURL with the model-listing path the test button probes. */
export function modelsUrlFor(baseURL) {
  const trimmed = text(baseURL).trim().replace(/\/+$/u, '')
  if (trimmed.length === 0) return ''
  return /\/models$/u.test(trimmed) ? trimmed : `${trimmed}/models`
}

/** Whether a URL is one a rule is allowed to touch at all. */
export function isRewritableUrl(url) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Bounded, content-free hit accounting for the settings card.
 *
 * Only the rule id, the request URL, and the `user-agent` pair are kept. No
 * other header is ever retained, so a credential header can never leak through
 * this structure (FR-10).
 */
export function createIdentityStats(options = {}) {
  const maxUrls = options.maxUrls ?? 3
  const maxRules = options.maxRules ?? IDENTITY_LIMITS.maxRules
  const records = new Map()
  let last = null

  return {
    record(ruleId, url, beforeUserAgent, afterUserAgent, at = Date.now()) {
      if (typeof ruleId !== 'string' || ruleId.length === 0) return
      const host = hostFromPattern(url) || ''
      let entry = records.get(ruleId)
      if (entry === undefined) {
        if (records.size >= maxRules) {
          const oldest = records.keys().next()
          if (!oldest.done) records.delete(oldest.value)
        }
        entry = { count: 0, lastAt: 0, hosts: [] }
        records.set(ruleId, entry)
      }
      entry.count += 1
      entry.lastAt = at
      if (!entry.hosts.includes(host)) {
        entry.hosts.push(host)
        if (entry.hosts.length > maxUrls) entry.hosts.splice(0, entry.hosts.length - maxUrls)
      }
      last = {
        ruleId,
        url: text(url),
        host,
        beforeUserAgent: text(beforeUserAgent),
        afterUserAgent: text(afterUserAgent),
        at,
      }
    },
    snapshot() {
      const out = {}
      for (const [id, entry] of records) {
        out[id] = { count: entry.count, lastAt: entry.lastAt, hosts: [...entry.hosts] }
      }
      return out
    },
    lastForUrl(url) {
      if (last === null) return null
      return last.url === text(url) ? { ...last } : null
    },
    last() {
      return last === null ? null : { ...last }
    },
    reset() {
      records.clear()
      last = null
    },
  }
}
