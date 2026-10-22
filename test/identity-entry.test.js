import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config, apply, name } from '../index.js'
import { PATCH_KEY } from '../src/identity-patch.js'

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

function fakeCtx() {
  const disposers = []
  const routes = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    inject(_names, callback) {
      callback({
        webServer: {
          register(options) {
            routes.push(options)
            return () => {
              options.closed = true
            }
          },
        },
        effect(callback) {
          const dispose = callback()
          if (typeof dispose === 'function') disposers.push(dispose)
        },
      })
    },
    get() {
      return undefined
    },
  }
  return { ctx, disposers, routes }
}

test('the plugin entry declares the default identity document', () => {
  assert.equal(name, 'dsh-toolbox')
  const config = Config({})
  assert.deepEqual(config.identity.get(), { enabled: true, diagnostics: false, rules: [] })
})

test('apply installs one wrapper and both routes, and dispose restores fetch', async () => {
  const native = globalThis.fetch
  const calls = []
  const fake = (input, init) => {
    calls.push({ input, init })
    return Promise.resolve(new Response('ok', { status: 200 }))
  }
  globalThis.fetch = fake
  const { ctx, disposers, routes } = fakeCtx()
  try {
    const config = Config({})
    apply(ctx, config)

    assert.deepEqual(
      routes.map((route) => [route.kind, route.path]),
      [
        ['exact', '/api/dsh-toolbox.identity'],
        ['exact', '/api/dsh-toolbox.identity-test'],
      ],
    )
    assert.equal(typeof globalThis.fetch, 'function')
    assert.notEqual(globalThis.fetch, fake)

    // No rules yet: the request must reach the native fetch untouched.
    await globalThis.fetch('https://agentrouter.org/v1/models', { headers: { 'user-agent': 'dsh/1.0' } })
    assert.equal(calls[0].input, 'https://agentrouter.org/v1/models')

    // A live settings write reaches the next request without reinstalling.
    config.identity[VOLATILE_WRITE]({
      enabled: true,
      diagnostics: false,
      rules: [
        {
          id: 'agentrouter',
          enabled: true,
          urlPattern: 'agentrouter.org',
          userAgent: 'claude-cli/1.0.60 (external, cli)',
          headers: [],
          note: '',
        },
      ],
    })
    await globalThis.fetch('https://agentrouter.org/v1/models', { headers: { 'user-agent': 'dsh/1.0' } })
    assert.ok(calls[1].input instanceof Request)
    assert.equal(calls[1].input.headers.get('user-agent'), 'claude-cli/1.0.60 (external, cli)')

    // Master switch off: the host UA is preserved again, immediately.
    config.identity[VOLATILE_WRITE]({
      enabled: false,
      diagnostics: false,
      rules: [
        {
          id: 'agentrouter',
          enabled: true,
          urlPattern: 'agentrouter.org',
          userAgent: 'claude-cli/1.0.60 (external, cli)',
          headers: [],
          note: '',
        },
      ],
    })
    await globalThis.fetch('https://agentrouter.org/v1/models', { headers: { 'user-agent': 'dsh/1.0' } })
    assert.equal(calls[2].input, 'https://agentrouter.org/v1/models')
  } finally {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        // Ignore cleanup failures; the assertion below still proves the restore.
      }
    }
    assert.equal(globalThis.fetch, fake)
    globalThis.fetch = native
    delete globalThis[PATCH_KEY]
  }
})
