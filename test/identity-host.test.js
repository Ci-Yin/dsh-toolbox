import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIdentityStats } from '../src/identity-core.js'
import {
  IDENTITY_ENTRY_ID,
  IDENTITY_ROUTE,
  IDENTITY_TEST_ROUTE,
  createIdentityHandlers,
  describeProviders,
  untrustedRequest,
} from '../src/identity-host.js'

function makeRes() {
  const res = {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      res.status = status
      res.headers = headers
    },
    end(chunk) {
      res.body = String(chunk ?? '')
    },
  }
  return res
}

function makeReq({ method = 'GET', host = '127.0.0.1:64370', origin, body } = {}) {
  const headers = { host }
  if (origin !== undefined) headers.origin = origin
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    },
  }
}

function fakeSettings(options = {}) {
  let state = options.value ?? { identity: { enabled: true, diagnostics: false, rules: [] } }
  let revision = options.revision ?? 1
  const calls = []
  const extraRows = options.extraRows ?? []
  return {
    writable: true,
    calls,
    revision: () => revision,
    state: () => state,
    describe: () => [
      { ns: IDENTITY_ENTRY_ID, revision, value: JSON.parse(JSON.stringify(state)) },
      ...extraRows,
    ],
    async replace(ns, section, expected) {
      calls.push({ ns, section, expected })
      if (options.rejectWith !== undefined) throw options.rejectWith
      if (expected !== undefined && expected !== revision) {
        const error = new Error('conflict')
        error.code = 'SETTINGS_CONFLICT'
        throw error
      }
      state = section
      revision += 1
    },
  }
}

const PROVIDER_ROWS = [
  {
    ns: 'llm-pi-ai',
    revision: 1,
    value: {
      providers: {
        agentrouter: { displayName: 'Agent Router', baseURL: 'https://agentrouter.org/v1' },
      },
    },
  },
]

function handlersWith(settings, overrides = {}) {
  const stats = overrides.stats ?? createIdentityStats()
  return createIdentityHandlers({
    readConfig: overrides.readConfig ?? (() => ({ enabled: true, diagnostics: false, rules: [] })),
    getSettings: () => settings,
    getLlm: () => ({ listConfigurableProviders: () => [{ provider: 'extra', displayName: 'Extra', defaultBaseURL: 'https://extra.example/v1' }] }),
    stats,
    logger: { info() {}, warn() {}, error() {} },
    ...overrides.deps,
  })
}

test('the config route exposes the live document, providers, and hit stats', async () => {
  const stats = createIdentityStats()
  stats.record('agentrouter', 'https://agentrouter.org/v1/models', 'dsh/1.0', 'cli')
  const settings = fakeSettings({
    value: { identity: { enabled: true, diagnostics: false, rules: [{ id: 'agentrouter', enabled: true, urlPattern: 'agentrouter.org', userAgent: 'cli', headers: [], note: '' }] } },
    extraRows: PROVIDER_ROWS,
  })
  const handlers = handlersWith(settings, { stats })
  const res = makeRes()
  await handlers.config(makeReq(), res)
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.entryId, IDENTITY_ENTRY_ID)
  assert.equal(body.revision, 1)
  assert.equal(body.value.rules[0].urlPattern, 'agentrouter.org')
  assert.deepEqual(body.stats.agentrouter.count, 1)
  assert.deepEqual(
    body.providers.map((provider) => provider.provider),
    ['agentrouter', 'extra'],
  )
  assert.equal(body.providers[0].baseURL, 'https://agentrouter.org/v1')
  assert.equal(body.providers[1].baseURL, 'https://extra.example/v1')
})

test('the config route refuses non-loopback hosts and cross-origin callers', async () => {
  const handlers = handlersWith(fakeSettings())
  const remote = makeRes()
  await handlers.config(makeReq({ host: 'evil.example:64370' }), remote)
  assert.equal(remote.status, 403)
  assert.equal(JSON.parse(remote.body).reason, 'non-loopback-host')

  const crossOrigin = makeRes()
  await handlers.config(makeReq({ origin: 'https://evil.example' }), crossOrigin)
  assert.equal(crossOrigin.status, 403)
  assert.equal(JSON.parse(crossOrigin.body).reason, 'origin-mismatch')

  const sameOrigin = makeRes()
  await handlers.config(makeReq({ origin: 'http://127.0.0.1:64370' }), sameOrigin)
  assert.equal(sameOrigin.status, 200)

  assert.equal(untrustedRequest({ headers: { host: 'localhost:1', origin: 'null' } }), 'null-origin')
  assert.equal(untrustedRequest({ headers: { host: 'localhost:1', origin: '::bad::' } }), 'origin-unparseable')
  assert.equal(untrustedRequest({ headers: { host: 'localhost:1' } }), null)
})

test('the config route reports a missing settings service or entry instead of guessing', async () => {
  const absent = createIdentityHandlers({
    readConfig: () => ({ enabled: true, rules: [] }),
    getSettings: () => undefined,
    getLlm: () => undefined,
    stats: createIdentityStats(),
  })
  const absentRes = makeRes()
  await absent.config(makeReq(), absentRes)
  assert.equal(absentRes.status, 503)
  assert.equal(JSON.parse(absentRes.body).code, 'settings-absent')

  const noEntry = fakeSettings({ extraRows: [] })
  noEntry.describe = () => []
  const handlers = handlersWith(noEntry)
  const missing = makeRes()
  await handlers.config(makeReq(), missing)
  assert.equal(missing.status, 404)
  assert.equal(JSON.parse(missing.body).code, 'namespace-missing')
})

