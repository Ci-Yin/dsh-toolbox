import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  IDENTITY_LIMITS,
  createIdentityStats,
  hostFromPattern,
  isReservedHeader,
  isRewritableUrl,
  matchRule,
  modelsUrlFor,
  sanitizeIdentityConfig,
  sanitizeRule,
  suggestRuleId,
} from '../src/identity-core.js'

const rule = (overrides = {}) => ({
  id: 'rule',
  enabled: true,
  urlPattern: 'agentrouter.org',
  userAgent: '',
  headers: [],
  note: '',
  ...overrides,
})

test('matchRule matches case-insensitively on a substring', () => {
  const rules = [rule({ id: 'a', urlPattern: 'AgentRouter.ORG' })]
  assert.equal(matchRule('https://agentrouter.org/v1/models', rules)?.id, 'a')
  assert.equal(matchRule('https://AGENTROUTER.org/v1/chat/completions', rules)?.id, 'a')
  assert.equal(matchRule('https://example.com/v1/models', rules), null)
})

test('matchRule skips disabled and blank rules', () => {
  const rules = [
    rule({ id: 'off', enabled: false }),
    rule({ id: 'blank', urlPattern: '   ' }),
    rule({ id: 'on', urlPattern: 'agentrouter' }),
  ]
  assert.equal(matchRule('https://agentrouter.org/', rules)?.id, 'on')
  assert.equal(matchRule('https://agentrouter.org/', [rules[0], rules[1]]), null)
})

test('matchRule prefers the longest pattern so the narrowest rule wins', () => {
  const rules = [
    rule({ id: 'broad', urlPattern: 'example.com' }),
    rule({ id: 'narrow', urlPattern: 'example.com/private' }),
  ]
  assert.equal(matchRule('https://example.com/private/models', rules)?.id, 'narrow')
  assert.equal(matchRule('https://example.com/public/models', rules)?.id, 'broad')
})

test('matchRule tolerates an empty or malformed rule list', () => {
  assert.equal(matchRule('https://agentrouter.org/', []), null)
  assert.equal(matchRule('https://agentrouter.org/', undefined), null)
  assert.equal(matchRule('', [rule()]), null)
  assert.equal(matchRule(undefined, [rule()]), null)
  assert.equal(matchRule('https://agentrouter.org/', [null, 7, 'x']), null)
})

test('sanitizeRule normalizes header names and trims fields', () => {
  const { rule: sanitized, errors, droppedHeaders } = sanitizeRule({
    id: '  AgentRouter  ',
    urlPattern: '  agentrouter.org  ',
    userAgent: '  claude-cli/1.0.60 (external, cli)  ',
    note: '  note  ',
    headers: [{ name: ' X-App ', value: 'cli' }],
  })
  assert.deepEqual(errors, [])
  assert.deepEqual(droppedHeaders, [])
  assert.equal(sanitized.id, 'AgentRouter')
  assert.equal(sanitized.urlPattern, 'agentrouter.org')
  assert.equal(sanitized.userAgent, 'claude-cli/1.0.60 (external, cli)')
  assert.equal(sanitized.note, 'note')
  assert.deepEqual(sanitized.headers, [{ name: 'x-app', value: 'cli' }])
  assert.equal(sanitized.enabled, true)
})

test('sanitizeRule drops reserved headers instead of rejecting the rule', () => {
  const { rule: sanitized, errors, droppedHeaders } = sanitizeRule(
    rule({
      headers: [
        { name: 'Authorization', value: 'Bearer leaked' },
        { name: 'x-api-key', value: 'leaked' },
        { name: 'x-app', value: 'cli' },
      ],
    }),
  )
  assert.deepEqual(errors, [])
  assert.deepEqual(droppedHeaders, ['authorization', 'x-api-key'])
  assert.deepEqual(sanitized.headers, [{ name: 'x-app', value: 'cli' }])
})

test('sanitizeRule rejects an empty pattern and control characters', () => {
  assert.deepEqual(sanitizeRule(rule({ urlPattern: '   ' })).errors, [
    { field: 'urlPattern', code: 'url-pattern-required', rule: 0 },
  ])
  assert.deepEqual(sanitizeRule(rule({ urlPattern: 'bad\u0000pattern' })).errors, [
    { field: 'urlPattern', code: 'url-pattern-control', rule: 0 },
  ])
  assert.deepEqual(sanitizeRule(rule({ userAgent: 'cli\r\nx: y' })).errors, [
    { field: 'userAgent', code: 'user-agent-control', rule: 0 },
  ])
})

test('sanitizeRule rejects header names that are not HTTP tokens', () => {
  for (const name of ['x app', 'x:app', '头部', '']) {
    if (name === '') continue
    const { errors } = sanitizeRule(rule({ headers: [{ name, value: 'v' }] }))
    assert.deepEqual(errors, [{ field: 'headers.0.name', code: 'invalid-header-name', rule: 0 }])
  }
})

