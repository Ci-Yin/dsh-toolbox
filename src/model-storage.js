/**
 * Versioned, local-only configuration and catalog snapshots.
 *
 * The plugin never edits a DSH profile or a host model record. Configuration
 * lives in the WebView's namespaced localStorage and can be exported/imported
 * as plain JSON. Invalid or oversized imports are rejected before any write, so
 * the previous configuration survives.
 */

import {
  DEFAULT_GROUP_ID,
  DEFAULT_GROUP_NAME,
  VIEW_MODES,
  cleanGroupName,
  normalizeGroupId,
  renumberGroups,
  sortGroups,
} from './model-groups.js'
import { normalizeModelKey, toCatalogSnapshot } from './model-catalog.js'

export const STORAGE_KEY = 'dsh-toolbox:v1'
export const CATALOG_KEY = 'dsh-toolbox:catalog:v1'
export const CONFIG_EVENT = 'dsh-toolbox:config-changed'
export const CATALOG_EVENT = 'dsh-toolbox:catalog-changed'
export const CONFIG_VERSION = 1
export const MAX_IMPORT_BYTES = 256 * 1024
export const MAX_GROUPS = 64
export const MAX_MODELS_PER_GROUP = 5000
export const MAX_CATALOG_MODELS = 10000
export const MAX_GROUP_NAME = 80
export const MAX_MODEL_KEY = 240

const CONFIG_KEYS = new Set(['version', 'mode', 'groups', 'showUngrouped', 'preserveProviderGroups'])
const GROUP_KEYS = new Set(['id', 'name', 'order', 'collapsed', 'modelKeys'])
const LEGACY_GROUP_KEYS = new Set(['id', 'name', 'order', 'collapsed', 'models', 'modelKeys'])

/** A rejected config, with a machine-readable code and a user-facing path. */
export class ConfigValidationError extends Error {
  constructor(code, message, path = '') {
    super(message)
    this.name = 'ConfigValidationError'
    this.code = code
    this.path = path
  }
}

/** Fresh default configuration. Always return a new object. */
export function createDefaultConfig() {
  return {
    version: CONFIG_VERSION,
    mode: 'custom',
    groups: [
      {
        id: DEFAULT_GROUP_ID,
        name: DEFAULT_GROUP_NAME,
        order: 0,
        collapsed: false,
        modelKeys: [],
      },
    ],
    showUngrouped: true,
    preserveProviderGroups: false,
  }
}

function fail(code, message, path = '') {
  throw new ConfigValidationError(code, message, path)
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rejectUnknownKeys(value, allowed, path) {
  if (!isPlainObject(value)) fail('invalid-type', 'Expected a JSON object', path)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('unknown-field', `Unknown field: ${key}`, path ? `${path}.${key}` : key)
  }
}

function asBoolean(value, fallback, path) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') fail('invalid-type', 'Expected a boolean', path)
  return value
}

function asOrder(value, fallback, path) {
  if (value === undefined) return fallback
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) fail('invalid-type', 'Expected a finite number', path)
  return Math.max(0, Math.trunc(number))
}

function normalizeKeys(value, path) {
  if (!Array.isArray(value)) fail('invalid-type', 'Expected an array of model keys', path)
  if (value.length > MAX_MODELS_PER_GROUP) {
    fail('too-many-models', `A group may contain at most ${MAX_MODELS_PER_GROUP} model keys`, path)
  }
  const keys = []
  const seen = new Set()
  for (const [index, raw] of value.entries()) {
    if (typeof raw !== 'string') fail('invalid-type', 'Each model key must be a string', `${path}[${index}]`)
    if (raw.length > MAX_MODEL_KEY) fail('key-too-long', 'Model key is too long', `${path}[${index}]`)
    const key = normalizeModelKey(raw)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    keys.push(key)
  }
  return keys
}

