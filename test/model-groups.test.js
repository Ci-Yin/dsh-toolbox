import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_GROUP_ID,
  UNGROUPED_ID,
  VIEW_ALL,
  VIEW_PROVIDER,
  addGroup,
  addModelsToGroup,
  buildViewModel,
  cleanGroupName,
  configFingerprint,
  createDefaultGroup,
  createGroupId,
  filterModels,
  groupModels,
  matchesQuery,
  modelsByProvider,
  moveGroup,
  normalizeGroupId,
  removeGroup,
  removeMissingModelKeys,
  removeModelsFromGroup,
  renameGroup,
  reorderGroups,
  setGroupCollapsed,
  setGroupModels,
  sortGroups,
  toggleModelInGroup,
} from '../src/model-groups.js'
import { makeModelKey, readModelCatalog } from '../src/model-catalog.js'
import { createModelDom } from './helpers.js'

function models() {
  const dom = createModelDom()
  return readModelCatalog(dom.window.document.querySelector('#menu-models')).models
}

function config(groups = []) {
  return {
    version: 1,
    mode: 'custom',
    groups,
    showUngrouped: true,
    preserveProviderGroups: false,
  }
}

function group(id, name, order, modelKeys = [], collapsed = false) {
  return { id, name, order, collapsed, modelKeys }
}

test('a model may belong to multiple groups and ungrouped is virtual', () => {
  const catalog = models()
  const chat = makeModelKey('deepseek', 'deepseek-chat')
  const gpt = makeModelKey('openai', 'gpt-4o')
  const result = groupModels(
    catalog,
    config([
      group('favorites', '常用', 1, [chat, gpt]),
      group('coding', '写代码', 0, [chat]),
    ]),
  )
  assert.equal(result[0].id, 'coding')
  assert.equal(result[1].id, 'favorites')
  assert.deepEqual(result[0].items.map((model) => model.modelId), ['deepseek-chat'])
  assert.deepEqual(result[1].items.map((model) => model.modelId), ['deepseek-chat', 'gpt-4o'])
  const ungrouped = result.find((entry) => entry.id === UNGROUPED_ID)
  assert.equal(ungrouped.count, 3)
  assert.equal(ungrouped.items.some((model) => model.modelId === 'deepseek-chat'), false)
})

test('stale keys are preserved and reported; empty catalog is safe', () => {
  const chat = makeModelKey('deepseek', 'deepseek-chat')
  const stale = makeModelKey('gone', 'missing')
  const result = groupModels(models(), config([group('g', '旧分组', 0, [chat, stale])]))
  assert.equal(result[0].count, 1)
  assert.deepEqual(result[0].missingModelKeys, [stale])

  const empty = groupModels([], config([group('g', '空', 0, [chat])]))
  assert.equal(empty[0].count, 0)
  assert.equal(empty.find((entry) => entry.id === UNGROUPED_ID), undefined)
})

test('showUngrouped false removes the virtual group', () => {
  const result = groupModels(models(), {
    ...config([group('g', 'G', 0, [])]),
    showUngrouped: false,
  })
  assert.equal(result.some((entry) => entry.id === UNGROUPED_ID), false)
})

test('search matches provider, display name, model id, multiple terms, and @provider', () => {
  const catalog = models()
  assert.deepEqual(
    filterModels(catalog, 'openai').map((model) => model.modelId),
    ['gpt-4o', 'gpt-4o-mini'],
  )
  assert.deepEqual(
    filterModels(catalog, 'claude').map((model) => model.modelId),
    ['claude-sonnet'],
  )
  assert.deepEqual(
    filterModels(catalog, 'gpt-4o-mini').map((model) => model.modelId),
    ['gpt-4o-mini'],
  )
  assert.deepEqual(
    filterModels(catalog, 'deepseek reasoner').map((model) => model.modelId),
    ['deepseek-reasoner'],
  )
  assert.deepEqual(
    filterModels(catalog, '@anthropic sonnet').map((model) => model.modelId),
    ['claude-sonnet'],
  )
  assert.equal(matchesQuery(catalog[0], ''), true)
  assert.equal(filterModels(catalog, '').length, catalog.length)
  assert.equal(filterModels(catalog, 'no-such-model').length, 0)
})

test('view model applies a group, search, provider view, and all view', () => {
  const catalog = models()
  const chat = makeModelKey('deepseek', 'deepseek-chat')
  const gpt = makeModelKey('openai', 'gpt-4o')
  const cfg = config([group('favorites', '常用', 0, [chat, gpt])])

  const custom = buildViewModel(catalog, cfg, { activeGroupId: 'favorites' })
  assert.equal(custom.activeKind, 'custom')
  assert.equal(custom.matchedCount, 2)
  assert.equal(custom.visibleKeys.has(chat), true)
  assert.equal(custom.visibleKeys.has(makeModelKey('anthropic', 'claude-sonnet')), false)

  const searched = buildViewModel(catalog, cfg, { query: 'claude' })
  assert.equal(searched.searching, true)
  assert.equal(searched.activeId, 'search')
  assert.equal(searched.matchedCount, 1)

  const provider = buildViewModel(catalog, cfg, { activeGroupId: VIEW_PROVIDER })
  assert.equal(provider.activeKind, VIEW_PROVIDER)
  assert.equal(provider.matchedCount, catalog.length)

  const all = buildViewModel(catalog, cfg, { activeGroupId: VIEW_ALL })
  assert.equal(all.activeKind, VIEW_ALL)
  assert.equal(all.matchedCount, catalog.length)
})

