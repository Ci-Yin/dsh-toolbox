/**
 * Additive enhancement for the native model menu.
 *
 * Design constraints:
 * - Never move or replace a React-rendered model row.
 * - Never call a private host service to change a model.
 * - Keep a single observer and remove every injected node/listener on close.
 * - When the host structure is unrecognized, leave the native menu untouched.
 */

import {
  MODEL_LABEL_SELECTOR,
  MODEL_ROW_SELECTOR,
  catalogFingerprint,
  detectExternalSearch,
  findExternalSearchInput,
  findModelMenus,
  readExternalQuery,
  readModelCatalog,
} from './model-catalog.js'
import {
  UNGROUPED_ID,
  VIEW_ALL,
  VIEW_PROVIDER,
  buildViewModel,
  setGroupCollapsed,
  sortGroups,
} from './model-groups.js'
import {
  loadCatalog,
  loadConfig,
  saveCatalog,
  saveConfig,
  subscribeConfig,
} from './model-storage.js'
import { installStyles } from './styles.js'

const HIDDEN = 'data-dsh-toolbox-hidden'
const ORIGINAL_TABINDEX = 'data-dsh-toolbox-tabindex'
const ORIGINAL_ARIA_HIDDEN = 'data-dsh-toolbox-aria-hidden'
const TOOLBAR_CLASS = 'dsh-toolbox-toolbar'
const STATUS_CLASS = 'dsh-toolbox-status'

function element(doc, tag, className, attributes = {}) {
  const node = doc.createElement(tag)
  if (className) node.className = className
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue
    node.setAttribute(name, String(value))
  }
  return node
}

function createSvg(doc, paths, options = {}) {
  const namespace = 'http://www.w3.org/2000/svg'
  const svg = doc.createElementNS(namespace, 'svg')
  svg.setAttribute('viewBox', options.viewBox ?? '0 0 16 16')
  svg.setAttribute('width', options.width ?? '16')
  svg.setAttribute('height', options.height ?? '16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', options.strokeWidth ?? '1.6')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  for (const data of paths) {
    const path = doc.createElementNS(namespace, 'path')
    path.setAttribute('d', data)
    svg.appendChild(path)
  }
  return svg
}

function chevron(doc, down = true) {
  return createSvg(doc, [down ? 'M4 6.5 8 10l4-3.5' : 'M6.5 4 10 8l-3.5 4'], { width: '12', height: '12' })
}

function gearIcon(doc) {
  return createSvg(doc, [
    'M8 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6Z',
    'M8 2.2v1.4M8 12.4v1.4M2.2 8h1.4M12.4 8h1.4M3.9 3.9l1 1M11.1 11.1l1 1M12.1 3.9l-1 1M4.9 11.1l-1 1',
  ], { width: '15', height: '15' })
}

function clearIcon(doc) {
  return createSvg(doc, ['M4 4l8 8M12 4l-8 8'], { width: '12', height: '12' })
}

function directChild(parent, className) {
  if (!parent?.children) return null
  for (const child of parent.children) {
    if (child.classList?.contains(className)) return child
  }
  return null
}

function removeChildren(node) {
  if (!node) return
  while (node.firstChild) node.removeChild(node.firstChild)
}

function connected(node, doc) {
  if (!node) return false
  if (typeof node.isConnected === 'boolean') return node.isConnected
  return doc?.documentElement?.contains?.(node) === true
}

function isModelButton(node) {
  return node?.tagName === 'BUTTON' && node.getAttribute?.('role') === 'menuitemradio'
}

function isOwnNode(node) {
  if (!node || node.nodeType !== 1) return false
  if (node.getAttribute?.('data-dsh-toolbox-injected') === 'true') return true
  return [...(node.classList ?? [])].some((name) => name.startsWith('dsh-toolbox-'))
}

function isOwnContainer(node) {
  return (
    node?.classList?.contains?.(TOOLBAR_CLASS) === true ||
    node?.classList?.contains?.(STATUS_CLASS) === true ||
    node?.classList?.contains?.('dsh-toolbox-tabs') === true ||
    node?.classList?.contains?.('dsh-toolbox-search-row') === true
  )
}

/** True for mutations caused by our own UI, so the observer does not self-trigger. */
function isOwnMutation(mutation) {
  if (isOwnContainer(mutation.target)) return true
  const added = [...(mutation.addedNodes ?? [])]
  if (added.length > 0 && added.every(isOwnNode)) return true
  const removed = [...(mutation.removedNodes ?? [])]
  if (removed.length > 0 && removed.every(isOwnNode) && isOwnContainer(mutation.target)) return true
  return false
}

/**
 * Show or hide a host node without changing its React ownership.
 * The original tabindex/aria-hidden values are restored on close.
 */
