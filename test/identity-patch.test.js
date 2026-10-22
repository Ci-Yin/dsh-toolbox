import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIdentityStats } from '../src/identity-core.js'
import { PATCH_KEY, identityPatchInstalled, installIdentityPatch } from '../src/identity-patch.js'

const CLI_UA = 'claude-cli/1.0.60 (external, cli)'

function fakeFetch() {
  const calls = []
  const fn = (input, init) => {
    calls.push({ input, init })
    return Promise.resolve(new Response('ok', { status: 200 }))
  }
  fn.calls = calls
  return fn
}

function rule(overrides = {}) {
  return {
    id: 'agentrouter',
    enabled: true,
    urlPattern: 'agentrouter.org',
    userAgent: CLI_UA,
    headers: [],
    note: '',
    ...overrides,
  }
}

/** Install over a fake fetch and guarantee the global is restored afterwards. */
async function withPatch(initialConfig, run) {
  const native = globalThis.fetch
  const fake = fakeFetch()
  globalThis.fetch = fake
  const config = { enabled: true, diagnostics: false, rules: [rule()], ...initialConfig }
  const stats = createIdentityStats()
  const dispose = installIdentityPatch({ read: () => config, stats })
  try {
    await run({ fake, config, stats, dispose })
  } finally {
    dispose()
    globalThis.fetch = native
    delete globalThis[PATCH_KEY]
  }
}

test('a matching rule rewrites the user-agent and keeps credentials', async () => {
  await withPatch({ rules: [rule({ headers: [{ name: 'x-app', value: 'cli' }] })] }, async ({ fake, stats }) => {
    await globalThis.fetch('https://agentrouter.org/v1/models', {
      headers: { 'user-agent': 'dsh/1.0', authorization: 'Bearer secret' },
    })
    assert.equal(fake.calls.length, 1)
    const forwarded = fake.calls[0].input
    assert.ok(forwarded instanceof Request)
    assert.equal(forwarded.url, 'https://agentrouter.org/v1/models')
    assert.equal(forwarded.headers.get('user-agent'), CLI_UA)
    assert.equal(forwarded.headers.get('x-app'), 'cli')
    assert.equal(forwarded.headers.get('authorization'), 'Bearer secret')
    assert.equal(stats.snapshot().agentrouter.count, 1)
  })
})

test('an unmatched request is forwarded with the original argument objects', async () => {
  await withPatch({}, async ({ fake }) => {
    const init = { method: 'POST', headers: { 'user-agent': 'dsh/1.0' }, body: '{"x":1}' }
    await globalThis.fetch('https://example.com/v1/models', init)
    assert.equal(fake.calls.length, 1)
    assert.equal(fake.calls[0].input, 'https://example.com/v1/models')
    assert.equal(fake.calls[0].init, init)
    assert.equal(globalThis[PATCH_KEY] !== undefined, true)
  })
})

test('the master switch and disabled rules both leave the host UA alone', async () => {
  await withPatch({ enabled: false }, async ({ fake }) => {
    await globalThis.fetch('https://agentrouter.org/v1/models', { headers: { 'user-agent': 'dsh/1.0' } })
    assert.equal(fake.calls[0].input, 'https://agentrouter.org/v1/models')
  })
  await withPatch({ rules: [rule({ enabled: false })] }, async ({ fake }) => {
    await globalThis.fetch('https://agentrouter.org/v1/models', { headers: { 'user-agent': 'dsh/1.0' } })
    assert.equal(fake.calls[0].input, 'https://agentrouter.org/v1/models')
  })
})

test('rules are read on every request so an edit applies without reinstalling', async () => {
  await withPatch({ rules: [] }, async ({ fake, config }) => {
    await globalThis.fetch('https://agentrouter.org/v1/models', { headers: { 'user-agent': 'dsh/1.0' } })
    assert.equal(fake.calls[0].input, 'https://agentrouter.org/v1/models')

    config.rules.push(rule())
    await globalThis.fetch('https://agentrouter.org/v1/models', { headers: { 'user-agent': 'dsh/1.0' } })
    assert.ok(fake.calls[1].input instanceof Request)
    assert.equal(fake.calls[1].input.headers.get('user-agent'), CLI_UA)
  })
})

