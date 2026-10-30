import { test } from 'node:test'
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { createSettingsPanel } from '../src/settings-panel.js'
import { CATALOG_KEY, createDefaultConfig, loadCatalogResult, loadConfig, saveCatalog, saveConfig } from '../src/model-storage.js'
import { LAST_GROUPED_VIEW_KEY } from '../src/workspace-flat-toggle.js'
import { SETTINGS_TAB_KEY } from '../src/settings-preferences.js'
import { FEATURE_SETTINGS_KEY } from '../src/feature-settings.js'
import { FULL_DATA_FORMAT, FULL_DATA_VERSION } from '../src/toolbox-data.js'
import { createTranslator } from '../src/i18n.js'
import { makeModelKey } from '../src/model-catalog.js'
import { FakeStorage } from './helpers.js'
import { JSDOM } from 'jsdom'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

test('settings interactions create a group and assign a model', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  const storage = new FakeStorage()
  const config = createDefaultConfig()
  config.groups[0].modelKeys = [makeModelKey('deepseek', 'deepseek-chat')]
  saveConfig(storage, config)
  saveCatalog(storage, [
    {
      key: makeModelKey('deepseek', 'deepseek-chat'),
      providerId: 'deepseek',
      providerName: 'DeepSeek',
      modelId: 'deepseek-chat',
      name: 'DeepSeek Chat',
    },
    {
      key: makeModelKey('openai', 'gpt-4o'),
      providerId: 'openai',
      providerName: 'OpenAI',
      modelId: 'gpt-4o',
      name: 'GPT-4o',
    },
  ])

  const Panel = createSettingsPanel(React)
  const root = createRoot(dom.window.document.getElementById('root'))
  await act(async () => {
    root.render(React.createElement(Panel, { t: createTranslator('zh'), storage, window: dom.window }))
  })

  const createInput = [...dom.window.document.querySelectorAll('input')].find(
    (input) => input.getAttribute('placeholder') === '分组名称',
  )
  assert.ok(createInput)
  await act(async () => {
    Simulate.change(createInput, { target: { value: '写代码' } })
  })
  const createButton = [...dom.window.document.querySelectorAll('button')].find(
    (button) => button.textContent === '新建分组',
  )
  assert.ok(createButton)
  assert.equal(createInput.value, '写代码')
  assert.equal(createButton.disabled, false)
  await act(async () => {
    createButton.click()
  })
  const afterCreate = loadConfig(storage)
  assert.equal(afterCreate.groups.length, 2)
  assert.equal(afterCreate.groups[1].name, '写代码')

  // The new group is selected by the creation flow's re-render fallback only
  // after its id is chosen; click its member button to open the picker.
  const memberButtons = [...dom.window.document.querySelectorAll('button')].filter(
    (button) => button.textContent === '分组成员',
  )
  const secondMemberButton = memberButtons[1]
  assert.ok(secondMemberButton)
  await act(async () => {
    secondMemberButton.click()
  })
  const gptLabel = [...dom.window.document.querySelectorAll('label')].find((label) =>
    label.textContent.includes('GPT-4o'),
  )
  assert.ok(gptLabel)
  const gptCheckbox = gptLabel.querySelector('input[type="checkbox"]')
  await act(async () => {
    gptCheckbox.click()
  })
  const afterToggle = loadConfig(storage)
  const coding = afterToggle.groups.find((group) => group.name === '写代码')
  assert.ok(coding)
  assert.ok(coding.modelKeys.includes(makeModelKey('openai', 'gpt-4o')))

  await act(async () => {
    root.unmount()
  })
  dom.window.close()
})

