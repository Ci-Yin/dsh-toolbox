/**
 * All visual additions are namespaced. The host's own model rows are never
 * restyled, only hidden or shown with the `data-dsh-toolbox-hidden` attribute.
 */

export const STYLE_ID = 'dsh-toolbox-styles'

export const css = String.raw`
.dsh-toolbox-toolbar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  box-sizing: border-box;
  width: 100%;
  padding: 8px 10px 9px;
  border-bottom: 1px solid var(--dsw-alias-border-secondary, rgba(127, 127, 127, .18));
  background: var(--dsw-alias-bg-base, var(--dsw-specific-menu, #fff));
  color: var(--dsw-alias-label-primary, #1f2328);
  font: inherit;
  flex: 0 0 auto;
}
.dsh-toolbox-search-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.dsh-toolbox-search {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  height: 30px;
  padding: 0 28px 0 9px;
  border: 1px solid var(--dsw-alias-border-secondary, rgba(127, 127, 127, .28));
  border-radius: 7px;
  outline: none;
  background: var(--dsw-alias-bg-secondary, rgba(127, 127, 127, .07));
  color: inherit;
  font: inherit;
  font-size: 13px;
}
.dsh-toolbox-search:focus {
  border-color: var(--dsw-alias-border-focus, #4d8dff);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-border-focus, #4d8dff) 22%, transparent);
}
.dsh-toolbox-search::placeholder {
  color: var(--dsw-alias-label-tertiary, #8b949e);
}
.dsh-toolbox-search-wrap {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
}
.dsh-toolbox-search-clear {
  position: absolute;
  right: 3px;
  top: 3px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #8b949e);
  cursor: pointer;
}
.dsh-toolbox-search-clear:hover {
  background: var(--dsw-alias-bg-hover, rgba(127, 127, 127, .12));
  color: var(--dsw-alias-label-primary, #1f2328);
}
.dsh-toolbox-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
  padding-bottom: 1px;
}
.dsh-toolbox-tabs::-webkit-scrollbar { display: none; }
.dsh-toolbox-tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
  max-width: 190px;
  height: 25px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #59636e);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
}
.dsh-toolbox-tab:hover {
  background: var(--dsw-alias-bg-hover, rgba(127, 127, 127, .09));
  color: var(--dsw-alias-label-primary, #1f2328);
}
.dsh-toolbox-tab[data-active="true"] {
  background: var(--dsw-alias-bg-active, rgba(77, 141, 255, .14));
  border-color: color-mix(in srgb, var(--dsw-alias-border-focus, #4d8dff) 35%, transparent);
  color: var(--dsw-alias-label-primary, #1f2328);
  font-weight: 600;
}
.dsh-toolbox-tab-label {
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-toolbox-tab-count,
.dsh-toolbox-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-secondary, rgba(127, 127, 127, .12));
  color: var(--dsw-alias-label-tertiary, #6e7781);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}
.dsh-toolbox-manage {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 27px;
  height: 27px;
  padding: 0;
  border: 1px solid var(--dsw-alias-border-secondary, rgba(127, 127, 127, .22));
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #59636e);
  cursor: pointer;
}
.dsh-toolbox-manage:hover {
  background: var(--dsw-alias-bg-hover, rgba(127, 127, 127, .1));
  color: var(--dsw-alias-label-primary, #1f2328);
}
.dsh-toolbox-collapse {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 19px;
  height: 19px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #6e7781);
  cursor: pointer;
}
.dsh-toolbox-collapse:hover {
  background: var(--dsw-alias-bg-hover, rgba(127, 127, 127, .12));
  color: var(--dsw-alias-label-primary, #1f2328);
}
.dsh-toolbox-collapse svg { width: 12px; height: 12px; display: block; }
.dsh-toolbox-tab-collapse {
  width: 27px;
  height: 27px;
  border: 1px solid var(--dsw-alias-border-secondary, rgba(127, 127, 127, .22));
  border-radius: 6px;
}
.dsh-toolbox-tab-collapse[data-collapsed="true"] svg { transform: rotate(-90deg); }
.dsh-toolbox-status {
  display: none;
  padding: 14px 12px;
  color: var(--dsw-alias-label-tertiary, #6e7781);
  font-size: 12px;
  text-align: center;
}
.dsh-toolbox-status[data-visible="true"] { display: block; }
.dsh-toolbox-status-title { font-weight: 600; color: var(--dsw-alias-label-secondary, #59636e); }
.dsh-toolbox-status-hint { margin-top: 3px; }
[data-dsh-toolbox-heading="true"] {
  cursor: pointer;
}
[data-dsh-toolbox-heading="true"]:hover {
  background: var(--dsw-alias-bg-hover, rgba(127, 127, 127, .08));
  border-radius: 4px;
}
.dsh-toolbox-group-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin: 0 5px 0 0;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #6e7781);
  vertical-align: -3px;
  cursor: pointer;
}
.dsh-toolbox-group-toggle:hover {
  background: var(--dsw-alias-bg-hover, rgba(127, 127, 127, .12));
}
.dsh-toolbox-group-toggle svg { width: 11px; height: 11px; display: block; }
.dsh-toolbox-group-toggle[data-collapsed="true"] svg { transform: rotate(-90deg); }
.dsh-toolbox-provider-badge {
  display: inline-flex;
  align-items: center;
  height: 15px;
  margin-left: 5px;
  padding: 0 4px;
  border-radius: 7px;
  background: var(--dsw-alias-bg-secondary, rgba(127, 127, 127, .12));
  color: var(--dsw-alias-label-tertiary, #6e7781);
  font-size: 10px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
[data-dsh-toolbox-hidden="true"] { display: none !important; }

/* Settings tab */
.dsh-toolbox-settings {
  box-sizing: border-box;
  width: 100%;
  max-width: 920px;
  padding: 4px 2px 28px;
  color: var(--dsw-alias-label-primary, #1f2328);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
}
.dsh-toolbox-settings-header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 16px;
}
.dsh-toolbox-settings-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--dsw-alias-border-focus, #4d8dff) 12%, transparent);
  color: var(--dsw-alias-border-focus, #4d8dff);
}
.dsh-toolbox-settings-icon svg { width: 21px; height: 21px; display: block; }
.dsh-toolbox-settings-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 0 0 14px;
  border-bottom: 1px solid var(--dsw-alias-border-secondary, rgba(127, 127, 127, .22));
}
.dsh-toolbox-settings-tab {
  appearance: none;
  margin: 0 0 -1px;
  padding: 8px 12px;
  border: 0;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #57606a);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.dsh-toolbox-settings-tab:hover {
  color: var(--dsw-alias-label-primary, #1f2328);
}
.dsh-toolbox-settings-tab[data-active="true"] {
  color: var(--dsw-alias-label-primary, #1f2328);
  border-bottom-color: var(--dsw-alias-border-focus, #4d8dff);
  font-weight: 600;
}
.dsh-toolbox-settings-tab:focus-visible {
  outline: 2px solid var(--dsw-alias-border-focus, #4d8dff);
  outline-offset: 2px;
}
.dsh-toolbox-settings[data-tab="groups"] .dsh-toolbox-settings-page[data-page="identity"],
.dsh-toolbox-settings[data-tab="identity"] .dsh-toolbox-settings-page[data-page="groups"] {
  display: none;
}
.dsh-toolbox-settings h2 {
  margin: 0;
  font-size: 17px;
  line-height: 1.3;
  font-weight: 650;
}
.dsh-toolbox-settings p { margin: 0; }
.dsh-toolbox-muted {
  color: var(--dsw-alias-label-tertiary, #6e7781);
  font-size: 12px;
}
.dsh-toolbox-card {
  margin-bottom: 14px;
  padding: 14px;
  border: 1px solid var(--dsw-alias-border-secondary, rgba(127, 127, 127, .2));
  border-radius: 10px;
  background: var(--dsw-alias-bg-secondary, rgba(127, 127, 127, .035));
}
.dsh-toolbox-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 10px;
}
.dsh-toolbox-card-title {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
}
.dsh-toolbox-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.dsh-toolbox-row-wrap { flex-wrap: wrap; }
.dsh-toolbox-spacer { flex: 1 1 auto; }
.dsh-toolbox-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-height: 28px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-secondary, rgba(127, 127, 127, .28));
  border-radius: 7px;
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-primary, #1f2328);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
}
.dsh-toolbox-button:hover {
  background: var(--dsw-alias-bg-hover, rgba(127, 127, 127, .08));
}
.dsh-toolbox-button:disabled { opacity: .5; cursor: default; }
.dsh-toolbox-button[data-variant="primary"] {
  border-color: transparent;
  background: var(--dsw-alias-border-focus, #4d8dff);
  color: #fff;
}
.dsh-toolbox-button[data-variant="danger"] {
  border-color: color-mix(in srgb, #d73a49 35%, transparent);
  color: #c62828;
}
.dsh-toolbox-button[data-variant="ghost"] {
  border-color: transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #59636e);
}
.dsh-toolbox-input {
  box-sizing: border-box;
  min-width: 0;
  height: 29px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-secondary, rgba(127, 127, 127, .28));
  border-radius: 6px;
  outline: none;
  background: var(--dsw-alias-bg-base, #fff);
  color: inherit;
  font: inherit;
  font-size: 12px;
}
.dsh-toolbox-input:focus {
  border-color: var(--dsw-alias-border-focus, #4d8dff);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-border-focus, #4d8dff) 18%, transparent);
}
.dsh-toolbox-select {
  height: 29px;
  padding: 0 26px 0 8px;
  border: 1px solid var(--dsw-alias-border-secondary, rgba(127, 127, 127, .28));
  border-radius: 6px;
  background: var(--dsw-alias-bg-base, #fff);
  color: inherit;
  font: inherit;
  font-size: 12px;
}
.dsh-toolbox-textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 90px;
  padding: 8px;
  border: 1px solid var(--dsw-alias-border-secondary, rgba(127, 127, 127, .28));
  border-radius: 7px;
  outline: none;
  background: var(--dsw-alias-bg-base, #fff);
  color: inherit;
  font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace;
  resize: vertical;
}
.dsh-toolbox-textarea:focus { border-color: var(--dsw-alias-border-focus, #4d8dff); }
.dsh-toolbox-group-list { display: flex; flex-direction: column; gap: 8px; }
.dsh-toolbox-group {
  border: 1px solid var(--dsw-alias-border-secondary, rgba(127, 127, 127, .2));
  border-radius: 9px;
  background: var(--dsw-alias-bg-base, #fff);
  overflow: hidden;
}
.dsh-toolbox-group[data-dragging="true"] { opacity: .55; }
.dsh-toolbox-group[data-drop="true"] { border-color: var(--dsw-alias-border-focus, #4d8dff); }
.dsh-toolbox-group-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  padding: 7px 8px;
  background: var(--dsw-alias-bg-secondary, rgba(127, 127, 127, .035));
  cursor: grab;
}
.dsh-toolbox-drag {
  flex: 0 0 auto;
  color: var(--dsw-alias-label-tertiary, #8b949e);
  cursor: grab;
  font-size: 12px;
  user-select: none;
}
.dsh-toolbox-group-name {
  flex: 1 1 140px;
  min-width: 100px;
  height: 26px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
}
.dsh-toolbox-group-name:hover { border-color: var(--dsw-alias-border-secondary, rgba(127, 127, 127, .25)); }
.dsh-toolbox-group-name:focus { border-color: var(--dsw-alias-border-focus, #4d8dff); outline: none; background: var(--dsw-alias-bg-base, #fff); }
.dsh-toolbox-group-body { padding: 9px 10px 10px; }
.dsh-toolbox-group-tools {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.dsh-toolbox-model-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 2px 10px;
  max-height: 240px;
  overflow: auto;
  padding: 3px;
  border: 1px solid var(--dsw-alias-border-secondary, rgba(127, 127, 127, .16));
  border-radius: 7px;
  background: var(--dsw-alias-bg-base, #fff);
}
.dsh-toolbox-provider-label {
  grid-column: 1 / -1;
  margin: 6px 0 2px;
  color: var(--dsw-alias-label-tertiary, #6e7781);
  font-size: 10px;
  font-weight: 650;
  letter-spacing: .04em;
  text-transform: uppercase;
}
.dsh-toolbox-check {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 3px 4px;
  border-radius: 5px;
  cursor: pointer;
  font-size: 12px;
}
.dsh-toolbox-check:hover { background: var(--dsw-alias-bg-hover, rgba(127, 127, 127, .08)); }
.dsh-toolbox-check input { flex: 0 0 auto; margin: 0; }
.dsh-toolbox-check-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-toolbox-check-id {
  margin-left: auto;
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary, #8b949e);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-toolbox-pref {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 6px 0;
}
.dsh-toolbox-pref-copy { flex: 1 1 auto; min-width: 0; }
.dsh-toolbox-pref-title { font-size: 13px; }
.dsh-toolbox-pref-hint { color: var(--dsw-alias-label-tertiary, #6e7781); font-size: 11px; }
.dsh-toolbox-switch {
  position: relative;
  flex: 0 0 auto;
  width: 34px;
  height: 20px;
  appearance: none;
  border: 0;
  border-radius: 10px;
  background: var(--dsw-alias-border-secondary, rgba(127, 127, 127, .35));
  cursor: pointer;
  transition: background .15s ease;
}
.dsh-toolbox-switch::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, .25);
  transition: transform .15s ease;
}
.dsh-toolbox-switch:checked { background: var(--dsw-alias-border-focus, #4d8dff); }
.dsh-toolbox-switch:checked::after { transform: translateX(14px); }
.dsh-toolbox-notice {
  margin-top: 8px;
  padding: 7px 9px;
  border-radius: 7px;
  background: color-mix(in srgb, #d73a49 8%, transparent);
  color: #b42318;
  font-size: 12px;
}
.dsh-toolbox-notice[data-kind="ok"] {
  background: color-mix(in srgb, #2da44e 9%, transparent);
  color: #1a7f37;
}
.dsh-toolbox-missing-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
  color: var(--dsw-alias-label-tertiary, #6e7781);
  font-size: 11px;
}
.dsh-toolbox-missing-key {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}
@media (max-width: 560px) {
  .dsh-toolbox-settings { padding-right: 0; padding-left: 0; }
  .dsh-toolbox-card { padding: 11px; }
  .dsh-toolbox-model-list { grid-template-columns: 1fr; }
  .dsh-toolbox-check-id { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-toolbox-switch, .dsh-toolbox-switch::after { transition: none; }
}

/* ---- Request identity rewrite ------------------------------------------ */
.dsh-toolbox-identity-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 10px;
}
.dsh-toolbox-identity-rules {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dsh-toolbox-identity-rule {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-secondary, rgba(127, 127, 127, .22));
  border-radius: 8px;
  background: var(--dsw-alias-bg-secondary, rgba(127, 127, 127, .05));
}
.dsh-toolbox-identity-rule[data-enabled="false"] {
  opacity: .55;
}
.dsh-toolbox-identity-rule-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.dsh-toolbox-identity-pattern {
  font-family: var(--dsw-alias-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  word-break: break-all;
}
.dsh-toolbox-identity-ua {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #57606a);
  word-break: break-all;
}
.dsh-toolbox-identity-meta {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #8b949e);
}
.dsh-toolbox-identity-rule-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  justify-content: flex-end;
  flex: 0 0 auto;
}
.dsh-toolbox-identity-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px;
  border: 1px dashed var(--dsw-alias-border-secondary, rgba(127, 127, 127, .32));
  border-radius: 8px;
}
.dsh-toolbox-identity-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.dsh-toolbox-identity-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary, #57606a);
}
.dsh-toolbox-identity-hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--dsw-alias-label-tertiary, #8b949e);
}
.dsh-toolbox-identity-warn {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--dsw-alias-state-warning-primary, #9a6700);
}
.dsh-toolbox-identity-error {
  font-size: 11px;
  color: var(--dsw-alias-state-error-primary, #cf222e);
}
.dsh-toolbox-identity-header-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.dsh-toolbox-identity-header-row > .dsh-toolbox-input {
  flex: 1 1 140px;
  min-width: 0;
}
.dsh-toolbox-identity-test {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--dsw-alias-border-secondary, rgba(127, 127, 127, .18));
}
.dsh-toolbox-identity-result {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-secondary, rgba(127, 127, 127, .07));
  font-size: 12px;
}
.dsh-toolbox-identity-result[data-kind="ok"] {
  border-left: 3px solid var(--dsw-alias-state-success-primary, #1a7f37);
}
.dsh-toolbox-identity-result[data-kind="warn"] {
  border-left: 3px solid var(--dsw-alias-state-warning-primary, #9a6700);
}
.dsh-toolbox-identity-result[data-kind="error"] {
  border-left: 3px solid var(--dsw-alias-state-error-primary, #cf222e);
}
.dsh-toolbox-identity-result-line {
  word-break: break-all;
}
.dsh-toolbox-identity-snippet {
  margin: 4px 0 0;
  max-height: 120px;
  overflow: auto;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-base, #fff);
  font-family: var(--dsw-alias-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
}
.dsh-toolbox-identity-unsupported {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}

/* Native workspace header shortcut. The host header contains two 28px
   controls; this attribute gives the third control room without changing the
   host's search-expanded hiding behavior. */
[data-dsh-toolbox-workspace-flat-host="true"] {
  max-width: 92px !important;
}
[data-dsh-toolbox-workspace-flat-host-hidden="true"] {
  max-width: 0 !important;
  opacity: 0;
  pointer-events: none;
  visibility: hidden;
  transform: translate(4px);
}
[data-dsh-toolbox-workspace-flat-toggle="true"] {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm, 5px);
  background: transparent;
  color: var(--dsw-alias-label-secondary, #6e7781);
  cursor: pointer;
}
[data-dsh-toolbox-workspace-flat-toggle="true"]:hover,
[data-dsh-toolbox-workspace-flat-toggle="true"][data-active="true"] {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .12));
  color: var(--dsw-alias-label-primary, #1f2328);
}
[data-dsh-toolbox-workspace-flat-toggle="true"]:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4d8dff));
  outline-offset: -2px;
}
[data-dsh-toolbox-workspace-flat-toggle="true"] svg {
  display: block;
}
`


