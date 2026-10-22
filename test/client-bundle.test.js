import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

test('the generated client bundle registers a classic-script factory and applies cleanly', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf-8')
  assert.equal(/^\s*import\s+/mu.test(source), false)
  let registration = null
  const context = {
    window: {
      __ModuleLoader__: {
        load(value) {
          registration = value
        },
      },
    },
    console,
    setTimeout,
    clearTimeout,
  }
  vm.runInNewContext(source, context)
  assert.equal(registration?.id, 'dsh-toolbox')
  assert.equal(typeof registration.factory, 'function')

  const React = {
    createElement() {
      return {}
    },
    useState() {
      return [undefined, () => {}]
    },
    useEffect() {},
    useMemo(fn) {
      return fn()
    },
    useCallback(fn) {
      return fn
    },
    useRef() {
      return { current: null }
    },
  }
  const module = registration.factory((name) => {
    assert.equal(name, 'react')
    return React
  })
  assert.deepEqual([...module.inject], ['slots', 'locale'])
  assert.equal(typeof module.apply, 'function')

  const disposers = []
  const injected = []
  const registered = []
  const ctx = {
    logger: { error() {} },
    locale: {
      bind: () => (key) => key,
      register: () => () => {},
      subscribe: () => () => {},
    },
    slots: {
      inject(name, callback) {
        injected.push(name)
        callback()
        return () => {}
      },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
    effect(callback) {
      const disposer = callback()
      disposers.push(disposer)
    },
  }

  module.apply(ctx)
  assert.deepEqual(injected, ['settings.plugins.tab'])
  assert.equal(registered.length, 1)
  assert.equal(registered[0].options.id, 'dsh-toolbox')
  assert.equal(registered[0].options.order, 20)
  assert.equal(typeof registered[0].component, 'function')

  for (const disposer of disposers.reverse()) {
    if (typeof disposer === 'function') disposer()
  }
})
