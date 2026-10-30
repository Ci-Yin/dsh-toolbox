import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ModelSelectorController } from '../src/model-selector.js'
import { createDefaultConfig, saveConfig } from '../src/model-storage.js'
import { createTranslator } from '../src/i18n.js'
import { createModelDom, FakeStorage, isHidden, modelRows, visibleModelIds } from './helpers.js'

function setup(options = {}) {
  const dom = createModelDom(options)
  const storage = new FakeStorage()
  const cfg = createDefaultConfig()
  cfg.groups[0].modelKeys = ['deepseek/deepseek-chat']
  saveConfig(storage, cfg)
  const logs = []
  const opened = []
  const controller = new ModelSelectorController({
    document: dom.window.document,
    window: dom.window,
    storage,
    t: createTranslator('zh'),
    openSettings: () => opened.push(true),
    logger: (message) => logs.push(message),
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    cancelAnimationFrame: (handle) => clearTimeout(handle),
    ...(options.controller ?? {}),
  })
  return { dom, storage, controller, logs, opened, cfg }
}

test('start injects exactly one toolbar and keeps native model rows', () => {
  const { dom, controller } = setup()
  controller.start()
  controller.scan()
  controller.scan()
  const document = dom.window.document
  assert.equal(document.querySelectorAll('.dsh-toolbox-toolbar').length, 1)
  assert.equal(document.querySelectorAll('.dsh-toolbox-tabs').length, 1)
  assert.equal(document.querySelectorAll('.dsh-toolbox-search').length, 1)
  assert.equal(modelRows(dom).length, 5)
  assert.equal(document.querySelector('#native-search-row').getAttribute('data-dsh-toolbox-hidden'), 'true')
  assert.equal(document.querySelectorAll('.dsh-toolbox-view').length, 0)
  assert.equal(document.querySelectorAll('.dsh-toolbox-tab-collapse').length, 1)
  assert.equal(document.querySelectorAll('.dsh-toolbox-status').length, 1)
  controller.stop()
})

test('default custom group filters the native list; tabs restore views', () => {
  const { dom, controller } = setup()
  controller.start()
  assert.deepEqual(visibleModelIds(dom), ['deepseek-chat'])

  dom.window.document.querySelector('[data-group-id="all"]').click()
  assert.deepEqual(visibleModelIds(dom), ['deepseek-chat', 'deepseek-reasoner'])

  dom.window.document.querySelector('[data-group-id="favorites"]').click()
  assert.deepEqual(visibleModelIds(dom), ['deepseek-chat'])

  dom.window.document.querySelector('[data-group-id="ungrouped"]').click()
  assert.equal(visibleModelIds(dom).includes('deepseek-chat'), false)
  assert.equal(visibleModelIds(dom).length, 4)
  controller.stop()
})

test('search matches provider, display name, model id, and multiple terms', () => {
  const { dom, controller } = setup()
  controller.start()
  const input = dom.window.document.querySelector('.dsh-toolbox-search')

  const type = (value) => {
    input.value = value
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  }

  type('openai')
  assert.deepEqual(visibleModelIds(dom), ['gpt-4o', 'gpt-4o-mini'])
  type('claude')
  assert.deepEqual(visibleModelIds(dom), ['claude-sonnet'])
  type('deepseek reasoner')
  assert.deepEqual(visibleModelIds(dom), ['deepseek-reasoner'])
  type('gpt-4o-mini')
  assert.deepEqual(visibleModelIds(dom), ['gpt-4o-mini'])
  type('nothing-here')
  assert.deepEqual(visibleModelIds(dom), [])
  assert.equal(dom.window.document.querySelector('.dsh-toolbox-status').getAttribute('data-visible'), 'true')

  dom.window.document.querySelector('.dsh-toolbox-search-clear').click()
  assert.deepEqual(visibleModelIds(dom), ['deepseek-chat'])
  controller.stop()
})

test('group view can be collapsed and the collapsed flag is persisted', () => {
  const { dom, controller, storage } = setup()
  controller.start()
  const document = dom.window.document
  assert.notEqual(document.querySelector('.dsh-toolbox-tab-collapse').style.display, 'none')
  document.querySelector('.dsh-toolbox-tab-collapse').click()
  assert.deepEqual(visibleModelIds(dom), [])
  const saved = JSON.parse(storage.getItem('dsh-toolbox:v1'))
  assert.equal(saved.groups[0].collapsed, true)
  assert.equal(document.querySelector('.dsh-toolbox-status').getAttribute('data-visible'), 'true')

  document.querySelector('.dsh-toolbox-tab-collapse').click()
  assert.deepEqual(visibleModelIds(dom), ['deepseek-chat'])
  document.querySelector('[data-group-id="all"]').click()
  assert.equal(document.querySelector('.dsh-toolbox-tab-collapse').style.display, 'none')
  controller.stop()
})

