import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BODY_LIMITS,
  IDENTITY_LIMITS,
  createIdentityStats,
  hostFromPattern,
  isReservedHeader,
  isRewritableUrl,
  matchRule,
  modelsUrlFor,
  sanitizeIdentityConfig,
  sanitizeRule,
  stripResponsesItemIds,
  suggestRuleId,
} from '../src/identity-core.js'

const rule = (overrides = {}) => ({
  id: 'rule',
  enabled: true,
  urlPattern: 'agentrouter.org',
  userAgent: '',
  headers: [],
  stripResponsesItemIds: false,
  note: '',
  ...overrides,
})

test('BODY_LIMITS is frozen at an 8 MiB JSON body cap', () => {
  assert.deepEqual(BODY_LIMITS, { maxJsonBodyBytes: 8 * 1024 * 1024 })
  assert.equal(Object.isFrozen(BODY_LIMITS), true)
  assert.throws(() => { BODY_LIMITS.maxJsonBodyBytes = 1 }, TypeError)
})

test('stripResponsesItemIds removes three top-level ids without changing other fields', () => {
  const expected = {
    id: 'body-id-kept',
    model: 'responses-model',
    store: false,
    previous_response_id: 'resp_kept',
    instructions: 'Keep all fields other than item ids',
    tools: [{ type: 'function', name: 'lookup', parameters: { id: 'schema-id-kept' } }],
    input: [
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'answer', id: 'nested-content-id-kept' }],
      },
      { type: 'reasoning', encrypted_content: 'encrypted-reasoning', summary: [{ type: 'summary_text', text: 'summary' }] },
      { type: 'function_call', call_id: 'call_kept', name: 'lookup', arguments: '{"id":"argument-id-kept"}' },
    ],
  }
  const raw = JSON.stringify({
    ...expected,
    input: expected.input.map((item, index) => ({ ...item, id: ['msg_1', 'rs_2', 'fc_3'][index] })),
  }, null, 2)
  const result = stripResponsesItemIds(raw)

  assert.equal(result.stripped, 3)
  assert.equal(result.skipped, 0)
  assert.deepEqual(JSON.parse(result.text), expected)
  assert.deepEqual(Object.keys(result).sort(), ['skipped', 'stripped', 'text'])
  assert.notEqual(result.text, raw)
})

test('stripResponsesItemIds leaves string input and missing input byte-for-byte unchanged', () => {
  const bodies = [
    ' { "input": "a prompt", "id": "body-id" }\n',
    '{\n  "model": "responses-model", "instructions": "no history"\n}\n',
  ]
  for (const raw of bodies) {
    assert.deepEqual(stripResponsesItemIds(raw), { text: raw, stripped: 0, skipped: 0 })
  }
})

test('stripResponsesItemIds fails open on invalid JSON and non-body values', () => {
  for (const raw of ['', ' ', '{', '{"input":[}', 'not json', 'null', 'true', '42', '[]', '{"input":null}', '{"input":{}}']) {
    assert.deepEqual(stripResponsesItemIds(raw), { text: raw, stripped: 0, skipped: 0 })
  }
  for (const raw of [undefined, null, 0, false, {}, [], new String('{"input":[{"id":"keep"}]}')]) {
    const result = stripResponsesItemIds(raw)
    assert.equal(result.text, raw)
    assert.deepEqual(result, { text: raw, stripped: 0, skipped: 0 })
  }
})

test('stripResponsesItemIds preserves item references and counts only references with an id', () => {
  const reference = { type: 'item_reference', id: 'msg_reference', metadata: { id: 'nested-reference-id' } }
  const raw = JSON.stringify({ input: [reference, { type: 'item_reference' }, { type: 'message', id: 'msg_inline', content: [] }] })
  const result = stripResponsesItemIds(raw)

  assert.equal(result.stripped, 1)
  assert.equal(result.skipped, 1)
  assert.deepEqual(JSON.parse(result.text), {
    input: [reference, { type: 'item_reference' }, { type: 'message', content: [] }],
  })

  const referenceOnly = ` { "input": [${JSON.stringify(reference)}] }\n`
  assert.deepEqual(stripResponsesItemIds(referenceOnly), { text: referenceOnly, stripped: 0, skipped: 1 })
})

