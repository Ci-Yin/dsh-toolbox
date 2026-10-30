import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { installStyles } from '../src/styles.js'
import {
  LAST_GROUPED_VIEW_KEY,
  WORKSPACE_FLAT_HOST_ATTRIBUTE,
  WORKSPACE_FLAT_HOST_HIDDEN_ATTRIBUTE,
  WORKSPACE_FLAT_TOGGLE_ATTRIBUTE,
  WORKSPACE_VIEW_PERSIST_KEY,
  WorkspaceFlatToggleController,
  findNativeWorkspaceViewStore,
  findWorkspaceHeader,
} from '../src/workspace-flat-toggle.js'
import { FakeStorage } from './helpers.js'

function createWorkspaceDom({ hidden = false, language = 'zh', wrappedView = false, prefix = 'cIzfCa' } = {}) {
  const searchLabel = language === 'en' ? 'Search sessions' : '搜索会话'
  const viewLabel = language === 'en' ? 'View options' : '视图选项'
  const viewControl = `<button type="button" aria-label="${viewLabel}">视图选项</button>`
  const dom = new JSDOM(`<!doctype html><html><head></head><body>
    <main id="workspace">
      <div class="${prefix}_root">
        <div class="${prefix}_sectionHeader">
          <span>工作区</span>
          <div class="${prefix}_searchSlot"><div class="search"><button type="button" aria-label="${searchLabel}" aria-expanded="${hidden ? 'true' : 'false'}">搜索</button></div></div>
          <div class="${prefix}_headerActions${hidden ? ` ${prefix}_headerActionsHidden` : ''}">
          ${wrappedView ? `<div class="native-view-trigger"><span class="tooltip">${viewControl}</span></div>` : viewControl}
            <button type="button" aria-label="添加工作区">+</button>
          </div>
        </div>
      </div>
    </main>
  </body></html>`, { url: 'http://localhost/' })
  return dom
}

function createStore(groupBy = 'workspace') {
  let state = { groupBy, orderBy: 'updated', archivedFilter: 'active' }
  let setGroupByCalls = 0
  const listeners = new Set()
  const instance = {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    actions: {
      setGroupBy(mode) {
        setGroupByCalls += 1
        state = { ...state, groupBy: mode }
        for (const listener of listeners) listener()
      },
    },
    get listenerCount() {
      return listeners.size
    },
  }
  return { instance, getState: () => state, getSetGroupByCalls: () => setGroupByCalls }
}