test('provider headings keep name, icon, count order and fold from the whole row', () => {
  const { dom, controller } = setup()
  controller.start()
  const document = dom.window.document
  document.querySelector('[data-group-id="all"]').click()

  const headings = [...document.querySelectorAll('[data-menu-group-heading]')]
  const deepseekHeading = headings[0]
  const openaiHeading = headings[1]
  const toggle = deepseekHeading.querySelector('.dsh-toolbox-group-toggle')
  const badge = deepseekHeading.querySelector('.dsh-toolbox-provider-badge')
  assert.ok(toggle)
  assert.equal(badge.textContent, '2')

  const meaningful = [...deepseekHeading.childNodes].filter(
    (node) => node.nodeType === 1 || (node.nodeType === 3 && node.textContent.trim() !== ''),
  )
  assert.equal(meaningful[0], toggle)
  assert.equal(meaningful[1].nodeType, 3)
  assert.equal(meaningful[2], badge)

  const headingMousedown = new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true })
  deepseekHeading.dispatchEvent(headingMousedown)
  assert.equal(headingMousedown.defaultPrevented, true)

  const iconMousedown = new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true })
  toggle.dispatchEvent(iconMousedown)
  assert.equal(iconMousedown.defaultPrevented, false)

  toggle.click()
  const rows = modelRows(dom)
  const deepseekRows = rows.filter((row) => row.querySelector('[data-provider-id="deepseek"]'))
  const openaiRows = rows.filter((row) => row.querySelector('[data-provider-id="openai"]'))
  assert.equal(deepseekRows.every((row) => isHidden(row)), true)
  assert.equal(openaiRows.every((row) => isHidden(row)), true)

  openaiHeading.click()
  assert.equal(openaiRows.every((row) => !isHidden(row)), true)

  const openaiBadge = openaiHeading.querySelector('.dsh-toolbox-provider-badge')
  openaiBadge.click()
  assert.equal(openaiRows.every((row) => isHidden(row)), true)

  deepseekHeading.click()
  assert.equal(deepseekRows.every((row) => !isHidden(row)), true)
  controller.stop()
})

test('only the selected model provider is expanded when the menu opens', () => {
  const { dom, controller } = setup()
  controller.start()
  const document = dom.window.document
  document.querySelector('[data-group-id="all"]').click()

  const rows = modelRows(dom)
  const deepseekRows = rows.filter((row) => row.querySelector('[data-provider-id="deepseek"]'))
  const openaiRows = rows.filter((row) => row.querySelector('[data-provider-id="openai"]'))
  const anthropicRows = rows.filter((row) => row.querySelector('[data-provider-id="anthropic"]'))
  assert.equal(deepseekRows.every((row) => !isHidden(row)), true)
  assert.equal(openaiRows.every((row) => isHidden(row)), true)
  assert.equal(anthropicRows.every((row) => isHidden(row)), true)
  assert.equal(document.body.textContent.includes('全部模型'), false)
  controller.stop()
})

test('search reveals matching providers and clearing restores the default fold', () => {
  const { dom, controller } = setup()
  controller.start()
  const document = dom.window.document
  document.querySelector('[data-group-id="all"]').click()
  const input = document.querySelector('.dsh-toolbox-search')
  const openaiRows = modelRows(dom).filter((row) => row.querySelector('[data-provider-id="openai"]'))
  assert.equal(openaiRows.every((row) => isHidden(row)), true)

  input.value = 'openai'
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  assert.equal(openaiRows.every((row) => !isHidden(row)), true)

  document.querySelector('.dsh-toolbox-search-clear').click()
  assert.equal(openaiRows.every((row) => isHidden(row)), true)
  controller.stop()
})

test('without a selected model the first visible provider is expanded', () => {
  const { dom, controller } = setup()
  for (const row of modelRows(dom)) row.setAttribute('aria-checked', 'false')
  controller.start()
  dom.window.document.querySelector('[data-group-id="all"]').click()
  const rows = modelRows(dom)
  const deepseekRows = rows.filter((row) => row.querySelector('[data-provider-id="deepseek"]'))
  const openaiRows = rows.filter((row) => row.querySelector('[data-provider-id="openai"]'))
  assert.equal(deepseekRows.every((row) => !isHidden(row)), true)
  assert.equal(openaiRows.every((row) => isHidden(row)), true)
  controller.stop()
})

test('hidden provider headings disable provider folding instead of hiding rows', () => {
  const dom = createModelDom()
  const storage = new FakeStorage()
  const cfg = createDefaultConfig()
  cfg.groups[0].modelKeys = ['deepseek/deepseek-chat', 'openai/gpt-4o']
  cfg.preserveProviderGroups = false
  saveConfig(storage, cfg)
  const controller = new ModelSelectorController({
    document: dom.window.document,
    window: dom.window,
    storage,
    t: createTranslator('zh'),
  })
  controller.start()
  assert.deepEqual(visibleModelIds(dom).sort(), ['deepseek-chat', 'gpt-4o'])
  assert.equal(isHidden(dom.window.document.querySelector('.dsh-toolbox-group-toggle')), true)
  controller.stop()
})

