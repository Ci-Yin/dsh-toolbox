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
    { id: '', enabled: true, urlPattern: 'agentrouter.org', userAgent: '', headers: [], stripResponsesItemIds: false, note: '' },
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

test('Responses item stripping normalization and drafts accept only literal true', () => {
  for (const input of [undefined, null, false, true, 'true', 'false', 0, 1, {}, []]) {
    const source = { id: 'rule', urlPattern: 'example.com', stripResponsesItemIds: input }
    const normalized = normalizeIdentityValue({ rules: [source] }).rules[0]
    assert.equal(normalized.stripResponsesItemIds, input === true)
    for (const editingId of [null, 'rule']) {
      const result = draftToRule(source, [], editingId)
      assert.deepEqual(result.errors, [])
      assert.equal(result.rule.stripResponsesItemIds, input === true)
    }
  }
  assert.equal(draftToRule({ urlPattern: 'example.com' }).rule.stripResponsesItemIds, false)
})

test('Responses item stripping text is localized in Chinese and English', () => {
  assert.equal(t('identity.field.stripItemIds'), '剥离 Responses 条目 id')
  assert.equal(t('identity.field.stripItemIdsHint'), '多资源 Azure 网关在多轮对话报 400 时开启；会移除历史条目的 id，保留工具调用关联')
  assert.equal(t('identity.strippedItems', { count: 7 }), '已剥离 7 个 Responses 条目 id')
  const english = createTranslator('en')
  assert.equal(english('identity.field.stripItemIds'), 'Strip Responses item IDs')
  assert.match(english('identity.field.stripItemIdsHint'), /400.*preserving tool-call associations/u)
  assert.equal(english('identity.strippedItems', { count: 7 }), 'Stripped 7 Responses item IDs')
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

test('disabling identity hides related settings and suppresses the success notice', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:64370/',
  })
  const win = dom.window
  globalThis.window = win
  globalThis.document = win.document
  const identity = { enabled: false, diagnostics: true, rules: [{ id: 'r1', enabled: true, urlPattern: 'example.com', userAgent: 'cli', headers: [], note: '' }] }
  let revision = 1
  win.fetch = async (path, init) => {
    if (path === '/api/dsh-toolbox.identity' && (init?.method ?? 'GET') === 'GET') {
      return { ok: true, status: 200, json: async () => ({ ok: true, writable: true, revision, value: identity, providers: [], stats: {} }) }
    }
    if (path === '/api/dsh-toolbox.identity' && init?.method === 'POST') {
      const body = JSON.parse(init.body)
      identity.enabled = body.value.enabled
      revision += 1
      return { ok: true, status: 200, json: async () => ({ ok: true, writable: true, revision, value: identity, providers: [], stats: {} }) }
    }
    throw new Error(`unexpected path ${path}`)
  }

  const IdentitySection = createIdentitySection(React)
  const root = createRoot(win.document.getElementById('root'))
  await act(async () => root.render(React.createElement(IdentitySection, { t, win })))
  assert.doesNotMatch(win.document.querySelector('.dsh-toolbox-identity-body')?.textContent ?? '', /身份规则/u)
  assert.doesNotMatch(win.document.querySelector('.dsh-toolbox-identity-body')?.textContent ?? '', /诊断模式/u)

  const toggle = win.document.querySelector('input[data-feature="identity"]')
  assert.ok(toggle)
  assert.equal(toggle.checked, false)
  await act(async () => Simulate.change(toggle, { target: { checked: true } }))
  assert.match(win.document.body.textContent, /身份规则/u)
  assert.match(win.document.body.textContent, /诊断日志/u)
  assert.doesNotMatch(win.document.body.textContent, /已保存/u)

  await act(async () => root.unmount())
  dom.window.close()
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
  assert.equal(win.document.querySelector('input[name="stripResponsesItemIds"]').checked, false)

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
  assert.equal(saveCall.body.value.rules[0].stripResponsesItemIds, false)
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

test('the Responses checkbox follows custom headers and survives new and edit saves', async (context) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:64370/',
  })
  const win = dom.window
  globalThis.window = win
  globalThis.document = win.document
  let value = { enabled: true, diagnostics: false, rules: [] }
  let revision = 1
  const saves = []
  win.fetch = async (path, init) => {
    assert.equal(path, '/api/dsh-toolbox.identity')
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body)
      assert.equal(body.expectedRevision, revision)
      saves.push(body.value)
      value = body.value
      revision += 1
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, writable: true, revision, value, providers: [], stats: {} }) }
  }
  const IdentitySection = createIdentitySection(React)
  const root = createRoot(win.document.getElementById('root'))
  context.after(async () => {
    await act(async () => root.unmount())
    win.close()
  })
  await act(async () => root.render(React.createElement(IdentitySection, { t, win })))

  const button = (label) => [...win.document.querySelectorAll('button')].find((entry) => entry.textContent === label)
  const checkbox = () => win.document.querySelector('input[name="stripResponsesItemIds"]')
  await act(async () => button('新建规则').click())
  assert.equal(checkbox().checked, false)
  assert.equal(checkbox().closest('label').textContent, '剥离 Responses 条目 id')
  const stripField = checkbox().closest('.dsh-toolbox-identity-field')
  assert.match(stripField.textContent, /多资源 Azure 网关在多轮对话报 400 时开启/u)
  assert.match(stripField.textContent, /保留工具调用关联/u)
  assert.match(stripField.previousElementSibling.textContent, /自定义请求头/u)

  const pattern = win.document.querySelector('input[placeholder="agentrouter.org"]')
  await act(async () => Simulate.change(pattern, { target: { value: 'example.com' } }))
  await act(async () => Simulate.change(checkbox(), { target: { checked: true } }))
  assert.equal(checkbox().checked, true)
  await act(async () => button('保存规则').click())
  assert.equal(saves.length, 1)
  assert.equal(saves[0].rules[0].stripResponsesItemIds, true)
  assert.equal(checkbox(), null)

  await act(async () => button('停用').click())
  assert.equal(value.rules[0].enabled, false)
  assert.equal(value.rules[0].stripResponsesItemIds, true)
  await act(async () => button('编辑').click())
  assert.equal(checkbox().checked, true)
  await act(async () => button('保存规则').click())
  assert.equal(value.rules[0].stripResponsesItemIds, true)
  assert.equal(value.rules[0].enabled, false)

  await act(async () => button('编辑').click())
  await act(async () => Simulate.change(checkbox(), { target: { checked: false } }))
  assert.equal(checkbox().checked, false)
  await act(async () => button('保存规则').click())
  assert.equal(value.rules[0].stripResponsesItemIds, false)
  assert.equal(value.rules[0].enabled, false)
  await act(async () => button('编辑').click())
  assert.equal(checkbox().checked, false)
  await act(async () => button('取消').click())
  await act(async () => button('新建规则').click())
  assert.equal(checkbox().checked, false)
})