function createSlots(store, { valid = true, live = true } = {}) {
  const makeEntry = (persist) => ({
    store: {
      spec: { persist, actions: { setGroupBy() {} } },
      create: live ? () => store.instance : (scopeKey) => store.instance,
    },
  })
  const validEntry = makeEntry(WORKSPACE_VIEW_PERSIST_KEY)
  const invalidEntry = makeEntry('other.store')
  let currentEntry = valid ? validEntry : invalidEntry
  const listeners = new Set()
  return {
    entriesOfSlot(name) {
      return name === 'sidebar.workspaces' && currentEntry ? [currentEntry] : []
    },
    subscribe(name, listener) {
      if (name !== 'sidebar.workspaces') return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setValid(nextValid) {
      currentEntry = nextValid ? validEntry : null
      for (const listener of listeners) listener()
    },
  }
}

function createController(dom, store, storage, slots = createSlots(store), logger = undefined) {
  return new WorkspaceFlatToggleController({
    document: dom.window.document,
    window: dom.window,
    storage,
    slots,
    logger,
    Observer: dom.window.MutationObserver,
    requestAnimationFrame: (callback) => callback(),
    cancelAnimationFrame: () => {},
    t: (key) => ({
      'workspace.flatToggle.enable': '切换到单列表',
      'workspace.flatToggle.restore': '恢复之前的视图',
    }[key] ?? key),
  })
}

test('finds exactly the native workspace header between search and view actions', () => {
  const dom = createWorkspaceDom()
  const header = findWorkspaceHeader(dom.window.document)
  assert.ok(header)
  assert.equal(header.viewButton.getAttribute('aria-label'), '视图选项')
  assert.equal(header.actions.classList.contains('cIzfCa_headerActions'), true)
  assert.equal(findWorkspaceHeader(new JSDOM('<body><button aria-label="View options"></button></body>').window.document), null)
})

test('finds the workspace header after the host CSS-module hash prefix changed', () => {
  const dom = createWorkspaceDom({ prefix: '_9dHiBa' })
  const header = findWorkspaceHeader(dom.window.document)
  assert.ok(header)
  assert.equal(header.viewButton.getAttribute('aria-label'), '视图选项')
  assert.equal(header.actions.classList.contains('_9dHiBa_headerActions'), true)

  const store = createStore('workspace-tree')
  const controller = createController(dom, store, new FakeStorage())
  controller.start()
  const button = dom.window.document.querySelector(`[${WORKSPACE_FLAT_TOGGLE_ATTRIBUTE}="true"]`)
  assert.ok(button)
  assert.equal(button.parentElement, header.actions)
  assert.equal(button.nextElementSibling, header.viewAnchor)
  button.click()
  assert.equal(store.getState().groupBy, 'flat')
  assert.equal(button.getAttribute('aria-pressed'), 'true')
  controller.stop()
})

test('matches hashed workspace classes by their stable camelCase key only', () => {
  const dom = createWorkspaceDom({ prefix: 'a1B2c3' })
  const header = findWorkspaceHeader(dom.window.document)
  assert.ok(header)
  assert.equal(header.header, dom.window.document.querySelector('.a1B2c3_sectionHeader'))

  const renamed = createWorkspaceDom({ prefix: 'noKeyHere' })
  for (const node of renamed.window.document.querySelectorAll('[class]')) {
    node.setAttribute('class', node.getAttribute('class').replaceAll('noKeyHere_', 'noKeyHere-'))
  }
  assert.equal(findWorkspaceHeader(renamed.window.document), null)
})

test('warns once when the host renders workspace controls in an unrecognized shape', () => {
  const dom = createWorkspaceDom({ prefix: 'noKeyHere' })
  for (const node of dom.window.document.querySelectorAll('[class]')) {
    node.setAttribute('class', node.getAttribute('class').replaceAll('noKeyHere_', 'noKeyHere-'))
  }
  const warnings = []
  const store = createStore()
  const controller = createController(dom, store, new FakeStorage(), createSlots(store), {
    warn: (message) => warnings.push(message),
  })
  controller.start()
  controller.scan()
  controller.scan()
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /workspace header not recognized/u)
  assert.equal(dom.window.document.querySelector(`[${WORKSPACE_FLAT_TOGGLE_ATTRIBUTE}="true"]`), null)
  controller.stop()
})

test('finds only the matching native workspace store registration', () => {
  const store = createStore()
  assert.equal(findNativeWorkspaceViewStore(createSlots(store))?.instance, store.instance)
  assert.equal(findNativeWorkspaceViewStore(createSlots(store, { valid: false })), null)
  assert.equal(findNativeWorkspaceViewStore(createSlots(store, { live: false })), null)
})

test('toggles workspace to flat and restores the previous grouped mode', () => {
  const dom = createWorkspaceDom()
  const store = createStore('workspace-tree')
  const storage = new FakeStorage()
  const controller = createController(dom, store, storage)
  controller.start()

  const button = dom.window.document.querySelector(`[${WORKSPACE_FLAT_TOGGLE_ATTRIBUTE}="true"]`)
  assert.ok(button)
  const header = findWorkspaceHeader(dom.window.document)
  assert.ok(header)
  assert.equal(header.header?.children?.[1]?.querySelector('button')?.getAttribute('aria-label'), '搜索会话')
  assert.equal(button.parentElement, header.actions)
  assert.equal(button.nextElementSibling?.getAttribute('aria-label'), '视图选项')
  assert.equal(button.getAttribute('aria-pressed'), 'false')

  button.click()
  assert.equal(store.getState().groupBy, 'flat')
  assert.equal(storage.getItem(LAST_GROUPED_VIEW_KEY), 'workspace-tree')
  assert.equal(button.getAttribute('aria-pressed'), 'true')

  button.click()
  assert.equal(store.getState().groupBy, 'workspace-tree')
  assert.equal(button.getAttribute('aria-pressed'), 'false')
  assert.deepEqual(store.getState(), { groupBy: 'workspace-tree', orderBy: 'updated', archivedFilter: 'active' })
  controller.stop()
  assert.equal(dom.window.document.querySelector(`[${WORKSPACE_FLAT_TOGGLE_ATTRIBUTE}="true"]`), null)
})

