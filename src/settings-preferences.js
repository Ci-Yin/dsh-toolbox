/** Persistent UI preferences shared by the settings page and full-data export. */

export const SETTINGS_TAB_KEY = 'dsh-toolbox:settings-tab:v1'
export const SETTINGS_TABS = Object.freeze(['groups', 'identity', 'other'])

export function normalizeSettingsTab(value) {
  return SETTINGS_TABS.includes(value) ? value : null
}

/** Read the remembered sub-page; anything unexpected falls back to groups. */
export function readSettingsTab(storage) {
  try {
    return normalizeSettingsTab(storage?.getItem?.(SETTINGS_TAB_KEY)) ?? 'groups'
  } catch {
    return 'groups'
  }
}

/** Remember the sub-page (best effort; storage may be unavailable). */
export function writeSettingsTab(storage, tab) {
  try {
    storage?.setItem?.(SETTINGS_TAB_KEY, normalizeSettingsTab(tab) ?? 'groups')
  } catch {
    // Losing the preference is harmless.
  }
}
