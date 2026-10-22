/**
 * Pure grouping, ordering, folding, and search rules.
 *
 * Nothing in this module touches the DOM or localStorage; the selector and the
 * settings page both consume the same results so their behavior cannot drift.
 */

import { makeModelKey, normalizeModelKey } from './model-catalog.js'

export const VIEW_ALL = 'all'
export const VIEW_CUSTOM = 'custom'
export const VIEW_PROVIDER = 'provider'
export const VIEW_MODES = Object.freeze([VIEW_ALL, VIEW_CUSTOM, VIEW_PROVIDER])
export const UNGROUPED_ID = 'ungrouped'
export const SEARCH_ID = 'search'
export const DEFAULT_GROUP_ID = 'favorites'
export const DEFAULT_GROUP_NAME = '常用'

const MAX_NAME = 80
const MAX_GROUPS = 64

/** Normalize a user-entered group name. */
export function cleanGroupName(value, fallback = '新分组') {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  return (text || fallback).slice(0, MAX_NAME)
}

/** Create a stable, URL-safe group id. */
export function createGroupId(existingIds = []) {
  const taken = new Set(existingIds)
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const random = Math.random().toString(36).slice(2, 8)
    const id = `g-${Date.now().toString(36)}-${random}`
    if (!taken.has(id)) return id
  }
  let index = 1
  while (taken.has(`g-${index}`)) index += 1
  return `g-${index}`
}

/** Ensure a group id is safe and not one of the reserved view ids. */
export function normalizeGroupId(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (text === '' || text === UNGROUPED_ID || text === SEARCH_ID || text === VIEW_ALL || text === VIEW_PROVIDER) {
    return ''
  }
  const cleaned = text.replace(/[^a-z0-9_-]/gu, '').slice(0, 64)
  return /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(cleaned) ? cleaned : ''
}

/** Sort ascending by order, then by name/id. */
export function sortGroups(groups) {
  return [...(Array.isArray(groups) ? groups : [])].sort((left, right) => {
    const order = Number(left?.order ?? 0) - Number(right?.order ?? 0)
    if (order !== 0) return order
    return String(left?.name ?? '').localeCompare(String(right?.name ?? ''), 'zh-Hans-CN')
  })
}

/** Renumber groups in their given order after an insertion, deletion, or move. */
export function renumberGroups(groups) {
  return (Array.isArray(groups) ? groups : []).map((group, index) => ({ ...group, order: index }))
}

/** Count how many model keys in a group exist in the current catalog. */
function groupItems(models, keys) {
  const wanted = new Set(keys)
  return models.filter((model) => wanted.has(model.key))
}

/** Keys that no longer resolve to a catalog model. */
export function missingKeysForGroup(group, models) {
  const available = new Set(models.map((model) => model.key))
  return (group.modelKeys ?? []).map(normalizeModelKey).filter((key) => key !== '' && !available.has(key))
}

/**
 * Build the custom groups plus the virtual `未分组` group.
 * A model may appear in several groups; `未分组` contains only models that no
 * custom group references.
 * @param {Array<object>} models
 * @param {object} config
 */
export function groupModels(models, config) {
  const catalog = Array.isArray(models) ? models : []
  const groups = sortGroups(config?.groups ?? [])
  const assigned = new Set()
  const result = groups.map((group, index) => {
    const keys = Array.isArray(group.modelKeys) ? group.modelKeys.map(normalizeModelKey).filter(Boolean) : []
    const items = groupItems(catalog, keys)
    for (const item of items) assigned.add(item.key)
    return {
      ...group,
      type: 'custom',
      kind: 'custom',
      order: Number.isFinite(Number(group.order)) ? Number(group.order) : index,
      collapsed: group.collapsed === true,
      modelKeys: keys,
      items,
      count: items.length,
      missingModelKeys: missingKeysForGroup(group, catalog),
    }
  })

  const ungrouped = catalog.filter((model) => !assigned.has(model.key))
  if (config?.showUngrouped !== false && ungrouped.length > 0) {
    result.push({
      id: UNGROUPED_ID,
      name: '未分组',
      type: 'ungrouped',
      kind: UNGROUPED_ID,
      order: result.length,
      collapsed: false,
      modelKeys: ungrouped.map((model) => model.key),
      items: ungrouped,
      count: ungrouped.length,
      missingModelKeys: [],
    })
  }

  return result
}

/** Split a query into lower-case search terms. */
export function queryTokens(query) {
  const text = String(query ?? '').trim().toLowerCase()
  if (text === '') return []
  return text.split(/\s+/u).filter(Boolean)
}

/**
 * Match provider name, provider id, visible model name, and model id.
 * Every whitespace-separated term must match. `@provider` restricts a term to
 * the provider fields, mirroring the familiar plugin syntax without changing
 * the native menu's own search.
 * @param {object} model
 * @param {string} query
 */