test('a body-bearing Request survives the rewrite with its method and payload', async () => {
  await withPatch({}, async ({ fake }) => {
    const request = new Request('https://agentrouter.org/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'dsh/1.0' },
      body: '{"model":"x"}',
      ...(typeof Request === 'function' ? { duplex: 'half' } : {}),
    })
    await globalThis.fetch(request)
    const forwarded = fake.calls[0].input
    assert.ok(forwarded instanceof Request)
    assert.equal(forwarded.method, 'POST')
    assert.equal(forwarded.headers.get('user-agent'), CLI_UA)
    assert.equal(await forwarded.text(), '{"model":"x"}')
  })
})

test('reserved headers are never overridden even if a rule carries them', async () => {
  await withPatch(
    { rules: [rule({ headers: [{ name: 'authorization', value: 'Bearer injected' }, { name: 'x-app', value: 'cli' }] })] },
    async ({ fake }) => {
      await globalThis.fetch('https://agentrouter.org/v1/models', {
        headers: { 'user-agent': 'dsh/1.0', authorization: 'Bearer real' },
      })
      assert.equal(fake.calls[0].input.headers.get('authorization'), 'Bearer real')
      assert.equal(fake.calls[0].input.headers.get('x-app'), 'cli')
    },
  )
})

test('non-http URLs pass through untouched even when a rule matches', async () => {
  await withPatch({ rules: [rule({ urlPattern: 'file:' })] }, async ({ fake }) => {
    await globalThis.fetch('file:///etc/passwd')
    assert.equal(fake.calls[0].input, 'file:///etc/passwd')
  })
})

test('diagnostic logging records the host and UA pair but no header values', async () => {
  const logs = []
  const native = globalThis.fetch
  const fake = fakeFetch()
  globalThis.fetch = fake
  const config = { enabled: true, diagnostics: true, rules: [rule()] }
  const dispose = installIdentityPatch({
    read: () => config,
    logger: { info: (message) => logs.push(message), warn() {} },
  })
  try {
    await globalThis.fetch('https://agentrouter.org/v1/models?api_key=QUERYSECRET', {
      headers: { 'user-agent': 'dsh/1.0', authorization: 'Bearer HEADERSECRET' },
    })
    assert.equal(logs.length, 1)
    assert.match(logs[0], /agentrouter\.org/u)
    assert.match(logs[0], /dsh\/1\.0 -> claude-cli\/1\.0\.60/u)
    assert.equal(logs[0].includes('QUERYSECRET'), false)
    assert.equal(logs[0].includes('HEADERSECRET'), false)
  } finally {
    dispose()
    globalThis.fetch = native
    delete globalThis[PATCH_KEY]
  }
})

test('installing twice keeps a single wrapper and dispose restores the original fetch exactly', async () => {
  const native = globalThis.fetch
  const fake = fakeFetch()
  globalThis.fetch = fake
  try {
    const config = { enabled: true, rules: [rule()] }
    const first = installIdentityPatch({ read: () => config })
    const wrapped = globalThis.fetch
    const second = installIdentityPatch({ read: () => config })
    assert.equal(globalThis.fetch, wrapped)
    assert.equal(identityPatchInstalled(), true)

    first()
    assert.equal(globalThis.fetch, wrapped, 'the second install still holds a reference')
    second()
    assert.equal(globalThis.fetch, fake)
    assert.equal(identityPatchInstalled(), false)
  } finally {
    globalThis.fetch = native
    delete globalThis[PATCH_KEY]
  }
})

test('disposing under an outer wrapper leaves it installed and makes ours transparent', async () => {
  const native = globalThis.fetch
  const fake = fakeFetch()
  globalThis.fetch = fake
  try {
    const config = { enabled: true, rules: [rule()] }
    const dispose = installIdentityPatch({ read: () => config })
    const ours = globalThis.fetch

    // Another plugin layers above us after our install.
    const layeredCalls = []
    const outer = (input, init) => {
      layeredCalls.push({ input, init })
      return ours(input, init)
    }
    globalThis.fetch = outer

    dispose()
    assert.equal(globalThis.fetch, outer, 'the outer wrapper is not clobbered')
    assert.equal(fake.calls.length, 0)

    await globalThis.fetch('https://agentrouter.org/v1/models', { headers: { 'user-agent': 'dsh/1.0' } })
    // Our wrapper is still in the chain but inactive: the request passes through raw.
    assert.equal(layeredCalls.length, 1)
    assert.equal(fake.calls[0].input, 'https://agentrouter.org/v1/models')
  } finally {
    globalThis.fetch = native
    delete globalThis[PATCH_KEY]
  }
})
