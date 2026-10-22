/**
 * Optional sidebar replacement that adds a Codex-like Workspace / Activity view.
 *
 * The host owns session data and navigation. This component only consumes the
 * public slot hooks and calls the public uiWorkspace service; it never scans
 * the host DOM or resumes sessions to build the list.
 */

function arrayFrom(value) {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return []
  if (value.byId && typeof value.byId === 'object') {
    return (Array.isArray(value.ids) ? value.ids : Object.keys(value.byId))
      .map((id) => value.byId[id])
      .filter(Boolean)
  }
  for (const key of ['items', 'sessions', 'workspaces', 'rows', 'visible', 'entries']) {
    if (Array.isArray(value[key])) return value[key]
  }
  return []
}

function firstText(...values) {
  return values.find((value) => typeof value === 'string' && value.trim() !== '')?.trim() ?? ''
}

function sessionIdOf(value) {
  return firstText(value?.sessionId, value?.id, value?.key)
}

function sessionTitleOf(value, t) {
  return firstText(value?.displayTitle, value?.title, value?.name) || t('activity.untitled')
}

function sessionSummaryOf(value, t) {
  return firstText(value?.summary, value?.preview, value?.description) || t('activity.noSummary')
}

function sessionTimeOf(value) {
  const raw = value?.updatedAt ?? value?.lastActivityAt ?? value?.activityAt ?? value?.createdAt
  const time = raw instanceof Date ? raw.getTime() : typeof raw === 'number' ? raw : Date.parse(String(raw ?? ''))
  return Number.isFinite(time) ? time : 0
}

function isArchived(value) {
  return value?.archived === true || value?.status === 'archived'
}

function isRunning(value) {
  return value?.running === true || value?.active === true || value?.status === 'running' || value?.status === 'busy'
}

function normalizeSessions(snapshot) {
  const seen = new Set()
  return arrayFrom(snapshot)
    .map((value) => {
      const id = sessionIdOf(value)
      if (!id || seen.has(id) || isArchived(value)) return null
      seen.add(id)
      return {
        id,
        title: sessionTitleOf(value, (key) => key),
        summary: sessionSummaryOf(value, (key) => key),
        time: sessionTimeOf(value),
        running: isRunning(value),
        workspaceId: firstText(value?.workspaceId, value?.workspace?.workspaceId),
        workspaceTitle: firstText(value?.workspaceTitle, value?.workspace?.title),
        raw: value,
      }
    })
    .filter(Boolean)
}

/** Normalize the visible session rows without assuming one projection shape. */
export function normalizeActivitySessions(snapshot, t = (key) => key) {
  return normalizeSessions(snapshot).map((session) => ({
    ...session,
    title: session.title === 'activity.untitled' ? t('activity.untitled') : session.title,
    summary: session.summary === 'activity.noSummary' ? t('activity.noSummary') : session.summary,
  }))
}