function normalizeGroup(raw, index, version) {
  const path = `groups[${index}]`
  rejectUnknownKeys(raw, version === 0 ? LEGACY_GROUP_KEYS : GROUP_KEYS, path)
  const id = normalizeGroupId(raw.id)
  if (id === '') fail('invalid-group-id', 'Group id is missing or reserved', `${path}.id`)
  if (typeof raw.name !== 'string') fail('invalid-type', 'Group name must be a string', `${path}.name`)
  const name = cleanGroupName(raw.name, '')
  if (name === '') fail('invalid-group-name', 'Group name must not be empty', `${path}.name`)
  if (name.length > MAX_GROUP_NAME) fail('group-name-too-long', 'Group name is too long', `${path}.name`)
  const rawKeys = raw.modelKeys ?? raw.models ?? []
  return {
    id,
    name,
    order: asOrder(raw.order, index, `${path}.order`),
    collapsed: asBoolean(raw.collapsed, false, `${path}.collapsed`),
    modelKeys: normalizeKeys(rawKeys, `${path}.modelKeys`),
  }
}

/** Migrate version 0 (or an unversioned legacy object) to the current shape. */
export function migrateConfig(raw) {
  if (!isPlainObject(raw)) fail('invalid-type', 'Configuration must be a JSON object', '')
  const version = raw.version === undefined ? 0 : raw.version
  if (!Number.isInteger(version) || version < 0) fail('invalid-version', 'Configuration version must be an integer', 'version')
  if (version > CONFIG_VERSION) {
    fail('unsupported-version', `Configuration version ${version} is newer than ${CONFIG_VERSION}`, 'version')
  }
  rejectUnknownKeys(raw, CONFIG_KEYS, '')
  if (!Array.isArray(raw.groups)) fail('invalid-type', 'groups must be an array', 'groups')
  if (raw.groups.length > MAX_GROUPS) {
    fail('too-many-groups', `At most ${MAX_GROUPS} groups are supported`, 'groups')
  }
  const groups = raw.groups.map((group, index) => normalizeGroup(group, index, version))
  const ids = new Set()
  for (const group of groups) {
    if (ids.has(group.id)) fail('duplicate-group-id', `Duplicate group id: ${group.id}`, 'groups')
    ids.add(group.id)
  }
  const mode = raw.mode === undefined ? 'custom' : raw.mode
  if (!VIEW_MODES.includes(mode)) fail('invalid-mode', 'Unknown default view mode', 'mode')
  return {
    version: CONFIG_VERSION,
    mode,
    groups: renumberGroups(sortGroups(groups)),
    showUngrouped: asBoolean(raw.showUngrouped, true, 'showUngrouped'),
    preserveProviderGroups: asBoolean(raw.preserveProviderGroups, false, 'preserveProviderGroups'),
    __migratedFrom: version,
  }
}

/** Validate and normalize any accepted config shape. */
export function normalizeConfig(raw) {
  const migrated = migrateConfig(raw)
  const { __migratedFrom, ...config } = migrated
  return config
}

/** Alias used by the settings panel and tests. */
export const validateConfig = normalizeConfig

function byteLength(text) {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).byteLength
  return unescape(encodeURIComponent(text)).length
}

/** Parse an export/import payload. Throws {@link ConfigValidationError}. */
export function parseConfigText(text) {
  if (typeof text !== 'string') fail('invalid-type', 'Import must be a JSON string', '')
  if (byteLength(text) > MAX_IMPORT_BYTES) {
    fail('too-large', `Import is larger than ${Math.round(MAX_IMPORT_BYTES / 1024)} KiB`, '')
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    fail('invalid-json', `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`, '')
  }
  return normalizeConfig(raw)
}

/** Serialize a config for export. The output is stable enough for diffing. */
export function exportConfig(config) {
  const normalized = normalizeConfig(config)
  return `${JSON.stringify(normalized, null, 2)}\n`
}

