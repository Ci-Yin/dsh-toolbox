/**
 * Add a small shortcut next to the native workspace search button.
 *
 * The host workspace browser owns the real view store. This feature only
 * discovers that public slot registration and calls its public store action;
 * it never replaces the workspace slot or simulates a native menu click.
 */

import { installStyles } from './styles.js'

export const WORKSPACE_VIEW_PERSIST_KEY = 'dsh.workspace.view.v5'
export const LAST_GROUPED_VIEW_KEY = 'dsh-toolbox:workspace-last-group-by:v1'
export const WORKSPACE_FLAT_TOGGLE_ATTRIBUTE = 'data-dsh-toolbox-workspace-flat-toggle'
export const WORKSPACE_FLAT_HOST_ATTRIBUTE = 'data-dsh-toolbox-workspace-flat-host'
export const WORKSPACE_FLAT_HOST_HIDDEN_ATTRIBUTE = 'data-dsh-toolbox-workspace-flat-host-hidden'

const BUTTON_BINDING_KEY = '__dshToolboxWorkspaceFlatToggleBinding'
const DOCUMENT_OWNER_KEY = '__dshToolboxWorkspaceFlatToggleOwner'
const FLAT = 'flat'
const GROUPED = new Set(['workspace', 'workspace-tree'])

function safeStorage(windowObject, storage) {
  if (storage !== undefined) return storage
  try {
    return windowObject?.localStorage ?? null
  } catch {
    return null
  }
}

