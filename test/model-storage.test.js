import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import {
  CATALOG_KEY,
  CONFIG_EVENT,
  MAX_IMPORT_BYTES,
  STORAGE_KEY,
  ConfigValidationError,
  createDefaultConfig,
  exportConfig,
  importConfig,
  loadCatalog,
  loadCatalogResult,
  loadConfig,
  loadConfigResult,
  migrateConfig,
  missingModelKeys,
  normalizeConfig,
  parseConfigText,
  resetConfig,
  saveCatalog,
  saveConfig,
  subscribeCatalog,
  subscribeConfig,
  validateConfig,
} from '../src/model-storage.js'
import { makeModelKey } from '../src/model-catalog.js'
import { FakeStorage, createModelDom } from './helpers.js'

function catalog() {
  const dom = createModelDom()
  return [...dom.window.document.querySelectorAll('button[role="menuitemradio"]')].map((button) => {
    const span = button.querySelector('[data-provider-id][data-model-id]')
    return {
      key: makeModelKey(span.getAttribute('data-provider-id'), span.getAttribute('data-model-id')),
      providerId: span.getAttribute('data-provider-id'),
      providerName: button.closest('section').querySelector('[data-menu-group-heading]').textContent,
      modelId: span.getAttribute('data-model-id'),
      name: button.getAttribute('title'),
    }
  })
}

test('fresh config is complete and independent on every call', () => {
  const first = createDefaultConfig()
  const second = createDefaultConfig()
  assert.equal(first.version, 1)
  assert.equal(first.mode, 'custom')
  assert.equal(first.groups.length, 1)
  assert.equal(first.showUngrouped, true)
  assert.equal(first.preserveProviderGroups, false)
  assert.equal(first.activityViewEnabled, false)
  first.groups[0].name = 'mutated'
  assert.notEqual(second.groups[0].name, 'mutated')
  assert.deepEqual(validateConfig(second), second)
})

test('save/load round-trips and returns defaults when storage is empty', () => {
  const storage = new FakeStorage()
  assert.deepEqual(loadConfig(storage), createDefaultConfig())
  const cfg = createDefaultConfig()
  cfg.groups[0].modelKeys = [makeModelKey('a', 'b')]
  const saved = saveConfig(storage, cfg)
  assert.deepEqual(loadConfig(storage), saved)
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).version, 1)
})

test('activity view opt-in survives save and rejects invalid values', () => {
  const storage = new FakeStorage()
  const config = createDefaultConfig()
  config.activityViewEnabled = true
  saveConfig(storage, config)
  assert.equal(loadConfig(storage).activityViewEnabled, true)
  assert.throws(
    () => normalizeConfig({ ...config, activityViewEnabled: 'true' }),
    (error) => error.code === 'invalid-type' && error.path === 'activityViewEnabled',
  )
})

test('version 0 groups[].models migrates to modelKeys', () => {
  const legacy = {
    version: 0,
    groups: [
      { id: 'old', name: 'Old', order: 0, models: ['p/m', 'p/m'] },
      { id: 'second', name: 'Second' },
    ],
  }
  const normalized = migrateConfig(legacy)
  assert.equal(normalized.version, 1)
  assert.deepEqual(normalized.groups[0].modelKeys, ['p/m'])
  assert.equal(normalized.groups[1].order, 1)
  assert.equal(normalized.showUngrouped, true)
  assert.equal(normalized.activityViewEnabled, false)
})

test('invalid JSON and unknown top-level/nested fields are rejected', () => {
  assert.throws(() => parseConfigText('{'), (error) => error instanceof ConfigValidationError && error.code === 'invalid-json')
  assert.throws(
    () => normalizeConfig({ version: 1, groups: [], extra: true }),
    (error) => error.code === 'unknown-field',
  )
  assert.throws(
    () =>
      normalizeConfig({
        version: 1,
        groups: [{ id: 'g', name: 'G', modelKeys: [], extra: true }],
      }),
    (error) => error.code === 'unknown-field',
  )
  assert.throws(
    () => normalizeConfig({ version: 2, groups: [] }),
    (error) => error.code === 'unsupported-version',
  )
})

test('duplicate ids, excessive groups, and reserved ids are rejected', () => {
  assert.throws(
    () =>
      normalizeConfig({
        version: 1,
        groups: [
          { id: 'g', name: 'A', modelKeys: [] },
          { id: 'g', name: 'B', modelKeys: [] },
        ],
      }),
    (error) => error.code === 'duplicate-group-id',
  )
  const groups = Array.from({ length: 65 }, (_, index) => ({
    id: `g${index}`,
    name: `G${index}`,
    modelKeys: [],
  }))
  assert.throws(() => normalizeConfig({ version: 1, groups }), (error) => error.code === 'too-many-groups')
  assert.throws(
    () => normalizeConfig({ version: 1, groups: [{ id: 'ungrouped', name: 'U', modelKeys: [] }] }),
    (error) => error.code === 'invalid-group-id',
  )
})