function localDayKey(time) {
  const date = new Date(time)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

/** Group sessions into the same local-day buckets shown by the activity view. */
export function groupActivitySessions(sessions, now = Date.now(), t = (key) => key) {
  const today = localDayKey(now)
  const yesterdayDate = new Date(now)
  yesterdayDate.setDate(yesterdayDate.getDate() - 1)
  const yesterday = localDayKey(yesterdayDate.getTime())
  const groups = [
    { id: 'running', label: t('activity.running'), items: [] },
    { id: 'today', label: t('activity.today'), items: [] },
    { id: 'yesterday', label: t('activity.yesterday'), items: [] },
    { id: 'earlier', label: t('activity.earlier'), items: [] },
  ]
  for (const session of [...(Array.isArray(sessions) ? sessions : [])].sort((a, b) => b.time - a.time)) {
    const key = localDayKey(session.time || now)
    const group = session.running ? groups[0] : key === today ? groups[1] : key === yesterday ? groups[2] : groups[3]
    group.items.push(session)
  }
  return groups.filter((group) => group.items.length > 0)
}

function normalizeWorkspaces(snapshot, sessions) {
  const workspaces = arrayFrom(snapshot)
  const fallback = new Map()
  for (const session of sessions) {
    const id = session.workspaceId || 'default'
    if (!fallback.has(id)) fallback.set(id, { workspaceId: id, title: session.workspaceTitle || id, sessionIds: [] })
    fallback.get(id).sessionIds.push(session.id)
  }
  if (workspaces.length === 0) return [...fallback.values()]
  return workspaces.map((workspace) => {
    const workspaceId = firstText(workspace.workspaceId, workspace.id)
    return {
      ...workspace,
      workspaceId,
      title: firstText(workspace.title, workspace.name) || workspaceId,
      sessionIds: Array.isArray(workspace.sessionIds) ? workspace.sessionIds : fallback.get(workspaceId)?.sessionIds ?? [],
    }
  })
}

function Icon({ h, kind }) {
  const paths = {
    activity: 'M3 12h3l2-7 4 14 2-7h4',
    workspace: 'M3 5.5h6l1.5 2H21v10.5H3z',
    plus: 'M12 5v14M5 12h14',
    dot: 'M12 12h.01',
  }
  return h('svg', { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' }, h('path', { d: paths[kind] ?? paths.dot }))
}

function SidebarRow({ h, session, onOpen, t, showWorkspace = false }) {
  return h(
    'button',
    {
      type: 'button',
      className: 'dsh-toolbox-activity-session',
      title: t('activity.open'),
      onClick: () => onOpen(session.id),
    },
    h('span', { className: 'dsh-toolbox-activity-session-main' },
      h('span', { className: 'dsh-toolbox-activity-session-title' }, session.title),
      h('span', { className: 'dsh-toolbox-activity-session-summary' },
        showWorkspace && session.workspaceTitle ? `${session.workspaceTitle} · ${session.summary}` : session.summary,
      ),
    ),
    session.running ? h('span', { className: 'dsh-toolbox-activity-running', title: t('activity.running') }, '●') : null,
  )
}

export function ActivitySidebar(props) {
  const React = props.React
  const h = React.createElement
  const { useMemo, useState } = React
  const t = props.t ?? ((key) => key)
  const uiWorkspace = props.uiWorkspace
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const workspaceSnapshot = typeof props.useWorkspaces === 'function' ? props.useWorkspaces((value) => value) : null
  const sessionSnapshot = typeof props.useSessions === 'function' ? props.useSessions((value) => value) : null
  const sessionStatus = typeof props.useSessionStatus === 'function' ? props.useSessionStatus((value) => value) : null
  const sourceSessions = useMemo(() => normalizeActivitySessions(sessionSnapshot, t).map((session) => ({
    ...session,
    running: sessionStatus?.get?.(session.id)?.running ?? session.running,
  })), [sessionSnapshot, sessionStatus, t])
  const workspaces = useMemo(() => normalizeWorkspaces(workspaceSnapshot, sourceSessions), [workspaceSnapshot, sourceSessions])
  const sessions = useMemo(() => {
    const workspaceBySession = new Map()
    for (const workspace of workspaces) {
      for (const id of workspace.sessionIds) workspaceBySession.set(String(id), workspace)
    }
    return sourceSessions.filter((session) => !workspaceSnapshot?.archivedSessionIds?.includes(session.id)).map((session) => {
      const workspace = workspaceBySession.get(session.id)
      return workspace ? { ...session, workspaceId: workspace.workspaceId, workspaceTitle: workspace.title } : session
    })
  }, [sourceSessions, workspaces, workspaceSnapshot])
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()
    return term === '' ? sessions : sessions.filter((session) => `${session.title} ${session.summary}`.toLowerCase().includes(term))
  }, [query, sessions])
  const activityGroups = useMemo(() => groupActivitySessions(filtered, Date.now(), t), [filtered, t])

  const runAction = (action) => {
    setError('')
    try {
      Promise.resolve(action()).catch((reason) => setError(String(reason?.message ?? reason)))
    } catch (reason) {
      setError(String(reason?.message ?? reason))
    }
  }
  const openSession = (id) => runAction(() => uiWorkspace.openSession(id))
  const startSession = () => runAction(() => uiWorkspace.startSession())
  if (props.wide === false) return h(
    'button',
    { type: 'button', className: 'dsh-toolbox-activity-rail', onClick: props.expandSidebar, title: t('activity.view.activity'), 'aria-label': t('activity.view.activity') },
    h(Icon, { h, kind: 'activity' }),
  )

  const activityContent = activityGroups.length === 0
    ? h('div', { className: 'dsh-toolbox-activity-empty' }, t('activity.empty'), h('small', null, t('activity.emptyHint')))
    : activityGroups.map((group) => h(
        'section', { className: 'dsh-toolbox-activity-workspace', key: group.id },
        h('h3', { className: 'dsh-toolbox-activity-section-title' }, group.label),
        group.items.map((session) => h(SidebarRow, { h, key: session.id, session, onOpen: openSession, t, showWorkspace: true })),
      ))

  return h(
    'aside', { className: 'dsh-toolbox-activity-sidebar', 'data-view': 'activity' },
    h('div', { className: 'dsh-toolbox-activity-brand' }, h('span', null, t('activity.view.activity'))),
    h('div', { className: 'dsh-toolbox-activity-actions' },
      h('button', { type: 'button', className: 'dsh-toolbox-activity-new', onClick: startSession }, h(Icon, { h, kind: 'plus' }), t('activity.newSession')),
    ),
    h('label', { className: 'dsh-toolbox-activity-search' }, h('span', { className: 'dsh-toolbox-activity-search-icon' }, '⌕'), h('input', { value: query, onChange: (event) => setQuery(event.target.value), placeholder: t('activity.search'), 'aria-label': t('activity.search') })),
    error ? h('div', { className: 'dsh-toolbox-activity-error', role: 'alert' }, error) : null,
    h('div', { className: 'dsh-toolbox-activity-list' }, activityContent),
    h('button', { type: 'button', className: 'dsh-toolbox-activity-restore', onClick: props.restoreNativeSidebar }, t('activity.restoreNative')),
  )
}