test('native model buttons still receive their own click handlers', () => {
  const { dom, controller } = setup()
  controller.start()
  let nativeClicks = 0
  const row = modelRows(dom).find((button) => button.getAttribute('title') === 'GPT-4o')
  row.addEventListener('click', () => {
    nativeClicks += 1
  })
  row.click()
  assert.equal(nativeClicks, 1)
  assert.equal(row.getAttribute('aria-checked'), 'false')
  controller.stop()
})

test('keyboard navigation only reaches visible rows and Enter chooses the first match', () => {
  const { dom, controller } = setup()
  controller.start()
  const document = dom.window.document
  const input = document.querySelector('.dsh-toolbox-search')
  input.focus()
  input.value = 'gpt'
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))

  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  assert.equal(document.activeElement.getAttribute('title'), 'GPT-4o')
  input.focus()
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  input.focus()
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  assert.equal(document.activeElement.getAttribute('title'), 'GPT-4o mini')

  let clicked = 0
  modelRows(dom)
    .find((button) => button.getAttribute('title') === 'GPT-4o')
    .addEventListener('click', () => {
      clicked += 1
    })
  input.focus()
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  assert.equal(clicked, 1)
  controller.stop()
})

test('the trigger sends keyboard entry to the toolbox search, not the hidden native search', () => {
  const { dom, controller } = setup()
  controller.start()
  const document = dom.window.document
  const trigger = document.querySelector('#model-trigger')
  trigger.focus()
  trigger.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  assert.equal(document.activeElement, document.querySelector('.dsh-toolbox-search'))
  trigger.focus()
  trigger.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
  assert.equal(document.activeElement, document.querySelector('.dsh-toolbox-search'))
  controller.stop()
})

test('hiding the focused native search moves focus into the toolbox instead of closing the menu', () => {
  const { dom, controller } = setup()
  const document = dom.window.document
  const nativeSearch = document.querySelector('#native-search')
  nativeSearch.focus()
  controller.start()
  assert.equal(document.activeElement, document.querySelector('.dsh-toolbox-search'))
  assert.equal(document.querySelector('#native-search-row').getAttribute('data-dsh-toolbox-hidden'), 'true')
  controller.stop()
})

test('stop removes every injected node, listener, and hidden attribute', () => {
  class Observer {
    constructor(callback) {
      this.callback = callback
    }

    observe() {
      this.observed = true
    }

    disconnect() {
      this.disconnected = true
    }
  }
  const { dom, controller } = setup({ controller: { MutationObserver: Observer } })
  controller.start()
  assert.equal(controller.observer.observed, true)
  const document = dom.window.document
  controller.stop()
  assert.equal(controller.observer, null)
  assert.equal(document.querySelector('.dsh-toolbox-toolbar'), null)
  assert.equal(document.querySelector('.dsh-toolbox-tab-collapse'), null)
  assert.equal(document.querySelector('.dsh-toolbox-status'), null)
  assert.equal(document.querySelector('#dsh-toolbox-styles'), null)
  assert.equal(document.querySelector('#native-search-row').hasAttribute('data-dsh-toolbox-hidden'), false)
  assert.equal(modelRows(dom).some((row) => row.hasAttribute('data-dsh-toolbox-hidden')), false)
  assert.equal(controller.records.size, 0)
})

test('closing the menu disposes its enhancement', () => {
  const { dom, controller } = setup()
  controller.start()
  dom.window.document.querySelector('#menu-models').remove()
  controller.scan()
  assert.equal(controller.records.size, 0)
  assert.equal(dom.window.document.querySelector('.dsh-toolbox-toolbar'), null)
  controller.stop()
})

test('a React rerender that drops the tabs or status re-enhances the menu once', () => {
  const { dom, controller } = setup()
  controller.start()
  const document = dom.window.document
  document.querySelector('.dsh-toolbox-status').remove()
  document.querySelector('.dsh-toolbox-tabs').remove()
  controller.scan()
  assert.equal(document.querySelectorAll('.dsh-toolbox-toolbar').length, 1)
  assert.equal(document.querySelectorAll('.dsh-toolbox-status').length, 1)
  assert.equal(document.querySelectorAll('.dsh-toolbox-tabs').length, 1)
  controller.stop()
})

test('an installed dsh-model-search is reused instead of duplicated', async () => {
  const { dom, controller } = setup({ external: true })
  controller.start()
  const document = dom.window.document
  assert.equal(document.querySelector('.dsh-toolbox-search'), null)
  assert.equal(document.querySelectorAll('.dms-wrap input').length, 1)
  const external = document.querySelector('#dms-input')
  external.value = 'claude'
  external.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(visibleModelIds(dom), ['claude-sonnet'])
  controller.stop()
})