function setHidden(node, hidden) {
  if (!node) return
  if (hidden) {
    if (node.getAttribute(HIDDEN) === 'true') return
    const originalTabIndex = node.getAttribute('tabindex')
    if (originalTabIndex !== null) node.setAttribute(ORIGINAL_TABINDEX, originalTabIndex)
    const originalAria = node.getAttribute('aria-hidden')
    if (originalAria !== null) node.setAttribute(ORIGINAL_ARIA_HIDDEN, originalAria)
    node.setAttribute(HIDDEN, 'true')
    node.setAttribute('aria-hidden', 'true')
    if (isModelButton(node)) node.setAttribute('tabindex', '-1')
  } else {
    const wasHidden = node.getAttribute(HIDDEN) === 'true'
    node.removeAttribute(HIDDEN)
    if (node.hasAttribute(ORIGINAL_ARIA_HIDDEN)) {
      node.setAttribute('aria-hidden', node.getAttribute(ORIGINAL_ARIA_HIDDEN))
      node.removeAttribute(ORIGINAL_ARIA_HIDDEN)
    } else {
      node.removeAttribute('aria-hidden')
    }
    if (isModelButton(node)) {
      if (node.hasAttribute(ORIGINAL_TABINDEX)) {
        node.setAttribute('tabindex', node.getAttribute(ORIGINAL_TABINDEX))
        node.removeAttribute(ORIGINAL_TABINDEX)
      } else if (wasHidden) {
        node.removeAttribute('tabindex')
      }
    }
  }
}

/** Restore a node modified by setHidden. */
function restoreNode(node) {
  if (!node) return
  node.removeAttribute(HIDDEN)
  if (node.hasAttribute(ORIGINAL_TABINDEX)) {
    node.setAttribute('tabindex', node.getAttribute(ORIGINAL_TABINDEX))
    node.removeAttribute(ORIGINAL_TABINDEX)
  }
  if (node.hasAttribute(ORIGINAL_ARIA_HIDDEN)) {
    node.setAttribute('aria-hidden', node.getAttribute(ORIGINAL_ARIA_HIDDEN))
    node.removeAttribute(ORIGINAL_ARIA_HIDDEN)
  }
}

/**
 * Controller for one page. Create one, call start(), call stop() on dispose.
 */
export class ModelSelectorController {
  constructor(options = {}) {
    this.options = options
    this.doc = options.document ?? globalThis.document
    this.win = options.window ?? globalThis.window ?? globalThis
    this.storage = options.storage ?? this.win?.localStorage ?? null
    this.t = options.t ?? ((key) => key)
    this.Observer = options.MutationObserver ?? this.win?.MutationObserver ?? globalThis.MutationObserver
    this.requestFrame =
      options.requestAnimationFrame ??
      this.win?.requestAnimationFrame?.bind(this.win) ??
      ((callback) => setTimeout(callback, 16))
    this.cancelFrame =
      options.cancelAnimationFrame ??
      this.win?.cancelAnimationFrame?.bind(this.win) ??
      ((handle) => clearTimeout(handle))
    this.config = options.getConfig?.() ?? loadConfig(this.storage)
    this.records = new Map()
    this.unsubscribeConfig = null
    this.styleCleanup = null
    this.observer = null
    this.started = false
    this.scheduled = false
    this.frameHandle = null
    this.timers = new Set()
    this.diagnosticOnce = new Set()
    this.catalogFingerprint = catalogFingerprint(this.storage ? loadCatalog(this.storage) : [])
    this.refresh = this.refresh.bind(this)
    this.scan = this.scan.bind(this)
  }

  /** Begin observing and enhance any currently open menu. */
  start() {
    if (this.started || !this.doc) return
    this.started = true
    this.styleCleanup = installStyles(this.doc)
    if (this.win?.addEventListener) {
      this.unsubscribeConfig = subscribeConfig(this.win, (config) => {
        this.config = config
        this.refresh()
      })
    }
    this.scan()
    if (typeof this.Observer === 'function') {
      const root = this.doc.body ?? this.doc.documentElement
      if (root) {
        this.observer = new this.Observer((mutations) => {
          if (mutations.every(isOwnMutation)) return
          this.schedule()
        })
        this.observer.observe(root, { childList: true, subtree: true })
      }
    }
  }

  /** Remove every enhancement and release the observer/listeners. */
  stop() {
    if (!this.started) return
    this.started = false
    this.scheduled = false
    if (this.frameHandle !== null) {
      this.cancelFrame?.(this.frameHandle)
      this.frameHandle = null
    }
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.observer?.disconnect()
    this.observer = null
    this.unsubscribeConfig?.()
    this.unsubscribeConfig = null
    for (const record of this.records.values()) this.cleanupRecord(record)
    this.records.clear()
    this.styleCleanup?.()
    this.styleCleanup = null
  }

  /** Update the translator after the host locale changes. */
  setTranslator(translate) {
    if (typeof translate !== 'function') return
    this.t = translate
    for (const record of this.records.values()) {
      record.lastTabsSignature = ''
      this.refreshToolbarLabels(record)
      this.refreshRecord(record)
    }
  }

  /** Coalesce many React mutations into one scan. */
  schedule() {
    if (!this.started || this.scheduled) return
    this.scheduled = true
    this.frameHandle = this.requestFrame(() => {
      this.scheduled = false
      this.frameHandle = null
      this.scan()
    })
  }

