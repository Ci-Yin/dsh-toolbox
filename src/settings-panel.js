/**
 * Settings tab for DSH Toolbox.
 *
 * Implemented as a vanilla React component (using React.createElement) so that
 * it runs directly in the browser runtime without any compiler or bundle tool.
 */

import {
  addGroup,
  cleanGroupName,
  modelsByProvider,
  moveGroup,
  removeGroup,
  removeMissingModelKeys,
  renameGroup,
  reorderGroups,
  setGroupCollapsed,
  setGroupModels,
  toggleModelInGroup,
} from './model-groups.js'
import {
  exportConfig,
  importConfig,
  loadCatalog,
  loadConfig,
  missingModelKeys,
  resetConfig,
  saveConfig,
  subscribeCatalog,
  subscribeConfig,
} from './model-storage.js'
import { matchesQuery } from './model-groups.js'
import { createIdentitySection } from './identity-client.js'

/** Which sub-page of the toolbox settings tab is showing. */
export const SETTINGS_TAB_KEY = 'dsh-toolbox:settings-tab:v1'

/** Read the remembered sub-page; anything unexpected falls back to groups. */
export function readSettingsTab(storage) {
  try {
    return storage?.getItem?.(SETTINGS_TAB_KEY) === 'identity' ? 'identity' : 'groups'
  } catch {
    return 'groups'
  }
}

/** Remember the sub-page (best effort; storage may be unavailable). */
export function writeSettingsTab(storage, tab) {
  try {
    storage?.setItem?.(SETTINGS_TAB_KEY, tab === 'identity' ? 'identity' : 'groups')
  } catch {
    // Losing the preference is harmless.
  }
}