test('inserts before the native view control wrapper without disturbing its click handler', () => {
  const dom = createWorkspaceDom({ wrappedView: true })
  const store = createStore('workspace-tree')
  const controller = createController(dom, store, new FakeStorage())
  const viewButton = dom.window.document.querySelector('.native-view-trigger button')
  let nativeClicks = 0
  viewButton.addEventListener('click', () => { nativeClicks += 1 })
  const headerBefore = findWorkspaceHeader(dom.window.document)
  assert.equal(headerBefore?.viewAnchor?.className, 'native-view-trigger')
  controller.start()

  const button = dom.window.document.querySelector(`[${WORKSPACE_FLAT_TOGGLE_ATTRIBUTE}="true"]`)
  assert.ok(button)
  assert.equal(button.parentElement, headerBefore.actions)
  assert.equal(button.nextElementSibling, headerBefore.viewAnchor)
  button.click()
  assert.equal(store.getState().groupBy, 'flat')
  button.click()
  assert.equal(store.getState().groupBy, 'workspace-tree')
  viewButton.click()
  assert.equal(nativeClicks, 1)
  controller.scan()
  assert.equal(dom.window.document.querySelectorAll(`[${WORKSPACE_FLAT_TOGGLE_ATTRIBUTE}="true"]`).length, 1)
  controller.stop()
  assert.equal(headerBefore.actions.querySelector(`[${WORKSPACE_FLAT_TOGGLE_ATTRIBUTE}="true"]`), null)
})

test('rejects ambiguous view wrappers instead of inserting into an unknown structure', () => {
  const dom = createWorkspaceDom({ wrappedView: true })
  const wrapper = dom.window.document.querySelector('.native-view-trigger')
  const extraButton = dom.window.document.createElement('button')
  extraButton.setAttribute('aria-label', 'Unknown action')
  wrapper.appendChild(extraButton)
  assert.equal(findWorkspaceHeader(dom.window.document), null)
  const controller = createController(dom, createStore(), new FakeStorage())
  controller.start()
  assert.equal(dom.window.document.querySelector(`[${WORKSPACE_FLAT_TOGGLE_ATTRIBUTE}="true"]`), null)
  controller.stop()
})

test('remembers native menu changes while flat mode is active and avoids duplicate buttons', () => {
  const dom = createWorkspaceDom()
  const store = createStore('workspace')
  const storage = new FakeStorage({ [LAST_GROUPED_VIEW_KEY]: 'workspace-tree' })
  const controller = createController(dom, store, storage)
  controller.start()
  const button = dom.window.document.querySelector(`[${WORKSPACE_FLAT_TOGGLE_ATTRIBUTE}="true"]`)
  assert.ok(button)

  store.instance.actions.setGroupBy('flat')
  assert.equal(storage.getItem(LAST_GROUPED_VIEW_KEY), 'workspace')
  store.instance.actions.setGroupBy('workspace-tree')
  assert.equal(storage.getItem(LAST_GROUPED_VIEW_KEY), 'workspace-tree')
  controller.scan()
  assert.equal(dom.window.document.querySelectorAll(`[${WORKSPACE_FLAT_TOGGLE_ATTRIBUTE}="true"]`).length, 1)
  controller.stop()
})