test('oversized imports are rejected before a write and old config survives', () => {
  const storage = new FakeStorage()
  const original = saveConfig(storage, createDefaultConfig())
  const oversized = ' '.repeat(MAX_IMPORT_BYTES + 1)
  assert.throws(() => importConfig(storage, oversized), (error) => error.code === 'too-large')
  assert.deepEqual(loadConfig(storage), original)

  const malformed = JSON.stringify({ version: 1, groups: [{ id: 'g', name: 'G', modelKeys: [] }], extra: 1 })
  assert.throws(() => importConfig(storage, malformed), (error) => error.code === 'unknown-field')
  assert.deepEqual(loadConfig(storage), original)
})

test('model keys are sanitized, deduplicated, and capped', () => {
  const normalized = normalizeConfig({
    version: 1,
    groups: [
      {
        id: 'g',
        name: 'G',
        modelKeys: ['openai::gpt-4o', 'openai/gpt-4o', '  ', 'p/m'],
      },
    ],
  })
  assert.deepEqual(normalized.groups[0].modelKeys, ['openai/gpt-4o', 'p/m'])
  assert.throws(
    () =>
      normalizeConfig({
        version: 1,
        groups: [{ id: 'g', name: 'G', modelKeys: Array.from({ length: 5001 }, (_, index) => `p/m${index}`) }],
      }),
    (error) => error.code === 'too-many-models',
  )
})

test('export/import round-trips and reset restores defaults', () => {
  const storage = new FakeStorage()
  const cfg = createDefaultConfig()
  cfg.mode = 'all'
  cfg.groups[0].modelKeys = [makeModelKey('p', 'm')]
  const text = exportConfig(cfg)
  assert.equal(JSON.parse(text).mode, 'all')
  const imported = importConfig(storage, text)
  assert.deepEqual(imported, cfg)
  const reset = resetConfig(storage)
  assert.deepEqual(reset, createDefaultConfig())
})

test('malformed stored config returns defaults with a diagnostic and keeps raw text', () => {
  const storage = new FakeStorage({ [STORAGE_KEY]: '{bad' })
  const result = loadConfigResult(storage)
  assert.deepEqual(result.config, createDefaultConfig())
  assert.equal(result.error?.code, 'invalid-json')
  assert.equal(result.raw, '{bad')
  assert.equal(storage.getItem(STORAGE_KEY), '{bad')
})

test('catalog cache round-trips, deduplicates, and tolerates corruption', () => {
  const storage = new FakeStorage()
  assert.deepEqual(loadCatalog(storage), [])
  const models = catalog()
  const payload = saveCatalog(storage, models)
  assert.equal(payload.version, 1)
  assert.equal(loadCatalog(storage).length, 5)
  assert.equal(loadCatalogResult(storage).models[0].key, makeModelKey('deepseek', 'deepseek-chat'))

  storage.setItem(CATALOG_KEY, '{broken')
  const broken = loadCatalogResult(storage)
  assert.deepEqual(broken.models, [])
  assert.ok(broken.error)
})

test('subscriptions notify same-window listeners and can be disposed', () => {
  const storage = new FakeStorage()
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const window = dom.window
  const received = []
  const off = subscribeConfig(window, (config) => received.push(config.mode))
  const cfg = createDefaultConfig()
  cfg.mode = 'provider'
  saveConfig(storage, cfg, window)
  assert.deepEqual(received, ['provider'])
  off()
  cfg.mode = 'all'
  saveConfig(storage, cfg, window)
  assert.deepEqual(received, ['provider'])

  const catalogs = []
  const offCatalog = subscribeCatalog(window, (models) => catalogs.push(models.length))
  saveCatalog(storage, catalog(), window)
  assert.deepEqual(catalogs, [5])
  offCatalog()
})

test('config events carry the normalized config', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  let detail = null
  dom.window.addEventListener(CONFIG_EVENT, (event) => {
    detail = event.detail
  })
  const storage = new FakeStorage()
  saveConfig(storage, createDefaultConfig(), dom.window)
  assert.equal(detail.config.version, 1)
})

test('missingModelKeys reports every stale group key', () => {
  const cfg = createDefaultConfig()
  cfg.groups[0].modelKeys = ['a/b', 'missing/key']
  const stale = missingModelKeys(cfg, [{ key: 'a/b' }])
  assert.deepEqual(stale, [{ groupId: 'favorites', groupName: '常用', key: 'missing/key' }])
})
