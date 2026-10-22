import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createToolbox } from '../src/features.js'
import { createDefaultConfig, loadConfig, saveConfig } from '../src/model-storage.js'
import { FakeStorage } from './helpers.js'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function fixture() {
  const storage = new FakeStorage()
  const events = new EventTarget()
  events.localStorage = storage
  events.CustomEvent = class extends Event {
    constructor(type, options) { super(type); this.detail = options.detail }
  }
  const registrations = []
  const uiWorkspace = { openSession() {}, startSession() {} }
  const ctx = {
    logger: { error(error) { throw error } },
    locale: { bind: () => (key) => key, register: () => () => {}, subscribe: () => () => {} },
    get(name) { return { uiWorkspace }[name] },
    slots: {
      inject(name, callback) {
        const unregister = callback()
        return () => unregister?.()
      },
      register(options, component) {
        const entry = { options, component, active: true }
        registrations.push(entry)
        return () => { entry.active = false }
      },
    },
    effects: [],
    effect(callback) { this.effects.push(callback()) },
  }
  return { ctx, events, storage, registrations, uiWorkspace }
}

test('sidebar button switches between native and activity while settings controls visibility', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
  const originalWindow = globalThis.window
  const originalDocument = globalThis.document
  const originalStorage = globalThis.localStorage
  const { ctx, storage, registrations, uiWorkspace } = fixture()
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.localStorage = storage
  const root = createRoot(dom.window.document.getElementById('root'))
  try {
    createToolbox({ React }).apply(ctx)
    assert.deepEqual(registrations.map(({ options }) => options.name), ['settings.plugins.tab'])
    saveConfig(storage, { ...createDefaultConfig(), activityViewEnabled: true }, dom.window)
    const toggle = registrations.at(-1)
    assert.equal(toggle.options.name, 'sidebar.footer.action')
    assert.equal(toggle.options.id, 'dsh-toolbox-activity-toggle')
    assert.equal(registrations.length, 2, 'native workspaces stay selected initially')
    await act(async () => root.render(React.createElement(toggle.component, { wide: true })))
    let button = dom.window.document.querySelector('.dsh-toolbox-activity-toggle')
    assert.equal(button.textContent.includes('activity.view.activity'), true)
    assert.equal(button.getAttribute('aria-pressed'), 'false')
    await act(async () => button.click())
    const activity = registrations.at(-1)
    assert.equal(activity.options.name, 'sidebar.workspaces')
    assert.equal(activity.options.priority, -10)
    assert.equal(activity.options.inject().uiWorkspace, uiWorkspace)
    button = dom.window.document.querySelector('.dsh-toolbox-activity-toggle')
    assert.equal(button.getAttribute('aria-pressed'), 'true')
    assert.equal(button.textContent.includes('activity.view.workspace'), true)
    saveConfig(storage, { ...createDefaultConfig(), mode: 'all', activityViewEnabled: true }, dom.window)
    assert.equal(registrations.length, 3, 'unrelated config changes do not remount the sidebar')
    await act(async () => activity.options.inject().restoreNativeSidebar())
    assert.equal(activity.active, false)
    assert.equal(loadConfig(storage).activityViewEnabled, true, 'restoring native view does not disable the feature')
    button = dom.window.document.querySelector('.dsh-toolbox-activity-toggle')
    assert.equal(button.getAttribute('aria-pressed'), 'false')
    await act(async () => button.click())
    const reopened = registrations.at(-1)
    assert.equal(reopened.options.name, 'sidebar.workspaces')
    assert.equal(reopened.active, true)
    await act(async () => saveConfig(storage, createDefaultConfig(), dom.window))
    assert.equal(reopened.active, false)
    assert.equal(toggle.active, false, 'settings switch removes the sidebar button')
    await act(async () => root.unmount())
    for (const dispose of ctx.effects.reverse()) dispose?.()
  } finally {
    dom.window.close()
    globalThis.window = originalWindow
    globalThis.document = originalDocument
    globalThis.localStorage = originalStorage
  }
})