test('stripResponsesItemIds returns the original text when no item has an id', () => {
  const raw = ' {\n "input": [null, true, 7, "text", [], {"type":"message","content":[{"id":"nested-id"}]}]\n }\n'
  const result = stripResponsesItemIds(raw)
  assert.equal(result.text, raw)
  assert.deepEqual(result, { text: raw, stripped: 0, skipped: 0 })
})

test('stripResponsesItemIds is idempotent even with a preserved item reference', () => {
  const first = stripResponsesItemIds('{"input":[{"id":"msg_inline","content":[]},{"type":"item_reference","id":"msg_ref"}]}')
  assert.equal(first.stripped, 1)
  assert.equal(first.skipped, 1)
  const second = stripResponsesItemIds(first.text)
  assert.deepEqual(second, { text: first.text, stripped: 0, skipped: 1 })
})

test('stripResponsesItemIds retains call linkage, encrypted content, and reasoning summaries', () => {
  const expected = {
    input: [
      { type: 'function_call', call_id: 'call_123', name: 'lookup', arguments: '{"query":"a"}', status: 'completed' },
      { type: 'function_call_output', call_id: 'call_123', output: '{"id":"result-id"}' },
      { type: 'reasoning', encrypted_content: 'opaque-encrypted-content', summary: [{ type: 'summary_text', text: 'private summary', id: 'nested-summary-id' }] },
    ],
  }
  const result = stripResponsesItemIds(JSON.stringify({
    input: expected.input.map((item, index) => ({ id: `item_${index}`, ...item })),
  }))
  assert.deepEqual(JSON.parse(result.text), expected)
  assert.equal(result.stripped, 3)
  assert.equal(result.skipped, 0)
})

test('stripResponsesItemIds removes own ids regardless of value and preserves other array entries', () => {
  const raw = JSON.stringify({ input: [null, false, 0, 'text', [], ...[null, false, 0, ''].map((id) => ({ id, keep: true }))] })
  const result = stripResponsesItemIds(raw)
  assert.equal(result.stripped, 4)
  assert.equal(result.skipped, 0)
  assert.deepEqual(JSON.parse(result.text), { input: [null, false, 0, 'text', [], ...Array.from({ length: 4 }, () => ({ keep: true }))] })
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
  assert.equal(sanitized.stripResponsesItemIds, false)
})

test('sanitizeRule enables Responses item-id stripping only for literal true', () => {
  const { rule: defaulted } = sanitizeRule({ id: 'default', urlPattern: 'example.com' })
  assert.equal(defaulted.stripResponsesItemIds, false)
  for (const value of [true, false, undefined, null, 'true', 'false', 1, 0, {}, [], new Boolean(true)]) {
    const { rule: sanitized, errors } = sanitizeRule(rule({ stripResponsesItemIds: value }))
    assert.deepEqual(errors, [])
    assert.equal(sanitized.stripResponsesItemIds, value === true)
    assert.equal(typeof sanitized.stripResponsesItemIds, 'boolean')
  }
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
    agentrouter: { count: 4, lastAt: stats.snapshot().agentrouter.lastAt, hosts: ['agentrouter.org', 'other.example'], strippedItems: 0 },
  })
  const last = stats.lastForUrl('https://other.example/v1/models')
  assert.equal(last.ruleId, 'agentrouter')
  assert.equal(last.beforeUserAgent, 'dsh/1.0')
  assert.equal(last.afterUserAgent, 'claude-cli/1.0')
  assert.equal(stats.lastForUrl('https://agentrouter.org/v1/models'), null)

  assert.equal(last.strippedItems, 0)
  stats.reset()
  assert.deepEqual(stats.snapshot(), {})
  assert.equal(stats.last(), null)
})

test('hit accounting keeps the fifth argument as at and defaults stripped counts to zero', () => {
  const stats = createIdentityStats()
  const url = 'https://example.com/v1/responses'
  const at = 123456789
  stats.record('legacy', url, 'before', 'after', at)

  assert.deepEqual(stats.last(), {
    ruleId: 'legacy', url, host: 'example.com', beforeUserAgent: 'before', afterUserAgent: 'after', at, strippedItems: 0,
  })
  assert.deepEqual(stats.lastForUrl(url), stats.last())
  assert.deepEqual(stats.snapshot(), {
    legacy: { count: 1, lastAt: at, hosts: ['example.com'], strippedItems: 0 },
  })

  const before = Date.now()
  stats.record('legacy', url, 'before', 'after', undefined, { strippedItems: 2 })
  assert.ok(stats.last().at >= before && stats.last().at <= Date.now())
  assert.equal(stats.last().strippedItems, 2)
  assert.equal(stats.snapshot().legacy.strippedItems, 2)
})