  /** Find open model panes and make sure each one is enhanced. */
  scan() {
    if (!this.started || !this.doc) return
    const menus = findModelMenus(this.doc)
    const groupNodes = this.doc.querySelectorAll?.('section[data-menu-group]') ?? []
    if (menus.length === 0 && groupNodes.length > 0) {
      this.warnOnce('unrecognized', 'model menu groups were found but the model pane could not be identified')
    }
    for (const [menu, record] of [...this.records.entries()]) {
      if (!this.recordIntact(record)) {
        this.cleanupRecord(record)
        this.records.delete(menu)
      }
    }
    for (const menu of menus) this.enhanceMenu(menu)
    if (this.records.size === 0 && menus.some((menu) => (menu.querySelectorAll?.(MODEL_ROW_SELECTOR)?.length ?? 0) > 0)) {
      this.warnOnce('unreadable-rows', 'model rows were found but their provider/model ids could not be read')
    }
    this.refresh()
    this.persistCatalog()
  }

  /** Re-read every open menu and apply the current config. */
  refresh() {
    if (!this.started) return
    let removed = false
    for (const [menu, record] of [...this.records.entries()]) {
      if (!this.recordIntact(record)) {
        this.cleanupRecord(record)
        this.records.delete(menu)
        removed = true
        continue
      }
      this.refreshRecord(record)
    }
    if (removed) this.schedule()
  }

  /** Whether every node this record owns is still attached to the live menu. */
  recordIntact(record) {
    return (
      connected(record.menu, this.doc) &&
      connected(record.toolbar, this.doc) &&
      connected(record.tabsElement, this.doc) &&
      connected(record.groupCollapseButton, this.doc) &&
      connected(record.manageButton, this.doc) &&
      (record.searchInput === null || connected(record.searchInput, this.doc)) &&
      connected(record.statusElement, this.doc)
    )
  }

  /** Build the toolbar and state for one menu. */
  enhanceMenu(menu) {
    const existing = this.records.get(menu)
    if (existing?.toolbar && connected(existing.toolbar, this.doc) && existing.toolbar.parentElement === menu.parentElement) {
      return existing
    }
    if (existing) {
      this.cleanupRecord(existing)
      this.records.delete(menu)
    }
    const parent = menu.parentElement
    if (!parent) return null
    const catalog = readModelCatalog(menu)
    if (catalog.models.length === 0) return null

    const external = detectExternalSearch(menu)
    const nativeInput = [...(parent.querySelectorAll?.('input[role="searchbox"]') ?? [])].find(
      (input) => !input.closest?.('.dsh-toolbox-toolbar'),
    )
    const record = {
      menu,
      root: parent,
      catalog,
      external,
      externalInput: null,
      nativeSearch: null,
      nativeInput: null,
      toolbar: null,
      searchInput: null,
      clearButton: null,
      tabsElement: null,
      groupCollapseButton: null,
      statusElement: null,
      query: external ? readExternalQuery(menu) : '',
      activeGroupId: null,
      trigger: null,
      ungroupedCollapsed: false,
      collapsedProviders: new Set(),
      providerCollapseInitialized: false,
      preSearchCollapsed: null,
      wasSearching: false,
      headingClickBound: new WeakSet(),
      listeners: [],
      injected: [],
      lastTabsSignature: '',
      lastStatusSignature: '',
    }
    this.records.set(menu, record)

    const toolbar = element(this.doc, 'div', TOOLBAR_CLASS)
    record.toolbar = toolbar

    if (!external) {
      const searchRow = element(this.doc, 'div', 'dsh-toolbox-search-row')
      const wrap = element(this.doc, 'div', 'dsh-toolbox-search-wrap')
      const input = element(this.doc, 'input', 'dsh-toolbox-search', {
        type: 'text',
        role: 'searchbox',
        placeholder: this.t('search.placeholder'),
        'aria-label': this.t('search.aria'),
        autocomplete: 'off',
        spellcheck: 'false',
        'data-dsh-toolbox': 'search',
      })
      const clear = element(this.doc, 'button', 'dsh-toolbox-search-clear', {
        type: 'button',
        'aria-label': this.t('search.clear'),
        title: this.t('search.clear'),
      })
      clear.appendChild(clearIcon(this.doc))
      clear.style.display = 'none'
      wrap.append(input, clear)
      searchRow.appendChild(wrap)
      toolbar.appendChild(searchRow)
      record.searchInput = input
      record.clearButton = clear
      this.addListener(record, input, 'input', () => {
        record.query = input.value
        this.updateClearButton(record)
        this.refreshRecord(record)
      })
      this.addListener(record, clear, 'click', (event) => {
        event.preventDefault()
        this.clearQuery(record)
      })
    }

    const tabbar = element(this.doc, 'div', 'dsh-toolbox-row')
    const tabs = element(this.doc, 'div', 'dsh-toolbox-tabs', {
      role: 'toolbar',
      'aria-label': this.t('tabs.custom'),
    })
    tabs.style.flex = '1 1 auto'
    const manage = element(this.doc, 'button', 'dsh-toolbox-manage', {
      type: 'button',
      'aria-label': this.t('group.settings'),
      title: this.t('group.settings'),
    })
    manage.appendChild(gearIcon(this.doc))
    const groupCollapse = element(this.doc, 'button', 'dsh-toolbox-collapse dsh-toolbox-tab-collapse', {
      type: 'button',
      'aria-label': this.t('view.collapse'),
      title: this.t('view.collapse'),
      'aria-expanded': 'true',
      'data-collapsed': 'false',
    })
    groupCollapse.appendChild(chevron(this.doc, true))
    groupCollapse.style.display = 'none'
    tabbar.append(tabs, groupCollapse, manage)
    toolbar.appendChild(tabbar)
    record.tabsElement = tabs
    record.groupCollapseButton = groupCollapse
    record.manageButton = manage

    this.addListener(record, groupCollapse, 'click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const active = record.view?.active
      if (!active) return
      if (active.kind === 'custom') {
        this.updateConfig(setGroupCollapsed(this.config, active.id, active.collapsed !== true))
      } else if (active.kind === UNGROUPED_ID) {
        record.ungroupedCollapsed = !record.ungroupedCollapsed
        this.refreshRecord(record)
      }
    })