test('saving validates, normalizes, drops reserved headers, and persists once', async () => {
  const settings = fakeSettings()
  const handlers = handlersWith(settings)
  const res = makeRes()
  await handlers.config(
    makeReq({
      method: 'POST',
      body: {
        expectedRevision: 1,
        value: {
          enabled: false,
          diagnostics: true,
          rules: [
            {
              id: 'agentrouter',
              urlPattern: ' agentrouter.org ',
              userAgent: ' cli ',
              headers: [
                { name: 'Authorization', value: 'leak' },
                { name: 'X-App', value: 'cli' },
              ],
            },
          ],
        },
      },
    }),
    res,
  )
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.revision, 2)
  assert.deepEqual(body.droppedHeaders, ['authorization'])
  assert.equal(body.value.enabled, false)
  assert.equal(body.value.diagnostics, true)
  assert.equal(body.value.rules[0].urlPattern, 'agentrouter.org')
  assert.deepEqual(body.value.rules[0].headers, [{ name: 'x-app', value: 'cli' }])
  assert.equal(settings.calls.length, 1)
  assert.equal(settings.calls[0].ns, IDENTITY_ENTRY_ID)
  assert.equal(settings.calls[0].expected, 1)
  assert.deepEqual(settings.state(), { identity: body.value })
})

test('saving rejects an invalid rule and a stale revision', async () => {
  const settings = fakeSettings()
  const handlers = handlersWith(settings)

  const invalid = makeRes()
  await handlers.config(makeReq({ method: 'POST', body: { value: { rules: [{ id: 'x', urlPattern: '  ' }] } } }), invalid)
  assert.equal(invalid.status, 400)
  const invalidBody = JSON.parse(invalid.body)
  assert.equal(invalidBody.code, 'invalid-config')
  assert.equal(invalidBody.errors[0].field, 'urlPattern')
  assert.equal(settings.calls.length, 0)

  const stale = makeRes()
  await handlers.config(
    makeReq({ method: 'POST', body: { expectedRevision: 99, value: { rules: [{ id: 'x', urlPattern: 'x.example' }] } } }),
    stale,
  )
  assert.equal(stale.status, 409)
  assert.equal(JSON.parse(stale.body).code, 'settings-conflict')

  const wrongMethod = makeRes()
  await handlers.config(makeReq({ method: 'PUT' }), wrongMethod)
  assert.equal(wrongMethod.status, 405)
})

test('the test probe reports status, snippet, and the UA pair the patch recorded', async () => {
  const stats = createIdentityStats()
  const handlers = handlersWith(fakeSettings(), {
    stats,
    deps: {
      fetchImpl: async (url) => {
        stats.record('agentrouter', url, 'dsh/1.0', 'claude-cli/1.0.60 (external, cli)')
        return new Response(JSON.stringify({ error: 'unauthorized client detected, contact support' }), { status: 401 })
      },
    },
  })
  const res = makeRes()
  await handlers.test(makeReq({ method: 'POST', body: { url: 'https://agentrouter.org/v1/models' } }), res)
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.status, 401)
  assert.equal(body.matchedRuleId, 'agentrouter')
  assert.equal(body.beforeUserAgent, 'dsh/1.0')
  assert.equal(body.afterUserAgent, 'claude-cli/1.0.60 (external, cli)')
  assert.match(body.snippet, /unauthorized client detected/u)
  assert.ok(body.snippet.length <= 200)
})

test('the test probe validates method and URL and reports transport failures', async () => {
  const handlers = handlersWith(fakeSettings())
  const wrongMethod = makeRes()
  await handlers.test(makeReq({ method: 'GET' }), wrongMethod)
  assert.equal(wrongMethod.status, 405)

  const invalid = makeRes()
  await handlers.test(makeReq({ method: 'POST', body: { url: 'not a url' } }), invalid)
  assert.equal(invalid.status, 400)
  assert.equal(JSON.parse(invalid.body).code, 'invalid-url')

  const nonHttp = makeRes()
  await handlers.test(makeReq({ method: 'POST', body: { url: 'file:///etc/passwd' } }), nonHttp)
  assert.equal(nonHttp.status, 400)

  const failing = handlersWith(fakeSettings(), {
    deps: {
      fetchImpl: async () => {
        throw new Error('connection refused')
      },
    },
  })
  const failure = makeRes()
  await failing.test(makeReq({ method: 'POST', body: { url: 'https://agentrouter.org/v1/models' } }), failure)
  assert.equal(failure.status, 502)
  assert.equal(JSON.parse(failure.body).code, 'test-failed')
})

test('a failing settings.describe does not make the route throw', async () => {
  const settings = {
    writable: true,
    describe() {
      throw new Error('another plugin has a broken config')
    },
    async replace() {},
  }
  const handlers = handlersWith(settings)
  const res = makeRes()
  await handlers.config(makeReq(), res)
  assert.equal(res.status, 404)
  assert.equal(JSON.parse(res.body).code, 'namespace-missing')
})

test('provider discovery tolerates a broken settings or llm service', () => {
  const rows = describeProviders(
    () => ({
      describe() {
        throw new Error('broken config')
      },
    }),
    () => ({
      listConfigurableProviders() {
        throw new Error('broken llm')
      },
    }),
  )
  assert.deepEqual(rows, [])

  const rowsFromLlmOnly = describeProviders(
    () => undefined,
    () => ({ listConfigurableProviders: () => [{ provider: 'w', displayName: 'W', defaultBaseURL: '' }] }),
  )
  assert.deepEqual(rowsFromLlmOnly, [{ provider: 'w', displayName: 'W', baseURL: '' }])
})

test('the route paths are stable', () => {
  assert.equal(IDENTITY_ROUTE, '/api/dsh-toolbox.identity')
  assert.equal(IDENTITY_TEST_ROUTE, '/api/dsh-toolbox.identity-test')
  assert.equal(IDENTITY_ENTRY_ID, 'dsh-toolbox')
})
