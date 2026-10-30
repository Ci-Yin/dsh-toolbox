import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CATALOG_KEY,
  STORAGE_KEY,
  createDefaultConfig,
  saveCatalogPayload,
  saveConfig,
} from '../src/model-storage.js'
import { LAST_GROUPED_VIEW_KEY } from '../src/workspace-flat-toggle.js'
import { SETTINGS_TAB_KEY } from '../src/settings-preferences.js'
import { DEFAULT_FEATURE_SETTINGS, FEATURE_SETTINGS_KEY } from '../src/feature-settings.js'
import {
  FULL_DATA_FORMAT,
  FULL_DATA_VERSION,
  MAX_FULL_DATA_BYTES,
  ToolboxDataError,
  exportToolboxData,
  importToolboxData,
  parseFullDataText,
  parseToolboxDataText,
  resetToolboxData,
} from '../src/toolbox-data.js'
import { FakeStorage } from './helpers.js'

const MODEL = {
  key: 'deepseek/deepseek-chat',
  providerId: 'deepseek',
  providerName: 'DeepSeek',
  modelId: 'deepseek-chat',
  name: 'DeepSeek Chat',
}

const IDENTITY = {
  enabled: false,
  diagnostics: true,
  rules: [
    {
      id: 'agentrouter',
      enabled: true,
      urlPattern: 'agentrouter.org',
      userAgent: 'claude-cli/1.0.60',
      headers: [{ name: 'x-client', value: 'toolbox-test' }],
      note: 'test rule',
    },
  ],
}

const EMPTY_IDENTITY = { enabled: true, diagnostics: false, rules: [] }

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function makeIdentityApi({ value = EMPTY_IDENTITY, revision = 1, writable = true } = {}) {
  let current = clone(value)
  let currentRevision = revision
  const reads = []
  const saves = []
  return {
    reads,
    saves,
    state: () => ({ value: clone(current), revision: currentRevision }),
    async read() {
      reads.push({})
      return { ok: true, writable, value: clone(current), revision: currentRevision }
    },
    async save(next, expectedRevision) {
      saves.push({ value: clone(next), expectedRevision })
      if (expectedRevision !== currentRevision) {
        const error = new Error('settings conflict')
        error.code = 'settings-conflict'
        throw error
      }
      current = clone(next)
      currentRevision += 1
      return { ok: true, writable, value: clone(current), revision: currentRevision }
    },
  }
}

function makeEnvelope() {
  return {
    format: FULL_DATA_FORMAT,
    version: FULL_DATA_VERSION,
    exportedAt: '2026-10-29T10:00:00.000Z',
    local: {
      modelConfig: {
        ...createDefaultConfig(),
        mode: 'all',
        groups: [
          {
            ...createDefaultConfig().groups[0],
            modelKeys: [MODEL.key],
          },
        ],
      },
      catalog: { version: 1, updatedAt: 123, models: [clone(MODEL)] },
      workspace: { lastGroupedView: 'workspace-tree' },
      settings: { tab: 'identity' },
      features: { modelGroups: false, workspaceFlatToggle: true },
    },
    identity: clone(IDENTITY),
  }
}

function writeLocalSnapshot(storage, {
  modelConfig,
  catalog,
  workspace = 'workspace',
  tab = 'groups',
  features = DEFAULT_FEATURE_SETTINGS,
}) {
  saveConfig(storage, modelConfig)
  saveCatalogPayload(storage, catalog)
  storage.setItem(LAST_GROUPED_VIEW_KEY, workspace)
  storage.setItem(SETTINGS_TAB_KEY, tab)
  storage.setItem(FEATURE_SETTINGS_KEY, JSON.stringify(features))
}

function readLocalSnapshot(storage) {
  return {
    model: storage.getItem(STORAGE_KEY),
    catalog: storage.getItem(CATALOG_KEY),
    workspace: storage.getItem(LAST_GROUPED_VIEW_KEY),
    settings: storage.getItem(SETTINGS_TAB_KEY),
    features: storage.getItem(FEATURE_SETTINGS_KEY),
  }
}

class FailOnceStorage extends FakeStorage {
  constructor(initial, failKey) {
    super(initial)
    this.failKey = failKey
    this.failuresRemaining = 1
  }

  setItem(key, value) {
    if (key === this.failKey && this.failuresRemaining > 0) {
      this.failuresRemaining -= 1
      throw new Error('quota exceeded')
    }
    return super.setItem(key, value)
  }
}

