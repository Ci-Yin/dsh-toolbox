import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import {
  DEFAULT_FEATURE_SETTINGS,
  FEATURE_SETTINGS_EVENT,
  FEATURE_SETTINGS_KEY,
  FEATURE_SETTINGS_KEYS,
  FeatureSettingsError,
  loadFeatureSettingsResult,
  normalizeFeatureSettings,
  notifyFeatureSettings,
  readFeatureSettings,
  subscribeFeatureSettings,
  writeFeatureSettings,
} from '../src/feature-settings.js'
import { FakeStorage } from './helpers.js'

const ENABLED = { modelGroups: true, workspaceFlatToggle: true }
const DISABLED = { modelGroups: false, workspaceFlatToggle: false }

function createWindow() {
  return new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' }).window
}

test('feature settings expose stable keys and fresh-install defaults', () => {
  assert.deepEqual(FEATURE_SETTINGS_KEYS, ['modelGroups', 'workspaceFlatToggle'])
  assert.deepEqual(DEFAULT_FEATURE_SETTINGS, ENABLED)

  const storage = new FakeStorage()
  const first = readFeatureSettings(storage)
  const second = readFeatureSettings(storage)
  assert.deepEqual(first, ENABLED)
  assert.deepEqual(second, ENABLED)
  assert.notEqual(first, second)
  first.modelGroups = false
  assert.deepEqual(readFeatureSettings(storage), ENABLED)
})

test('strict normalization accepts exactly the two boolean switches', () => {
  assert.deepEqual(normalizeFeatureSettings(DISABLED, { strict: true }), DISABLED)
  assert.deepEqual(normalizeFeatureSettings({ ...DISABLED }, { strict: true }), DISABLED)

  assert.throws(
    () => normalizeFeatureSettings({ ...DISABLED, extra: true }, { strict: true }),
    (error) => error instanceof FeatureSettingsError && error.code === 'unknown-field' && error.path === 'extra',
  )
  assert.throws(
    () => normalizeFeatureSettings({ modelGroups: false }, { strict: true }),
    (error) => error instanceof FeatureSettingsError && error.code === 'invalid-type' && error.path === 'workspaceFlatToggle',
  )
  assert.throws(
    () => normalizeFeatureSettings({ ...DISABLED, modelGroups: 0 }, { strict: true }),
    (error) => error instanceof FeatureSettingsError && error.code === 'invalid-type' && error.path === 'modelGroups',
  )
  for (const value of [null, [], 'true', 1]) {
    assert.throws(
      () => normalizeFeatureSettings(value, { strict: true }),
      (error) => error instanceof FeatureSettingsError && error.code === 'invalid-type',
    )
  }
})

test('non-strict reads fail open while strict validation remains lossless', () => {
  assert.deepEqual(normalizeFeatureSettings({ ...DISABLED, unknown: false }), ENABLED)
  assert.deepEqual(normalizeFeatureSettings({ modelGroups: false }), ENABLED)
  assert.deepEqual(normalizeFeatureSettings('{"modelGroups":false}'), ENABLED)

  const malformed = new FakeStorage({ [FEATURE_SETTINGS_KEY]: '{broken' })
  const malformedResult = loadFeatureSettingsResult(malformed)
  assert.deepEqual(malformedResult.settings, ENABLED)
  assert.equal(malformedResult.error?.name, 'SyntaxError')

  const invalid = new FakeStorage({ [FEATURE_SETTINGS_KEY]: JSON.stringify({ ...DISABLED, extra: true }) })
  const invalidResult = loadFeatureSettingsResult(invalid)
  assert.deepEqual(invalidResult.settings, ENABLED)
  assert.equal(invalidResult.error, null)
  const strictResult = loadFeatureSettingsResult(invalid, { strict: true })
  assert.deepEqual(strictResult.settings, ENABLED)
  assert.equal(strictResult.error?.code, 'unknown-field')
})

