import { test } from 'node:test'
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { createSettingsPanel } from '../src/settings-panel.js'
import { createDefaultConfig, loadConfig, saveCatalog, saveConfig } from '../src/model-storage.js'
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