test('unrecognized group markup is left alone and diagnosed once', () => {
  const dom = createModelDom()
  const document = dom.window.document
  const menu = document.querySelector('#menu-models')
  menu.removeAttribute('id')
  menu.removeAttribute('role')
  const storage = new FakeStorage()
  const logs = []
  const controller = new ModelSelectorController({
    document,
    window: dom.window,
    storage,
    t: createTranslator('zh'),
    logger: (message) => logs.push(message),
  })
  controller.start()
  controller.scan()
  assert.equal(document.querySelector('.dsh-toolbox-toolbar'), null)
  assert.ok(logs.some((message) => message.includes('could not be identified')))
  controller.stop()
})

test('model rows without provider/model ids are left native and diagnosed', () => {
  const dom = createModelDom()
  const document = dom.window.document
  for (const span of document.querySelectorAll('[data-provider-id]')) {
    span.removeAttribute('data-provider-id')
    span.removeAttribute('data-model-id')
  }
  const logs = []
  const controller = new ModelSelectorController({
    document,
    window: dom.window,
    storage: new FakeStorage(),
    t: createTranslator('zh'),
    logger: (message) => logs.push(message),
  })
  controller.start()
  controller.scan()
  assert.equal(document.querySelector('.dsh-toolbox-toolbar'), null)
  assert.ok(logs.some((message) => message.includes('provider/model ids')))
  controller.stop()
})

test('the mutation observer does not rescan on its own injected nodes', async () => {
  const { dom, controller } = setup()
  const originalScan = controller.scan.bind(controller)
  let scans = 0
  controller.scan = () => {
    scans += 1
    originalScan()
  }
  controller.start()
  await new Promise((resolve) => setTimeout(resolve, 60))
  const settled = scans
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(scans, settled)
  controller.stop()
})

test('provider rows are indented under their provider label', () => {
  const { dom, controller } = setup()
  const { window } = dom
  const document = window.document
  const menu = document.querySelector('#menu-models')

  // jsdom has no layout: fake the host geometry. The heading content starts at
  // 24, the injected disclosure button occupies 24..42 (+5 margin) which puts
  // the label at 47, while model names sit at 30 — the screenshot's 30/47 zigzag.
  const rect = (left, width) => ({ left, right: left + width, top: 0, bottom: 20, width, height: 20, x: left, y: 0 })
  window.Element.prototype.getBoundingClientRect = function getRect() {
    if (this === menu) return rect(0, 260)
    if (this.classList?.contains('dsh-toolbox-group-toggle')) return rect(24, 18)
    if (this.matches?.('[data-menu-group-heading]')) return rect(24, 240)
    if (this.matches?.('button[role="menuitemradio"]')) return rect(8, 240)
    if (this.matches?.('[data-provider-id]')) {
      // The label really moves with the row, so the measured indent converges.
      const applied = Number(this.closest('button')?.dataset.dshToolboxIndent ?? 0)
      return rect(30 + applied, 120)
    }
    return rect(0, 0)
  }
  window.getComputedStyle = (node) => ({
    marginRight: node.classList?.contains('dsh-toolbox-group-toggle') ? '5px' : '0px',
    columnGap: 'normal',
    paddingLeft: node.matches?.('button[role="menuitemradio"]') ? '22px' : '0px',
  })

  controller.start()
  document.querySelector('[data-group-id="all"]').click()

  const sections = [...document.querySelectorAll('[data-menu-group]')]
  const deepseekRows = [...sections[0].querySelectorAll('button[role="menuitemradio"]')]
  for (const row of deepseekRows) {
    assert.equal(row.style.paddingLeft, '39px') // 22 host padding + 17 to reach the label column
    assert.equal(row.dataset.dshToolboxIndent, '17')
  }

  // A folded provider indents its rows once it opens.
  sections[1].querySelector('[data-menu-group-heading]').click()
  const openaiRows = [...sections[1].querySelectorAll('button[role="menuitemradio"]')]
  for (const row of openaiRows) assert.equal(row.style.paddingLeft, '39px')

  // Re-running converges instead of stacking another indent on top.
  controller.refresh()
  for (const row of deepseekRows) assert.equal(row.style.paddingLeft, '39px')

  // A view that hides the provider headings drops the indent again.
  document.querySelector('[data-group-id="favorites"]').click()
  for (const row of deepseekRows) assert.equal(row.style.paddingLeft, '22px')

  controller.stop()
  for (const row of deepseekRows) {
    assert.equal(row.style.paddingLeft, '')
    assert.equal(row.hasAttribute('data-dsh-toolbox-indent'), false)
  }
})