test('writes canonical JSON and reads persisted switches without sharing state', () => {
  const storage = new FakeStorage()
  const saved = writeFeatureSettings(storage, DISABLED)
  assert.deepEqual(saved, DISABLED)
  assert.equal(storage.getItem(FEATURE_SETTINGS_KEY), JSON.stringify(DISABLED))
  assert.deepEqual(readFeatureSettings(storage), DISABLED)
  saved.modelGroups = true
  assert.deepEqual(readFeatureSettings(storage), DISABLED)

  assert.throws(
    () => writeFeatureSettings(storage, { ...DISABLED, extra: true }),
    (error) => error instanceof FeatureSettingsError && error.code === 'unknown-field',
  )
  assert.throws(
    () => writeFeatureSettings(null, DISABLED),
    (error) => error instanceof FeatureSettingsError && error.code === 'storage-unavailable',
  )
})

test('write dispatches the same-window custom event only after persistence', () => {
  const window = createWindow()
  const storage = new FakeStorage()
  const events = []
  window.addEventListener(FEATURE_SETTINGS_EVENT, (event) => {
    events.push({ type: event.type, detail: event.detail })
  })

  writeFeatureSettings(storage, DISABLED, window)
  assert.deepEqual(events, [{
    type: FEATURE_SETTINGS_EVENT,
    detail: { settings: DISABLED },
  }])
  assert.deepEqual(readFeatureSettings(storage), DISABLED)
})

test('notify normalizes event detail and tolerates non-browser targets', () => {
  const window = createWindow()
  let received = null
  window.addEventListener(FEATURE_SETTINGS_EVENT, (event) => { received = event.detail })

  notifyFeatureSettings(window, { ...DISABLED, extra: true })
  assert.deepEqual(received, { settings: ENABLED })

  assert.doesNotThrow(() => notifyFeatureSettings({ dispatchEvent() {} }, DISABLED))
  assert.doesNotThrow(() => notifyFeatureSettings(null, DISABLED))
})

test('subscription observes relevant storage and same-window custom events, then disposes', () => {
  const window = createWindow()
  const target = window
  for (const method of ['getItem', 'setItem', 'removeItem']) {
    target[method] = window.localStorage[method].bind(window.localStorage)
  }
  target.setItem(FEATURE_SETTINGS_KEY, JSON.stringify(ENABLED))
  const received = []
  const off = subscribeFeatureSettings(target, (settings) => received.push(settings))

  target.setItem(FEATURE_SETTINGS_KEY, JSON.stringify(DISABLED))
  target.dispatchEvent(new window.StorageEvent('storage', { key: FEATURE_SETTINGS_KEY }))
  assert.deepEqual(received, [DISABLED])

  window.dispatchEvent(new window.StorageEvent('storage', { key: 'unrelated-key' }))
  assert.equal(received.length, 1)

  window.dispatchEvent(new window.StorageEvent('storage', { key: null }))
  assert.deepEqual(received, [DISABLED, DISABLED])

  window.dispatchEvent(new window.CustomEvent(FEATURE_SETTINGS_EVENT, {
    detail: { settings: ENABLED },
  }))
  assert.deepEqual(received, [DISABLED, DISABLED, ENABLED])

  window.dispatchEvent(new window.CustomEvent(FEATURE_SETTINGS_EVENT))
  assert.deepEqual(received, [DISABLED, DISABLED, ENABLED, DISABLED])

  off()
  window.localStorage.setItem(FEATURE_SETTINGS_KEY, JSON.stringify(ENABLED))
  window.dispatchEvent(new window.StorageEvent('storage', { key: FEATURE_SETTINGS_KEY }))
  window.dispatchEvent(new window.CustomEvent(FEATURE_SETTINGS_EVENT, { detail: { settings: ENABLED } }))
  assert.equal(received.length, 4)
})

test('subscription has a harmless no-op compatibility path for invalid targets', () => {
  let calls = 0
  const off = subscribeFeatureSettings(null, () => { calls += 1 })
  assert.equal(typeof off, 'function')
  assert.doesNotThrow(off)
  assert.equal(calls, 0)

  const target = { addEventListener() {}, removeEventListener() {} }
  assert.doesNotThrow(() => subscribeFeatureSettings(target, null))
})