    this.addListener(record, tabs, 'click', (event) => {
      const tab = event.target?.closest?.('[data-group-id]')
      if (!tab || !tabs.contains(tab)) return
      event.preventDefault()
      this.selectTab(record, tab.getAttribute('data-group-id'))
    })
    this.addListener(record, manage, 'click', (event) => {
      event.preventDefault()
      this.openSettings(record)
    })
    this.addListener(record, toolbar, 'keydown', (event) => this.handleKeyDown(record, event), true)
    this.addListener(record, menu, 'keydown', (event) => this.handleKeyDown(record, event), true)
    const trigger = [...(this.doc.querySelectorAll?.('button[aria-haspopup="menu"][aria-expanded="true"]') ?? [])].find(
      (button) => /model|模型/i.test(button.getAttribute?.('aria-label') ?? button.textContent ?? ''),
    )
    if (trigger) {
      record.trigger = trigger
      this.addListener(record, trigger, 'keydown', (event) => this.handleTriggerKeyDown(record, event), true)
    }

    const status = element(this.doc, 'div', STATUS_CLASS, { 'data-visible': 'false' })
    record.statusElement = status
    parent.insertBefore(toolbar, menu)
    parent.insertBefore(status, menu)

    if (external) {
      this.bindExternalInput(record)
    } else if (nativeInput) {
      const row = nativeInput.closest?.('div') ?? nativeInput.parentElement ?? nativeInput
      record.nativeSearch = row
      record.nativeInput = nativeInput
      this.focusBeforeHide(record, row)
      setHidden(row, true)
    }