test('full envelope export and import round-trip every owned value', async () => {
  const source = new FakeStorage()
  const sourceConfig = createDefaultConfig()
  sourceConfig.mode = 'all'
  sourceConfig.groups[0].modelKeys = [MODEL.key]
  writeLocalSnapshot(source, {
    modelConfig: sourceConfig,
    catalog: { version: 1, updatedAt: 123, models: [MODEL] },
    workspace: 'workspace-tree',
    tab: 'identity',
    features: { modelGroups: false, workspaceFlatToggle: true },
  })
  const sourceApi = makeIdentityApi({ value: IDENTITY, revision: 4 })

  const text = await exportToolboxData(source, {
    identityApi: sourceApi,
    exportedAt: '2026-10-29T10:00:00.000Z',
  })
  const parsed = parseToolboxDataText(text)
  assert.equal(parsed.kind, 'full')
  assert.deepEqual(parsed.data.local.modelConfig, sourceConfig)
  assert.deepEqual(parsed.data.local.catalog, { version: 1, updatedAt: 123, models: [MODEL] })
  assert.deepEqual(parsed.data.local.features, { modelGroups: false, workspaceFlatToggle: true })
  assert.deepEqual(parsed.data.identity, IDENTITY)

  const destination = new FakeStorage()
  const destinationApi = makeIdentityApi({ value: EMPTY_IDENTITY, revision: 8 })
  const imported = await importToolboxData(destination, text, { identityApi: destinationApi })
  assert.equal(imported.kind, 'full')
  assert.equal(imported.identityRevision, 9)
  assert.deepEqual(readLocalSnapshot(destination), readLocalSnapshot(source))
  assert.deepEqual(destinationApi.state().value, IDENTITY)

  const roundTrip = await exportToolboxData(destination, {
    identityApi: destinationApi,
    exportedAt: '2026-10-29T10:00:00.000Z',
  })
  assert.equal(roundTrip, text)
})

test('legacy model-only imports leave catalog, workspace, settings, and host identity untouched', async () => {
  const storage = new FakeStorage()
  const modelConfig = createDefaultConfig()
  modelConfig.mode = 'provider'
  writeLocalSnapshot(storage, {
    modelConfig,
    catalog: { version: 1, updatedAt: 77, models: [MODEL] },
    workspace: 'workspace-tree',
    tab: 'other',
  })
  const before = readLocalSnapshot(storage)
  const identityApi = makeIdentityApi({ value: IDENTITY, revision: 12 })
  const legacyConfig = { ...createDefaultConfig(), mode: 'all', groups: [] }

  const result = await importToolboxData(storage, JSON.stringify(legacyConfig), { identityApi })

  assert.equal(result.kind, 'legacy')
  assert.deepEqual(result.config, legacyConfig)
  assert.equal(storage.getItem(STORAGE_KEY), JSON.stringify(legacyConfig))
  assert.equal(storage.getItem(CATALOG_KEY), before.catalog)
  assert.equal(storage.getItem(LAST_GROUPED_VIEW_KEY), before.workspace)
  assert.equal(storage.getItem(SETTINGS_TAB_KEY), before.settings)
  assert.equal(storage.getItem(FEATURE_SETTINGS_KEY), before.features)
  assert.equal(identityApi.reads.length, 0)
  assert.equal(identityApi.saves.length, 0)
})

test('reset writes fresh local defaults and the default identity document', async () => {
  const storage = new FakeStorage()
  const changed = createDefaultConfig()
  changed.mode = 'all'
  writeLocalSnapshot(storage, {
    modelConfig: changed,
    catalog: { version: 1, updatedAt: 42, models: [MODEL] },
    workspace: 'workspace-tree',
    tab: 'identity',
  })
  const identityApi = makeIdentityApi({ value: IDENTITY, revision: 20 })

  const result = await resetToolboxData(storage, { identityApi })

  assert.equal(result.kind, 'full')
  assert.equal(result.identityRevision, 21)
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)), createDefaultConfig())
  assert.deepEqual(JSON.parse(storage.getItem(CATALOG_KEY)), { version: 1, updatedAt: 0, models: [] })
  assert.equal(storage.getItem(LAST_GROUPED_VIEW_KEY), 'workspace')
  assert.equal(storage.getItem(SETTINGS_TAB_KEY), 'groups')
  assert.deepEqual(JSON.parse(storage.getItem(FEATURE_SETTINGS_KEY)), DEFAULT_FEATURE_SETTINGS)
  assert.deepEqual(identityApi.state().value, EMPTY_IDENTITY)
})

