import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  catalogFingerprint,
  detectExternalSearch,
  escapeKeyPart,
  findModelMenus,
  makeModelKey,
  normalizeModelKey,
  parseModelKey,
  readExternalQuery,
  readModelCatalog,
  readModelRow,
  toCatalogSnapshot,
  unescapeKeyPart,
} from '../src/model-catalog.js'
import { createModelDom } from './helpers.js'

test('stable keys use provider and model ids, not display names', () => {
  const dom = createModelDom()
  const catalog = readModelCatalog(dom.window.document.querySelector('#menu-models'))
  const chat = catalog.models.find((model) => model.modelId === 'deepseek-chat')
  assert.equal(chat.key, makeModelKey('deepseek', 'deepseek-chat'))
  assert.equal(chat.name, 'DeepSeek Chat')
  assert.equal(chat.providerName, 'DeepSeek')

  chat.button.setAttribute('title', 'Renamed Model')
  const afterRename = readModelCatalog(dom.window.document.querySelector('#menu-models'))
  assert.equal(afterRename.models.find((model) => model.modelId === 'deepseek-chat').key, chat.key)
})

test('key escaping round-trips provider and model ids containing separators', () => {
  const key = makeModelKey('provider/with/slash', 'model~with~tilde')
  assert.equal(key, 'provider~1with~1slash/model~0with~0tilde')
  assert.deepEqual(parseModelKey(key), {
    providerId: 'provider/with/slash',
    modelId: 'model~with~tilde',
  })
  assert.equal(unescapeKeyPart(escapeKeyPart('a/b~c')), 'a/b~c')
  assert.deepEqual(parseModelKey('not-a-key'), null)
})

test('legacy key forms are normalized without attaching a bare id to another provider', () => {
  assert.equal(normalizeModelKey('openai::gpt-4o'), makeModelKey('openai', 'gpt-4o'))
  assert.equal(normalizeModelKey('openai\u001fgpt-4o'), makeModelKey('openai', 'gpt-4o'))
  assert.equal(normalizeModelKey('openai/gpt-4o'), 'openai/gpt-4o')
  assert.equal(normalizeModelKey('bare-model'), 'bare-model')
  assert.equal(normalizeModelKey('  '), '')
  assert.equal(normalizeModelKey(42), '')
})

test('catalog reads provider groups, counts, duplicates, and snapshots', () => {
  const dom = createModelDom()
  const menu = dom.window.document.querySelector('#menu-models')
  const catalog = readModelCatalog(menu)
  assert.equal(catalog.models.length, 5)
  assert.deepEqual(
    catalog.providers.map((provider) => provider.providerId),
    ['deepseek', 'openai', 'anthropic'],
  )
  assert.equal(catalog.groups.length, 3)
  assert.equal(catalog.groups[0].models.length, 2)
  assert.equal(catalog.duplicateKeys.length, 0)

  // Duplicate rows are ignored, so the cache cannot contain ambiguous keys.
  const clone = catalog.models[0].button.cloneNode(true)
  menu.querySelector('section').appendChild(clone)
  const withDuplicate = readModelCatalog(menu)
  assert.equal(withDuplicate.models.length, 5)
  assert.deepEqual(withDuplicate.duplicateKeys, [makeModelKey('deepseek', 'deepseek-chat')])

  const snapshot = toCatalogSnapshot(catalog.models)
  assert.equal(snapshot.length, 5)
  assert.equal(snapshot[0].button, undefined)
  assert.equal(typeof snapshot[0].key, 'string')
})

test('empty catalog and synthetic flat groups remain readable', () => {
  const dom = createModelDom()
  const menu = dom.window.document.querySelector('#menu-models')
  menu.innerHTML = ''
  const empty = readModelCatalog(menu)
  assert.equal(empty.models.length, 0)
  assert.equal(empty.groups.length, 0)

  menu.innerHTML = `
    <button role="menuitemradio" title="One">
      <span data-provider-id="p" data-model-id="one">One</span>
    </button>`
  const flat = readModelCatalog(menu)
  assert.equal(flat.models.length, 1)
  assert.equal(flat.groups.length, 1)
  assert.equal(flat.groups[0].element, menu)
  assert.equal(flat.groups[0].heading, null)
})

test('row reader tolerates missing labels and exposes disabled state', () => {
  const dom = createModelDom()
  const button = dom.window.document.createElement('button')
  button.setAttribute('role', 'menuitemradio')
  button.setAttribute('title', 'No ids')
  const row = readModelRow(button, { providerId: 'p', providerName: 'P' })
  assert.equal(row, null)

  const known = dom.window.document.querySelector('button[role="menuitemradio"]')
  known.disabled = true
  const read = readModelRow(known, { providerId: 'deepseek', providerName: 'DeepSeek' })
  assert.equal(read.disabled, true)
  assert.equal(read.selected, true)
})

test('findModelMenus selects the inner model pane, not an outer menu', () => {
  const dom = createModelDom()
  const pane = dom.window.document.querySelector('#pane')
  const outer = dom.window.document.createElement('div')
  outer.setAttribute('role', 'menu')
  outer.setAttribute('id', 'outer')
  pane.parentElement.insertBefore(outer, pane)
  outer.appendChild(pane)
  const menus = findModelMenus(dom.window.document)
  assert.equal(menus.length, 1)
  assert.equal(menus[0].id, 'menu-models')
})

test('external search detection and query read do not depend on our classes', () => {
  const plain = createModelDom()
  const plainMenu = plain.window.document.querySelector('#menu-models')
  assert.equal(detectExternalSearch(plainMenu), false)
  assert.equal(readExternalQuery(plainMenu), '')

  const compatible = createModelDom({ external: true })
  const menu = compatible.window.document.querySelector('#menu-models')
  assert.equal(detectExternalSearch(menu), true)
  const input = compatible.window.document.querySelector('#dms-input')
  input.value = 'claude'
  assert.equal(readExternalQuery(menu), 'claude')
})

test('catalog fingerprint changes when only a display name changes', () => {
  const dom = createModelDom()
  const menu = dom.window.document.querySelector('#menu-models')
  const first = readModelCatalog(menu)
  const before = catalogFingerprint(first.models)
  first.models[0].button.setAttribute('title', 'Renamed')
  const after = catalogFingerprint(readModelCatalog(menu).models)
  assert.notEqual(before, after)
  assert.equal(catalogFingerprint([]), catalogFingerprint([]))
})

test('injected count and fold controls do not pollute the provider name', () => {
  const dom = createModelDom()
  const menu = dom.window.document.querySelector('#menu-models')
  const heading = menu.querySelector('[data-menu-group-heading]')
  const badge = dom.window.document.createElement('span')
  badge.setAttribute('data-dsh-toolbox-injected', 'true')
  badge.textContent = '2'
  const toggle = dom.window.document.createElement('button')
  toggle.setAttribute('data-dsh-toolbox-injected', 'true')
  heading.append(toggle, badge)
  const catalog = readModelCatalog(menu)
  assert.equal(catalog.providers[0].providerName, 'DeepSeek')
  assert.equal(catalog.models[0].providerName, 'DeepSeek')
})
