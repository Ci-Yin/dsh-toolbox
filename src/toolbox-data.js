/**
 * Full export/import of data owned by DSH Toolbox.
 *
 * The envelope deliberately contains only plugin-owned persistence. Runtime
 * identity hit statistics and host/provider credentials are not persisted here.
 */

import {
  CATALOG_KEY,
  CONFIG_EVENT,
  STORAGE_KEY,
  CATALOG_EVENT,
  MAX_IMPORT_BYTES,
  createDefaultConfig,
  loadCatalogResult,
  loadConfigResult,
  normalizeCatalogPayload,
  normalizeConfig,
  notifyCatalogChanged,
  notifyConfigChanged,
} from './model-storage.js'
import { sanitizeIdentityConfig } from './identity-core.js'
import { createIdentityApi } from './identity-client.js'
import { LAST_GROUPED_VIEW_KEY, GROUPED_VIEW_MODES, normalizeGroupBy } from './workspace-flat-toggle.js'
import { normalizeSettingsTab, SETTINGS_TAB_KEY } from './settings-preferences.js'
import {
  DEFAULT_FEATURE_SETTINGS,
  FEATURE_SETTINGS_KEY,
  loadFeatureSettingsResult,
  normalizeFeatureSettings,
  notifyFeatureSettings,
} from './feature-settings.js'

export const FULL_DATA_FORMAT = 'dsh-toolbox-data'
export const FULL_DATA_VERSION = 1
export const MAX_FULL_DATA_BYTES = 8 * 1024 * 1024

const FULL_KEYS = new Set(['format', 'version', 'exportedAt', 'local', 'identity'])
const LOCAL_KEYS = new Set(['modelConfig', 'catalog', 'workspace', 'settings', 'features'])
const WORKSPACE_KEYS = new Set(['lastGroupedView'])
const SETTINGS_KEYS = new Set(['tab'])
const IDENTITY_KEYS = new Set(['enabled', 'diagnostics', 'rules'])
const RULE_KEYS = new Set(['id', 'enabled', 'urlPattern', 'userAgent', 'headers', 'note'])
const HEADER_KEYS = new Set(['name', 'value'])

export class ToolboxDataError extends Error {
  constructor(code, message, path = '') {
    super(message)
    this.name = 'ToolboxDataError'
    this.code = code
    this.path = path
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rejectUnknownKeys(value, allowed, path) {
  if (!isPlainObject(value)) throw new ToolboxDataError('invalid-type', 'Expected a JSON object', path)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ToolboxDataError('unknown-field', `Unknown field: ${key}`, path ? `${path}.${key}` : key)
  }
}

function byteLength(text) {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).byteLength
  return unescape(encodeURIComponent(text)).length
}