export function matchesQuery(model, query) {
  const tokens = queryTokens(query)
  if (tokens.length === 0) return true
  const provider = `${model?.providerName ?? ''} ${model?.providerId ?? ''}`.toLowerCase()
  const names = `${model?.name ?? ''} ${model?.modelId ?? ''} ${model?.key ?? ''}`.toLowerCase()
  const combined = `${provider} ${names}`
  return tokens.every((rawToken) => {
    let token = rawToken
    if (token.startsWith('@')) {
      token = token.slice(1)
      if (token === '') return true
      return provider.includes(token)
    }
    return combined.includes(token)
  })
}

/** Filter the catalog without mutating it. */
export function filterModels(models, query) {
  const catalog = Array.isArray(models) ? models : []
  if (queryTokens(query).length === 0) return catalog
  return catalog.filter((model) => matchesQuery(model, query))
}

/**
 * Resolve which view the menu should open with.
 * @param {object} config
 * @param {Array<object>} grouped result of {@link groupModels}
 * @param {string | null} requestedId
 */
export function resolveActiveGroup(config, grouped, requestedId = null) {
  const custom = grouped.filter((group) => group.type === 'custom')
  if (requestedId === VIEW_ALL || requestedId === VIEW_PROVIDER) {
    return { id: requestedId, name: requestedId === VIEW_ALL ? '全部模型' : '原始 Provider 分组', kind: requestedId, items: [] }
  }
  const requested = grouped.find((group) => group.id === requestedId)
  if (requested) return requested
  if (config?.mode === VIEW_PROVIDER) {
    return { id: VIEW_PROVIDER, name: '原始 Provider 分组', kind: VIEW_PROVIDER, items: [] }
  }
  if (config?.mode === VIEW_CUSTOM) {
    const first = custom[0]
    if (first && first.count > 0) return first
    const nonEmpty = custom.find((group) => group.count > 0)
    if (nonEmpty) return nonEmpty
    // A fresh install starts with an empty 常用 group. Opening the menu should
    // still show every model rather than an empty group; an explicit click on
    // the empty group's tab is handled above and keeps the empty view.
    return null
  }
  return null
}

/**
 * Build the complete presentation model for one menu render.
 * A non-empty query searches the whole catalog; otherwise the selected group
 * narrows the native provider sections.
 * @param {Array<object>} models
 * @param {object} config
 * @param {{ query?: string, activeGroupId?: string | null }} state
 */
export function buildViewModel(models, config, state = {}) {
  const catalog = Array.isArray(models) ? models : []
  const query = String(state.query ?? '')
  const grouped = groupModels(catalog, config)
  const groupedById = new Map(grouped.map((group) => [group.id, group]))
  const searching = queryTokens(query).length > 0

  let active = null
  let items = []
  if (searching) {
    items = filterModels(catalog, query)
    active = { id: SEARCH_ID, name: '搜索结果', kind: SEARCH_ID, items, count: items.length, collapsed: false }
  } else {
    const candidate = resolveActiveGroup(config, grouped, state.activeGroupId ?? null)
    if (candidate !== null && candidate.id !== VIEW_ALL && candidate.id !== VIEW_PROVIDER) {
      const stored = groupedById.get(candidate.id)
      active = stored ?? candidate
      items = active.items ?? []
    } else if (candidate !== null && candidate.id === VIEW_PROVIDER) {
      active = { ...candidate, items: catalog, count: catalog.length, collapsed: false }
      items = catalog
    } else if (candidate !== null && candidate.id === VIEW_ALL) {
      active = { ...candidate, items: catalog, count: catalog.length, collapsed: false }
      items = catalog
    } else {
      active = null
      items = catalog
    }
  }

  const visibleKeys = new Set(items.map((model) => model.key))
  const counts = new Map()
  for (const group of grouped) counts.set(group.id, group.count)
  const missing = new Map()
  for (const group of grouped) {
    if (group.missingModelKeys.length > 0) missing.set(group.id, group.missingModelKeys)
  }

  return {
    models: catalog,
    grouped,
    groupedById,
    active,
    activeId: active?.id ?? null,
    activeKind: active?.kind ?? active?.type ?? null,
    searching,
    query,
    items,
    visibleKeys,
    counts,
    missing,
    totalCount: catalog.length,
    matchedCount: items.length,
    ungrouped: grouped.find((group) => group.type === 'ungrouped') ?? null,
  }
}

/** Move a group one slot up or down. */
export function moveGroup(groups, id, delta) {
  const sorted = sortGroups(groups)
  const index = sorted.findIndex((group) => group.id === id)
  if (index < 0) return renumberGroups(sorted)
  const target = index + Math.sign(Number(delta) || 0)
  if (target < 0 || target >= sorted.length || target === index) return renumberGroups(sorted)
  const next = [...sorted]
  const [group] = next.splice(index, 1)
  next.splice(target, 0, group)
  return renumberGroups(next)
}

/** Move `sourceId` to `targetId`'s current position (drag-and-drop). */
export function reorderGroups(groups, sourceId, targetId) {
  const sorted = sortGroups(groups)
  const from = sorted.findIndex((group) => group.id === sourceId)
  const to = sorted.findIndex((group) => group.id === targetId)
  if (from < 0 || to < 0 || from === to) return renumberGroups(sorted)
  const next = [...sorted]
  const [group] = next.splice(from, 1)
  next.splice(to, 0, group)
  return renumberGroups(next)
}