test('the other settings page imports full data, changes the tab, and resets every field', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:64370/',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  dom.window.confirm = () => true
  let revision = 1
  let identity = { enabled: true, diagnostics: false, rules: [] }
  dom.window.fetch = async (path, init) => {
    assert.equal(path, '/api/dsh-toolbox.identity')
    if (init.method === 'POST') {
      const body = JSON.parse(init.body)
      assert.equal(body.expectedRevision, revision)
      identity = body.value
      revision += 1
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, writable: true, revision, value: identity, providers: [], stats: {} }) }
  }
  const storage = new FakeStorage()
  const config = createDefaultConfig()
  config.groups[0].name = '导入分组'
  const payload = {
    format: FULL_DATA_FORMAT,
    version: FULL_DATA_VERSION,
    exportedAt: new Date().toISOString(),
    local: {
      modelConfig: config,
      catalog: { version: 1, updatedAt: 2468, models: [] },
      workspace: { lastGroupedView: 'workspace-tree' },
      settings: { tab: 'identity' },
      features: { modelGroups: false, workspaceFlatToggle: true },
    },
    identity: { enabled: false, diagnostics: true, rules: [] },
  }
  const Panel = createSettingsPanel(React)
  const root = createRoot(dom.window.document.getElementById('root'))
  await act(async () => {
    root.render(React.createElement(Panel, { t: createTranslator('zh'), storage, window: dom.window }))
  })
  const tabs = [...dom.window.document.querySelectorAll('.dsh-toolbox-settings-tab')]
  const groupFeatureInput = dom.window.document.querySelector('[data-page="groups"] input[data-feature="modelGroups"]')
  assert.ok(groupFeatureInput)
  assert.equal(groupFeatureInput.checked, true)
  assert.equal(dom.window.document.querySelector('[data-page="groups"] input[data-feature="workspaceFlatToggle"]'), null)
  await act(async () => Simulate.change(groupFeatureInput, { target: { checked: false } }))
  assert.deepEqual(JSON.parse(storage.getItem(FEATURE_SETTINGS_KEY)), { modelGroups: false, workspaceFlatToggle: true })
  assert.doesNotMatch(dom.window.document.body.textContent, /功能开关已保存/u)
  assert.equal(dom.window.document.querySelectorAll('[data-page="groups"] .dsh-toolbox-card').length, 1)
  assert.equal(dom.window.document.querySelector('[data-page="groups"] input[data-feature="modelGroups"]')?.checked, false)

  await act(async () => Simulate.change(dom.window.document.querySelector('[data-page="groups"] input[data-feature="modelGroups"]'), { target: { checked: true } }))
  assert.deepEqual(JSON.parse(storage.getItem(FEATURE_SETTINGS_KEY)), { modelGroups: true, workspaceFlatToggle: true })
  assert.match(dom.window.document.querySelector('[data-page="groups"]').textContent, /模型目录|打开行为|自定义分组/u)

  await act(async () => tabs[2].click())
  const workspaceFeatureInput = dom.window.document.querySelector('[data-page="other"] input[data-feature="workspaceFlatToggle"]')
  assert.ok(workspaceFeatureInput)
  assert.equal(workspaceFeatureInput.checked, true)
  assert.equal(dom.window.document.querySelector('[data-page="other"] input[data-feature="modelGroups"]'), null)
  await act(async () => Simulate.change(workspaceFeatureInput, { target: { checked: false } }))
  assert.deepEqual(JSON.parse(storage.getItem(FEATURE_SETTINGS_KEY)), { modelGroups: true, workspaceFlatToggle: false })
  const textarea = dom.window.document.querySelector('[data-page="other"] textarea')
  await act(async () => Simulate.change(textarea, { target: { value: JSON.stringify(payload) } }))
  const importButton = [...dom.window.document.querySelectorAll('[data-page="other"] button')]
    .find((button) => button.textContent === '导入 JSON')
  await act(async () => importButton.click())
  assert.equal(loadConfig(storage).groups[0].name, '导入分组')
  assert.equal(loadCatalogResult(storage).updatedAt, 2468)
  assert.equal(storage.getItem(LAST_GROUPED_VIEW_KEY), 'workspace-tree')
  assert.equal(storage.getItem(SETTINGS_TAB_KEY), 'identity')
  assert.equal(dom.window.document.querySelector('.dsh-toolbox-settings').getAttribute('data-tab'), 'identity')
  assert.deepEqual(JSON.parse(storage.getItem(FEATURE_SETTINGS_KEY)), { modelGroups: false, workspaceFlatToggle: true })
  assert.equal(identity.enabled, false)
  await act(async () => tabs[2].click())
  const resetButton = [...dom.window.document.querySelectorAll('[data-page="other"] button')]
    .find((button) => button.textContent === '恢复默认')
  await act(async () => resetButton.click())
  assert.deepEqual(loadConfig(storage), createDefaultConfig())
  assert.deepEqual(JSON.parse(storage.getItem(CATALOG_KEY)), { version: 1, updatedAt: 0, models: [] })
  assert.equal(storage.getItem(LAST_GROUPED_VIEW_KEY), 'workspace')
  assert.equal(storage.getItem(SETTINGS_TAB_KEY), 'groups')
  assert.deepEqual(JSON.parse(storage.getItem(FEATURE_SETTINGS_KEY)), { modelGroups: true, workspaceFlatToggle: true })
  assert.deepEqual(identity, { enabled: true, diagnostics: false, rules: [] })
  await act(async () => root.unmount())
  dom.window.close()
})
