/**
 * Read the live model selector into a stable, presentation-only catalog.
 *
 * The host owns the menu DOM and the model objects. This module never mutates a
 * model, never opens a menu, and never relies on the visible model name alone:
 * the stable key is derived from the provider and model ids that the host puts
 * on the model label (`data-provider-id` / `data-model-id`).
 */

export const MODEL_MENU_SELECTOR = '[role="menu"][id$="-models"]'
export const MODEL_GROUP_SELECTOR = 'section[data-menu-group]'
export const MODEL_ROW_SELECTOR = 'button[role="menuitemradio"]'
export const MODEL_LABEL_SELECTOR = '[data-provider-id][data-model-id]'
export const EXTERNAL_SEARCH_SELECTOR = [
  '[data-dsh-model-search]',
  '[data-dsh-plugin="dsh-model-search"]',
  '.dms-wrap',
  '.dms-input',
  '[class*="dms-"]',
].join(', ')

export const EXTERNAL_INPUT_SELECTOR = [
  '[data-dsh-model-search] input',
  '[data-dsh-plugin="dsh-model-search"] input',
  '.dms-wrap input',
  '.dms-input input',
  '.dms-input',
  '[class*="dms-"] input',
].join(', ')

const KEY_SEPARATOR = '/'
const ESCAPE_TILDE = '~0'
const ESCAPE_SLASH = '~1'

/** Escape one key part so `provider/model` stays reversible. */
export function escapeKeyPart(value) {
  return String(value ?? '')
    .replaceAll('~', ESCAPE_TILDE)
    .replaceAll('/', ESCAPE_SLASH)
}

/** Undo {@link escapeKeyPart}. */
export function unescapeKeyPart(value) {
  return String(value ?? '')
    .replaceAll(ESCAPE_SLASH, '/')
    .replaceAll(ESCAPE_TILDE, '~')
}

/**
 * Build the stable key used by every stored group.
 * @param {string} providerId
 * @param {string} modelId
 * @returns {string}
 */
export function makeModelKey(providerId, modelId) {
  return `${escapeKeyPart(providerId)}${KEY_SEPARATOR}${escapeKeyPart(modelId)}`
}

/**
 * Reverse a key when diagnostics or a migration need its two parts.
 * @param {string} key
 * @returns {{ providerId: string, modelId: string } | null}
 */
export function parseModelKey(key) {
  const text = String(key ?? '')
  const index = text.indexOf(KEY_SEPARATOR)
  if (index <= 0 || index === text.length - 1) return null
  return {
    providerId: unescapeKeyPart(text.slice(0, index)),
    modelId: unescapeKeyPart(text.slice(index + 1)),
  }
}

/** Normalize a key imported from an older or hand-edited config. */
export function normalizeModelKey(value) {
  if (typeof value !== 'string') return ''
  let text = value.trim()
  if (text === '') return ''
  if (text.length > 240) return ''
  if (text.includes('\u001f')) {
    const [provider, model] = text.split('\u001f')
    return makeModelKey(provider, model)
  }
  if (text.includes('::')) {
    const index = text.indexOf('::')
    return makeModelKey(text.slice(0, index), text.slice(index + 2))
  }
  if (text.includes(KEY_SEPARATOR)) return text
  // A bare model id is retained so an old hand-written config is not lost; it
  // will be reported as missing rather than silently attached to another model.
  return text
}

/** Read the provider and model ids from a model row's label span. */
function readIdentity(button) {
  const label = button.querySelector?.(MODEL_LABEL_SELECTOR)
  const providerId = String(label?.getAttribute?.('data-provider-id') ?? '').trim()
  const modelId = String(label?.getAttribute?.('data-model-id') ?? '').trim()
  return { providerId, modelId }
}

function fallbackProviderId(name) {
  const text = String(name ?? '').trim()
  return text === '' ? 'provider:unknown' : `provider:${text}`
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim()
}

function readProviderName(group) {
  const heading = group.querySelector?.('[data-menu-group-heading]')
  if (heading) {
    // Ignore the count/fold controls this plugin appends to the heading. React
    // owns the label text, and reading the heading wholesale would fold our own
    // badge digits into the provider name on every scan.
    let text = ''
    for (const child of heading.childNodes ?? []) {
      if (child.nodeType === 1 && child.getAttribute?.('data-dsh-toolbox-injected') === 'true') continue
      text += child.textContent ?? ''
    }
    const label = cleanText(text)
    if (label !== '') return label
  }
  return cleanText(group.getAttribute?.('aria-label') ?? '')
}

function readModelName(button, modelId) {
  const title = cleanText(button.getAttribute?.('title') ?? '')
  if (title !== '') return title
  const label = button.querySelector?.(MODEL_LABEL_SELECTOR)
  const text = cleanText(label?.textContent ?? '')
  if (text !== '') return text
  return modelId
}

/**
 * Read one model row. The returned row is a plain record; the live button is
 * retained only so the selector can show/hide it without replacing it.
 * @param {Element} button
 * @param {{ providerId: string, providerName: string }} provider
 */
export function readModelRow(button, provider) {
  const identity = readIdentity(button)
  const providerId = identity.providerId || provider.providerId
  const modelId = identity.modelId || cleanText(button.getAttribute?.('data-model-id') ?? '')
  if (providerId === '' || modelId === '') return null
  return {
    key: makeModelKey(providerId, modelId),
    providerId,
    providerName: provider.providerName || providerId,
    modelId,
    name: readModelName(button, modelId),
    selected: button.getAttribute?.('aria-checked') === 'true',
    disabled: button.disabled === true || button.getAttribute?.('aria-disabled') === 'true',
    button,
  }
}