test('full-data validation rejects unknown fields and invalid nested values before any write', async () => {
  const storage = new FakeStorage()
  const initial = readLocalSnapshot(storage)
  const identityApi = makeIdentityApi()

  const unknown = makeEnvelope()
  unknown.extra = true
  await assert.rejects(
    importToolboxData(storage, JSON.stringify(unknown), { identityApi }),
    (error) => error.code === 'unknown-field' && error.path === 'extra',
  )
  assert.deepEqual(readLocalSnapshot(storage), initial)
  assert.equal(identityApi.reads.length, 0)

  const invalidWorkspace = makeEnvelope()
  invalidWorkspace.local.workspace.lastGroupedView = 'flat'
  assert.throws(
    () => parseFullDataText(JSON.stringify(invalidWorkspace)),
    (error) => error.code === 'invalid-workspace-view' && error.path === 'local.workspace.lastGroupedView',
  )

  const invalidFeatures = makeEnvelope()
  invalidFeatures.local.features.workspaceFlatToggle = 'true'
  assert.throws(
    () => parseFullDataText(JSON.stringify(invalidFeatures)),
    (error) => error.code === 'invalid-type' && error.path === 'local.features.workspaceFlatToggle',
  )

  const unknownFeature = makeEnvelope()
  unknownFeature.local.features.extra = false
  assert.throws(
    () => parseFullDataText(JSON.stringify(unknownFeature)),
    (error) => error.code === 'unknown-field' && error.path === 'local.features.extra',
  )
})

test('full-data envelopes from before global switches default missing feature settings', () => {
  const legacyEnvelope = makeEnvelope()
  delete legacyEnvelope.local.features
  const parsed = parseFullDataText(JSON.stringify(legacyEnvelope))
  assert.deepEqual(parsed.local.features, DEFAULT_FEATURE_SETTINGS)
})

test('partial local write failure rolls back both local keys and the committed host identity', async () => {
  const original = new FakeStorage()
  const originalConfig = createDefaultConfig()
  originalConfig.mode = 'provider'
  writeLocalSnapshot(original, {
    modelConfig: originalConfig,
    catalog: { version: 1, updatedAt: 5, models: [MODEL] },
    workspace: 'workspace-tree',
    tab: 'other',
  })
  const storage = new FailOnceStorage(
    readLocalSnapshot(original),
    CATALOG_KEY,
  )
  const before = readLocalSnapshot(storage)
  const identityApi = makeIdentityApi({ value: IDENTITY, revision: 2 })

  await assert.rejects(
    importToolboxData(storage, JSON.stringify(makeEnvelope()), { identityApi }),
    (error) => error.message === 'quota exceeded' && error.rollbackError === undefined,
  )

  assert.deepEqual(readLocalSnapshot(storage), before)
  assert.equal(identityApi.saves.length, 2)
  assert.deepEqual(identityApi.state().value, IDENTITY)
})

test('ambiguous host save failure compensates a host write that became visible', async () => {
  const originalStorage = new FakeStorage()
  const originalConfig = createDefaultConfig()
  originalConfig.mode = 'provider'
  writeLocalSnapshot(originalStorage, {
    modelConfig: originalConfig,
    catalog: { version: 1, updatedAt: 5, models: [MODEL] },
    workspace: 'workspace-tree',
    tab: 'other',
  })
  const storage = new FakeStorage(readLocalSnapshot(originalStorage))
  const before = readLocalSnapshot(storage)
  const oldIdentity = { enabled: true, diagnostics: false, rules: [] }
  let current = clone(oldIdentity)
  let revision = 7
  let saveAttempts = 0
  const saves = []
  const identityApi = {
    async read() {
      return { ok: true, writable: true, value: clone(current), revision }
    },
    async save(value, expectedRevision) {
      saves.push({ value: clone(value), expectedRevision })
      assert.equal(expectedRevision, revision)
      current = clone(value)
      revision += 1
      if (saveAttempts++ === 0) throw new Error('connection lost after commit')
      return { ok: true, writable: true, value: clone(current), revision }
    },
  }

  await assert.rejects(
    importToolboxData(storage, JSON.stringify(makeEnvelope()), { identityApi }),
    (error) => error.message === 'connection lost after commit' && error.identityRollbackError === undefined,
  )

  assert.deepEqual(readLocalSnapshot(storage), before)
  assert.deepEqual(current, oldIdentity)
  assert.deepEqual(saves, [
    { value: IDENTITY, expectedRevision: 7 },
    { value: oldIdentity, expectedRevision: 8 },
  ])
})