test('hit accounting reports the latest request count separately from per-rule totals', () => {
  const stats = createIdentityStats()
  const url = 'https://example.com/v1/responses'
  stats.record('first', url, 'before', 'after', 100, { strippedItems: 3 })
  stats.record('first', url, 'before', 'after', 200, { strippedItems: 2 })
  assert.equal(stats.last().strippedItems, 2)
  assert.equal(stats.lastForUrl(url).strippedItems, 2)
  assert.equal(stats.snapshot().first.strippedItems, 5)

  stats.record('second', url, 'before', 'after', 300, { strippedItems: 4 })
  stats.record('first', url, 'before', 'after', 400)
  assert.equal(stats.last().strippedItems, 0)
  assert.deepEqual(stats.snapshot(), {
    first: { count: 3, lastAt: 400, hosts: ['example.com'], strippedItems: 5 },
    second: { count: 1, lastAt: 300, hosts: ['example.com'], strippedItems: 4 },
  })

  const copy = stats.snapshot()
  copy.first.strippedItems = 999
  copy.first.hosts.push('mutated.example')
  const lastCopy = stats.last()
  lastCopy.strippedItems = 999
  assert.equal(stats.snapshot().first.strippedItems, 5)
  assert.deepEqual(stats.snapshot().first.hosts, ['example.com'])
  assert.equal(stats.last().strippedItems, 0)

  stats.reset()
  assert.deepEqual(stats.snapshot(), {})
  assert.equal(stats.last(), null)
  assert.equal(stats.lastForUrl(url), null)
  stats.record('first', url, 'before', 'after', 500, { strippedItems: 1 })
  assert.equal(stats.snapshot().first.strippedItems, 1)
})

test('hit accounting accepts finite stripped counts and clamps negative or non-numeric values to zero', () => {
  const stats = createIdentityStats()
  const url = 'https://example.com/v1/responses'
  stats.record('rule', url, '', '', 1, { strippedItems: 2 })
  const invalid = [undefined, null, NaN, Infinity, -Infinity, -1, -0.5, '3', true, {}, [], new Number(3)]
  for (const strippedItems of invalid) {
    stats.record('rule', url, '', '', 2, { strippedItems })
    assert.equal(stats.last().strippedItems, 0)
    assert.equal(stats.snapshot().rule.strippedItems, 2)
  }
  stats.record('rule', url, '', '', 3, { strippedItems: 1.5 })
  assert.equal(stats.last().strippedItems, 1.5)
  assert.equal(stats.snapshot().rule.strippedItems, 3.5)
})

test('hit accounting retains only the stripped count from extra and never body content', () => {
  const stats = createIdentityStats()
  const url = 'https://example.com/v1/responses'
  const secret = 'private-request-content-never-retained'
  const extra = {
    strippedItems: 3,
    text: secret,
    body: { input: [{ id: 'msg_private', content: secret }] },
    headers: { authorization: secret },
    skipped: 8,
    at: 999,
    ruleId: 'injected',
    count: 100,
  }
  stats.record('safe', url, 'before', 'after', 123, extra)
  extra.strippedItems = 99
  extra.body.input[0].content = 'mutated-secret'

  const last = {
    ruleId: 'safe', url, host: 'example.com', beforeUserAgent: 'before', afterUserAgent: 'after', at: 123, strippedItems: 3,
  }
  assert.deepEqual(stats.last(), last)
  assert.deepEqual(stats.lastForUrl(url), last)
  assert.deepEqual(stats.snapshot(), {
    safe: { count: 1, lastAt: 123, hosts: ['example.com'], strippedItems: 3 },
  })
  const serialized = JSON.stringify({ last: stats.last(), snapshot: stats.snapshot() })
  assert.equal(serialized.includes(secret), false)
  assert.equal(serialized.includes('msg_private'), false)
  assert.equal(serialized.includes('authorization'), false)
})