/** Add a group and return a new config. */
export function addGroup(config, name, options = {}) {
  const groups = sortGroups(config?.groups ?? [])
  if (groups.length >= MAX_GROUPS) return config
  const existingIds = groups.map((group) => group.id)
  const id = normalizeGroupId(options.id) || createGroupId(existingIds)
  if (existingIds.includes(id)) return config
  const group = {
    id,
    name: cleanGroupName(name, '新分组'),
    order: groups.length,
    collapsed: false,
    modelKeys: [],
  }
  return { ...config, groups: renumberGroups([...groups, group]) }
}

/** Remove a group; model records and the host's catalog are untouched. */
export function removeGroup(config, id) {
  const groups = sortGroups(config?.groups ?? []).filter((group) => group.id !== id)
  return { ...config, groups: renumberGroups(groups) }
}

/** Rename a group without changing its membership. */
export function renameGroup(config, id, name) {
  return {
    ...config,
    groups: sortGroups(config?.groups ?? []).map((group) =>
      group.id === id ? { ...group, name: cleanGroupName(name, group.name) } : group,
    ),
  }
}

/** Persist a group's folded state. */
export function setGroupCollapsed(config, id, collapsed) {
  return {
    ...config,
    groups: sortGroups(config?.groups ?? []).map((group) =>
      group.id === id ? { ...group, collapsed: collapsed === true } : group,
    ),
  }
}

/** Add or remove one model key from one group. */
export function toggleModelInGroup(config, id, modelKey, member) {
  const key = normalizeModelKey(modelKey)
  if (key === '') return config
  return {
    ...config,
    groups: sortGroups(config?.groups ?? []).map((group) => {
      if (group.id !== id) return group
      const keys = new Set(group.modelKeys ?? [])
      if (member === true) keys.add(key)
      else if (member === false) keys.delete(key)
      else if (keys.has(key)) keys.delete(key)
      else keys.add(key)
      return { ...group, modelKeys: [...keys] }
    }),
  }
}

/** Replace a group's entire membership (bulk add/remove). */
export function setGroupModels(config, id, modelKeys) {
  const keys = [...new Set((modelKeys ?? []).map(normalizeModelKey).filter(Boolean))]
  return {
    ...config,
    groups: sortGroups(config?.groups ?? []).map((group) =>
      group.id === id ? { ...group, modelKeys: keys } : group,
    ),
  }
}

/** Add many keys at once. */
export function addModelsToGroup(config, id, modelKeys) {
  const additions = (modelKeys ?? []).map(normalizeModelKey).filter(Boolean)
  return {
    ...config,
    groups: sortGroups(config?.groups ?? []).map((group) => {
      if (group.id !== id) return group
      return { ...group, modelKeys: [...new Set([...(group.modelKeys ?? []), ...additions])] }
    }),
  }
}

/** Remove many keys at once. */
export function removeModelsFromGroup(config, id, modelKeys) {
  const removals = new Set((modelKeys ?? []).map(normalizeModelKey).filter(Boolean))
  return {
    ...config,
    groups: sortGroups(config?.groups ?? []).map((group) =>
      group.id === id
        ? { ...group, modelKeys: (group.modelKeys ?? []).filter((key) => !removals.has(key)) }
        : group,
    ),
  }
}

/** Remove stale keys from every group, preserving the rest. */
export function removeMissingModelKeys(config, availableKeys) {
  const available = new Set(availableKeys)
  return {
    ...config,
    groups: sortGroups(config?.groups ?? []).map((group) => ({
      ...group,
      modelKeys: (group.modelKeys ?? []).filter((key) => available.has(key)),
    })),
  }
}

/** A stable membership signature used to avoid unnecessary storage writes. */
export function configFingerprint(config) {
  return JSON.stringify({
    mode: config?.mode,
    showUngrouped: config?.showUngrouped,
    preserveProviderGroups: config?.preserveProviderGroups,
    groups: sortGroups(config?.groups ?? []).map((group) => ({
      id: group.id,
      name: group.name,
      order: group.order,
      collapsed: group.collapsed,
      modelKeys: [...(group.modelKeys ?? [])].sort(),
    })),
  })
}

/** The default group used by a fresh install. */
export function createDefaultGroup() {
  return {
    id: DEFAULT_GROUP_ID,
    name: DEFAULT_GROUP_NAME,
    order: 0,
    collapsed: false,
    modelKeys: [],
  }
}

/** Utility for settings: group a catalog by provider for the membership picker. */
export function modelsByProvider(models) {
  const map = new Map()
  for (const model of Array.isArray(models) ? models : []) {
    if (!map.has(model.providerId)) {
      map.set(model.providerId, {
        providerId: model.providerId,
        providerName: model.providerName,
        models: [],
      })
    }
    map.get(model.providerId).models.push(model)
  }
  return [...map.values()]
}

/** Build a model key for callers that already have both ids. */
export function keyFor(providerId, modelId) {
  return makeModelKey(providerId, modelId)
}
