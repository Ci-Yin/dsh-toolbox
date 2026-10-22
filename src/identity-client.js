/**
 * Settings card for the request-identity feature.
 *
 * The card is a static Web-GUI plugin: it has no host.call channel, so it reads
 * and writes the host's identity document through the two same-origin HTTP
 * routes registered by `src/identity-host.js`. Every draft is validated with
 * the same `identity-core` functions the host uses, so the browser and the host
 * can never disagree about what a valid rule is.
 *
 * @module dsh-toolbox/identity-client
 */

import {
  IDENTITY_LIMITS,
  hostFromPattern,
  isReservedHeader,
  isValidHeaderName,
  modelsUrlFor,
  sanitizeRule,
  suggestRuleId,
} from './identity-core.js'

export const IDENTITY_API = '/api/dsh-toolbox.identity'
export const IDENTITY_TEST_API = '/api/dsh-toolbox.identity-test'

/** HTTP client for the host routes, tolerant of a missing/older host. */
export function createIdentityApi(win = globalThis) {
  const request = async (path, init) => {
    const fetchImpl = win?.fetch
    if (typeof fetchImpl !== 'function') {
      const error = new Error('fetch-unavailable')
      error.code = 'fetch-unavailable'
      throw error
    }
    const response = await fetchImpl.call(win, path, init)
    let body = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    if (!response.ok || body?.ok === false) {
      const bare404 = response.status === 404 && body?.code === undefined
      const error = new Error(body?.code ?? (bare404 ? 'route-missing' : `http-${response.status}`))
      error.code = body?.code ?? (bare404 ? 'route-missing' : `http-${response.status}`)
      error.status = response.status
      error.body = body
      throw error
    }
    return body
  }

  return {
    read() {
      return request(IDENTITY_API, { headers: { accept: 'application/json' } })
    },
    save(value, expectedRevision) {
      return request(IDENTITY_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ value, expectedRevision }),
      })
    },
    test(url) {
      return request(IDENTITY_TEST_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ url }),
      })
    },
  }
}

/** Coerce a host snapshot into the shape the card edits. */
export function normalizeIdentityValue(value) {
  return {
    enabled: value?.enabled !== false,
    diagnostics: value?.diagnostics === true,
    rules: Array.isArray(value?.rules)
      ? value.rules.map((rule) => ({
          id: String(rule?.id ?? ''),
          enabled: rule?.enabled !== false,
          urlPattern: String(rule?.urlPattern ?? ''),
          userAgent: String(rule?.userAgent ?? ''),
          headers: Array.isArray(rule?.headers)
            ? rule.headers.map((header) => ({
                name: String(header?.name ?? ''),
                value: String(header?.value ?? ''),
              }))
            : [],
          note: String(rule?.note ?? ''),
        }))
      : [],
  }
}

/** Turn the card's draft state into a rule the host will accept. */
export function draftToRule(draft, rules = [], editingId = null) {
  const id = editingId ?? suggestRuleId(draft?.urlPattern, rules.map((rule) => rule.id).filter((existing) => existing !== editingId))
  return sanitizeRule({
    id,
    enabled: true,
    urlPattern: draft?.urlPattern ?? '',
    userAgent: draft?.userAgent ?? '',
    note: draft?.note ?? '',
    headers: draft?.headers ?? [],
  })
}

/** Map sanitizer error codes onto `field` keys for inline display. */
export function errorsByField(errors = []) {
  const out = {}
  for (const error of errors) {
    if (typeof error?.field !== 'string') continue
    if (out[error.field] === undefined) out[error.field] = error.code
  }
  return out
}

/** Human-readable text for a route/discovery failure. */
export function identityErrorText(t, error) {
  const code = error?.code ?? 'unknown'
  switch (code) {
    case 'settings-absent':
      return t('identity.error.settingsAbsent')
    case 'namespace-missing':
      return t('identity.error.namespaceMissing')
    case 'route-missing':
      return t('identity.error.routeMissing')
    case 'untrusted-request':
      return t('identity.error.untrusted')
    case 'settings-conflict':
      return t('identity.error.conflict')
    case 'invalid-config':
      return t('identity.error.invalid')
    case 'invalid-url':
      return t('identity.error.invalidUrl')
    case 'test-failed':
      return t('identity.error.testFailed', { message: error?.message ?? '' })
    case 'method-not-allowed':
      return t('identity.error.method')
    case 'fetch-unavailable':
      return t('identity.error.offline')
    default:
      return t('identity.error.generic', { message: error?.message ?? String(error) })
  }
}