test('an empty default group falls back to the first non-empty group, but an explicit empty group stays empty', () => {
  const catalog = models()
  const cfg = config([group('favorites', '常用', 0, []), group('coding', '写代码', 1, [makeModelKey('openai', 'gpt-4o')])])
  const initial = buildViewModel(catalog, cfg, { activeGroupId: null })
  assert.equal(initial.matchedCount, 1)
  assert.equal(initial.activeId, 'coding')

  const explicit = buildViewModel(catalog, cfg, { activeGroupId: 'favorites' })
  assert.equal(explicit.activeId, 'favorites')
  assert.equal(explicit.matchedCount, 0)

  const fresh = buildViewModel(catalog, config([group('favorites', '常用', 0, [])]), { activeGroupId: null })
  assert.equal(fresh.matchedCount, catalog.length)
  assert.equal(fresh.activeId, null)
})

test('collapse and sort are reflected in groupModels and fingerprint', () => {
  const cfg = config([
    group('b', 'B', 2, []),
    group('a', 'A', 1, [], true),
  ])
  assert.deepEqual(sortGroups(cfg.groups).map((entry) => entry.id), ['a', 'b'])
  const grouped = groupModels(models(), cfg)
  assert.equal(grouped[0].collapsed, true)
  const before = configFingerprint(cfg)
  const after = configFingerprint(setGroupCollapsed(cfg, 'a', false))
  assert.notEqual(before, after)
})

test('group CRUD never removes a model and renumbers order', () => {
  let cfg = config([createDefaultGroup()])
  cfg = addGroup(cfg, ' 写代码 ')
  assert.equal(cfg.groups.length, 2)
  assert.equal(cleanGroupName('  a   b  '), 'a b')
  assert.equal(cfg.groups[1].name, '写代码')
  const secondId = cfg.groups[1].id
  cfg = renameGroup(cfg, secondId, 'Coding')
  assert.equal(cfg.groups[1].name, 'Coding')
  cfg = { ...cfg, groups: moveGroup(cfg.groups, secondId, -1) }
  assert.equal(cfg.groups[0].id, secondId)
  cfg = { ...cfg, groups: reorderGroups(cfg.groups, DEFAULT_GROUP_ID, secondId) }
  assert.equal(cfg.groups[0].id, DEFAULT_GROUP_ID)
  cfg = removeGroup(cfg, secondId)
  assert.equal(cfg.groups.length, 1)
  assert.deepEqual(cfg.groups.map((entry) => entry.order), [0])
})

test('membership supports toggle, bulk set, add, remove, and cleanup', () => {
  const chat = makeModelKey('deepseek', 'deepseek-chat')
  const gpt = makeModelKey('openai', 'gpt-4o')
  let cfg = config([group('g', 'G', 0, [chat])])

  cfg = toggleModelInGroup(cfg, 'g', gpt)
  assert.deepEqual(cfg.groups[0].modelKeys, [chat, gpt])
  cfg = toggleModelInGroup(cfg, 'g', gpt)
  assert.deepEqual(cfg.groups[0].modelKeys, [chat])
  cfg = setGroupModels(cfg, 'g', [gpt, gpt])
  assert.deepEqual(cfg.groups[0].modelKeys, [gpt])
  cfg = addModelsToGroup(cfg, 'g', [chat, chat])
  assert.equal(cfg.groups[0].modelKeys.length, 2)
  cfg = removeModelsFromGroup(cfg, 'g', [chat])
  assert.deepEqual(cfg.groups[0].modelKeys, [gpt])
  cfg = removeMissingModelKeys(cfg, [])
  assert.deepEqual(cfg.groups[0].modelKeys, [])
})

test('group ids are safe, unique, and reserved ids are rejected', () => {
  const ids = new Set([createGroupId(), createGroupId(), createGroupId()])
  assert.equal(ids.size, 3)
  for (const id of ids) assert.match(id, /^[a-z0-9-]+$/)
  let cfg = config([])
  cfg = addGroup(cfg, 'A', { id: UNGROUPED_ID })
  assert.equal(cfg.groups.length, 1)
  assert.notEqual(cfg.groups[0].id, UNGROUPED_ID)
  cfg = addGroup(cfg, 'B', { id: VIEW_ALL })
  assert.equal(cfg.groups[1].id.startsWith('g-'), true)
  assert.equal(normalizeGroupId('Mixed_Case'), 'mixed_case')
  assert.equal(normalizeGroupId('-leading'), '')
})

test('provider grouping preserves catalog order', () => {
  const providers = modelsByProvider(models())
  assert.deepEqual(providers.map((entry) => entry.providerId), ['deepseek', 'openai', 'anthropic'])
  assert.equal(providers[0].models.length, 2)
})
