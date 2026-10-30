/** Persistent global switches for independently controlled toolbox features. */

export const FEATURE_SETTINGS_KEY = 'dsh-toolbox:features:v1'
export const FEATURE_SETTINGS_EVENT = 'dsh-toolbox:features-changed'
export const FEATURE_SETTINGS_KEYS = Object.freeze(['modelGroups', 'workspaceFlatToggle'])
export const DEFAULT_FEATURE_SETTINGS = Object.freeze({
  modelGroups: true,
  workspaceFlatToggle: true,
})

export class FeatureSettingsError extends Error {
  constructor(code, message, path = '') {
    super(message)
    this.name = 'FeatureSettingsError'
    this.code = code
    this.path = path
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(code, message, path = '') {
  throw new FeatureSettingsError(code, message, path)
}

/** Strictly normalize a feature-switch object for persistence or import. */
export function normalizeFeatureSettings(raw, options = {}) {
  const strict = options.strict === true
  if (!isPlainObject(raw)) {
    if (strict) invalid('invalid-type', 'Feature settings must be an object')
    return { ...DEFAULT_FEATURE_SETTINGS }
  }
  for (const key of Object.keys(raw)) {
    if (!FEATURE_SETTINGS_KEYS.includes(key)) {
      if (strict) invalid('unknown-field', `Unknown feature setting: ${key}`, key)
      return { ...DEFAULT_FEATURE_SETTINGS }
    }
  }
  for (const key of FEATURE_SETTINGS_KEYS) {
    if (typeof raw[key] !== 'boolean') {
      if (strict) invalid('invalid-type', 'Feature settings must contain boolean values', key)
      return { ...DEFAULT_FEATURE_SETTINGS }
    }
  }
  return {
    modelGroups: raw.modelGroups,
    workspaceFlatToggle: raw.workspaceFlatToggle,
  }
}

function resolveStorage(storage) {
  if (storage?.getItem) return storage
  try {
    return storage?.localStorage ?? null
  } catch {
    return null
  }
}

function readRaw(storage) {
  try {
    const resolved = resolveStorage(storage)
    return resolved?.getItem?.(FEATURE_SETTINGS_KEY) ?? null
  } catch (error) {
    return { error }
  }
}

/** Read persisted switches and preserve a diagnostic for strict export paths. */
export function loadFeatureSettingsResult(storage, options = {}) {
  const rawResult = readRaw(storage)
  if (rawResult?.error) return { settings: { ...DEFAULT_FEATURE_SETTINGS }, error: rawResult.error }
  const raw = rawResult
  if (raw === null || raw === '') return { settings: { ...DEFAULT_FEATURE_SETTINGS }, error: null }
  try {
    return { settings: normalizeFeatureSettings(JSON.parse(raw), options), error: null }
  } catch (error) {
    return { settings: { ...DEFAULT_FEATURE_SETTINGS }, error }
  }
}

/** Read persisted switches; missing or damaged storage fails open to defaults. */
export function readFeatureSettings(storage) {
  return loadFeatureSettingsResult(storage).settings
}

/** Persist switches and notify current-window subscribers after a successful write. */
export function writeFeatureSettings(storage, value, target = null) {
  const normalized = normalizeFeatureSettings(value, { strict: true })
  const resolved = resolveStorage(storage)
  if (!resolved || typeof resolved.setItem !== 'function') {
    throw new FeatureSettingsError('storage-unavailable', 'Feature settings storage is unavailable')
  }
  resolved.setItem(FEATURE_SETTINGS_KEY, JSON.stringify(normalized))
  notifyFeatureSettings(target, normalized)
  return normalized
}

function customEvent(target, detail) {
  try {
    const EventConstructor = target?.CustomEvent ?? globalThis.CustomEvent
    if (typeof EventConstructor !== 'function' || typeof target?.dispatchEvent !== 'function') return
    target.dispatchEvent(new EventConstructor(FEATURE_SETTINGS_EVENT, { detail: { settings: detail } }))
  } catch {
    // A non-browser test double may not support CustomEvent dispatch.
  }
}

export function notifyFeatureSettings(target, settings) {
  customEvent(target, normalizeFeatureSettings(settings))
}

/** Subscribe to same-window and cross-window feature switch changes. */
export function subscribeFeatureSettings(target, listener) {
  if (!target?.addEventListener || typeof listener !== 'function') return () => {}
  const onStorage = (event) => {
    if (event?.key !== FEATURE_SETTINGS_KEY && event?.key != null) return
    listener(readFeatureSettings(target))
  }
  const onCustom = (event) => {
    const settings = event?.detail?.settings
    listener(settings ? normalizeFeatureSettings(settings) : readFeatureSettings(target))
  }
  target.addEventListener('storage', onStorage)
  target.addEventListener(FEATURE_SETTINGS_EVENT, onCustom)
  return () => {
    target.removeEventListener('storage', onStorage)
    target.removeEventListener(FEATURE_SETTINGS_EVENT, onCustom)
  }
}