function parseJsonText(text) {
  if (typeof text !== 'string') throw new ToolboxDataError('invalid-type', 'Import must be a JSON string')
  if (byteLength(text) > MAX_FULL_DATA_BYTES) {
    throw new ToolboxDataError('too-large', `Import is larger than ${Math.round(MAX_FULL_DATA_BYTES / 1024)} KiB`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new ToolboxDataError('invalid-json', `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function normalizeIdentityPayload(raw) {
  rejectUnknownKeys(raw, IDENTITY_KEYS, 'identity')
  if (typeof raw.enabled !== 'boolean' || typeof raw.diagnostics !== 'boolean' || !Array.isArray(raw.rules)) {
    throw new ToolboxDataError('invalid-type', 'Expected enabled, diagnostics and rules', 'identity')
  }
  const rules = raw.rules
  for (const [index, rule] of rules.entries()) {
    const path = `identity.rules[${index}]`
    rejectUnknownKeys(rule, RULE_KEYS, path)
    if (typeof rule.id !== 'string' || typeof rule.enabled !== 'boolean' || typeof rule.urlPattern !== 'string' ||
        typeof rule.userAgent !== 'string' || typeof rule.note !== 'string') {
      throw new ToolboxDataError('invalid-type', 'Expected typed identity rule fields', path)
    }
    if (!Array.isArray(rule.headers)) throw new ToolboxDataError('invalid-type', 'Expected an array of headers', `${path}.headers`)
    for (const [headerIndex, header] of rule.headers.entries()) {
      const headerPath = `${path}.headers[${headerIndex}]`
      rejectUnknownKeys(header, HEADER_KEYS, headerPath)
      if (typeof header.name !== 'string' || typeof header.value !== 'string') {
        throw new ToolboxDataError('invalid-type', 'Expected a string header name and value', headerPath)
      }
    }
  }
  const sanitized = sanitizeIdentityConfig(raw)
  const lossy = rules.some((rule, index) => {
    const saved = sanitized.value.rules[index]
    return !saved || rule.id.trim() !== saved.id ||
      rule.userAgent.trim() !== saved.userAgent ||
      rule.note.trim() !== saved.note ||
      rule.urlPattern.trim() !== saved.urlPattern ||
      rule.headers.length !== saved.headers.length ||
      rule.headers.some((header, headerIndex) =>
        header.name.trim().toLowerCase() !== saved.headers[headerIndex]?.name ||
        header.value !== saved.headers[headerIndex]?.value)
  })
  if (sanitized.errors.length > 0 || sanitized.droppedHeaders.length > 0 || lossy) {
    const error = new ToolboxDataError('invalid-identity', 'Identity configuration is invalid or would lose header values', 'identity')
    error.details = sanitized.errors
    throw error
  }
  return sanitized.value
}

function normalizeWorkspace(raw) {
  rejectUnknownKeys(raw, WORKSPACE_KEYS, 'local.workspace')
  const mode = normalizeGroupBy(raw.lastGroupedView)
  if (typeof raw.lastGroupedView !== 'string' || !GROUPED_VIEW_MODES.includes(mode)) {
    throw new ToolboxDataError('invalid-workspace-view', 'The last grouped workspace view is invalid', 'local.workspace.lastGroupedView')
  }
  return { lastGroupedView: mode }
}

function normalizeSettings(raw) {
  rejectUnknownKeys(raw, SETTINGS_KEYS, 'local.settings')
  const tab = normalizeSettingsTab(raw.tab)
  if (typeof raw.tab !== 'string' || tab === null) {
    throw new ToolboxDataError('invalid-settings-tab', 'The settings tab is invalid', 'local.settings.tab')
  }
  return { tab }
}

function normalizeFeatures(raw, allowMissing = false) {
  if (raw === undefined && allowMissing) return { ...DEFAULT_FEATURE_SETTINGS }
  try {
    return normalizeFeatureSettings(raw, { strict: true })
  } catch (error) {
    throw new ToolboxDataError(
      error.code ?? 'invalid-feature-settings',
      error.message ?? 'The feature settings are invalid',
      error.path ? `local.features.${error.path}` : 'local.features',
    )
  }
}

/** Normalize and validate a complete export envelope. */
export function normalizeFullData(raw) {
  rejectUnknownKeys(raw, FULL_KEYS, '')
  if (raw.format !== FULL_DATA_FORMAT) throw new ToolboxDataError('invalid-format', 'This is not a DSH Toolbox data file', 'format')
  if (raw.version !== FULL_DATA_VERSION) throw new ToolboxDataError('unsupported-version', 'Unsupported DSH Toolbox data version', 'version')
  if (typeof raw.exportedAt !== 'string' || Number.isNaN(Date.parse(raw.exportedAt))) {
    throw new ToolboxDataError('invalid-export-time', 'The export timestamp is invalid', 'exportedAt')
  }
  rejectUnknownKeys(raw.local, LOCAL_KEYS, 'local')
  const local = {
    modelConfig: normalizeConfig(raw.local.modelConfig),
    catalog: normalizeCatalogPayload(raw.local.catalog),
    workspace: normalizeWorkspace(raw.local.workspace),
    settings: normalizeSettings(raw.local.settings),
    features: normalizeFeatures(raw.local.features, true),
  }
  return {
    format: FULL_DATA_FORMAT,
    version: FULL_DATA_VERSION,
    exportedAt: raw.exportedAt,
    local,
    identity: normalizeIdentityPayload(raw.identity),
  }
}

/** Parse a full envelope only. */
export function parseFullDataText(text) {
  return normalizeFullData(parseJsonText(text))
}

/** Parse either the new full envelope or the legacy model-only JSON. */
export function parseToolboxDataText(text) {
  const raw = parseJsonText(text)
  if (isPlainObject(raw) && raw.format === FULL_DATA_FORMAT) {
    return { kind: 'full', data: normalizeFullData(raw) }
  }
  // Keep the old model export size limit and never touch unrelated data.
  if (byteLength(text) > MAX_IMPORT_BYTES) {
    throw new ToolboxDataError('too-large', 'Legacy model configuration exceeds its import size limit')
  }
  return { kind: 'legacy', config: normalizeConfig(raw) }
}

function requireStorage(storage) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function' || typeof storage.removeItem !== 'function') {
    throw new ToolboxDataError('storage-unavailable', 'Local storage is unavailable')
  }
  return storage
}

function readRaw(storage, key) {
  try {
    return storage.getItem(key)
  } catch (error) {
    throw new ToolboxDataError('storage-read-failed', `Could not read local storage: ${error?.message ?? String(error)}`, key)
  }
}

function writeRaw(storage, key, value) {
  if (value === null || value === undefined) {
    storage.removeItem(key)
    return
  }
  storage.setItem(key, value)
}

function captureLocal(storage) {
  return new Map([STORAGE_KEY, CATALOG_KEY, LAST_GROUPED_VIEW_KEY, SETTINGS_TAB_KEY, FEATURE_SETTINGS_KEY].map((key) => [key, readRaw(storage, key)]))
}

function localPayload(storage, settingsTab = null) {
  const config = loadConfigResult(storage)
  const catalog = loadCatalogResult(storage)
  if (config.error) throw new ToolboxDataError('corrupt-local-data', `Stored model configuration is invalid: ${config.error.message}`, STORAGE_KEY)
  if (catalog.error) throw new ToolboxDataError('corrupt-local-data', `Stored model catalog is invalid: ${catalog.error.message}`, CATALOG_KEY)
  let catalogPayload = { version: 1, updatedAt: 0, models: [] }
  const catalogRaw = readRaw(storage, CATALOG_KEY)
  if (catalogRaw !== null && catalogRaw !== '') {
    try {
      catalogPayload = normalizeCatalogPayload(JSON.parse(catalogRaw))
    } catch (error) {
      throw new ToolboxDataError('corrupt-local-data', `Stored model catalog cannot be exported losslessly: ${error.message}`, CATALOG_KEY)
    }
  }
  const savedView = readRaw(storage, LAST_GROUPED_VIEW_KEY)
  const savedTab = readRaw(storage, SETTINGS_TAB_KEY)
  const featureResult = loadFeatureSettingsResult(storage, { strict: true })
  if (savedView !== null && !GROUPED_VIEW_MODES.includes(savedView)) {
    throw new ToolboxDataError('corrupt-local-data', 'Stored workspace view is invalid', LAST_GROUPED_VIEW_KEY)
  }
  if (savedTab !== null && normalizeSettingsTab(savedTab) === null) {
    throw new ToolboxDataError('corrupt-local-data', 'Stored settings tab is invalid', SETTINGS_TAB_KEY)
  }
  if (featureResult.error) {
    throw new ToolboxDataError(
      'corrupt-local-data',
      `Stored feature settings are invalid: ${featureResult.error.message}`,
      FEATURE_SETTINGS_KEY,
    )
  }
  return {
    modelConfig: config.config,
    catalog: catalogPayload,
    workspace: { lastGroupedView: savedView ?? 'workspace' },
    settings: { tab: normalizeSettingsTab(settingsTab) ?? savedTab ?? 'groups' },
    features: featureResult.settings,
  }
}

function makeData(local, identity, exportedAt = new Date().toISOString()) {
  return normalizeFullData({
    format: FULL_DATA_FORMAT,
    version: FULL_DATA_VERSION,
    exportedAt,
    local,
    identity,
  })
}

function checkedIdentitySnapshot(snapshot, requireWritable = false) {
  if (snapshot?.ok !== true || !isPlainObject(snapshot.value) ||
      !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
    throw new ToolboxDataError('invalid-host-snapshot', 'The host identity response is incomplete')
  }
  if (requireWritable && snapshot.writable === false) {
    throw new ToolboxDataError('identity-read-only', 'The host identity settings are read-only')
  }
  return { value: normalizeIdentityPayload(snapshot.value), revision: snapshot.revision }
}

/** Build the complete data object, including the current host identity value. */
export async function buildFullData(storage, options = {}) {
  const target = options.window ?? options.target ?? globalThis
  const identityApi = options.identityApi ?? createIdentityApi(target)
  const checkedStorage = requireStorage(storage)
  const current = checkedIdentitySnapshot(await identityApi.read())
  return makeData(localPayload(checkedStorage, options.settingsTab), current.value, options.exportedAt)
}

/** Serialize the complete data object for copy/download. */
export async function exportToolboxData(storage, options = {}) {
  const text = `${JSON.stringify(await buildFullData(storage, options), null, 2)}\n`
  if (byteLength(text) > MAX_FULL_DATA_BYTES) {
    throw new ToolboxDataError('too-large', 'The complete data export exceeds the import size limit')
  }
  return text
}

function localStoragePayload(data) {
  return {
    [STORAGE_KEY]: JSON.stringify(data.local.modelConfig),
    [CATALOG_KEY]: JSON.stringify(data.local.catalog),
    [LAST_GROUPED_VIEW_KEY]: data.local.workspace.lastGroupedView,
    [SETTINGS_TAB_KEY]: data.local.settings.tab,
    [FEATURE_SETTINGS_KEY]: JSON.stringify(data.local.features),
  }
}

function notifyLocal(target, data) {
  if (!target) return
  notifyConfigChanged(target, data.local.modelConfig)
  notifyCatalogChanged(target, data.local.catalog.models)
  notifyFeatureSettings(target, data.local.features)
}

async function applyFullData(storage, data, options = {}) {
  const target = options.window ?? options.target ?? null
  const identityApi = options.identityApi ?? createIdentityApi(target ?? globalThis)
  const checkedStorage = requireStorage(storage)
  const currentIdentity = checkedIdentitySnapshot(await identityApi.read(), true)
  const values = localStoragePayload(data)
  let previous = null
  let hostSaveAttempted = false
  let identityRevision = currentIdentity.revision
  try {
    // Commit the host first: local readers cannot observe four new keys while
    // a potentially slow HTTP save is still in progress.
    hostSaveAttempted = true
    const savedIdentity = checkedIdentitySnapshot(await identityApi.save(data.identity, currentIdentity.revision))
    if (savedIdentity.revision <= currentIdentity.revision ||
        JSON.stringify(savedIdentity.value) !== JSON.stringify(data.identity)) {
      throw new ToolboxDataError('invalid-host-snapshot', 'The host did not confirm the imported identity value')
    }
    identityRevision = savedIdentity.revision
    // Snapshot immediately before the synchronous local commit. An edit made
    // during the host request is not an old value to roll back over.
    previous = captureLocal(checkedStorage)
    for (const [key, value] of Object.entries(values)) checkedStorage.setItem(key, value)
  } catch (error) {
    const rollbackErrors = []
    for (const [key, value] of [...(previous ?? [])].reverse()) {
      try {
        const live = readRaw(checkedStorage, key)
        if (live !== values[key] && live !== value) {
          throw new ToolboxDataError('local-rollback-conflict', 'Local data changed during import; manual recovery may be required', key)
        }
        if (live !== value) writeRaw(checkedStorage, key, value)
        if (readRaw(checkedStorage, key) !== value) {
          throw new ToolboxDataError('local-rollback-failed', 'Local rollback could not be verified', key)
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (rollbackErrors.length > 0) error.rollbackError = new AggregateError(rollbackErrors, 'Local data rollback was incomplete')
    if (hostSaveAttempted) {
      try {
        const latest = checkedIdentitySnapshot(await identityApi.read())
        if (latest.revision !== currentIdentity.revision &&
            JSON.stringify(latest.value) === JSON.stringify(data.identity)) {
          const restored = checkedIdentitySnapshot(await identityApi.save(currentIdentity.value, latest.revision))
          if (restored.revision <= latest.revision ||
              JSON.stringify(restored.value) !== JSON.stringify(currentIdentity.value)) {
            throw new ToolboxDataError('identity-rollback-failed', 'Host identity rollback could not be verified')
          }
        } else if (latest.revision !== currentIdentity.revision ||
                   JSON.stringify(latest.value) !== JSON.stringify(currentIdentity.value)) {
          throw new ToolboxDataError('identity-rollback-conflict', 'Host identity changed during import; manual recovery may be required')
        }
      } catch (rollbackError) {
        error.identityRollbackError = rollbackError
      }
    }
    throw error
  }
  notifyLocal(target, data)
  return { data, identityRevision }
}

/** Apply either a complete envelope or a legacy model-only configuration. */
export async function importToolboxData(storage, text, options = {}) {
  const parsed = parseToolboxDataText(text)
  if (parsed.kind === 'legacy') {
    const checkedStorage = requireStorage(storage)
    const previous = readRaw(checkedStorage, STORAGE_KEY)
    try {
      checkedStorage.setItem(STORAGE_KEY, JSON.stringify(parsed.config))
    } catch (error) {
      try {
        writeRaw(checkedStorage, STORAGE_KEY, previous)
      } catch (rollbackError) {
        error.rollbackError = rollbackError
      }
      throw error
    }
    notifyConfigChanged(options.window ?? options.target ?? null, parsed.config)
    return { kind: 'legacy', config: parsed.config }
  }
  return { kind: 'full', ...(await applyFullData(storage, parsed.data, options)) }
}

/** Restore every plugin-owned persistent value to a fresh-install default. */
export async function resetToolboxData(storage, options = {}) {
  const data = makeData(
    {
      modelConfig: createDefaultConfig(),
      catalog: { version: 1, updatedAt: 0, models: [] },
      workspace: { lastGroupedView: 'workspace' },
      settings: { tab: 'groups' },
      features: { ...DEFAULT_FEATURE_SETTINGS },
    },
    { enabled: true, diagnostics: false, rules: [] },
  )
  return { kind: 'full', ...(await applyFullData(storage, data, options)) }
}

/** Expose the local key names for tests and diagnostics without exposing values. */
export const TOOLBOX_DATA_KEYS = Object.freeze({
  STORAGE_KEY,
  CATALOG_KEY,
  LAST_GROUPED_VIEW_KEY,
  SETTINGS_TAB_KEY,
  FEATURE_SETTINGS_KEY,
  CONFIG_EVENT,
  CATALOG_EVENT,
})
