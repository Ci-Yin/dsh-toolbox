/**
 * DSH Toolbox feature registry.
 *
 * Each feature owns one capability and can be added without touching the
 * feature's neighbours. Today the registry contains workspace flat-list
 * switching and model groups/search; a message editing or rollback feature
 * can be appended in a later phase.
 */

import { createModelSelectorController } from './model-selector.js'
import { createWorkspaceFlatToggleController } from './workspace-flat-toggle.js'
import { createSettingsPanel } from './settings-panel.js'
import { NS, en, zh } from './i18n.js'

/**
 * Best-effort navigation from the model menu to Settings → Plugins → DSH
 * Toolbox. This only clicks visible host controls; it never calls a private
 * host service. If the structure differs, the button stays on the menu and the
 * user can open Settings manually.
 */
export function navigateToToolboxSettings(doc = globalThis.document) {
  if (!doc) return false
  const existing = doc.querySelector?.('div[role="dialog"][data-shortcut-modal="settings"]')
  if (existing) {
    return selectToolboxTab(existing)
  }

  const triggers = [...(doc.querySelectorAll?.('button[aria-haspopup="dialog"]') ?? [])]
  const settingsTrigger = triggers.find((button) => {
    const label = button.getAttribute?.('aria-label') || button.getAttribute?.('title') || button.textContent || ''
    return /设置|settings/i.test(label)
  })
  if (!settingsTrigger) return false
  settingsTrigger.click?.()

  const start = Date.now()
  const tick = () => {
    const dialog = doc.querySelector?.('div[role="dialog"][data-shortcut-modal="settings"]')
    if (dialog) {
      selectToolboxTab(dialog)
      return
    }
    if (Date.now() - start < 1500) {
      setTimeout(tick, 50)
    }
  }
  setTimeout(tick, 50)
  return true
}

/** Click the Plugins navigation entry and then the DSH Toolbox tab. */
function selectToolboxTab(dialog) {
  const nav = [...(dialog.querySelectorAll?.('nav button') ?? [])]
  const plugins = nav.find((button) => /内置插件|插件|plugins/i.test(button.textContent || ''))
  if (plugins) plugins.click?.()
  const start = Date.now()
  const tick = () => {
    const tabs = [...(dialog.querySelectorAll?.('button[role="tab"]') ?? [])]
    const toolbox = tabs.find((button) => /dsh toolbox|模型分组|model groups/i.test(button.textContent || ''))
    if (toolbox) {
      toolbox.click?.()
      return true
    }
    if (Date.now() - start < 1200) setTimeout(tick, 50)
    return false
  }
  setTimeout(tick, 40)
  return true
}

/**
 * Shortcut for toggling the native workspace browser into one flat list.
 */
export const workspaceFlatToggleFeature = {
  id: 'workspace-flat-toggle',
  name: 'Workspace flat-list toggle',
  description: 'Toggle the native workspace browser between one list and the previous grouped view.',
  inject: ['slots', 'locale'],
  defaultEnabled: true,

  apply(ctx, helpers) {
    const doc = typeof document !== 'undefined' ? document : null
    const win = typeof window !== 'undefined' ? window : null
    const controller = createWorkspaceFlatToggleController({
      document: doc,
      window: win,
      slots: ctx.slots,
      t: helpers.t,
      logger: ctx.logger ?? console,
    })
    helpers.workspaceFlatToggle = controller
    if (doc) controller.start()
    return () => controller.stop()
  },
}

export const modelGroupsFeature = {
  id: 'model-groups',
  name: 'Model groups and search',
  description: 'Search by provider, model name, or model id; assign models to persistent groups and fold them.',
  inject: ['slots', 'locale'],
  defaultEnabled: true,
  settingsTab: 'dsh-toolbox',
  configSchema: {
    version: 1,
    keys: ['version', 'mode', 'groups', 'showUngrouped', 'preserveProviderGroups'],
  },

  apply(ctx, helpers) {
    const doc = typeof document !== 'undefined' ? document : null
    const win = typeof window !== 'undefined' ? window : null
    const storage = typeof localStorage !== 'undefined' ? localStorage : null
    const t = helpers.t

    const controller = createModelSelectorController({
      document: doc,
      window: win,
      storage,
      t,
      openSettings: () => navigateToToolboxSettings(doc),
      logger: ctx.logger ?? console,
    })
    helpers.controller = controller
    if (doc) controller.start()

    let slotDisposer = null
    if (helpers.React && ctx.slots?.inject) {
      const SettingsView = createSettingsPanel(helpers.React)
      const Component = (props) =>
        helpers.React.createElement(SettingsView, {
          ...props,
          t,
          storage,
          window: win,
        })
      slotDisposer = ctx.slots.inject('settings.plugins.tab', () =>
        ctx.slots.register(
          {
            name: 'settings.plugins.tab',
            id: 'dsh-toolbox',
            order: 20,
            label: () => t('settings.tab'),
            locale: NS,
          },
          Component,
        ),
      )
    }

    return () => {
      try {
        if (typeof slotDisposer === 'function') slotDisposer()
      } catch {
        // The slot owner may already be disposed during page teardown.
      }
      controller.stop()
    }
  },
}

/** Active features. Append `messageEditFeature` here in phase 2. */
export const features = [modelGroupsFeature, workspaceFlatToggleFeature]

/**
 * Build the plugin face consumed by the Web module factory.
 * @param {{ React: object }} runtime
 */
export function createToolbox({ React }) {
  return {
    inject: ['slots', 'locale'],
    apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-toolbox: locale dictionaries')
      const helpers = { React, t, ctx, controller: null, workspaceFlatToggle: null }
      const offLocale = ctx.locale.subscribe(() => {
        const nextTranslator = ctx.locale.bind(NS)
        helpers.controller?.setTranslator(nextTranslator)
        helpers.workspaceFlatToggle?.setTranslator(nextTranslator)
      })
      ctx.effect(
        () => () => {
          if (typeof offLocale === 'function') offLocale()
        },
        'dsh-toolbox: locale subscription',
      )

      const cleanups = []
      for (const feature of features) {
        try {
          const cleanup = feature.apply(ctx, helpers)
          if (typeof cleanup === 'function') cleanups.push(cleanup)
        } catch (error) {
          ctx.logger?.error?.(`[dsh-toolbox] failed to apply feature ${feature.id}`, error)
        }
      }
      ctx.effect(
        () => () => {
          for (const cleanup of cleanups.reverse()) {
            try {
              cleanup()
            } catch (error) {
              ctx.logger?.error?.('[dsh-toolbox] feature cleanup failed', error)
            }
          }
        },
        'dsh-toolbox: feature cleanups',
      )
    },
    features,
  }
}