test('keeps the shortcut hidden with native search expansion and restores it afterward', () => {
  const dom = createWorkspaceDom({ hidden: true })
  const store = createStore()
  const controller = createController(dom, store, new FakeStorage())
  controller.start()
  const actions = dom.window.document.querySelector('.cIzfCa_headerActions')
  assert.equal(actions.getAttribute(WORKSPACE_FLAT_HOST_ATTRIBUTE), null)
  assert.equal(actions.getAttribute(WORKSPACE_FLAT_HOST_HIDDEN_ATTRIBUTE), 'true')
  actions.classList.remove('cIzfCa_headerActionsHidden')
  const search = dom.window.document.querySelector('.cIzfCa_searchSlot button')
  search.setAttribute('aria-expanded', 'false')
  controller.scan()
  assert.equal(actions.getAttribute(WORKSPACE_FLAT_HOST_ATTRIBUTE), 'true')
  assert.equal(actions.getAttribute(WORKSPACE_FLAT_HOST_HIDDEN_ATTRIBUTE), null)
  controller.stop()
})

test('never matches unrelated search and view controls or ambiguous workspace headers', () => {
  const unrelated = new JSDOM(`<!doctype html><body><main>
    <section><button aria-label="View options">视图选项</button></section>
    <section><button aria-label="Search sessions">搜索会话</button></section>
  </main></body>`)
  assert.equal(findWorkspaceHeader(unrelated.window.document), null)

  const dom = createWorkspaceDom()
  const root = dom.window.document.querySelector('.cIzfCa_root')
  root?.removeAttribute('class')
  assert.equal(findWorkspaceHeader(dom.window.document), null)
})

test('invalid stored flat mode and unavailable storage still restore a grouped view', () => {
  const dom = createWorkspaceDom()
  const store = createStore('flat')
  const storage = new FakeStorage({ [LAST_GROUPED_VIEW_KEY]: 'flat' })
  const controller = createController(dom, store, storage)
  controller.start()
  dom.window.document.querySelector(`[${WORKSPACE_FLAT_TOGGLE_ATTRIBUTE}="true"]`)?.click()
  assert.equal(store.getState().groupBy, 'workspace')
  controller.stop()

  const treeDom = createWorkspaceDom()
  const treeStore = createStore('workspace-tree')
  const failingStorage = { getItem() { throw new Error('unavailable') }, setItem() { throw new Error('unavailable') } }
  const treeController = createController(treeDom, treeStore, failingStorage)
  treeController.start()
  const button = treeDom.window.document.querySelector(`[${WORKSPACE_FLAT_TOGGLE_ATTRIBUTE}="true"]`)
  button?.click()
  button?.click()
  assert.equal(treeStore.getState().groupBy, 'workspace-tree')
  treeController.stop()
})

test('late native slot registration, unregistration, and DOM replacement do not duplicate the shortcut', () => {
  const dom = createWorkspaceDom({ language: 'en' })
  const store = createStore()
  const slots = createSlots(store, { valid: false })
  const controller = createController(dom, store, new FakeStorage(), slots)
  controller.start()
  const selector = `[${WORKSPACE_FLAT_TOGGLE_ATTRIBUTE}="true"]`
  assert.equal(dom.window.document.querySelector(selector), null)
  slots.setValid(true)
  assert.equal(dom.window.document.querySelectorAll(selector).length, 1)
  slots.setValid(false)
  assert.equal(dom.window.document.querySelectorAll(selector).length, 0)
  slots.setValid(true)
  const oldRoot = dom.window.document.querySelector('.cIzfCa_root')
  const oldButton = dom.window.document.querySelector(selector)
  const newRoot = oldRoot.cloneNode(true)
  oldRoot.replaceWith(newRoot)
  controller.scan()
  assert.equal(dom.window.document.querySelectorAll(selector).length, 1)
  oldButton.click()
  assert.equal(store.getState().groupBy, 'workspace')
  dom.window.document.querySelector(selector)?.click()
  assert.equal(store.getState().groupBy, 'flat')
  slots.setValid(false)
  controller.stop()
  assert.equal(dom.window.document.querySelector('#dsh-toolbox-styles'), null)
})

