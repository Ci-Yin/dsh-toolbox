import { test } from 'node:test'
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { createSettingsPanel, SETTINGS_TAB_KEY } from '../src/settings-panel.js'
import { createDefaultConfig, saveConfig } from '../src/model-storage.js'
import { createTranslator } from '../src/i18n.js'
import { FakeStorage } from './helpers.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const t = createTranslator('zh')

function fixtureStorage() {
  const storage = new FakeStorage()
  saveConfig(storage, createDefaultConfig())
  return storage
}

function identitySnapshot() {
  return {
    ok: true,
    writable: true,
    revision: 1,
    value: { enabled: true, diagnostics: false, rules: [] },
    providers: [],
    stats: {},
  }
}

test('the settings page renders three sub-page tabs and page containers', () => {
  const Panel = createSettingsPanel(React)
  const html = renderToStaticMarkup(React.createElement(Panel, { t, storage: fixtureStorage() }))
  assert.match(html, /role="tablist"/u)
  assert.match(html, /data-tab="groups"/u)
  assert.match(html, /data-page="groups"/u)
  assert.match(html, /data-page="identity"/u)
  assert.match(html, /data-page="activity"/u)
  assert.match(html, /启用活动视图/u)
  assert.match(html, /aria-selected="true">模型分组/u)
  assert.match(html, /aria-selected="false">请求身份改写/u)
  assert.match(html, /data-tab="activity"/u)
  assert.match(html, /aria-selected="false">活动视图/u)
  // Groups content belongs to its own page, the identity card to the other.
  const groupsPage = html.slice(html.indexOf('data-page="groups"'), html.indexOf('data-page="identity"'))
  const identityPage = html.slice(html.indexOf('data-page="identity"'))
  assert.match(groupsPage, /自定义分组/u)
  assert.doesNotMatch(groupsPage, /身份规则/u)
  assert.match(identityPage, /身份规则/u)
  assert.doesNotMatch(identityPage, /自定义分组/u)
})

test('clicking the identity tab switches the page and remembers the choice', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:64370/',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  dom.window.fetch = async () => ({ ok: true, status: 200, json: async () => identitySnapshot() })
  const storage = fixtureStorage()
  const Panel = createSettingsPanel(React)
  const root = createRoot(dom.window.document.getElementById('root'))
  await act(async () => {
    root.render(React.createElement(Panel, { t, storage, window: dom.window }))
  })

  const container = dom.window.document.querySelector('.dsh-toolbox-settings')
  assert.equal(container.getAttribute('data-tab'), 'groups')
  const tabs = [...dom.window.document.querySelectorAll('.dsh-toolbox-settings-tab')]
  assert.deepEqual(
    tabs.map((tab) => tab.textContent),
    ['模型分组', '请求身份改写', '活动视图'],
  )
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true')

  await act(async () => {
    tabs[1].click()
  })
  assert.equal(container.getAttribute('data-tab'), 'identity')
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true')
  assert.equal(tabs[0].getAttribute('aria-selected'), 'false')
  assert.equal(storage.getItem(SETTINGS_TAB_KEY), 'identity')
  assert.match(dom.window.document.body.textContent, /身份规则/u)
  // The groups page stays mounted (CSS hides it) so its edits are not lost.
  assert.ok(dom.window.document.querySelector('[data-page="groups"]'))

  await act(async () => {
    root.unmount()
  })
  dom.window.close()

  // A fresh mount with the same storage opens on the remembered tab.
  const html = renderToStaticMarkup(React.createElement(Panel, { t, storage }))
  assert.match(html, /class="dsh-toolbox-settings" data-tab="identity"/u)
  assert.match(html, /aria-selected="true">请求身份改写/u)
})

test('an invalid stored tab falls back to the model-groups page', () => {
  const storage = fixtureStorage()
  storage.setItem(SETTINGS_TAB_KEY, 'nonsense')
  const html = renderToStaticMarkup(React.createElement(createSettingsPanel(React), { t, storage }))
  assert.match(html, /class="dsh-toolbox-settings" data-tab="groups"/u)
})