test('corrupt local data cannot be exported and corrupt JSON is diagnosed', async () => {
  const storage = new FakeStorage({ [STORAGE_KEY]: '{broken' })
  const identityApi = makeIdentityApi()

  await assert.rejects(
    exportToolboxData(storage, { identityApi }),
    (error) => error instanceof ToolboxDataError && error.code === 'corrupt-local-data' && error.path === STORAGE_KEY,
  )
  assert.throws(() => parseFullDataText('{broken'), (error) => error.code === 'invalid-json')

  const validConfig = createDefaultConfig()
  saveConfig(storage, validConfig)
  storage.setItem(CATALOG_KEY, '{broken-catalog')
  await assert.rejects(
    exportToolboxData(storage, { identityApi }),
    (error) => error.code === 'corrupt-local-data' && error.path === CATALOG_KEY,
  )
})

test('malformed identity reads fail closed before importing local values', async () => {
  const storage = new FakeStorage()
  const before = readLocalSnapshot(storage)
  const malformedSnapshots = [
    { ok: true, writable: true, value: EMPTY_IDENTITY, revision: '1' },
    { ok: true, writable: true, value: { enabled: true, diagnostics: false, rules: 'not-an-array' }, revision: 1 },
  ]

  for (const snapshot of malformedSnapshots) {
    const identityApi = { read: async () => snapshot, save: async () => { throw new Error('must not save') } }
    await assert.rejects(
      importToolboxData(storage, JSON.stringify(makeEnvelope()), { identityApi }),
      (error) => ['invalid-host-snapshot', 'invalid-type', 'invalid-identity'].includes(error.code),
    )
    assert.deepEqual(readLocalSnapshot(storage), before)
  }
})

test('a missing or read-only host route fails without changing local data', async () => {
  const storage = new FakeStorage()
  const before = readLocalSnapshot(storage)
  const unavailable = { async read() { throw new Error('route-missing') }, async save() { throw new Error('unexpected save') } }
  await assert.rejects(importToolboxData(storage, JSON.stringify(makeEnvelope()), { identityApi: unavailable }), /route-missing/u)
  await assert.rejects(resetToolboxData(storage, { identityApi: unavailable }), /route-missing/u)
  await assert.rejects(exportToolboxData(storage, { identityApi: unavailable }), /route-missing/u)
  assert.deepEqual(readLocalSnapshot(storage), before)
  const readOnly = makeIdentityApi({ writable: false })
  await assert.rejects(importToolboxData(storage, JSON.stringify(makeEnvelope()), { identityApi: readOnly }),
    (error) => error.code === 'identity-read-only')
  assert.deepEqual(readLocalSnapshot(storage), before)
})

test('catalog validation is strict about shape, keys, timestamps, and duplicates', () => {
  const unknownField = makeEnvelope()
  unknownField.local.catalog.extra = true
  assert.throws(() => parseFullDataText(JSON.stringify(unknownField)), (error) => error.code === 'unknown-field')

  const duplicate = makeEnvelope()
  duplicate.local.catalog.models.push({ ...MODEL })
  assert.throws(() => parseFullDataText(JSON.stringify(duplicate)), (error) => error.code === 'invalid-catalog')

  const nonCanonicalKey = makeEnvelope()
  nonCanonicalKey.local.catalog.models[0].key = 'deepseek::deepseek-chat'
  assert.throws(() => parseFullDataText(JSON.stringify(nonCanonicalKey)), (error) => error.code === 'invalid-catalog')

  const invalidTimestamp = makeEnvelope()
  invalidTimestamp.local.catalog.updatedAt = -1
  assert.throws(() => parseFullDataText(JSON.stringify(invalidTimestamp)), (error) => error.code === 'invalid-catalog')
})

test('the full-data size limit accepts exactly the boundary and rejects one byte over', () => {
  const serialized = JSON.stringify(makeEnvelope())
  const padding = ' '.repeat(MAX_FULL_DATA_BYTES - Buffer.byteLength(serialized))
  const exact = `${serialized}${padding}`
  assert.equal(Buffer.byteLength(exact), MAX_FULL_DATA_BYTES)
  assert.equal(parseFullDataText(exact).format, FULL_DATA_FORMAT)

  const over = `${exact} `
  assert.equal(Buffer.byteLength(over), MAX_FULL_DATA_BYTES + 1)
  assert.throws(() => parseFullDataText(over), (error) => error.code === 'too-large')
})