test('existing and legacy rules keep strict Responses checkbox values and show only positive counts', async (context) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:64370/',
  })
  const win = dom.window
  globalThis.window = win
  globalThis.document = win.document
  const rules = [
    { id: 'on', urlPattern: 'on.example.com', stripResponsesItemIds: true },
    { id: 'off', urlPattern: 'off.example.com', stripResponsesItemIds: false },
    { id: 'legacy', urlPattern: 'legacy.example.com' },
    { id: 'string', urlPattern: 'string.example.com', stripResponsesItemIds: 'true' },
  ]
  let value = { enabled: true, diagnostics: false, rules }
  const stats = {
    on: { count: 3, hosts: ['on.example.com'], strippedItems: 7 },
    off: { count: 2, hosts: ['off.example.com'], strippedItems: 0 },
    legacy: { count: 1, hosts: ['legacy.example.com'] },
    string: { count: 1, hosts: ['string.example.com'], strippedItems: -1 },
  }
  win.fetch = async (path, init) => {
    assert.equal(path, '/api/dsh-toolbox.identity')
    if (init?.method === 'POST') value = JSON.parse(init.body).value
    return { ok: true, status: 200, json: async () => ({ ok: true, writable: true, revision: 1, value, providers: [], stats }) }
  }
  const IdentitySection = createIdentitySection(React)
  const root = createRoot(win.document.getElementById('root'))
  context.after(async () => {
    await act(async () => root.unmount())
    win.close()
  })
  await act(async () => root.render(React.createElement(IdentitySection, { t, win })))

  const button = (scope, label) => [...scope.querySelectorAll('button')].find((entry) => entry.textContent === label)
  const rows = () => [...win.document.querySelectorAll('.dsh-toolbox-identity-rule')]
  assert.match(rows()[0].textContent, /已命中 3 次/u)
  assert.match(rows()[0].textContent, /已剥离 7 个 Responses 条目 id/u)
  for (const row of rows().slice(1)) assert.doesNotMatch(row.textContent, /已剥离/u)

  for (const [index, rule] of rules.entries()) {
    await act(async () => button(rows()[index], '编辑').click())
    assert.equal(win.document.querySelector('input[name="stripResponsesItemIds"]').checked, rule.stripResponsesItemIds === true)
    await act(async () => button(win.document, '保存规则').click())
    assert.equal(value.rules[index].stripResponsesItemIds, rule.stripResponsesItemIds === true)
  }
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
