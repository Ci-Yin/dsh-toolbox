import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { JSDOM } from 'jsdom'
import {
  features,
  modelGroupsFeature,
  settingsPanelFeature,
  workspaceFlatToggleFeature,
} from '../src/features.js'
import { writeFeatureSettings } from '../src/feature-settings.js'

function createRuntime() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const registrations = []
  const disposers = []
  const slots = {
    inject(name, callback) {
      registrations.push({ name, callback })
      return () => disposers.push(name)
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => disposers.push(options.id)
    },
    entriesOfSlot() {
      return []
    },
  }
  const ctx = { slots, logger: { error() {} } }
  const helpers = { React, t: (key) => key }
  return { dom, slots, ctx, helpers, registrations, disposers }
}

function withGlobals(dom, callback) {
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  try {
    return callback()
  } finally {
    globalThis.window = previousWindow
    globalThis.document = previousDocument
  }
}

test('feature controllers start and stop independently from persisted switches', () => {
  const { dom, ctx, helpers } = createRuntime()
  try {
    withGlobals(dom, () => {
      const modelCleanup = modelGroupsFeature.apply(ctx, helpers)
      const workspaceCleanup = workspaceFlatToggleFeature.apply(ctx, helpers)
      assert.equal(helpers.controller.started, true)
      assert.equal(helpers.workspaceFlatToggle.started, true)

      writeFeatureSettings(dom.window.localStorage, { modelGroups: false, workspaceFlatToggle: true }, dom.window)
      assert.equal(helpers.controller.started, false)
      assert.equal(helpers.workspaceFlatToggle.started, true)

      writeFeatureSettings(dom.window.localStorage, { modelGroups: false, workspaceFlatToggle: false }, dom.window)
      assert.equal(helpers.controller.started, false)
      assert.equal(helpers.workspaceFlatToggle.started, false)

      writeFeatureSettings(dom.window.localStorage, { modelGroups: true, workspaceFlatToggle: false }, dom.window)
      assert.equal(helpers.controller.started, true)
      assert.equal(helpers.workspaceFlatToggle.started, false)

      modelCleanup()
      workspaceCleanup()
      assert.equal(helpers.controller.started, false)
      assert.equal(helpers.workspaceFlatToggle.started, false)
    })
  } finally {
    dom.window.close()
  }
})

test('settings panel registration remains active when optional features are disabled', () => {
  const { dom, ctx, helpers, registrations } = createRuntime()
  try {
    withGlobals(dom, () => {
      const cleanup = settingsPanelFeature.apply(ctx, helpers)
      assert.ok(registrations.some((entry) => entry.name === 'settings.plugins.tab'))
      registrations.find((entry) => entry.name === 'settings.plugins.tab').callback()
      assert.ok(registrations.some((entry) => entry.options?.id === 'dsh-toolbox'))
      cleanup()
    })
  } finally {
    dom.window.close()
  }
})

test('the feature registry keeps the settings panel separate from optional features', () => {
  assert.deepEqual(features.map((feature) => feature.id), [
    'settings-panel',
    'model-groups',
    'workspace-flat-toggle',
  ])
})
