import { test } from 'node:test'
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import {
  createIdentityApi,
  createIdentitySection,
  draftToRule,
  errorsByField,
  identityErrorText,
  normalizeIdentityValue,
} from '../src/identity-client.js'
import { createTranslator } from '../src/i18n.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const t = createTranslator('zh')

test('normalizeIdentityValue tolerates a partial host document', () => {
  assert.deepEqual(normalizeIdentityValue(undefined), { enabled: true, diagnostics: false, rules: [] })
  const value = normalizeIdentityValue({
    enabled: false,
    diagnostics: true,
    rules: [{ urlPattern: 'agentrouter.org' }],
  })
  assert.equal(value.enabled, false)
  assert.equal(value.diagnostics, true)
  assert.deepEqual(value.rules, [
    { id: '', enabled: true, urlPattern: 'agentrouter.org', userAgent: '', headers: [], note: '' },
  ])
})

test('draftToRule derives a unique id and drops reserved headers', () => {
  const created = draftToRule(
    {
      urlPattern: 'https://AgentRouter.org/v1',
      userAgent: 'cli',
      note: '',
      headers: [{ name: 'Authorization', value: 'leak' }, { name: 'x-app', value: 'cli' }],
    },
    [],
    null,
  )
  assert.deepEqual(created.errors, [])
  assert.deepEqual(created.droppedHeaders, ['authorization'])
  assert.equal(created.rule.id, 'agentrouter-org-v1')
  assert.deepEqual(created.rule.headers, [{ name: 'x-app', value: 'cli' }])

  const draft = { urlPattern: 'agentrouter.org', userAgent: '', note: '', headers: [] }
  assert.equal(draftToRule(draft, [{ id: 'agentrouter-org' }], null).rule.id, 'agentrouter-org-2')
  // Editing keeps the rule's own id out of the collision set.
  assert.equal(draftToRule(draft, [{ id: 'agentrouter-org' }], 'agentrouter-org').rule.id, 'agentrouter-org')
})

test('errorsByField keeps the first error per field and error text maps route codes', () => {
  assert.deepEqual(
    errorsByField([
      { field: 'urlPattern', code: 'url-pattern-required' },
      { field: 'urlPattern', code: 'url-pattern-control' },
      { field: 'rules', code: 'invalid-rules' },
    ]),
    { urlPattern: 'url-pattern-required', rules: 'invalid-rules' },
  )
  assert.match(identityErrorText(t, { code: 'namespace-missing' }), /重启 DSH/u)
  assert.match(identityErrorText(t, { code: 'test-failed', message: 'boom' }), /boom/u)
  assert.match(identityErrorText(t, { code: 'weird', message: 'why' }), /why/u)
})

test('the card renders its loading state without touching the network', () => {
  const IdentitySection = createIdentitySection(React)
  const html = renderToStaticMarkup(React.createElement(IdentitySection, { t, win: {} }))
  assert.match(html, /身份规则/u)
  assert.match(html, /正在读取宿主配置/u)
  assert.match(html, /仅对你有权使用的服务使用/u)
})