export function createSettingsPanel(React) {
  const h = React.createElement
  const { useState, useEffect, useMemo, useCallback, useRef } = React
  const IdentitySection = createIdentitySection(React)

  return function SettingsPanel(props) {
    const t = props.t ?? ((key, params) => key)
    const storage = props.storage ?? globalThis.localStorage ?? null
    const win = props.window ?? globalThis.window ?? globalThis

    const [config, setConfig] = useState(() => loadConfig(storage))
    const configRef = useRef(config)
    const [catalog, setCatalog] = useState(() => loadCatalog(storage))
    const [selectedGroupId, setSelectedGroupId] = useState(() => config.groups[0]?.id ?? null)
    const [modelSearch, setModelSearch] = useState('')
    const [newGroupName, setNewGroupName] = useState('')
    const [nameDrafts, setNameDrafts] = useState({})
    const [importText, setImportText] = useState('')
    const [notice, setNotice] = useState(null) // { kind: 'ok' | 'error', message: string }
    const [draggedGroupId, setDraggedGroupId] = useState(null)
    const [dropTargetGroupId, setDropTargetGroupId] = useState(null)
    const fileInputRef = useRef(null)
    const [activeTab, setActiveTab] = useState(() => readSettingsTab(storage))

    useEffect(() => {
      writeSettingsTab(storage, activeTab)
    }, [storage, activeTab])

    // Keep a ref in sync so a save never mutates React state from inside an
    // updater function (which runs during render in concurrent React).
    useEffect(() => {
      configRef.current = config
    }, [config])

    // Keep state in sync with cross-component or cross-window updates
    useEffect(() => {
      if (!win) return
      const offConfig = subscribeConfig(win, (nextConfig) => {
        configRef.current = nextConfig
        setConfig(nextConfig)
      })
      const offCatalog = subscribeCatalog(win, (nextCatalog) => {
        setCatalog(nextCatalog)
      })
      return () => {
        offConfig()
        offCatalog()
      }
    }, [win])

    const persistConfig = useCallback(
      (updater) => {
        const previous = configRef.current
        const next = typeof updater === 'function' ? updater(previous) : updater
        try {
          saveConfig(storage, next, win)
          configRef.current = next
          setConfig(next)
        } catch (err) {
          setNotice({
            kind: 'error',
            message: t('settings.data.storageError', { message: err?.message || String(err) }),
          })
        }
      },
      [storage, win, t],
    )

    // Ensure selectedGroupId stays valid if groups change
    useEffect(() => {
      if (config.groups.length === 0) {
        setSelectedGroupId(null)
      } else if (!config.groups.some((g) => g.id === selectedGroupId)) {
        setSelectedGroupId(config.groups[0].id)
      }
    }, [config.groups, selectedGroupId])

    const activeGroup = useMemo(() => {
      return config.groups.find((g) => g.id === selectedGroupId) || null
    }, [config.groups, selectedGroupId])

    const staleKeys = useMemo(() => {
      // Without a catalog snapshot, every key would look stale. Wait until the
      // menu has been opened once before reporting missing models.
      if (catalog.length === 0) return []
      return missingModelKeys(config, catalog)
    }, [config, catalog])

    // Filter catalog models by query
    const filteredModels = useMemo(() => {
      if (!modelSearch.trim()) return catalog
      return catalog.filter((m) => matchesQuery(m, modelSearch))
    }, [catalog, modelSearch])

    const filteredProviders = useMemo(() => {
      return modelsByProvider(filteredModels)
    }, [filteredModels])

    // Handlers
    const handleCreateGroup = (e) => {
      e?.preventDefault()
      const name = cleanGroupName(newGroupName.trim(), '')
      if (!name) return
      const current = configRef.current
      const next = addGroup(current, name)
      const created = next.groups.find((group) => !current.groups.some((existing) => existing.id === group.id))
      persistConfig(next)
      if (created) setSelectedGroupId(created.id)
      setNewGroupName('')
      setNotice({ kind: 'ok', message: t('settings.saved') })
    }

    const handleDeleteGroup = (group) => {
      const confirmMsg = t('settings.groups.deleteConfirm', { name: group.name })
      if (win.confirm && !win.confirm(confirmMsg)) return
      persistConfig((prev) => removeGroup(prev, group.id))
      setNotice({ kind: 'ok', message: t('settings.saved') })
    }

    const handleRenameGroup = (groupId, newName) => {
      persistConfig((prev) => renameGroup(prev, groupId, newName))
    }

    const handleMoveGroup = (groupId, delta) => {
      persistConfig((prev) => ({
        ...prev,
        groups: moveGroup(prev.groups, groupId, delta),
      }))
    }

    const handleToggleCollapse = (groupId, collapsed) => {
      persistConfig((prev) => setGroupCollapsed(prev, groupId, collapsed))
    }

    const handleModelToggle = (modelKey) => {
      if (!activeGroup) return
      persistConfig((prev) => toggleModelInGroup(prev, activeGroup.id, modelKey))
    }

    const handleBatchAdd = () => {
      if (!activeGroup) return
      const keysToAdd = filteredModels.map((m) => m.key)
      persistConfig((prev) => {
        const currentKeys = new Set(activeGroup.modelKeys)
        for (const k of keysToAdd) currentKeys.add(k)
        return setGroupModels(prev, activeGroup.id, [...currentKeys])
      })
    }

    const handleBatchRemove = () => {
      if (!activeGroup) return
      const keysToRemove = new Set(filteredModels.map((m) => m.key))
      persistConfig((prev) => {
        const nextKeys = activeGroup.modelKeys.filter((k) => !keysToRemove.has(k))
        return setGroupModels(prev, activeGroup.id, nextKeys)
      })
    }

    const handleRemoveStaleKeys = () => {
      const available = catalog.map((m) => m.key)
      persistConfig((prev) => removeMissingModelKeys(prev, available))
      setNotice({ kind: 'ok', message: t('settings.saved') })
    }

    const handleModeChange = (e) => {
      const nextMode = e.target.value
      persistConfig((prev) => ({ ...prev, mode: nextMode }))
    }

    const handleToggleUngrouped = (e) => {
      const checked = e.target.checked
      persistConfig((prev) => ({ ...prev, showUngrouped: checked }))
    }

    const handleTogglePreserveProviders = (e) => {
      const checked = e.target.checked
      persistConfig((prev) => ({ ...prev, preserveProviderGroups: checked }))
    }

    const handleExport = () => {
      const json = exportConfig(config)
      setImportText(json)
      if (win.navigator?.clipboard?.writeText) {
        win.navigator.clipboard.writeText(json).catch(() => {})
      }
      setNotice({ kind: 'ok', message: t('settings.data.copied') })
    }

    const handleDownload = () => {
      const json = exportConfig(config)
      try {
        const blob = new Blob([json], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `dsh-toolbox-config-${new Date().toISOString().slice(0, 10)}.json`
        a.click()
        URL.revokeObjectURL(url)
      } catch (err) {
        setNotice({ kind: 'error', message: String(err) })
      }
    }

    const handleImport = () => {
      if (!importText.trim()) return
      try {
        const imported = importConfig(storage, importText, win)
        setConfig(imported)
        setNameDrafts({})
        setNotice({ kind: 'ok', message: t('settings.data.importSuccess') })
      } catch (err) {
        setNotice({
          kind: 'error',
          message: t('settings.data.importError', { message: err?.message || String(err) }),
        })
      }
    }

    const handleFileImport = (e) => {
      const file = e.target?.files?.[0]
      if (!file) return
      const input = e.target
      const reader = new FileReader()
      reader.onload = (event) => {
        const content = event.target?.result
        if (typeof content === 'string') {
          setImportText(content)
          try {
            const imported = importConfig(storage, content, win)
            setConfig(imported)
            setNameDrafts({})
            setNotice({ kind: 'ok', message: t('settings.data.importSuccess') })
          } catch (err) {
            setNotice({
              kind: 'error',
              message: t('settings.data.importError', { message: err?.message || String(err) }),
            })
          }
        }
        input.value = ''
      }
      reader.onerror = () => {
        input.value = ''
      }
      reader.readAsText(file)
    }

    const handleReset = () => {
      if (win.confirm && !win.confirm(t('settings.data.restoreConfirm'))) return
      try {
        const fresh = resetConfig(storage, win)
        setConfig(fresh)
        setNameDrafts({})
        setNotice({ kind: 'ok', message: t('settings.saved') })
      } catch (err) {
        setNotice({
          kind: 'error',
          message: t('settings.data.storageError', { message: err?.message || String(err) }),
        })
      }
    }

    // Drag-and-drop group reordering
    const handleDragStart = (e, groupId) => {
      setDraggedGroupId(groupId)
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
    }

    const handleDragOver = (e, targetGroupId) => {
      e.preventDefault()
      if (draggedGroupId && draggedGroupId !== targetGroupId) {
        setDropTargetGroupId(targetGroupId)
      }
    }

    const handleDrop = (e, targetGroupId) => {
      e.preventDefault()
      if (draggedGroupId && draggedGroupId !== targetGroupId) {
        persistConfig((prev) => ({
          ...prev,
          groups: reorderGroups(prev.groups, draggedGroupId, targetGroupId),
        }))
      }
      setDraggedGroupId(null)
      setDropTargetGroupId(null)
    }

    const handleDragEnd = () => {
      setDraggedGroupId(null)
      setDropTargetGroupId(null)
    }

    return h(
      'div',
      { className: 'dsh-toolbox-settings', 'data-tab': activeTab },

      // Header
      h(
        'div',
        { className: 'dsh-toolbox-settings-header' },
        h(
          'div',
          { className: 'dsh-toolbox-settings-icon' },
          h(
            'svg',
            {
              viewBox: '0 0 24 24',
              width: 22,
              height: 22,
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 2,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
            },
            h('path', { d: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z' }),
          ),
        ),
        h(
          'div',
          null,
          h('h2', null, t('meta.title')),
          h('p', { className: 'dsh-toolbox-muted' }, t('meta.description')),
        ),
      ),

      // Sub-page tabs: model groups vs. request identity
      h(
        'div',
        { className: 'dsh-toolbox-settings-tabs', role: 'tablist', 'aria-label': t('settings.tabs.aria') },
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            className: 'dsh-toolbox-settings-tab',
            'data-tab': 'groups',
            'data-active': activeTab === 'groups' ? 'true' : 'false',
            'aria-selected': activeTab === 'groups' ? 'true' : 'false',
            onClick: () => setActiveTab('groups'),
          },
          t('settings.tabs.groups'),
        ),
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            className: 'dsh-toolbox-settings-tab',
            'data-tab': 'identity',
            'data-active': activeTab === 'identity' ? 'true' : 'false',
            'aria-selected': activeTab === 'identity' ? 'true' : 'false',
            onClick: () => setActiveTab('identity'),
          },
          t('settings.tabs.identity'),
        ),
      ),

      // Page: model groups
      h(
        'div',
        { className: 'dsh-toolbox-settings-page', 'data-page': 'groups' },

        // Notification bar
        notice
          ? h(
              'div',
              {
                className: 'dsh-toolbox-notice',
                'data-kind': notice.kind,
              },
              notice.message,
            )
          : null,

        // Section 1: Catalog Status
        h(
          'div',
          { className: 'dsh-toolbox-card' },
          h(
            'div',
            { className: 'dsh-toolbox-card-head' },
            h('h3', { className: 'dsh-toolbox-card-title' }, t('settings.catalog.title')),
            h(
              'span',
              { className: 'dsh-toolbox-count' },
              t('settings.catalog.summary', { count: catalog.length }),
            ),
          ),
          catalog.length === 0
            ? h('p', { className: 'dsh-toolbox-muted' }, t('settings.catalog.empty'))
            : h('p', { className: 'dsh-toolbox-muted' }, t('settings.catalog.hint')),
        ),

        // Section 2: Preferences / Opening Behavior
      h(
        'div',
        { className: 'dsh-toolbox-card' },
        h('div', { className: 'dsh-toolbox-card-head' }, h('h3', { className: 'dsh-toolbox-card-title' }, t('settings.prefs.title'))),

        // Default view select
        h(
          'div',
          { className: 'dsh-toolbox-pref' },
          h(
            'div',
            { className: 'dsh-toolbox-pref-copy' },
            h('div', { className: 'dsh-toolbox-pref-title' }, t('settings.prefs.defaultView')),
          ),
          h(
            'select',
            {
              className: 'dsh-toolbox-select',
              value: config.mode,
              onChange: handleModeChange,
            },
            h('option', { value: 'custom' }, t('settings.prefs.defaultView.custom')),
            h('option', { value: 'all' }, t('settings.prefs.defaultView.all')),
            h('option', { value: 'provider' }, t('settings.prefs.defaultView.provider')),
          ),
        ),

        // Show ungrouped switch
        h(
          'div',
          { className: 'dsh-toolbox-pref' },
          h(
            'div',
            { className: 'dsh-toolbox-pref-copy' },
            h('div', { className: 'dsh-toolbox-pref-title' }, t('settings.prefs.showUngrouped')),
          ),
          h('input', {
            type: 'checkbox',
            className: 'dsh-toolbox-switch',
            checked: config.showUngrouped !== false,
            onChange: handleToggleUngrouped,
          }),
        ),

        // Preserve provider headings switch
        h(
          'div',
          { className: 'dsh-toolbox-pref' },
          h(
            'div',
            { className: 'dsh-toolbox-pref-copy' },
            h('div', { className: 'dsh-toolbox-pref-title' }, t('settings.prefs.preserveProviderGroups')),
          ),
          h('input', {
            type: 'checkbox',
            className: 'dsh-toolbox-switch',
            checked: config.preserveProviderGroups === true,
            onChange: handleTogglePreserveProviders,
          }),
        ),
      ),

      // Section 3: Custom Group Management
      h(
        'div',
        { className: 'dsh-toolbox-card' },
        h(
          'div',
          { className: 'dsh-toolbox-card-head' },
          h('h3', { className: 'dsh-toolbox-card-title' }, t('settings.groups.title')),
          h(
            'form',
            { onSubmit: handleCreateGroup, className: 'dsh-toolbox-row' },
            h('input', {
              type: 'text',
              className: 'dsh-toolbox-input',
              maxLength: 80,
              placeholder: t('settings.groups.namePlaceholder'),
              value: newGroupName,
              onChange: (e) => setNewGroupName(e.target.value),
            }),
            h(
              'button',
              {
                type: 'submit',
                className: 'dsh-toolbox-button',
                'data-variant': 'primary',
                disabled: !newGroupName.trim(),
              },
              t('settings.groups.new'),
            ),
          ),
        ),

        // Group cards list
        config.groups.length === 0
          ? h('p', { className: 'dsh-toolbox-muted' }, t('settings.groups.empty'))
          : h(
              'div',
              { className: 'dsh-toolbox-group-list' },
              config.groups.map((group, idx) => {
                const isSelected = group.id === selectedGroupId
                const isDragging = group.id === draggedGroupId
                const isDropTarget = group.id === dropTargetGroupId

                return h(
                  'div',
                  {
                    key: group.id,
                    className: 'dsh-toolbox-group',
                    'data-dragging': isDragging ? 'true' : 'false',
                    'data-drop': isDropTarget ? 'true' : 'false',
                    onDragOver: (e) => handleDragOver(e, group.id),
                    onDrop: (e) => handleDrop(e, group.id),
                  },

                  // Group head (draggable row)
                  h(
                    'div',
                    {
                      className: 'dsh-toolbox-group-head',
                      draggable: true,
                      onDragStart: (e) => handleDragStart(e, group.id),
                      onDragEnd: handleDragEnd,
                    },
                    h('span', { className: 'dsh-toolbox-drag', title: t('group.dragHint') }, '⋮⋮'),
                    h('input', {
                      type: 'text',
                      className: 'dsh-toolbox-group-name',
                      maxLength: 80,
                      value: nameDrafts[group.id] ?? group.name,
                      onChange: (e) =>
                        setNameDrafts((previous) => ({ ...previous, [group.id]: e.target.value })),
                      onBlur: (e) => {
                        const draft = e.currentTarget.value
                        handleRenameGroup(group.id, draft)
                        setNameDrafts((previous) => {
                          const next = { ...previous }
                          delete next[group.id]
                          return next
                        })
                      },
                      onKeyDown: (e) => {
                        if (e.key === 'Enter') e.currentTarget.blur()
                      },
                    }),
                    h(
                      'span',
                      { className: 'dsh-toolbox-count' },
                      t('settings.groups.count', { count: group.modelKeys.length }),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-toolbox-button',
                        'data-variant': isSelected ? 'primary' : 'ghost',
                        onClick: () => {
                          setSelectedGroupId(group.id)
                          if (group.collapsed) handleToggleCollapse(group.id, false)
                        },
                      },
                      t('settings.groups.members'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-toolbox-button',
                        disabled: idx === 0,
                        onClick: () => handleMoveGroup(group.id, -1),
                        title: t('settings.groups.up'),
                      },
                      '↑',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-toolbox-button',
                        disabled: idx === config.groups.length - 1,
                        onClick: () => handleMoveGroup(group.id, 1),
                        title: t('settings.groups.down'),
                      },
                      '↓',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-toolbox-button',
                        onClick: () => handleToggleCollapse(group.id, !group.collapsed),
                      },
                      t(group.collapsed ? 'settings.groups.collapsed' : 'settings.groups.expanded'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-toolbox-button',
                        'data-variant': 'danger',
                        onClick: () => handleDeleteGroup(group),
                      },
                      t('settings.groups.delete'),
                    ),
                  ),

                  // Group members assignment (shown if group is selected and expanded)
                  isSelected && !group.collapsed
                    ? h(
                        'div',
                        { className: 'dsh-toolbox-group-body' },
                        h(
                          'div',
                          { className: 'dsh-toolbox-group-tools' },
                          h('input', {
                            type: 'text',
                            className: 'dsh-toolbox-input',
                            style: { flex: '1 1 180px' },
                            placeholder: t('settings.groups.searchPlaceholder'),
                            value: modelSearch,
                            onChange: (e) => setModelSearch(e.target.value),
                          }),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'dsh-toolbox-button',
                              onClick: handleBatchAdd,
                              disabled: filteredModels.length === 0,
                            },
                            t('settings.groups.batchAdd'),
                          ),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'dsh-toolbox-button',
                              onClick: handleBatchRemove,
                              disabled: filteredModels.length === 0,
                            },
                            t('settings.groups.batchRemove'),
                          ),
                        ),

                        // Model checkbox grid grouped by provider
                        filteredProviders.length === 0
                          ? h('p', { className: 'dsh-toolbox-muted' }, t('settings.groups.noModels'))
                          : h(
                              'div',
                              { className: 'dsh-toolbox-model-list' },
                              filteredProviders.map((provider) =>
                                h(
                                  React.Fragment,
                                  { key: provider.providerId },
                                  h(
                                    'div',
                                    { className: 'dsh-toolbox-provider-label' },
                                    provider.providerName,
                                  ),
                                  provider.models.map((model) => {
                                    const isChecked = group.modelKeys.includes(model.key)
                                    return h(
                                      'label',
                                      {
                                        key: model.key,
                                        className: 'dsh-toolbox-check',
                                        title: `${model.name} (${model.modelId})`,
                                      },
                                      h('input', {
                                        type: 'checkbox',
                                        checked: isChecked,
                                        onChange: () => handleModelToggle(model.key),
                                      }),
                                      h('span', { className: 'dsh-toolbox-check-name' }, model.name),
                                      h('span', { className: 'dsh-toolbox-check-id' }, model.modelId),
                                    )
                                  }),
                                ),
                              ),
                            ),
                      )
                    : null,
                )
              }),
            ),
      ),

      // Section 4: Stale Model Keys Warning & Cleanup
      staleKeys.length > 0
        ? h(
            'div',
            { className: 'dsh-toolbox-card' },
            h(
              'div',
              { className: 'dsh-toolbox-card-head' },
              h('h3', { className: 'dsh-toolbox-card-title' }, t('settings.missing.title')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-toolbox-button',
                  'data-variant': 'danger',
                  onClick: handleRemoveStaleKeys,
                },
                t('settings.missing.remove'),
              ),
            ),
            h('p', { className: 'dsh-toolbox-muted' }, t('settings.missing.hint')),
            h(
              'div',
              { style: { marginTop: 8 } },
              staleKeys.map((stale, idx) =>
                h(
                  'div',
                  { key: idx, className: 'dsh-toolbox-missing-row' },
                  h('span', { style: { fontWeight: 600 } }, `[${stale.groupName}]`),
                  h('span', { className: 'dsh-toolbox-missing-key' }, stale.key),
                  h('span', null, `— ${t('group.missing')}`),
                ),
              ),
            ),
          )
        : null,

      // Section 5: Data Export / Import / Reset
      h(
        'div',
        { className: 'dsh-toolbox-card' },
        h(
          'div',
          { className: 'dsh-toolbox-card-head' },
          h('h3', { className: 'dsh-toolbox-card-title' }, t('settings.data.title')),
          h(
            'div',
            { className: 'dsh-toolbox-row' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-toolbox-button',
                onClick: handleExport,
              },
              t('settings.data.copy'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-toolbox-button',
                onClick: handleDownload,
              },
              t('settings.data.download'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-toolbox-button',
                'data-variant': 'danger',
                onClick: handleReset,
              },
              t('settings.data.restore'),
            ),
          ),
        ),
        h('p', { className: 'dsh-toolbox-muted' }, t('settings.data.importHint')),
        h('textarea', {
          className: 'dsh-toolbox-textarea',
          style: { marginTop: 8 },
          placeholder: t('settings.data.importPlaceholder'),
          value: importText,
          onChange: (e) => setImportText(e.target.value),
        }),
        h(
          'div',
          { className: 'dsh-toolbox-row', style: { marginTop: 8 } },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-toolbox-button',
              'data-variant': 'primary',
              disabled: !importText.trim(),
              onClick: handleImport,
            },
            t('settings.data.import'),
          ),
          h('input', {
            type: 'file',
            accept: '.json',
            ref: fileInputRef,
            style: { display: 'none' },
            onChange: handleFileImport,
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-toolbox-button',
              onClick: () => fileInputRef.current?.click(),
            },
            t('settings.data.chooseFile'),
          ),
        ),
      ),
      ),

      // Page: request identity rewrite (host fetch patch)
      h(
        'div',
        { className: 'dsh-toolbox-settings-page', 'data-page': 'identity' },
        h(IdentitySection, { key: 'identity', t, win }),
      ),
    )
  }
}
