import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ActivitySidebar, groupActivitySessions, normalizeActivitySessions } from '../src/activity-sidebar.js'

test('sidebar renders sessions, workspace labels, and recovery control from host hooks', () => {
  const now = Date.now()
  const html = renderToStaticMarkup(React.createElement(ActivitySidebar, {
    React,
    t: (key) => key,
    useSessions: (select) => select({ ids: ['s1'], byId: { s1: { sessionId: 's1', title: 'Review task', updatedAt: now } } }),
    useWorkspaces: (select) => select({ items: [{ workspaceId: 'w1', title: 'Project Alpha', sessionIds: ['s1'] }], archivedSessionIds: [] }),
    useSessionStatus: (select) => select(new Map([['s1', { running: true }]])),
    uiWorkspace: { openSession() {}, startSession() {} },
    restoreNativeSidebar() {},
  }))
  assert.match(html, /Review task/u)
  assert.match(html, /Project Alpha/u)
  assert.match(html, /activity\.running/u)
  assert.match(html, /activity\.restoreNative/u)
})

test('collapsed sidebar exposes an accessible expansion control', () => {
  const html = renderToStaticMarkup(React.createElement(ActivitySidebar, {
    React, t: (key) => key, wide: false, expandSidebar() {},
  }))
  assert.match(html, /dsh-toolbox-activity-rail/u)
  assert.match(html, /aria-label="activity.view.activity"/u)
})

test('activity sessions are deduplicated and archived rows are excluded', () => {
  const sessions = normalizeActivitySessions([
    { sessionId: 'a', title: 'A', updatedAt: '2026-10-22T08:00:00Z' },
    { sessionId: 'a', title: 'duplicate', updatedAt: '2026-10-22T09:00:00Z' },
    { sessionId: 'b', title: 'B', status: 'archived', updatedAt: '2026-10-22T10:00:00Z' },
  ])
  assert.deepEqual(sessions.map((session) => session.id), ['a'])
  assert.equal(sessions[0].title, 'A')
})

test('native ids/byId snapshots preserve numeric epoch timestamps', () => {
  const time = new Date(2026, 9, 22, 11).getTime()
  const rows = normalizeActivitySessions({ ids: ['b', 'a'], byId: {
    a: { sessionId: 'a', title: 'Earlier', updatedAt: time - 60000 },
    b: { sessionId: 'b', title: 'Latest', updatedAt: time },
  } })
  assert.deepEqual(rows.map((row) => row.id), ['b', 'a'])
  assert.equal(rows[0].time, time)
  assert.deepEqual(groupActivitySessions(rows, time).at(0).items.map((row) => row.id), ['b', 'a'])
})

test('running sessions are prioritized without losing date ordering', () => {
  const now = new Date(2026, 9, 22, 12).getTime()
  const groups = groupActivitySessions([
    { id: 'recent', time: now - 1000 },
    { id: 'working', time: now - 5000, running: true },
  ], now)
  assert.deepEqual(groups.map((group) => group.id), ['running', 'today'])
  assert.deepEqual(groups[0].items.map((item) => item.id), ['working'])
})

test('activity sessions group by local calendar day and sort newest first', () => {
  const now = new Date(2026, 9, 22, 12).getTime()
  const groups = groupActivitySessions(
    [
      { id: 'old', time: new Date(2026, 9, 20, 12).getTime() },
      { id: 'late', time: new Date(2026, 9, 22, 11).getTime() },
      { id: 'early', time: new Date(2026, 9, 22, 8).getTime() },
      { id: 'yesterday', time: new Date(2026, 9, 21, 9).getTime() },
    ],
    now,
  )
  assert.deepEqual(groups.map((group) => group.id), ['today', 'yesterday', 'earlier'])
  assert.deepEqual(groups[0].items.map((item) => item.id), ['late', 'early'])
  assert.deepEqual(groups[2].items.map((item) => item.id), ['old'])
})
