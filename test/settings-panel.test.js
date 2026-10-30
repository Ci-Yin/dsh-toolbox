import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createSettingsPanel } from '../src/settings-panel.js'
import { createDefaultConfig, saveCatalog, saveConfig } from '../src/model-storage.js'
import { createTranslator } from '../src/i18n.js'
import { makeModelKey } from '../src/model-catalog.js'
import { FakeStorage } from './helpers.js'

const t = createTranslator('zh')

function fixture(options = {}) {
  const storage = new FakeStorage()
  const config = createDefaultConfig()
  config.groups[0].name = '常用'
  config.groups[0].modelKeys = [makeModelKey('deepseek', 'deepseek-chat')]
  if (options.extraGroup) {
    config.groups.push({
      id: 'coding',
      name: '写代码',
      order: 1,
      collapsed: false,
      modelKeys: [makeModelKey('openai', 'gpt-4o')],
    })
  }
  if (options.stale) config.groups[0].modelKeys.push('gone/model')
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
  return storage
}

test('settings panel renders the group editor with the cached catalog', () => {
  const storage = fixture({ extraGroup: true })
  const Panel = createSettingsPanel(React)
  const html = renderToStaticMarkup(React.createElement(Panel, { t, storage }))
  assert.match(html, /模型分组/)
  assert.match(html, /自定义分组/)
  assert.match(html, /常用/)
  assert.match(html, /写代码/)
  assert.match(html, /DeepSeek Chat/)
  assert.match(html, /GPT-4o/)
  assert.match(html, /加入全部结果/)
  const groupsPage = html.slice(html.indexOf('data-page="groups"'), html.indexOf('data-page="identity"'))
  const otherPage = html.slice(html.indexOf('data-page="other"'))
  assert.doesNotMatch(groupsPage, /配置数据/)
  assert.match(otherPage, /配置数据/)
  assert.match(otherPage, /导入 JSON/)
})

test('settings panel tells the user how to populate an empty catalog', () => {
  const storage = new FakeStorage()
  const config = createDefaultConfig()
  config.groups = []
  saveConfig(storage, config)
  const Panel = createSettingsPanel(React)
  const html = renderToStaticMarkup(React.createElement(Panel, { t, storage }))
  assert.match(html, /打开一次模型选择器/)
  assert.match(html, /还没有分组/)
})

test('settings panel exposes stale keys and cleanup controls', () => {
  const storage = fixture({ stale: true })
  const Panel = createSettingsPanel(React)
  const html = renderToStaticMarkup(React.createElement(Panel, { t, storage }))
  assert.match(html, /已失效的模型 key/)
  assert.match(html, /gone\/model/)
  assert.match(html, /清理全部失效项/)
})