/** Build the identity card component for the settings tab. */
export function createIdentitySection(React) {
  const h = React.createElement
  const { useState, useEffect, useMemo, useCallback } = React

  return function IdentitySection(props) {
    const t = props.t ?? ((key) => key)
    const win = props.win ?? globalThis

    const api = useMemo(() => createIdentityApi(win), [win])

    const [phase, setPhase] = useState('loading') // loading | ready | unsupported | error
    const [snapshot, setSnapshot] = useState(null)
    const [draft, setDraft] = useState(null)
    const [fieldErrors, setFieldErrors] = useState({})
    const [notice, setNotice] = useState(null)
    const [busy, setBusy] = useState(false)
    const [providerId, setProviderId] = useState('')
    const [testUrl, setTestUrl] = useState('')
    const [testResult, setTestResult] = useState(null)

    const acceptSnapshot = useCallback((body) => {
      const value = normalizeIdentityValue(body?.value)
      setSnapshot({
        value,
        revision: body?.revision,
        providers: Array.isArray(body?.providers) ? body.providers : [],
        stats: body?.stats !== null && typeof body?.stats === 'object' ? body.stats : {},
        writable: body?.writable !== false,
      })
      setPhase('ready')
      const firstWithBase = (Array.isArray(body?.providers) ? body.providers : []).find(
        (provider) => typeof provider?.baseURL === 'string' && provider.baseURL.length > 0,
      )
      if (firstWithBase) {
        setProviderId((current) => current || firstWithBase.provider)
        setTestUrl((current) => current || modelsUrlFor(firstWithBase.baseURL))
      }
    }, [])

    const load = useCallback(async () => {
      try {
        const body = await api.read()
        acceptSnapshot(body)
        setNotice(null)
      } catch (error) {
        if (
          error?.code === 'namespace-missing' ||
          error?.code === 'settings-absent' ||
          error?.code === 'route-missing'
        ) {
          setPhase('unsupported')
        } else {
          setPhase('error')
        }
        setNotice({ kind: 'error', message: identityErrorText(t, error) })
      }
    }, [api, acceptSnapshot, t])

    useEffect(() => {
      load()
    }, [load])

    const commit = useCallback(
      async (nextValue, successMessage) => {
        if (snapshot === null) return false
        setBusy(true)
        try {
          const body = await api.save(nextValue, snapshot.revision)
          acceptSnapshot(body)
          const dropped = Array.isArray(body?.droppedHeaders) ? body.droppedHeaders : []
          setNotice({
            kind: 'ok',
            message:
              dropped.length > 0
                ? t('identity.droppedHeaders', { names: dropped.join(', ') })
                : successMessage ?? t('settings.saved'),
          })
          setFieldErrors({})
          return true
        } catch (error) {
          if (error?.code === 'settings-conflict') {
            setNotice({ kind: 'error', message: t('identity.error.conflict') })
            await load()
          } else if (error?.code === 'invalid-config') {
            setFieldErrors(errorsByField(error.body?.errors ?? []))
            setNotice({ kind: 'error', message: t('identity.error.invalid') })
          } else {
            setNotice({ kind: 'error', message: identityErrorText(t, error) })
          }
          return false
        } finally {
          setBusy(false)
        }
      },
      [acceptSnapshot, api, load, snapshot, t],
    )

    const value = snapshot?.value ?? { enabled: false, diagnostics: false, rules: [] }
    const rules = value.rules
    const stats = snapshot?.stats ?? {}

    const replaceRule = useCallback(
      (ruleId, update) => {
        const next = rules.map((rule) => (rule.id === ruleId ? update(rule) : rule))
        return commit({ ...value, rules: next })
      },
      [commit, rules, value],
    )

    const moveRule = (index, delta) => {
      const target = index + delta
      if (target < 0 || target >= rules.length) return
      const next = [...rules]
      const [moved] = next.splice(index, 1)
      next.splice(target, 0, moved)
      commit({ ...value, rules: next })
    }

    const removeRule = (rule) => {
      const confirmMessage = t('identity.deleteConfirm', { pattern: rule.urlPattern })
      if (typeof win?.confirm === 'function' && !win.confirm(confirmMessage)) return
      commit({ ...value, rules: rules.filter((entry) => entry.id !== rule.id) })
    }

    const beginNew = (seed = {}) => {
      setFieldErrors({})
      setDraft({
        editingId: null,
        urlPattern: seed.urlPattern ?? '',
        userAgent: seed.userAgent ?? '',
        note: seed.note ?? '',
        headers: [],
      })
    }

    const beginEdit = (rule) => {
      setFieldErrors({})
      setDraft({
        editingId: rule.id,
        urlPattern: rule.urlPattern,
        userAgent: rule.userAgent,
        note: rule.note,
        headers: rule.headers.map((header) => ({ ...header })),
      })
    }

    const saveDraft = async () => {
      if (draft === null) return
      const sanitized = draftToRule(draft, rules, draft.editingId)
      if (sanitized.errors.length > 0) {
        setFieldErrors(errorsByField(sanitized.errors))
        setNotice({ kind: 'error', message: t('identity.error.invalid') })
        return
      }
      const rule = draft.editingId === null ? { ...sanitized.rule, enabled: true } : sanitized.rule
      const nextRules =
        draft.editingId === null
          ? [...rules, rule]
          : rules.map((entry) => (entry.id === draft.editingId ? { ...rule, enabled: entry.enabled } : entry))
      const saved = await commit({ ...value, rules: nextRules })
      if (saved) setDraft(null)
    }

    const selectedProvider = snapshot?.providers?.find((provider) => provider.provider === providerId) ?? null

    const generateFromProvider = () => {
      if (selectedProvider === null) return
      const pattern = hostFromPattern(selectedProvider.baseURL) || selectedProvider.provider
      beginNew({ urlPattern: pattern, note: selectedProvider.displayName ?? selectedProvider.provider })
      if (testUrl.trim().length === 0) setTestUrl(modelsUrlFor(selectedProvider.baseURL))
    }

    const runTest = async () => {
      const url = testUrl.trim()
      if (url.length === 0) return
      setBusy(true)
      setTestResult(null)
      try {
        const body = await api.test(url)
        setTestResult({ ok: true, ...body })
      } catch (error) {
        setTestResult({ ok: false, message: identityErrorText(t, error), code: error?.code })
      } finally {
        setBusy(false)
      }
    }

    const fieldError = (field) => {
      const code = fieldErrors[field]
      return code === undefined ? null : t(`identity.fieldError.${code}`)
    }

    const reservedDraftHeaders =
      draft === null
        ? []
        : draft.headers
            .map((header) => header.name.trim().toLowerCase())
            .filter((name) => name.length > 0 && isReservedHeader(name))

    const ruleRows = rules.map((rule, index) => {
      const hits = stats[rule.id] ?? null
      const matchText =
        hits !== null && hits.count > 0
          ? t('identity.hits', { count: hits.count, hosts: (hits.hosts ?? []).join(', ') })
          : t('identity.noHits')
      return h(
        'div',
        {
          key: rule.id,
          className: 'dsh-toolbox-identity-rule',
          'data-enabled': rule.enabled ? 'true' : 'false',
        },
        h(
          'div',
          { className: 'dsh-toolbox-identity-rule-main' },
          h('code', { className: 'dsh-toolbox-identity-pattern' }, rule.urlPattern),
          h(
            'span',
            { className: 'dsh-toolbox-identity-ua' },
            rule.userAgent.length > 0 ? rule.userAgent : t('identity.hostUserAgent'),
          ),
          h('span', { className: 'dsh-toolbox-identity-meta' }, matchText),
          rule.note.length > 0 ? h('span', { className: 'dsh-toolbox-muted' }, rule.note) : null,
        ),
        h(
          'div',
          { className: 'dsh-toolbox-identity-rule-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-toolbox-button',
              title: t('settings.groups.up'),
              disabled: busy || index === 0,
              onClick: () => moveRule(index, -1),
            },
            '↑',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-toolbox-button',
              title: t('settings.groups.down'),
              disabled: busy || index === rules.length - 1,
              onClick: () => moveRule(index, 1),
            },
            '↓',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-toolbox-button',
              disabled: busy,
              onClick: () => replaceRule(rule.id, (entry) => ({ ...entry, enabled: !entry.enabled })),
            },
            t(rule.enabled ? 'identity.disableRule' : 'identity.enableRule'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-toolbox-button',
              'data-variant': 'ghost',
              disabled: busy,
              onClick: () => beginEdit(rule),
            },
            t('identity.editRule'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-toolbox-button',
              'data-variant': 'danger',
              disabled: busy,
              onClick: () => removeRule(rule),
            },
            t('identity.deleteRule'),
          ),
        ),
      )
    })

    const editor =
      draft === null
        ? null
        : h(
            'div',
            { className: 'dsh-toolbox-identity-editor' },
            h(
              'div',
              { className: 'dsh-toolbox-identity-field' },
              h('span', { className: 'dsh-toolbox-identity-label' }, t('identity.field.urlPattern')),
              h('input', {
                type: 'text',
                className: 'dsh-toolbox-input',
                maxLength: IDENTITY_LIMITS.urlPattern,
                placeholder: 'agentrouter.org',
                value: draft.urlPattern,
                onChange: (event) => setDraft({ ...draft, urlPattern: event.target.value }),
              }),
              h('span', { className: 'dsh-toolbox-identity-hint' }, t('identity.field.urlPatternHint')),
              fieldError('urlPattern') !== null
                ? h('span', { className: 'dsh-toolbox-identity-error' }, fieldError('urlPattern'))
                : null,
            ),
            h(
              'div',
              { className: 'dsh-toolbox-identity-field' },
              h('span', { className: 'dsh-toolbox-identity-label' }, t('identity.field.userAgent')),
              h('input', {
                type: 'text',
                className: 'dsh-toolbox-input',
                maxLength: IDENTITY_LIMITS.userAgent,
                placeholder: 'claude-cli/1.0.60 (external, cli)',
                value: draft.userAgent,
                onChange: (event) => setDraft({ ...draft, userAgent: event.target.value }),
              }),
              h('span', { className: 'dsh-toolbox-identity-hint' }, t('identity.field.userAgentHint')),
              fieldError('userAgent') !== null
                ? h('span', { className: 'dsh-toolbox-identity-error' }, fieldError('userAgent'))
                : null,
            ),
            h(
              'div',
              { className: 'dsh-toolbox-identity-field' },
              h('span', { className: 'dsh-toolbox-identity-label' }, t('identity.field.note')),
              h('input', {
                type: 'text',
                className: 'dsh-toolbox-input',
                maxLength: IDENTITY_LIMITS.note,
                value: draft.note,
                onChange: (event) => setDraft({ ...draft, note: event.target.value }),
              }),
            ),
            h(
              'div',
              { className: 'dsh-toolbox-identity-field' },
              h('span', { className: 'dsh-toolbox-identity-label' }, t('identity.field.headers')),
              draft.headers.length === 0
                ? h('span', { className: 'dsh-toolbox-identity-hint' }, t('identity.field.noHeaders'))
                : draft.headers.map((header, headerIndex) =>
                    h(
                      'div',
                      { key: headerIndex, className: 'dsh-toolbox-identity-header-row' },
                      h('input', {
                        type: 'text',
                        className: 'dsh-toolbox-input',
                        maxLength: IDENTITY_LIMITS.headerName,
                        placeholder: 'x-app',
                        value: header.name,
                        onChange: (event) => {
                          const headers = [...draft.headers]
                          headers[headerIndex] = { ...header, name: event.target.value }
                          setDraft({ ...draft, headers })
                        },
                      }),
                      h('input', {
                        type: 'text',
                        className: 'dsh-toolbox-input',
                        maxLength: IDENTITY_LIMITS.headerValue,
                        placeholder: 'value',
                        value: header.value,
                        onChange: (event) => {
                          const headers = [...draft.headers]
                          headers[headerIndex] = { ...header, value: event.target.value }
                          setDraft({ ...draft, headers })
                        },
                      }),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-toolbox-button',
                          'data-variant': 'ghost',
                          onClick: () =>
                            setDraft({ ...draft, headers: draft.headers.filter((_, index) => index !== headerIndex) }),
                        },
                        '×',
                      ),
                      fieldError(`headers.${headerIndex}.name`) !== null
                        ? h(
                            'span',
                            { className: 'dsh-toolbox-identity-error' },
                            fieldError(`headers.${headerIndex}.name`),
                          )
                        : null,
                      fieldError(`headers.${headerIndex}.value`) !== null
                        ? h(
                            'span',
                            { className: 'dsh-toolbox-identity-error' },
                            fieldError(`headers.${headerIndex}.value`),
                          )
                        : null,
                    ),
                  ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-toolbox-button',
                  disabled: draft.headers.length >= IDENTITY_LIMITS.maxHeadersPerRule,
                  onClick: () => setDraft({ ...draft, headers: [...draft.headers, { name: '', value: '' }] }),
                },
                t('identity.field.addHeader'),
              ),
              reservedDraftHeaders.length > 0
                ? h(
                    'span',
                    { className: 'dsh-toolbox-identity-warn' },
                    t('identity.reservedHeader', { names: reservedDraftHeaders.join(', ') }),
                  )
                : null,
            ),
            h(
              'div',
              { className: 'dsh-toolbox-row' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-toolbox-button',
                  'data-variant': 'primary',
                  disabled: busy,
                  onClick: saveDraft,
                },
                t('identity.saveRule'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-toolbox-button',
                  disabled: busy,
                  onClick: () => {
                    setDraft(null)
                    setFieldErrors({})
                  },
                },
                t('identity.cancel'),
              ),
            ),
          )

    const ready = phase === 'ready' && snapshot !== null

    return h(
      'div',
      { className: 'dsh-toolbox-card', 'data-feature': 'identity' },
      h(
        'div',
        { className: 'dsh-toolbox-card-head' },
        h('h3', { className: 'dsh-toolbox-card-title' }, t('identity.cardTitle')),
        ready && snapshot.writable
          ? h('input', {
              type: 'checkbox',
              className: 'dsh-toolbox-switch',
              checked: value.enabled,
              disabled: busy,
              title: t('identity.enable'),
              onChange: () => commit({ ...value, enabled: !value.enabled }),
            })
          : null,
      ),
      h('p', { className: 'dsh-toolbox-muted' }, t('identity.description')),
      h('p', { className: 'dsh-toolbox-identity-hint' }, t('identity.scope')),
      h('p', { className: 'dsh-toolbox-identity-warn' }, t('identity.risk')),

      notice !== null
        ? h(
            'div',
            { className: 'dsh-toolbox-notice', 'data-kind': notice.kind },
            notice.message,
          )
        : null,

      phase === 'loading' ? h('p', { className: 'dsh-toolbox-muted' }, t('identity.loading')) : null,
      phase === 'unsupported'
        ? h(
            'div',
            { className: 'dsh-toolbox-identity-unsupported' },
            h('p', { className: 'dsh-toolbox-muted' }, t('identity.unsupported')),
            h(
              'button',
              { type: 'button', className: 'dsh-toolbox-button', onClick: () => load() },
              t('action.retry'),
            ),
          )
        : null,
      phase === 'error'
        ? h(
            'div',
            { className: 'dsh-toolbox-identity-unsupported' },
            h(
              'button',
              { type: 'button', className: 'dsh-toolbox-button', onClick: () => load() },
              t('action.retry'),
            ),
          )
        : null,

      ready
        ? h(
            'div',
            { className: 'dsh-toolbox-identity-body' },
            h(
              'div',
              { className: 'dsh-toolbox-row-wrap' },
              h('span', { className: 'dsh-toolbox-identity-label' }, t('identity.rules')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-toolbox-button',
                  'data-variant': 'primary',
                  disabled: busy || rules.length >= IDENTITY_LIMITS.maxRules,
                  onClick: () => beginNew(),
                },
                t('identity.newRule'),
              ),
            ),

            rules.length === 0
              ? h('p', { className: 'dsh-toolbox-muted' }, t('identity.empty'))
              : h('div', { className: 'dsh-toolbox-identity-rules' }, ruleRows),

            h(
              'div',
              { className: 'dsh-toolbox-row' },
              h(
                'select',
                {
                  className: 'dsh-toolbox-select',
                  value: providerId,
                  disabled: busy || (snapshot.providers ?? []).length === 0,
                  onChange: (event) => {
                    const nextId = event.target.value
                    setProviderId(nextId)
                    const provider = (snapshot.providers ?? []).find((entry) => entry.provider === nextId)
                    if (provider) setTestUrl(modelsUrlFor(provider.baseURL))
                  },
                },
                h('option', { value: '' }, t('identity.chooseProvider')),
                (snapshot.providers ?? []).map((provider) =>
                  h(
                    'option',
                    { key: provider.provider, value: provider.provider },
                    `${provider.displayName ?? provider.provider} (${provider.provider})`,
                  ),
                ),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-toolbox-button',
                  disabled: busy || selectedProvider === null || !snapshot.writable,
                  onClick: generateFromProvider,
                },
                t('identity.generateFromProvider'),
              ),
            ),

            editor,

            h(
              'div',
              { className: 'dsh-toolbox-identity-test' },
              h('span', { className: 'dsh-toolbox-identity-label' }, t('identity.testTitle')),
              h(
                'div',
                { className: 'dsh-toolbox-row' },
                h('input', {
                  type: 'text',
                  className: 'dsh-toolbox-input',
                  style: { flex: '1 1 240px' },
                  placeholder: 'https://example.com/v1/models',
                  value: testUrl,
                  onChange: (event) => setTestUrl(event.target.value),
                }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-toolbox-button',
                    disabled: busy || testUrl.trim().length === 0,
                    onClick: runTest,
                  },
                  t('identity.test'),
                ),
              ),
              h('span', { className: 'dsh-toolbox-identity-hint' }, t('identity.testHint')),
              testResult === null
                ? null
                : testResult.ok === true
                  ? h(
                      'div',
                      { className: 'dsh-toolbox-identity-result', 'data-kind': testResult.matchedRuleId ? 'ok' : 'warn' },
                      h(
                        'div',
                        { className: 'dsh-toolbox-identity-result-line' },
                        t('identity.testStatus', { status: testResult.status }),
                        testResult.matchedRuleId
                          ? t('identity.testMatched', { rule: testResult.matchedRuleId })
                          : t('identity.testUnmatched'),
                      ),
                      h(
                        'div',
                        { className: 'dsh-toolbox-identity-result-line' },
                        t('identity.testBefore', { ua: testResult.beforeUserAgent || '—' }),
                      ),
                      h(
                        'div',
                        { className: 'dsh-toolbox-identity-result-line' },
                        t('identity.testAfter', { ua: testResult.afterUserAgent || '—' }),
                      ),
                      h('pre', { className: 'dsh-toolbox-identity-snippet' }, testResult.snippet || ''),
                    )
                  : h(
                      'div',
                      { className: 'dsh-toolbox-identity-result', 'data-kind': 'error' },
                      testResult.message,
                    ),
            ),

            h(
              'div',
              { className: 'dsh-toolbox-pref' },
              h(
                'div',
                { className: 'dsh-toolbox-pref-copy' },
                h('div', { className: 'dsh-toolbox-pref-title' }, t('identity.diagnostics')),
                h('div', { className: 'dsh-toolbox-pref-hint' }, t('identity.diagnosticsHint')),
              ),
              h('input', {
                type: 'checkbox',
                className: 'dsh-toolbox-switch',
                checked: value.diagnostics,
                disabled: busy || !snapshot.writable,
                onChange: () => commit({ ...value, diagnostics: !value.diagnostics }),
              }),
            ),
          )
        : null,
    )
  }
}