test('the card loads host state, creates a provider rule, saves it, and probes it', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:64370/',
  })
  const win = dom.window
  globalThis.window = win
  globalThis.document = win.document
  win.confirm = () => true

  let value = { enabled: true, diagnostics: false, rules: [] }
  let revision = 1
  const calls = []
  const providers = [
    { provider: 'agentrouter', displayName: 'Agent Router', baseURL: 'https://agentrouter.org/v1' },
  ]
  win.fetch = async (path, init) => {
    calls.push({ path, init, body: init?.body === undefined ? null : JSON.parse(init.body) })
    if (path === '/api/dsh-toolbox.identity' && (init?.method ?? 'GET') === 'GET') {
      return { ok: true, status: 200, json: async () => ({ ok: true, writable: true, revision, value, providers, stats: {} }) }
    }
    if (path === '/api/dsh-toolbox.identity' && init.method === 'POST') {
      value = calls.at(-1).body.value
      revision += 1
      return { ok: true, status: 200, json: async () => ({ ok: true, revision, value, providers, stats: {}, droppedHeaders: [] }) }
    }
    if (path === '/api/dsh-toolbox.identity-test') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          status: 401,
          snippet: '{"error":"unauthorized client detected"}',
          matchedRuleId: 'agentrouter-org',
          beforeUserAgent: 'dsh/1.0',
          afterUserAgent: 'claude-cli/1.0.60 (external, cli)',
        }),
      }
    }
    throw new Error(`unexpected path ${path}`)
  }

  const IdentitySection = createIdentitySection(React)
  const root = createRoot(win.document.getElementById('root'))
  await act(async () => {
    root.render(React.createElement(IdentitySection, { t, win }))
  })

  const text = () => win.document.body.textContent
  assert.match(text(), /身份规则/u)
  assert.match(text(), /还没有规则/u)
  assert.match(text(), /Agent Router \(agentrouter\)/u)

  const generate = [...win.document.querySelectorAll('button')].find(
    (button) => button.textContent === '用该 provider 生成规则',
  )
  assert.ok(generate)
  await act(async () => {
    generate.click()
  })

  const patternInput = [...win.document.querySelectorAll('input')].find(
    (input) => input.getAttribute('placeholder') === 'agentrouter.org',
  )
  assert.ok(patternInput)
  assert.equal(patternInput.value, 'agentrouter.org')

  const uaInput = [...win.document.querySelectorAll('input')].find(
    (input) => input.getAttribute('placeholder') === 'claude-cli/1.0.60 (external, cli)',
  )
  assert.ok(uaInput)
  await act(async () => {
    Simulate.change(uaInput, { target: { value: 'claude-cli/1.0.60 (external, cli)' } })
  })

  const save = [...win.document.querySelectorAll('button')].find(
    (button) => button.textContent === '保存规则',
  )
  assert.ok(save)
  await act(async () => {
    save.click()
  })

  const saveCall = calls.find((call) => call.path === '/api/dsh-toolbox.identity' && call.init?.method === 'POST')
  assert.ok(saveCall)
  assert.equal(saveCall.body.value.rules.length, 1)
  assert.equal(saveCall.body.value.rules[0].urlPattern, 'agentrouter.org')
  assert.equal(saveCall.body.value.rules[0].userAgent, 'claude-cli/1.0.60 (external, cli)')
  assert.equal(saveCall.body.value.rules[0].note, 'Agent Router')
  assert.equal(saveCall.body.expectedRevision, 1)

  const testButton = [...win.document.querySelectorAll('button')].find(
    (button) => button.textContent === '测试',
  )
  assert.ok(testButton)
  await act(async () => {
    testButton.click()
  })

  const probeCall = calls.find((call) => call.path === '/api/dsh-toolbox.identity-test')
  assert.ok(probeCall)
  assert.equal(probeCall.body.url, 'https://agentrouter.org/v1/models')
  assert.match(text(), /状态码 401/u)
  assert.match(text(), /命中规则 agentrouter-org/u)
  assert.match(text(), /claude-cli\/1.0.60 \(external, cli\)/u)
  assert.match(text(), /unauthorized client detected/u)

  await act(async () => {
    root.unmount()
  })
  dom.window.close()
})

test('the API client surfaces host error codes instead of JSON parse noise', async () => {
  const win = {
    fetch: async () => ({
      ok: false,
      status: 404,
      json: async () => ({ ok: false, code: 'namespace-missing' }),
    }),
  }
  const api = createIdentityApi(win)
  await assert.rejects(
    () => api.read(),
    (error) => error.code === 'namespace-missing' && error.status === 404,
  )

  // A bare 404 (route not registered because the host half is still the old
  // module) must become an actionable code, not "http-404".
  const bare = createIdentityApi({
    fetch: async () => ({ ok: false, status: 404, json: async () => ({ error: 'not found' }) }),
  })
  await assert.rejects(
    () => bare.read(),
    (error) => error.code === 'route-missing' && error.status === 404,
  )
  assert.match(identityErrorText(t, { code: 'route-missing' }), /重启 DSH/u)

  const offline = createIdentityApi({})
  await assert.rejects(
    () => offline.read(),
    (error) => error.code === 'fetch-unavailable',
  )
})

test('the card explains a missing host route and offers a retry', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:64370/',
  })
  const win = dom.window
  globalThis.window = win
  globalThis.document = win.document
  let attempts = 0
  win.fetch = async () => {
    attempts += 1
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) }
  }

  const IdentitySection = createIdentitySection(React)
  const root = createRoot(win.document.getElementById('root'))
  await act(async () => {
    root.render(React.createElement(IdentitySection, { t, win }))
  })

  assert.equal(attempts, 1)
  assert.match(win.document.body.textContent, /重启 DSH/u)
  const retry = [...win.document.querySelectorAll('button')].find((button) => button.textContent === '重试')
  assert.ok(retry)
  await act(async () => {
    retry.click()
  })
  assert.equal(attempts, 2)

  await act(async () => {
    root.unmount()
  })
  dom.window.close()
})