    this.refreshRecord(record)
    return record
  }

  /** Recompute one record from the live DOM and the current config. */
  refreshRecord(record) {
    if (!record?.menu || !connected(record.menu, this.doc)) return
    record.catalog = readModelCatalog(record.menu)
    record.view = buildViewModel(record.catalog.models, this.config, {
      query: record.query,
      activeGroupId: record.activeGroupId,
    })
    const searching = record.view.searching
    if (!record.wasSearching && searching) {
      record.preSearchCollapsed = new Set(record.collapsedProviders)
    } else if (record.wasSearching && !searching) {
      if (record.preSearchCollapsed) {
        record.collapsedProviders = new Set(record.preSearchCollapsed)
        record.preSearchCollapsed = null
      }
      this.ensureVisibleProviderExpanded(record)
    }
    record.wasSearching = searching
    this.initializeProviderCollapse(record)
    this.refreshToolbarLabels(record)
    this.refreshTabs(record)
    this.refreshGroupCollapse(record)
    this.applyVisibility(record)
    this.refreshStatus(record)
    this.updateClearButton(record)
  }

  /** Providers that have a heading and at least one row in the current view. */
  visibleProviderIds(record) {
    const view = record.view
    if (!view) return []
    const ids = []
    for (const group of record.catalog.groups) {
      if (!group.heading) continue
      if ((group.models ?? []).some((model) => view.visibleKeys.has(model.key)) && !ids.includes(group.providerId)) {
        ids.push(group.providerId)
      }
    }
    return ids
  }

  /**
   * On first render, expand only the provider that owns the selected model.
   * If that provider is not in the active view, expand the first visible one.
   */
  initializeProviderCollapse(record) {
    const view = record.view
    if (!view || view.searching || record.providerCollapseInitialized) return
    const visible = this.visibleProviderIds(record)
    const all = record.catalog.groups.filter((group) => group.heading).map((group) => group.providerId)
    const selectedProvider = record.catalog.models.find((model) => model.selected)?.providerId
    const expanded = visible.includes(selectedProvider) ? selectedProvider : visible[0]
    record.collapsedProviders = new Set(
      [...new Set(all)].filter((providerId) => providerId !== expanded),
    )
    record.providerCollapseInitialized = true
  }

  /** Never leave every visible provider folded, which would look like an empty menu. */
  ensureVisibleProviderExpanded(record) {
    if (record.view?.searching) return
    const visible = this.visibleProviderIds(record)
    if (visible.length === 0) return
    if (!visible.some((providerId) => !record.collapsedProviders.has(providerId))) {
      record.collapsedProviders.delete(visible[0])
    }
  }

  refreshToolbarLabels(record) {
    if (record.searchInput) {
      record.searchInput.setAttribute('placeholder', this.t('search.placeholder'))
      record.searchInput.setAttribute('aria-label', this.t('search.aria'))
    }
    if (record.clearButton) record.clearButton.setAttribute('aria-label', this.t('search.clear'))
    if (record.manageButton) {
      record.manageButton.setAttribute('aria-label', this.t('group.settings'))
      record.manageButton.setAttribute('title', this.t('group.settings'))
    }
    record.tabsElement?.setAttribute('aria-label', this.t('tabs.custom'))
  }

  /** Rebuild the tab row only when its labels, counts, or active tab change. */
  refreshTabs(record) {
    const view = record.view
    if (!record.tabsElement || !view) return
    const groups = sortGroups(this.config.groups)
    const entries = [
      { id: VIEW_ALL, label: this.t('tabs.all'), count: view.totalCount },
      ...groups.map((group) => ({
        id: group.id,
        label: group.name,
        count: view.counts.get(group.id) ?? 0,
      })),
    ]
    if (view.ungrouped) {
      entries.push({ id: UNGROUPED_ID, label: this.t('tabs.ungrouped'), count: view.ungrouped.count })
    }
    entries.push({ id: VIEW_PROVIDER, label: this.t('tabs.provider'), count: view.totalCount })
    const activeId = view.searching ? null : (view.activeId ?? VIEW_ALL)
    const signature = JSON.stringify({
      activeId,
      entries: entries.map((entry) => [entry.id, entry.label, entry.count]),
    })
    if (signature === record.lastTabsSignature) return
    record.lastTabsSignature = signature
    removeChildren(record.tabsElement)
    for (const entry of entries) {
      const tab = element(this.doc, 'button', 'dsh-toolbox-tab', {
        type: 'button',
        'data-group-id': entry.id,
        'data-active': entry.id === activeId ? 'true' : 'false',
        title: `${entry.label} · ${this.t('view.count', { count: entry.count })}`,
        'aria-pressed': entry.id === activeId ? 'true' : 'false',
      })
      const label = element(this.doc, 'span', 'dsh-toolbox-tab-label')
      label.textContent = entry.label
      const count = element(this.doc, 'span', 'dsh-toolbox-tab-count')
      count.textContent = String(entry.count)
      tab.append(label, count)
      record.tabsElement.appendChild(tab)
    }
  }

  /** Keep the custom-group fold control in the tab bar in sync with the active view. */
  refreshGroupCollapse(record) {
    const node = record.groupCollapseButton
    const view = record.view
    if (!node || !view) return
    const active = view.active
    const foldable =
      !view.searching &&
      active !== null &&
      (active.kind === 'custom' || active.kind === UNGROUPED_ID)
    node.style.display = foldable ? '' : 'none'
    if (!foldable) return
    const collapsed = active.kind === 'custom' ? active.collapsed === true : record.ungroupedCollapsed
    node.dataset.collapsed = String(collapsed)
    node.setAttribute('aria-expanded', String(!collapsed))
    node.setAttribute('aria-label', this.t(collapsed ? 'view.expand' : 'view.collapse'))
    node.setAttribute('title', this.t(collapsed ? 'view.expand' : 'view.collapse'))
  }

  /** Apply the active view/search to native rows without replacing them. */
  applyVisibility(record) {
    const view = record.view
    if (!view) return
    const activeCollapsed =
      !view.searching &&
      view.active !== null &&
      ((view.active.kind === 'custom' && view.active.collapsed === true) ||
        (view.active.kind === UNGROUPED_ID && record.ungroupedCollapsed === true))
    const hideHeadings =
      this.config.preserveProviderGroups !== true &&
      !view.searching &&
      (view.activeKind === 'custom' || view.activeKind === UNGROUPED_ID)
    const providerFoldEnabled = !hideHeadings && !view.searching

    for (const group of record.catalog.groups) {
      const matches = (group.models ?? []).filter((model) => view.visibleKeys.has(model.key))
      const collapsedProvider =
        providerFoldEnabled && record.collapsedProviders.has(group.providerId)
      for (const model of group.models ?? []) {
        const visible = view.visibleKeys.has(model.key) && !collapsedProvider && !activeCollapsed
        setHidden(model.button, !visible)
      }
      if (group.element === record.menu) continue
      const sectionHidden = activeCollapsed || matches.length === 0
      setHidden(group.element, sectionHidden)
      if (!group.heading) continue
      setHidden(group.heading, sectionHidden || hideHeadings)
      const controls = this.ensureHeadingControls(record, group)
      if (controls) {
        const label = String(matches.length)
        if (controls.badge.textContent !== label) controls.badge.textContent = label
        controls.badge.style.display = matches.length > 0 ? '' : 'none'
        controls.toggle.dataset.providerId = group.providerId
        controls.toggle.dataset.collapsed = String(collapsedProvider)
        controls.toggle.setAttribute('aria-expanded', String(!collapsedProvider))
        controls.toggle.setAttribute('aria-label', this.t(collapsedProvider ? 'view.expand' : 'view.collapse'))
        controls.toggle.setAttribute('title', this.t(collapsedProvider ? 'view.expand' : 'view.collapse'))
        setHidden(controls.toggle, matches.length === 0 || activeCollapsed || !providerFoldEnabled)
        group.heading.dataset.dshToolboxHeading =
          providerFoldEnabled && matches.length > 0 ? 'true' : 'false'
      }
      if (hideHeadings || sectionHidden) {
        this.applyRowIndent(record, group, 0)
      } else {
        const indent = this.providerIndent(record, group)
        if (indent !== null) this.applyRowIndent(record, group, indent)
      }
    }

    if (record.nativeSearch) {
      this.focusBeforeHide(record, record.nativeSearch)
      setHidden(record.nativeSearch, true)
    }
  }

  /** Add a collapse button and a count badge to a provider heading. */
  ensureHeadingControls(record, group) {
    const heading = group.heading
    if (!heading?.insertBefore) return null
    let toggle = directChild(heading, 'dsh-toolbox-group-toggle')
    if (!toggle) {
      toggle = element(this.doc, 'button', 'dsh-toolbox-group-toggle', {
        type: 'button',
        'data-provider-id': group.providerId,
        'data-dsh-toolbox-injected': 'true',
      })
      toggle.appendChild(chevron(this.doc, true))
      heading.insertBefore(toggle, heading.firstChild)
      record.injected.push(toggle)
      this.addListener(record, toggle, 'click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        this.toggleProvider(record, toggle.getAttribute('data-provider-id'))
      })
    }
    // Keep the icon first even when the host re-renders the heading.
    if (heading.firstChild !== toggle) heading.insertBefore(toggle, heading.firstChild)
    let badge = directChild(heading, 'dsh-toolbox-provider-badge')
    if (!badge) {
      badge = element(this.doc, 'span', 'dsh-toolbox-provider-badge', {
        'data-dsh-toolbox-injected': 'true',
      })
      heading.appendChild(badge)
      record.injected.push(badge)
    }
    // The count stays last: icon → name → count.
    if (heading.lastChild !== badge) heading.appendChild(badge)
    heading.dataset.dshToolboxHeading = 'true'
    heading.dataset.dshToolboxProviderId = group.providerId
    if (!record.headingClickBound.has(heading)) {
      record.headingClickBound.add(heading)
      this.addListener(record, heading, 'mousedown', (event) => {
        if (event.button !== 0) return
        if (event.target?.closest?.('.dsh-toolbox-group-toggle')) return
        // Keeping the current focus inside the menu prevents the host's menu
        // onBlur from closing the popup when the heading (a non-focusable div)
        // is clicked.
        event.preventDefault()
      })
      this.addListener(record, heading, 'click', (event) => {
        if (event.target?.closest?.('.dsh-toolbox-group-toggle')) return
        this.toggleProvider(record, group.providerId)
      })
    }
    return { toggle, badge }
  }

  /**
   * Measure how far one provider's rows must move to sit under its label.
   *
   * The disclosure button lives in the heading's text flow, so the label starts
   * one button footprint right of the heading's content edge. Subtracting the
   * indent already applied to the sample row keeps the value stable: it does not
   * feed its own result back in, and it re-measures after a theme or host change.
   * Returns null when there is nothing safe to measure (menu closed, provider
   * collapsed, no visible row).
   */
  providerIndent(record, group) {
    const heading = group.heading
    if (!heading || !record.menu?.getBoundingClientRect) return null
    if (record.menu.getBoundingClientRect().width === 0) return null
    const toggle = directChild(heading, 'dsh-toolbox-group-toggle')
    const toggleBox = toggle?.getBoundingClientRect?.()
    if (!toggleBox || toggleBox.width === 0) return null
    const headingGap = parseFloat(this.win?.getComputedStyle?.(heading)?.columnGap ?? '0') || 0
    const toggleMargin = parseFloat(this.win?.getComputedStyle?.(toggle)?.marginRight ?? '0') || 0
    const sample = (group.models ?? []).find((model) => {
      const button = model.button
      return button && button.getAttribute?.(HIDDEN) !== 'true' && button.getBoundingClientRect?.().width > 0
    })
    const label = sample?.button?.querySelector?.(MODEL_LABEL_SELECTOR)
    if (!label) return null
    const applied = Number(sample.button.dataset.dshToolboxIndent ?? 0)
    const labelLeft = label.getBoundingClientRect().left - applied
    return Math.round(toggleBox.right + toggleMargin + headingGap - labelLeft)
  }

  /**
   * Move every host row of one provider by `indent` pixels without touching its
   * structure or click handler. Padding (not margin) keeps the row's hover and
   * focus background full width, so only the text moves.
   */
  applyRowIndent(record, group, indent) {
    for (const model of group.models ?? []) {
      const button = model.button
      if (!button?.style) continue
      const applied = Number(button.dataset.dshToolboxIndent ?? 0)
      if (applied === indent) continue
      if (!button.hasAttribute('data-dsh-toolbox-indent-base')) {
        const inline = parseFloat(button.style.paddingLeft)
        const base = Number.isFinite(inline)
          ? inline
          : parseFloat(this.win?.getComputedStyle?.(button)?.paddingLeft ?? '0') || 0
        button.setAttribute('data-dsh-toolbox-indent-base', String(base))
      }
      const base = Number(button.getAttribute('data-dsh-toolbox-indent-base')) || 0
      button.style.paddingLeft = `${Math.max(0, base + indent)}px`
      button.dataset.dshToolboxIndent = String(indent)
    }
  }

  /** Toggle one provider's fold state; used by the heading and its chevron. */
  toggleProvider(record, providerId) {
    if (!providerId || record.view?.searching) return
    if (record.collapsedProviders.has(providerId)) record.collapsedProviders.delete(providerId)
    else record.collapsedProviders.add(providerId)
    this.refreshRecord(record)
  }

  /** Show the empty/collapsed state below the toolbar. */
  refreshStatus(record) {
    const node = record.statusElement
    const view = record.view
    if (!node || !view) return
    const activeCollapsed =
      !view.searching &&
      view.active !== null &&
      ((view.active.kind === 'custom' && view.active.collapsed === true) ||
        (view.active.kind === UNGROUPED_ID && record.ungroupedCollapsed === true))
    let title = ''
    let hint = ''
    if (activeCollapsed) {
      title = this.t('view.collapsedNotice')
      hint = this.t('view.expand')
    } else if (view.totalCount > 0 && view.matchedCount === 0) {
      title = this.t('status.noMatch')
      hint = this.t('status.noMatchHint')
    }
    const visible = title !== ''
    const signature = JSON.stringify([visible, title, hint])
    if (signature === record.lastStatusSignature && connected(node, this.doc)) return
    record.lastStatusSignature = signature
    node.setAttribute('data-visible', String(visible))
    removeChildren(node)
    if (!visible) return
    const titleNode = element(this.doc, 'div', 'dsh-toolbox-status-title')
    titleNode.textContent = title
    const hintNode = element(this.doc, 'div', 'dsh-toolbox-status-hint')
    hintNode.textContent = hint
    node.append(titleNode, hintNode)
  }

  /** A click on a tab changes only the current menu view, not the host model. */
  selectTab(record, id) {
    if (!id) return
    record.activeGroupId = id
    record.providerCollapseInitialized = false
    record.preSearchCollapsed = null
    if (id === VIEW_ALL || id === VIEW_PROVIDER) record.ungroupedCollapsed = false
    if (!record.external && record.searchInput?.value) {
      record.searchInput.value = ''
      record.query = ''
    }
    this.refreshRecord(record)
  }

  /**
   * Move focus into the toolbox search before hiding the host's search row.
   * Hiding the focused native input would otherwise blur to <body>, and the
   * host's menu onBlur would close the just-opened menu.
   */
  focusBeforeHide(record, row) {
    if (!record.searchInput) return
    const active = this.doc.activeElement
    if (!active || !row) return
    if (active === record.nativeInput || row.contains?.(active) || row === active) {
      record.searchInput.focus?.()
    }
  }

  /** Clear the toolbox search and restore the full list. */
  clearQuery(record) {
    record.query = ''
    if (record.searchInput) {
      record.searchInput.value = ''
      record.searchInput.focus?.()
    }
    this.refreshRecord(record)
  }

  updateClearButton(record) {
    if (!record.clearButton) return
    record.clearButton.style.display = record.query.trim() === '' ? 'none' : ''
  }

  /** Reuse a compatible `dsh-model-search` input when it is already installed. */
  bindExternalInput(record) {
    const input = findExternalSearchInput(record.menu)
    if (!input || input === record.externalInput) return
    record.externalInput = input
    record.query = typeof input.value === 'string' ? input.value : ''
    this.addListener(record, input, 'input', () => {
      record.query = input.value
      // Let the other plugin's React state settle before recomputing matches.
      this.schedule()
    })
  }

  /** Move keyboard focus among visible native rows only. */
  handleKeyDown(record, event) {
    if (event?.defaultPrevented || event?.isComposing) return
    const key = event.key
    const inToolbar = record.toolbar?.contains?.(event.target) === true
    const inMenu = record.menu?.contains?.(event.target) === true
    if (key === 'Escape') {
      if (record.external) return
      if (record.query.trim() !== '') {
        event.preventDefault()
        event.stopPropagation()
        this.clearQuery(record)
      }
      return
    }
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
      if (!inToolbar && !inMenu) return
      event.preventDefault()
      event.stopPropagation()
      this.moveFocus(record, key)
      return
    }
    if (key === 'Enter' && event.target === record.searchInput && record.query.trim() !== '') {
      const buttons = this.visibleButtons(record)
      if (buttons.length > 0) {
        event.preventDefault()
        event.stopPropagation()
        buttons[0].click()
      }
      return
    }
    if (key === 'Tab' && !event.shiftKey && event.target === record.searchInput) {
      const buttons = this.visibleButtons(record)
      if (buttons.length > 0) {
        event.preventDefault()
        event.stopPropagation()
        buttons[0].focus()
      }
    }
  }

  /** Keyboard entry from the trigger, whose own handler would otherwise focus the hidden native search. */
  handleTriggerKeyDown(record, event) {
    if (event?.defaultPrevented || event?.isComposing) return
    const key = event.key
    if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End' && key !== 'Tab') return
    if (key === 'Tab' && event.shiftKey) return
    const buttons = this.visibleButtons(record)
    if (record.searchInput) {
      event.preventDefault()
      event.stopPropagation()
      record.searchInput.focus?.()
      return
    }
    if (record.externalInput) {
      event.preventDefault()
      event.stopPropagation()
      record.externalInput.focus?.()
      return
    }
    if (buttons.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    if (key === 'ArrowUp' || key === 'End') buttons[buttons.length - 1].focus?.()
    else buttons[0].focus?.()
  }

  visibleButtons(record) {
    const buttons = []
    for (const model of record.catalog?.models ?? []) {
      const button = model.button
      if (!button || button.disabled === true || button.getAttribute?.('aria-disabled') === 'true') continue
      if (button.getAttribute?.(HIDDEN) === 'true') continue
      if (button.hidden === true) continue
      if (button.style?.display === 'none') continue
      buttons.push(button)
    }
    return buttons
  }

  moveFocus(record, key) {
    const buttons = this.visibleButtons(record)
    if (buttons.length === 0) return
    const active = buttons.indexOf(this.doc.activeElement)
    let next
    if (key === 'Home') next = 0
    else if (key === 'End') next = buttons.length - 1
    else {
      const delta = key === 'ArrowDown' ? 1 : -1
      next = active < 0 ? (delta > 0 ? 0 : buttons.length - 1) : (active + delta + buttons.length) % buttons.length
    }
    buttons[next]?.focus?.()
  }

  /** Open the plugin's settings tab, closing the model menu first. */
  openSettings(record) {
    if (typeof this.options.openSettings !== 'function') return
    this.closeMenu(record)
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      try {
        this.options.openSettings()
      } catch (error) {
        this.warnOnce('open-settings', `could not open settings: ${error instanceof Error ? error.message : String(error)}`)
      }
    }, 80)
    this.timers.add(timer)
  }

  closeMenu(record) {
    const triggers = [...(this.doc.querySelectorAll?.('button[aria-haspopup="menu"][aria-expanded="true"]') ?? [])]
    const trigger = triggers.find((button) => /model|模型/i.test(button.getAttribute?.('aria-label') ?? button.textContent ?? ''))
      ?? triggers[0]
    if (trigger) {
      trigger.click?.()
      return
    }
    try {
      const KeyboardEventConstructor = this.win?.KeyboardEvent ?? globalThis.KeyboardEvent
      record.menu.dispatchEvent(new KeyboardEventConstructor('keydown', { key: 'Escape', bubbles: true }))
    } catch {
      // The menu will be cleaned up by the observer when the host closes it.
    }
  }

  updateConfig(next) {
    try {
      if (typeof this.options.setConfig === 'function') {
        const saved = this.options.setConfig(next)
        this.config = saved ?? next
      } else if (this.storage) {
        this.config = saveConfig(this.storage, next, this.win)
      } else {
        this.config = next
      }
    } catch (error) {
      // Keep the in-memory view usable even when storage is full or disabled.
      this.config = next
      this.warnOnce('storage', `could not save configuration: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.refresh()
  }

  /** Save the catalog snapshot once per distinct catalog. */
  persistCatalog() {
    for (const record of this.records.values()) {
      const models = record.catalog?.models ?? []
      if (models.length === 0) continue
      const fingerprint = catalogFingerprint(models)
      if (fingerprint === this.catalogFingerprint) return
      try {
        if (this.storage) saveCatalog(this.storage, models, this.win)
        this.catalogFingerprint = fingerprint
      } catch (error) {
        this.warnOnce('catalog', `could not cache catalog: ${error instanceof Error ? error.message : String(error)}`)
      }
      return
    }
  }

  addListener(record, target, type, handler, capture = false) {
    target.addEventListener(type, handler, capture)
    record.listeners.push({ target, type, handler, capture })
  }

  cleanupRecord(record) {
    for (const { target, type, handler, capture } of record.listeners ?? []) {
      target.removeEventListener?.(type, handler, capture)
    }
    record.listeners.length = 0
    for (const node of record.injected ?? []) node.remove?.()
    record.injected.length = 0
    record.toolbar?.remove?.()
    record.statusElement?.remove?.()
    for (const heading of record.root?.querySelectorAll?.('[data-dsh-toolbox-heading]') ?? []) {
      heading.removeAttribute('data-dsh-toolbox-heading')
      heading.removeAttribute('data-dsh-toolbox-provider-id')
    }
    for (const node of record.root?.querySelectorAll?.('[data-dsh-toolbox-indent]') ?? []) {
      node.style.paddingLeft = ''
      node.removeAttribute('data-dsh-toolbox-indent')
      node.removeAttribute('data-dsh-toolbox-indent-base')
    }
    for (const node of record.root?.querySelectorAll?.(`[${HIDDEN}]`) ?? []) restoreNode(node)
    for (const node of record.root?.querySelectorAll?.(`[${ORIGINAL_TABINDEX}]`) ?? []) restoreNode(node)
    restoreNode(record.nativeSearch)
    record.toolbar = null
    record.groupCollapseButton = null
    record.statusElement = null
    record.nativeSearch = null
    record.catalog = null
    record.view = null
  }

  warnOnce(key, message) {
    if (this.diagnosticOnce.has(key)) return
    this.diagnosticOnce.add(key)
    const text = `[dsh-toolbox] ${message}`
    if (typeof this.options.logger === 'function') this.options.logger(text)
    else if (this.options.logger?.info) this.options.logger.info(text)
    else {
      try {
        this.win?.console?.info?.(text)
      } catch {
        // Diagnostics must never break the menu.
      }
    }
  }
}

/** Convenience factory used by the feature registry. */
export function createModelSelectorController(options) {
  return new ModelSelectorController(options)
}