/** Resolve a storage-like object, preferring an explicit one. */
export function resolveStorage(storage) {
  if (storage && typeof storage.getItem === 'function') return storage
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function readText(storage, key) {
  const target = resolveStorage(storage)
  if (target === null) return null
  try {
    return target.getItem(key)
  } catch {
    return null
  }
}

function writeText(storage, key, text) {
  const target = resolveStorage(storage)
  if (target === null) return false
  target.setItem(key, text)
  return true
}

/**
 * Read configuration without throwing. The caller gets the fallback and the
 * diagnostic so a malformed value can be reported without losing the raw text.
 */
export function loadConfigResult(storage) {
  const text = readText(storage, STORAGE_KEY)
  if (text === null || text === '') {
    return { config: createDefaultConfig(), error: null, raw: text }
  }
  try {
    return { config: parseConfigText(text), error: null, raw: text }
  } catch (error) {
    return { config: createDefaultConfig(), error, raw: text }
  }
}

/** Read configuration, falling back to defaults on a malformed value. */
export function loadConfig(storage) {
  return loadConfigResult(storage).config
}

/** Persist a validated config. Throws before writing on invalid input. */
export function saveConfig(storage, config, target = null) {
  const normalized = normalizeConfig(config)
  writeText(storage, STORAGE_KEY, JSON.stringify(normalized))
  if (target) notifyConfigChanged(target, normalized)
  return normalized
}

/** Import a JSON payload atomically. The previous value is untouched on error. */
export function importConfig(storage, text, target = null) {
  const config = parseConfigText(text)
  saveConfig(storage, config, target)
  return config
}

/** Restore the fresh-install configuration. */
export function resetConfig(storage, target = null) {
  return saveConfig(storage, createDefaultConfig(), target)
}

function customEvent(target, name, detail) {
  try {
    const EventConstructor = target?.CustomEvent ?? globalThis.CustomEvent
    if (typeof EventConstructor !== 'function') return
    target.dispatchEvent(new EventConstructor(name, { detail }))
  } catch {
    // A non-browser test double may not dispatch events; subscribers can still
    // call loadConfig on their next render.
  }
}

/** Notify same-window subscribers after a write. */
export function notifyConfigChanged(target, config) {
  customEvent(target, CONFIG_EVENT, { config })
}

/** Notify same-window subscribers after a catalog snapshot write. */
export function notifyCatalogChanged(target, models) {
  customEvent(target, CATALOG_EVENT, { models })
}

/** Subscribe to same-window and cross-window config writes. */
export function subscribeConfig(target, listener) {
  if (!target?.addEventListener) return () => {}
  const onStorage = (event) => {
    if (event?.key !== STORAGE_KEY && event?.key != null) return
    listener(loadConfig(target))
  }
  const onCustom = (event) => {
    const config = event?.detail?.config
    if (config !== undefined) listener(normalizeConfig(config))
    else listener(loadConfig(target))
  }
  target.addEventListener('storage', onStorage)
  target.addEventListener(CONFIG_EVENT, onCustom)
  return () => {
    target.removeEventListener('storage', onStorage)
    target.removeEventListener(CONFIG_EVENT, onCustom)
  }
}

const CATALOG_KEYS = new Set(['version', 'updatedAt', 'models'])

/** Normalize a serialized catalog payload for full-data export/import. */
export function normalizeCatalogPayload(raw) {
  if (!isPlainObject(raw) || raw.version !== 1 || !Array.isArray(raw.models)) {
    throw new ConfigValidationError('invalid-catalog', 'Invalid catalog cache')
  }
  rejectUnknownKeys(raw, CATALOG_KEYS, 'catalog')
  if (!Number.isSafeInteger(raw.updatedAt) || raw.updatedAt < 0) {
    throw new ConfigValidationError('invalid-catalog', 'Invalid catalog timestamp', 'catalog.updatedAt')
  }
  if (raw.models.length > MAX_CATALOG_MODELS) {
    throw new ConfigValidationError('too-many-models', 'Catalog cache is too large', 'catalog.models')
  }
  const models = []
  const seen = new Set()
  const modelKeys = new Set(['key', 'providerId', 'providerName', 'modelId', 'name'])
  for (const [index, model] of raw.models.entries()) {
    const path = `catalog.models[${index}]`
    rejectUnknownKeys(model, modelKeys, path)
    for (const field of modelKeys) {
      if (typeof model[field] !== 'string') {
        throw new ConfigValidationError('invalid-catalog', `Invalid catalog ${field}`, `${path}.${field}`)
      }
    }
    const key = normalizeModelKey(model.key)
    if (key === '' || key !== model.key || seen.has(key)) {
      throw new ConfigValidationError('invalid-catalog', 'Invalid or duplicate catalog model key', `${path}.key`)
    }
    seen.add(key)
    models.push({
      key,
      providerId: model.providerId,
      providerName: model.providerName,
      modelId: model.modelId,
      name: model.name,
    })
  }
  return { version: 1, updatedAt: raw.updatedAt, models }
}

/** Read the cached catalog snapshot; an absent or malformed cache is empty. */
export function loadCatalogResult(storage) {
  const text = readText(storage, CATALOG_KEY)
  if (text === null || text === '') return { models: [], updatedAt: 0, error: null }
  try {
    const raw = JSON.parse(text)
    if (!isPlainObject(raw) || raw.version !== 1 || !Array.isArray(raw.models)) {
      throw new ConfigValidationError('invalid-catalog', 'Invalid catalog cache')
    }
    if (raw.models.length > MAX_CATALOG_MODELS) {
      throw new ConfigValidationError('too-many-models', 'Catalog cache is too large')
    }
    const models = []
    const seen = new Set()
    for (const model of raw.models) {
      if (!isPlainObject(model) || typeof model.key !== 'string') continue
      const key = normalizeModelKey(model.key)
      if (key === '' || seen.has(key)) continue
      seen.add(key)
      models.push({
        key,
        providerId: String(model.providerId ?? ''),
        providerName: String(model.providerName ?? ''),
        modelId: String(model.modelId ?? ''),
        name: String(model.name ?? ''),
      })
    }
    return { models, updatedAt: Number(raw.updatedAt) || 0, error: null }
  } catch (error) {
    return { models: [], updatedAt: 0, error }
  }
}

/** Read just the cached models. */
export function loadCatalog(storage) {
  return loadCatalogResult(storage).models
}

/** Persist a complete catalog payload without changing its timestamp. */
export function saveCatalogPayload(storage, payload, target = null) {
  const normalized = normalizeCatalogPayload(payload)
  writeText(storage, CATALOG_KEY, JSON.stringify(normalized))
  if (target) notifyCatalogChanged(target, normalized.models)
  return normalized
}

/** Persist the last observed catalog for the settings page. */
export function saveCatalog(storage, models, target = null) {
  const snapshot = toCatalogSnapshot(Array.isArray(models) ? models : []).slice(0, MAX_CATALOG_MODELS)
  return saveCatalogPayload(storage, { version: 1, updatedAt: Date.now(), models: snapshot }, target)
}

/** Subscribe to same-window and cross-window catalog snapshots. */
export function subscribeCatalog(target, listener) {
  if (!target?.addEventListener) return () => {}
  const onStorage = (event) => {
    if (event?.key !== CATALOG_KEY && event?.key != null) return
    listener(loadCatalog(target))
  }
  const onCustom = (event) => {
    const models = event?.detail?.models
    listener(Array.isArray(models) ? models : loadCatalog(target))
  }
  target.addEventListener('storage', onStorage)
  target.addEventListener(CATALOG_EVENT, onCustom)
  return () => {
    target.removeEventListener('storage', onStorage)
    target.removeEventListener(CATALOG_EVENT, onCustom)
  }
}

/** True when an imported config carries a model key that no longer exists. */
export function missingModelKeys(config, catalog) {
  const available = new Set((catalog ?? []).map((model) => model.key))
  const result = []
  for (const group of sortGroups(config?.groups ?? [])) {
    for (const key of group.modelKeys ?? []) {
      if (!available.has(key)) result.push({ groupId: group.id, groupName: group.name, key })
    }
  }
  return result
}