/**
 * Read every model row from a model pane.
 * @param {Element} menu the `[role="menu"][id$="-models"]` groups container
 * @returns {{
 *   menu: Element,
 *   groups: Array<{ element: Element, providerId: string, providerName: string, heading: Element | null }>,
 *   models: Array<ReturnType<typeof readModelRow>>,
 *   providers: Array<{ providerId: string, providerName: string }>,
 *   duplicateKeys: string[],
 * }}
 */
export function readModelCatalog(menu) {
  const groups = []
  const models = []
  const duplicateKeys = []
  const seen = new Set()

  const groupElements = menu?.querySelectorAll
    ? [...menu.querySelectorAll(MODEL_GROUP_SELECTOR)]
    : []

  if (groupElements.length === 0) {
    // A future host may flatten the model pane. Keep the enhancement useful
    // rather than failing the whole menu: treat all direct rows as one group.
    const rows = menu?.querySelectorAll ? [...menu.querySelectorAll(MODEL_ROW_SELECTOR)] : []
    if (rows.length > 0) {
      groupElements.push(menu)
    }
  }

  for (const element of groupElements) {
    const isSynthetic = element === menu
    const providerName = isSynthetic
      ? cleanText(menu.getAttribute?.('aria-label') ?? '') || 'Models'
      : readProviderName(element)
    const heading = isSynthetic ? null : element.querySelector?.('[data-menu-group-heading]') ?? null
    const buttons = isSynthetic
      ? [...menu.querySelectorAll(MODEL_ROW_SELECTOR)]
      : [...element.querySelectorAll(MODEL_ROW_SELECTOR)]
    let providerId = ''
    for (const button of buttons) {
      const identity = readIdentity(button)
      if (identity.providerId !== '') {
        providerId = identity.providerId
        break
      }
    }
    providerId = providerId || fallbackProviderId(providerName)
    const provider = { providerId, providerName: providerName || providerId }
    const groupRecord = {
      element,
      providerId,
      providerName: provider.providerName,
      heading,
      models: [],
    }
    groups.push(groupRecord)

    for (const button of buttons) {
      const row = readModelRow(button, provider)
      if (row === null) continue
      if (seen.has(row.key)) {
        duplicateKeys.push(row.key)
        continue
      }
      seen.add(row.key)
      groupRecord.models.push(row)
      models.push(row)
    }
  }

  const providerMap = new Map()
  for (const group of groups) {
    if (!providerMap.has(group.providerId)) {
      providerMap.set(group.providerId, {
        providerId: group.providerId,
        providerName: group.providerName,
      })
    }
  }

  return {
    menu,
    groups,
    models,
    providers: [...providerMap.values()],
    duplicateKeys,
  }
}

/**
 * Find the innermost model panes under a root.
 * @param {ParentNode} root
 * @returns {Element[]}
 */
export function findModelMenus(root) {
  if (!root?.querySelectorAll) return []
  const direct = [...root.querySelectorAll(MODEL_MENU_SELECTOR)]
  if (direct.length > 0) return direct

  const menuNodes = [...root.querySelectorAll('[role="menu"]')]
  const withGroups = menuNodes.filter((menu) => menu.querySelector?.(MODEL_GROUP_SELECTOR) != null)
  return withGroups.filter((menu) => {
    for (const child of menu.querySelectorAll?.('[role="menu"]') ?? []) {
      if (child !== menu && child.querySelector?.(MODEL_GROUP_SELECTOR) != null) return false
    }
    return true
  })
}

/** Whether another search plugin already owns the search row for this menu. */
export function detectExternalSearch(menu) {
  const pane = menu?.parentElement ?? menu
  if (!pane?.querySelector) return false
  if (pane.querySelector(EXTERNAL_SEARCH_SELECTOR) != null) return true
  const root = pane.closest?.('[class*="ModelSelect"], [data-model-select]') ?? pane.parentElement
  return root?.querySelector?.(EXTERNAL_SEARCH_SELECTOR) != null
}

/** Find a cooperating search plugin's input, if one is present. */
export function findExternalSearchInput(menu) {
  const pane = menu?.parentElement ?? menu
  return pane?.querySelector?.(EXTERNAL_INPUT_SELECTOR) ?? null
}

/** Read a query from a cooperating search plugin, if one is present. */
export function readExternalQuery(menu) {
  const input = findExternalSearchInput(menu)
  return typeof input?.value === 'string' ? input.value : ''
}

/** A compact fingerprint used to avoid rewriting the catalog cache on every mutation. */
export function catalogFingerprint(models) {
  let hash = 2166136261
  const records = [...new Map(models.map((model) => [model.key, model])).values()].sort((left, right) =>
    left.key.localeCompare(right.key),
  )
  for (const model of records) {
    const text = `${model.key}\u001f${model.providerName ?? ''}\u001f${model.name ?? ''}\u001f${model.modelId ?? ''}`
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    hash ^= 0x1f
    hash = Math.imul(hash, 16777619)
  }
  return `${records.length}:${hash >>> 0}`
}

/** Convert live rows into the serializable shape kept in the catalog cache. */
export function toCatalogSnapshot(models) {
  return models.map(({ key, providerId, providerName, modelId, name }) => ({
    key,
    providerId,
    providerName,
    modelId,
    name,
  }))
}