/**
 * Insert the stylesheet once per document.
 *
 * The lease count lives on the DOM node rather than only in a module-local
 * WeakMap. Client bundle reloads evaluate this module again while the old
 * generation may still be mounted; a DOM-backed count keeps old cleanup from
 * removing a stylesheet still leased by the new generation.
 *
 * @param {Document} doc
 * @returns {() => void} cleanup
 */
const STYLE_LEASE_ATTRIBUTE = 'data-dsh-toolbox-style-leases'
const STYLE_OWNER_ATTRIBUTE = 'data-dsh-toolbox-style-owner'
const STYLE_OWNER = 'dsh-toolbox'
const OWNED_STYLE_SELECTOR = `style[${STYLE_OWNER_ATTRIBUTE}="${STYLE_OWNER}"]`

function styleLeaseCount(element) {
  const value = Number.parseInt(element?.getAttribute?.(STYLE_LEASE_ATTRIBUTE) ?? '', 10)
  return Number.isFinite(value) && value >= 0 ? value : 0
}

function findOwnedStyle(doc) {
  return doc.querySelector?.(OWNED_STYLE_SELECTOR) ?? null
}

function createOwnedStyle(doc, useReservedId) {
  const element = doc.createElement('style')
  if (useReservedId) element.id = STYLE_ID
  element.textContent = css
  element.setAttribute(STYLE_OWNER_ATTRIBUTE, STYLE_OWNER)
  element.setAttribute(STYLE_LEASE_ATTRIBUTE, '0')
  doc.head.appendChild(element)
  return element
}

export function installStyles(doc = globalThis.document) {
  if (!doc?.head) return () => {}
  const existing = findOwnedStyle(doc)
  const element = existing ?? createOwnedStyle(doc, !doc.getElementById?.(STYLE_ID))
  element.textContent = css
  element.setAttribute(STYLE_OWNER_ATTRIBUTE, STYLE_OWNER)
  element.setAttribute(STYLE_LEASE_ATTRIBUTE, String(styleLeaseCount(element) + 1))

  let released = false
  return () => {
    if (released) return
    released = true
    if (!element.isConnected || element.getAttribute?.(STYLE_OWNER_ATTRIBUTE) !== STYLE_OWNER) return
    const leases = styleLeaseCount(element)
    if (leases <= 1) {
      element.remove?.()
    } else {
      element.setAttribute(STYLE_LEASE_ATTRIBUTE, String(leases - 1))
    }
  }
}