function readStorage(storage, key) {
  if (!storage || typeof storage.getItem !== 'function') return null
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(storage, key, value) {
  if (!storage || typeof storage.setItem !== 'function') return false
  try {
    storage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

export function normalizeGroupBy(value) {
  return value === FLAT || GROUPED.has(value) ? value : null
}

export function readLastGroupedView(storage) {
  const mode = normalizeGroupBy(readStorage(storage, LAST_GROUPED_VIEW_KEY))
  return GROUPED.has(mode) ? mode : 'workspace'
}

export function rememberGroupedView(storage, mode) {
  const normalized = normalizeGroupBy(mode)
  if (!GROUPED.has(normalized)) return false
  writeStorage(storage, LAST_GROUPED_VIEW_KEY, normalized)
  return true
}

function ariaLabel(node) {
  return String(node?.getAttribute?.('aria-label') ?? node?.getAttribute?.('title') ?? '').trim()
}

const NATIVE_WORKSPACE_CLASSES = Object.freeze({
  root: 'cIzfCa_root',
  sectionHeader: 'cIzfCa_sectionHeader',
  searchSlot: 'cIzfCa_searchSlot',
  headerActions: 'cIzfCa_headerActions',
})

function hasClass(node, className) {
  return node?.classList?.contains?.(className) === true
}

function isSearchButton(node) {
  return /搜索会话|search sessions/i.test(ariaLabel(node))
}

function isViewOptionsButton(node) {
  return /视图选项|view options/i.test(ariaLabel(node))
}

function directChildrenWithClass(parent, className) {
  return [...(parent?.children ?? [])].filter((child) => hasClass(child, className))
}

function findNativeWorkspaceHeader(root) {
  const headers = directChildrenWithClass(root, NATIVE_WORKSPACE_CLASSES.sectionHeader)
  if (headers.length !== 1) return null
  const header = headers[0]
  const searchSlots = directChildrenWithClass(header, NATIVE_WORKSPACE_CLASSES.searchSlot)
  const actionGroups = directChildrenWithClass(header, NATIVE_WORKSPACE_CLASSES.headerActions)
  if (searchSlots.length !== 1 || actionGroups.length !== 1) return null
  const searchButtons = [...(searchSlots[0].querySelectorAll?.('button') ?? [])].filter(isSearchButton)
  const viewButtons = [...(actionGroups[0].querySelectorAll?.('button[aria-label]') ?? [])].filter(isViewOptionsButton)
  if (searchButtons.length !== 1 || viewButtons.length !== 1) return null
  // The native control can be wrapped by a tooltip/menu trigger. insertBefore
  // requires a *direct* child of the action group, not the nested button.
  let viewAnchor = viewButtons[0]
  while (viewAnchor?.parentElement && viewAnchor.parentElement !== actionGroups[0]) {
    viewAnchor = viewAnchor.parentElement
  }
  if (viewAnchor?.parentElement !== actionGroups[0]) return null
  if (viewAnchor.querySelectorAll?.('button').length !== (viewAnchor === viewButtons[0] ? 0 : 1)) return null
  const expanded = searchButtons[0].getAttribute?.('aria-expanded')
  if (expanded !== 'true' && expanded !== 'false') return null
  return {
    root,
    header,
    searchSlot: searchSlots[0],
    searchButton: searchButtons[0],
    actions: actionGroups[0],
    viewButton: viewButtons[0],
    viewAnchor,
  }
}

/**
 * Find the one exact native workspace header for the checked host build.
 * Multiple roots or incomplete/ambiguous headers are rejected so another
 * panel cannot receive the shortcut by accident.
 */
export function findWorkspaceHeader(doc = globalThis.document) {
  if (!doc?.querySelectorAll) return null
  const roots = [...doc.querySelectorAll(`.${NATIVE_WORKSPACE_CLASSES.root}`)]
  const candidates = roots.map(findNativeWorkspaceHeader).filter(Boolean)
  return candidates.length === 1 ? candidates[0] : null
}

function createFlatListIcon(doc) {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.5')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('aria-hidden', 'true')
  for (const pathData of ['M6 3.5h7.5', 'M6 8h7.5', 'M6 12.5h7.5', 'M2.6 3.5h.01', 'M2.6 8h.01', 'M2.6 12.5h.01']) {
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', pathData)
    svg.appendChild(path)
  }
  return svg
}

function nativeStoreFromEntry(entry) {
  const handle = entry?.store
  const spec = handle?.spec
  if (
    !handle ||
    !spec ||
    spec.persist !== WORKSPACE_VIEW_PERSIST_KEY ||
    typeof spec.actions?.setGroupBy !== 'function' ||
    typeof handle.create !== 'function'
  ) {
    return null
  }
  // The checked host wraps the generic defineStore handle with
  // `create: () => viewInstance`. A generic handle has `create(scopeKey)` and
  // would allocate a detached store (and another persistence subscription), so
  // reject it without calling create twice.
  if (handle.create.length !== 0) return null
  try {
    const instance = handle.create()
    if (
      typeof instance?.getSnapshot !== 'function' ||
      typeof instance?.subscribe !== 'function' ||
      typeof instance?.actions?.setGroupBy !== 'function'
    ) {
      return null
    }
    return { handle, instance }
  } catch {
    return null
  }
}

/** Find the native view store registered by the host workspace browser. */
export function findNativeWorkspaceViewStore(slots) {
  if (typeof slots?.entriesOfSlot !== 'function') return null
  try {
    const entries = slots.entriesOfSlot('sidebar.workspaces')
    if (!Array.isArray(entries)) return null
    const matches = entries.map(nativeStoreFromEntry).filter(Boolean)
    return matches.length === 1 ? matches[0] : null
  } catch {
    return null
  }
}

export class WorkspaceFlatToggleController {
  constructor(options = {}) {
    this.doc = options.document ?? globalThis.document ?? null
    this.win = options.window ?? globalThis.window ?? null
    this.storage = safeStorage(this.win, options.storage)
    this.slots = options.slots ?? null
    this.t = options.t ?? ((key) => key)
    this.logger = options.logger ?? console
    this.Observer = options.Observer ?? this.win?.MutationObserver ?? globalThis.MutationObserver
    this.requestFrame = options.requestAnimationFrame ?? ((callback) => setTimeout(callback, 16))
    this.cancelFrame = options.cancelAnimationFrame ?? ((handle) => clearTimeout(handle))
    this.started = false
    this.styleCleanup = null
    this.lastGroupedView = readLastGroupedView(this.storage)
    this.observer = null
    this.slotUnsubscribe = null
    this.storeUnsubscribe = null
    this.store = null
    this.storeHandle = null
    this.button = null
    this.boundButton = null
    this.actions = null
    this.scheduled = false
    this.frameHandle = null
    this.refresh = this.refresh.bind(this)
    this.scan = this.scan.bind(this)
    this.toggle = this.toggle.bind(this)
  }

  isOwner() {
    return this.doc?.[DOCUMENT_OWNER_KEY] === this
  }

  claimOwnership() {
    if (!this.doc) return false
    const previous = this.doc[DOCUMENT_OWNER_KEY]
    if (previous === this) return true
    try {
      this.doc[DOCUMENT_OWNER_KEY] = this
    } catch {
      return false
    }
    if (previous?.started && typeof previous.stop === 'function') {
      try {
        previous.stop()
      } catch {
        // A stale generation must not prevent the new owner from starting.
      }
    }
    return true
  }

  releaseOwnership() {
    if (this.isOwner()) delete this.doc[DOCUMENT_OWNER_KEY]
  }

  disposeSafely(disposer, label) {
    if (typeof disposer !== 'function') return
    try {
      disposer()
    } catch (error) {
      this.logger?.warn?.(`[dsh-toolbox] ${label} cleanup failed`, error)
    }
  }

  start() {
    if (this.started || !this.doc || !this.claimOwnership()) return
    this.started = true
    this.styleCleanup = installStyles(this.doc)
    if (typeof this.slots?.subscribe === 'function') {
      try {
        const unsubscribe = this.slots.subscribe('sidebar.workspaces', this.refresh)
        this.slotUnsubscribe = typeof unsubscribe === 'function' ? unsubscribe : null
      } catch (error) {
        this.logger?.warn?.('[dsh-toolbox] workspace slot subscription unavailable', error)
      }
    }
    const root = this.doc.body ?? this.doc.documentElement
    if (typeof this.Observer === 'function' && root) {
      this.observer = new this.Observer((mutations) => {
        if (mutations.every((mutation) => mutation.type === 'attributes' && mutation.target === this.button)) return
        this.schedule()
      })
      this.observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-expanded', 'aria-label', 'class'],
      })
    }
    this.bindNativeStore()
    this.scan()
  }

  stop() {
    if (!this.started) return
    const owner = this.isOwner()
    this.started = false
    this.observer?.disconnect()
    this.observer = null
    this.disposeSafely(this.slotUnsubscribe, 'workspace slot subscription')
    this.slotUnsubscribe = null
    this.disposeSafely(this.storeUnsubscribe, 'native workspace store subscription')
    this.storeUnsubscribe = null
    this.store = null
    this.storeHandle = null
    this.disposeSafely(this.styleCleanup, 'workspace styles')
    this.styleCleanup = null
    if (this.frameHandle !== null) this.cancelFrame(this.frameHandle)
    this.frameHandle = null
    this.scheduled = false
    if (owner) this.removeOwnButtons()
    else {
      this.unbindButton()
      this.button = null
      this.actions = null
    }
    if (owner) this.releaseOwnership()
  }

  setTranslator(translate) {
    if (typeof translate !== 'function') return
    this.t = translate
    this.updateButton()
  }

  schedule() {
    if (!this.started || !this.isOwner() || this.scheduled) return
    this.scheduled = true
    this.frameHandle = this.requestFrame(() => {
      this.scheduled = false
      this.frameHandle = null
      this.refresh()
    })
  }

  refresh() {
    if (!this.started || !this.isOwner()) return
    this.bindNativeStore()
    this.scan()
  }

  bindNativeStore() {
    if (!this.isOwner()) return
    const candidate = findNativeWorkspaceViewStore(this.slots)
    if (candidate?.handle === this.storeHandle && candidate.instance === this.store) return
    this.disposeSafely(this.storeUnsubscribe, 'native workspace store subscription')
    this.storeUnsubscribe = null
    this.store = candidate?.instance ?? null
    this.storeHandle = candidate?.handle ?? null
    if (this.store) {
      try {
        const unsubscribe = this.store.subscribe(() => this.handleStoreChange())
        if (typeof unsubscribe !== 'function') throw new TypeError('native workspace store subscribe did not return a disposer')
        this.storeUnsubscribe = unsubscribe
        this.handleStoreChange()
      } catch (error) {
        this.disposeSafely(this.storeUnsubscribe, 'native workspace store subscription')
        this.storeUnsubscribe = null
        this.logger?.warn?.('[dsh-toolbox] native workspace view store unavailable', error)
        this.store = null
        this.storeHandle = null
      }
    }
  }

  handleStoreChange() {
    if (!this.started || !this.isOwner()) return
    const mode = this.currentMode()
    if (GROUPED.has(mode)) {
      this.lastGroupedView = mode
      rememberGroupedView(this.storage, mode)
    }
    this.updateButton()
  }

  currentMode() {
    try {
      return normalizeGroupBy(this.store?.getSnapshot?.()?.groupBy)
    } catch {
      return null
    }
  }

  toggle(event) {
    if (!this.started || !this.isOwner()) return
    event?.preventDefault?.()
    event?.stopPropagation?.()
    const mode = this.currentMode()
    if (!this.store || !mode || typeof this.store.actions?.setGroupBy !== 'function') return
    try {
      if (mode === FLAT) {
        const restoreMode = GROUPED.has(this.lastGroupedView) ? this.lastGroupedView : readLastGroupedView(this.storage)
        this.store.actions.setGroupBy(restoreMode)
      } else {
        this.lastGroupedView = mode
        rememberGroupedView(this.storage, mode)
        this.store.actions.setGroupBy(FLAT)
      }
    } catch (error) {
      this.logger?.warn?.('[dsh-toolbox] workspace flat toggle failed', error)
    }
    this.updateButton()
  }

  createButton() {
    const button = this.doc.createElement('button')
    button.type = 'button'
    button.className = 'dsh-toolbox-workspace-flat-toggle'
    button.setAttribute(WORKSPACE_FLAT_TOGGLE_ATTRIBUTE, 'true')
    button.appendChild(createFlatListIcon(this.doc))
    this.bindButton(button)
    return button
  }

  bindButton(button) {
    if (!button || !this.isOwner()) return
    const previousOwner = button[BUTTON_BINDING_KEY]
    if (previousOwner && previousOwner !== this) previousOwner.unbindButton(button)
    if (this.boundButton === button) return
    this.unbindButton()
    button.addEventListener?.('click', this.toggle)
    button[BUTTON_BINDING_KEY] = this
    this.boundButton = button
  }

  unbindButton(button = this.boundButton) {
    if (!button) return
    button.removeEventListener?.('click', this.toggle)
    if (button[BUTTON_BINDING_KEY] === this) delete button[BUTTON_BINDING_KEY]
    if (this.boundButton === button) this.boundButton = null
  }

  removeOwnButtons(keep = null) {
    if (!this.isOwner()) return
    if (this.boundButton && this.boundButton !== keep) this.unbindButton()
    for (const node of [...(this.doc?.querySelectorAll?.(`[${WORKSPACE_FLAT_TOGGLE_ATTRIBUTE}="true"]`) ?? [])]) {
      if (node === keep) continue
      node[BUTTON_BINDING_KEY]?.unbindButton?.(node)
      node.remove?.()
    }
    for (const host of [...(this.doc?.querySelectorAll?.(`[${WORKSPACE_FLAT_HOST_ATTRIBUTE}="true"], [${WORKSPACE_FLAT_HOST_HIDDEN_ATTRIBUTE}="true"]`) ?? [])]) {
      if (host === keep?.parentElement) continue
      host.removeAttribute?.(WORKSPACE_FLAT_HOST_ATTRIBUTE)
      host.removeAttribute?.(WORKSPACE_FLAT_HOST_HIDDEN_ATTRIBUTE)
    }
    if (this.button && this.button !== keep) {
      this.button = null
      this.actions = null
    }
  }

  scan() {
    if (!this.started || !this.isOwner() || !this.doc) return
    const header = findWorkspaceHeader(this.doc)
    if (!header || !this.store || !this.currentMode()) {
      this.removeOwnButtons()
      return
    }
    let button = [...(header.actions.querySelectorAll?.(`[${WORKSPACE_FLAT_TOGGLE_ATTRIBUTE}="true"]`) ?? [])][0] ?? null
    if (!button) button = this.createButton()
    this.removeOwnButtons(button)
    if (button.parentElement !== header.actions || button.nextElementSibling !== header.viewAnchor) {
      header.actions.insertBefore(button, header.viewAnchor)
    }
    const expanded = header.searchButton.getAttribute?.('aria-expanded')
    header.actions.removeAttribute(WORKSPACE_FLAT_HOST_ATTRIBUTE)
    header.actions.removeAttribute(WORKSPACE_FLAT_HOST_HIDDEN_ATTRIBUTE)
    if (expanded === 'true') {
      header.actions.setAttribute(WORKSPACE_FLAT_HOST_HIDDEN_ATTRIBUTE, 'true')
    } else if (expanded === 'false') {
      header.actions.setAttribute(WORKSPACE_FLAT_HOST_ATTRIBUTE, 'true')
    }
    this.button = button
    this.actions = header.actions
    this.bindButton(button)
    this.updateButton()
  }

  updateButton() {
    if (!this.button || !this.isOwner()) return
    const flat = this.currentMode() === FLAT
    const label = this.t(flat ? 'workspace.flatToggle.restore' : 'workspace.flatToggle.enable')
    this.button.setAttribute('aria-label', label)
    this.button.setAttribute('title', label)
    this.button.setAttribute('aria-pressed', flat ? 'true' : 'false')
    this.button.dataset.active = flat ? 'true' : 'false'
  }
}

export function createWorkspaceFlatToggleController(options) {
  return new WorkspaceFlatToggleController(options)
}