test('sanitizeRule caps header count and value length', () => {
  const many = Array.from({ length: IDENTITY_LIMITS.maxHeadersPerRule + 1 }, (_, index) => ({
    name: `x-${index}`,
    value: 'v',
  }))
  assert.deepEqual(sanitizeRule(rule({ headers: many })).errors, [
    { field: 'headers', code: 'too-many-headers', rule: 0 },
  ])
  const long = 'a'.repeat(IDENTITY_LIMITS.headerValue + 1)
  assert.deepEqual(sanitizeRule(rule({ headers: [{ name: 'x-a', value: long }] })).errors, [
    { field: 'headers.0.value', code: 'invalid-header-value', rule: 0 },
  ])
})

test('sanitizeIdentityConfig fills defaults and rejects duplicate ids case-insensitively', () => {
  const empty = sanitizeIdentityConfig({})
  assert.deepEqual(empty.value, { enabled: true, diagnostics: false, rules: [] })
  assert.deepEqual(empty.errors, [])

  const duplicate = sanitizeIdentityConfig({
    enabled: false,
    diagnostics: true,
    rules: [rule({ id: 'Same' }), rule({ id: 'same' })],
  })
  assert.equal(duplicate.value.enabled, false)
  assert.equal(duplicate.value.diagnostics, true)
  assert.equal(duplicate.value.rules.length, 1)
  assert.deepEqual(duplicate.errors, [{ rule: 1, field: 'id', code: 'duplicate-rule-id' }])
})

test('sanitizeIdentityConfig rejects malformed top-level fields and too many rules', () => {
  assert.deepEqual(sanitizeIdentityConfig({ enabled: 'yes' }).errors, [
    { field: 'enabled', code: 'invalid-enabled' },
  ])
  assert.deepEqual(sanitizeIdentityConfig({ rules: 'nope' }).errors, [
    { field: 'rules', code: 'invalid-rules' },
  ])
  const tooMany = sanitizeIdentityConfig({
    rules: Array.from({ length: IDENTITY_LIMITS.maxRules + 1 }, (_, index) => rule({ id: `r${index}` })),
  })
  assert.equal(tooMany.errors[0].code, 'too-many-rules')
  assert.equal(tooMany.value.rules.length, IDENTITY_LIMITS.maxRules)
})

test('suggestRuleId slugifies and deduplicates', () => {
  assert.equal(suggestRuleId('agentrouter.org'), 'agentrouter-org')
  assert.equal(suggestRuleId('https://API.Example.com/v1'), 'api-example-com-v1')
  assert.equal(suggestRuleId('agentrouter.org', ['agentrouter-org']), 'agentrouter-org-2')
  assert.equal(suggestRuleId('***'), 'rule')
  assert.equal(suggestRuleId('agentrouter.org', ['AGENTROUTER-ORG']), 'agentrouter-org-2')
})

test('reserved header detection is case-insensitive', () => {
  assert.equal(isReservedHeader('Authorization'), true)
  assert.equal(isReservedHeader('X-API-KEY'), true)
  assert.equal(isReservedHeader('x-app'), false)
})

test('URL helpers accept only http(s) and derive hosts and model URLs', () => {
  assert.equal(isRewritableUrl('https://agentrouter.org/v1'), true)
  assert.equal(isRewritableUrl('http://127.0.0.1:8080/v1'), true)
  assert.equal(isRewritableUrl('file:///etc/passwd'), false)
  assert.equal(isRewritableUrl('not a url'), false)

  assert.equal(hostFromPattern('https://agentrouter.org/v1'), 'agentrouter.org')
  assert.equal(hostFromPattern('agentrouter.org'), 'agentrouter.org')
  assert.equal(modelsUrlFor('https://agentrouter.org/v1'), 'https://agentrouter.org/v1/models')
  assert.equal(modelsUrlFor('https://agentrouter.org/v1/models'), 'https://agentrouter.org/v1/models')
  assert.equal(modelsUrlFor(''), '')
})

test('hit accounting keeps counts, bounded hosts, and the last request pair', () => {
  const stats = createIdentityStats({ maxUrls: 2 })
  stats.record('agentrouter', 'https://agentrouter.org/v1/models', 'dsh/1.0', 'claude-cli/1.0')
  stats.record('agentrouter', 'https://agentrouter.org/v1/chat/completions', 'dsh/1.0', 'claude-cli/1.0')
  stats.record('agentrouter', 'https://agentrouter.org/v1/responses', 'dsh/1.0', 'claude-cli/1.0')
  stats.record('agentrouter', 'https://other.example/v1/models', 'dsh/1.0', 'claude-cli/1.0')

  assert.deepEqual(stats.snapshot(), {
    agentrouter: { count: 4, lastAt: stats.snapshot().agentrouter.lastAt, hosts: ['agentrouter.org', 'other.example'] },
  })
  const last = stats.lastForUrl('https://other.example/v1/models')
  assert.equal(last.ruleId, 'agentrouter')
  assert.equal(last.beforeUserAgent, 'dsh/1.0')
  assert.equal(last.afterUserAgent, 'claude-cli/1.0')
  assert.equal(stats.lastForUrl('https://agentrouter.org/v1/models'), null)

  stats.reset()
  assert.deepEqual(stats.snapshot(), {})
})