test('overlapping controllers keep one active button owner and one toggle action', () => {
  const dom = createWorkspaceDom()
  const store = createStore()
  const slots = createSlots(store)
  const first = createController(dom, store, new FakeStorage(), slots)
  const second = createController(dom, store, new FakeStorage(), slots)
  first.start()
  second.start()
  const button = dom.window.document.querySelector(`[${WORKSPACE_FLAT_TOGGLE_ATTRIBUTE}="true"]`)
  assert.ok(button)
  assert.equal(dom.window.document.querySelectorAll(`[${WORKSPACE_FLAT_TOGGLE_ATTRIBUTE}="true"]`).length, 1)
  button.click()
  assert.equal(store.getSetGroupByCalls(), 1)
  assert.equal(store.getState().groupBy, 'flat')
  first.stop()
  assert.equal(dom.window.document.querySelector(`[${WORKSPACE_FLAT_TOGGLE_ATTRIBUTE}="true"]`), button)
  button.click()
  assert.equal(store.getSetGroupByCalls(), 2)
  assert.equal(store.getState().groupBy, 'workspace')
  second.stop()
})

test('hands the button to a controller from a reloaded module generation', async () => {
  const dom = createWorkspaceDom()
  const store = createStore()
  const slots = createSlots(store)
  const first = createController(dom, store, new FakeStorage(), slots)
  first.start()
  const moduleUrl = `${pathToFileURL(resolve('src/workspace-flat-toggle.js')).href}?reload=${Date.now()}`
  const reloaded = await import(moduleUrl)
  const second = new reloaded.WorkspaceFlatToggleController({
    document: dom.window.document,
    window: dom.window,
    storage: new FakeStorage(),
    slots,
    Observer: dom.window.MutationObserver,
    requestAnimationFrame: (callback) => callback(),
    cancelAnimationFrame: () => {},
    t: (key) => ({
      'workspace.flatToggle.enable': '切换到单列表',
      'workspace.flatToggle.restore': '恢复之前的视图',
    }[key] ?? key),
  })
  second.start()
  assert.equal(first.started, false)
  const button = dom.window.document.querySelector(`[${WORKSPACE_FLAT_TOGGLE_ATTRIBUTE}="true"]`)
  assert.ok(button)
  assert.equal(dom.window.document.querySelectorAll(`[${WORKSPACE_FLAT_TOGGLE_ATTRIBUTE}="true"]`).length, 1)
  button.click()
  assert.equal(store.getSetGroupByCalls(), 1)
  assert.equal(store.getState().groupBy, 'flat')
  second.stop()
  assert.equal(dom.window.document.querySelector(`[${WORKSPACE_FLAT_TOGGLE_ATTRIBUTE}="true"]`), null)
})

test('fails closed when native store registration is missing', () => {
  const dom = createWorkspaceDom()
  const store = createStore()
  const controller = createController(dom, store, new FakeStorage(), createSlots(store, { valid: false }))
  controller.start()
  assert.equal(dom.window.document.querySelector(`[${WORKSPACE_FLAT_TOGGLE_ATTRIBUTE}="true"]`), null)
  controller.stop()
})

test('keeps stylesheet leases across overlapping module evaluations', async () => {
  const dom = createWorkspaceDom()
  const firstCleanup = installStyles(dom.window.document)
  const moduleUrl = `${pathToFileURL(resolve('src/styles.js')).href}?reload=${Date.now()}`
  const reloaded = await import(moduleUrl)
  const secondCleanup = reloaded.installStyles(dom.window.document)
  const style = dom.window.document.querySelector('#dsh-toolbox-styles')
  assert.equal(style?.getAttribute('data-dsh-toolbox-style-leases'), '2')
  firstCleanup()
  assert.equal(dom.window.document.querySelector('#dsh-toolbox-styles'), style)
  secondCleanup()
  assert.equal(dom.window.document.querySelector('#dsh-toolbox-styles'), null)
})

test('does not remove a pre-existing stylesheet with the reserved id', () => {
  const dom = createWorkspaceDom()
  const external = dom.window.document.createElement('style')
  external.id = 'dsh-toolbox-styles'
  external.textContent = '.external-style { color: red; }'
  dom.window.document.head.appendChild(external)
  const cleanup = installStyles(dom.window.document)
  const owned = [...dom.window.document.querySelectorAll('style')].find((style) => style !== external)
  assert.ok(owned)
  cleanup()
  assert.equal(external.isConnected, true)
  assert.equal(owned.isConnected, false)
})
