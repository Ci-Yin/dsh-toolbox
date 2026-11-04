import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BODY_LIMITS, createIdentityStats } from '../src/identity-core.js'
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
async function withPatch(initialConfig, run, options = {}) {
  const native = globalThis.fetch
  const fake = fakeFetch()
  globalThis.fetch = fake
  const config = { enabled: true, diagnostics: false, rules: [rule()], ...initialConfig }
  const stats = createIdentityStats()
  const dispose = installIdentityPatch({ ...options, read: () => config, stats })
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

const responsesUrl = 'https://agentrouter.org/v1/responses'
const itemBody = JSON.stringify({
  model: 'gpt-6.1-sol',
  store: false,
  input: [{ type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'BODYSECRET' }] }],
})
const stripRule = (overrides = {}) => rule({ userAgent: '', stripResponsesItemIds: true, ...overrides })
const responsesRequest = (body = itemBody, init = {}) => new Request(responsesUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body,
  ...init,
})

// docs/responses-item-ids.md §6.9–15 (1–8 live in core; 16 in host).
test('Responses 9: strips item ids, rewrites headers and removes stale content-length', async () => {
  await withPatch({ rules: [stripRule({ userAgent: CLI_UA, headers: [{ name: 'x-app', value: 'cli' }] })] }, async ({ fake, stats }) => {
    const controller = new AbortController()
    const request = responsesRequest(itemBody, {
      headers: { 'content-type': 'Application/JSON; charset=utf-8', 'content-length': String(Buffer.byteLength(itemBody)), 'user-agent': 'dsh/1.0', authorization: 'Bearer real' },
      signal: controller.signal,
      credentials: 'include',
      redirect: 'manual',
    })
    await globalThis.fetch(request)
    const next = fake.calls[0].input
    assert.notStrictEqual(next, request)
    const expected = JSON.parse(itemBody)
    delete expected.input[0].id
    assert.deepEqual(await next.json(), expected)
    assert.equal(next.headers.get('content-length'), null)
    assert.equal(next.headers.get('user-agent'), CLI_UA)
    assert.equal(next.headers.get('x-app'), 'cli')
    assert.equal(next.headers.get('authorization'), 'Bearer real')
    assert.equal(next.url, request.url)
    assert.equal(next.method, 'POST')
    assert.equal(next.credentials, 'include')
    assert.equal(next.redirect, 'manual')
    assert.equal(next.duplex, 'half')
    controller.abort()
    assert.equal(next.signal.aborted, true)
    assert.equal(await request.text(), itemBody, 'the original body was not consumed')
    assert.equal(stats.snapshot().agentrouter.strippedItems, 1)
    assert.equal(stats.last().strippedItems, 1)
    assert.equal(JSON.stringify(stats.snapshot()).includes('BODYSECRET'), false)
  })
})

test('Responses 10: false sends the exact same Request instance to native without reading it', async () => {
  await withPatch({ rules: [stripRule({ stripResponsesItemIds: false })] }, async ({ fake, stats }) => {
    const request = responsesRequest()
    request.clone = () => { throw new Error('must not clone a disabled body') }
    await globalThis.fetch(request)
    assert.strictEqual(fake.calls[0].input, request)
    assert.strictEqual(fake.calls[0].init, undefined)
    assert.equal(request.bodyUsed, false)
    assert.equal(await fake.calls[0].input.text(), itemBody)
    assert.equal(stats.last().strippedItems, 0)
  })
})

test('Responses 11: GET models passes through without inspecting the body', async () => {
  await withPatch({ rules: [stripRule()] }, async ({ fake }) => {
    const request = new Request('https://agentrouter.org/v1/models')
    request.clone = () => { throw new Error('must not clone GET') }
    await globalThis.fetch(request)
    assert.strictEqual(fake.calls[0].input, request)
    assert.equal(fake.calls[0].input.body, null)
  })
})

test('Responses 12: text/plain POST passes through unchanged', async () => {
  await withPatch({ rules: [stripRule()] }, async ({ fake }) => {
    const request = responsesRequest(itemBody, { headers: { 'content-type': 'text/plain' } })
    request.clone = () => { throw new Error('must not read non-JSON') }
    await globalThis.fetch(request)
    assert.strictEqual(fake.calls[0].input, request)
    assert.equal(await request.text(), itemBody)
  })
})

test('Responses 13: invalid JSON forwards original Request and init without throwing', async () => {
  await withPatch({ rules: [stripRule()] }, async ({ fake }) => {
    const request = responsesRequest('{invalid BODYSECRET')
    const init = { redirect: 'manual' }
    await globalThis.fetch(request, init)
    assert.strictEqual(fake.calls[0].input, request)
    assert.strictEqual(fake.calls[0].init, init)
    assert.equal(request.bodyUsed, false)
    assert.equal(await request.text(), '{invalid BODYSECRET')
  })
})

test('Responses 14: mixed references survive and function call associations stay intact', async () => {
  await withPatch({ rules: [stripRule()] }, async ({ fake, stats }) => {
    const reference = { type: 'item_reference', id: 'msg_ref' }
    const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe', arguments: '{}' }
    const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [] }
    const result = { type: 'function_call_output', call_id: 'call_1', output: 'ok' }
    await globalThis.fetch(responsesRequest(JSON.stringify({ input: [reference, call, reasoning, result] })))
    const body = await fake.calls[0].input.json()
    assert.deepEqual(body.input, [reference, { type: 'function_call', call_id: 'call_1', name: 'probe', arguments: '{}' }, { type: 'reasoning', encrypted_content: 'opaque', summary: [] }, result])
    assert.equal(stats.last().strippedItems, 2)
  })
})

test('Responses 15: declared oversized bodies are never cloned and warn only with diagnostics', async () => {
  const logs = []
  await withPatch({ diagnostics: true, rules: [stripRule()] }, async ({ fake, config }) => {
    for (let i = 0; i < 2; i += 1) {
      const request = responsesRequest(itemBody, { headers: { 'content-type': 'application/json', 'content-length': String(BODY_LIMITS.maxJsonBodyBytes + 1) } })
      request.clone = () => { throw new Error('must not clone oversized body') }
      await globalThis.fetch(request)
      assert.strictEqual(fake.calls[i].input, request)
      assert.equal(await request.text(), itemBody)
      config.diagnostics = false
    }
    assert.equal(logs.length, 1)
    assert.match(logs[0], /byte limit/u)
    assert.equal(logs[0].includes('BODYSECRET'), false)
  }, { logger: { warn: (message) => logs.push(message) } })
})

test('actual byte limit also bounds undeclared and understated multibyte JSON bodies', async () => {
  const raw = JSON.stringify({ input: [{ id: 'msg_1', content: '汉'.repeat(Math.ceil(BODY_LIMITS.maxJsonBodyBytes / 3)) }] })
  assert.ok(raw.length < BODY_LIMITS.maxJsonBodyBytes)
  assert.ok(Buffer.byteLength(raw) > BODY_LIMITS.maxJsonBodyBytes)
  for (const declared of [null, '1']) {
    const logs = []
    await withPatch({ diagnostics: true, rules: [stripRule()] }, async ({ fake }) => {
      const headers = { 'content-type': 'application/json' }
      if (declared !== null) headers['content-length'] = declared
      const request = responsesRequest(raw, { headers })
      await globalThis.fetch(request)
      assert.strictEqual(fake.calls[0].input, request)
      assert.equal(await request.text(), raw)
      assert.equal(logs.length, 1)
    }, { logger: { warn: (message) => logs.push(message) } })
  }
})

test('Responses no-op bodies preserve both original URL/init and Request/init arguments', async () => {
  for (const raw of ['{"input":[]}', '{"input":"hi"}', '{"model":"x"}', '{ "input": [{ "type":"item_reference", "id":"msg_1" }] }']) {
    await withPatch({ rules: [stripRule()] }, async ({ fake }) => {
      const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw }
      await globalThis.fetch(responsesUrl, init)
      assert.strictEqual(fake.calls[0].input, responsesUrl)
      assert.strictEqual(fake.calls[0].init, init)
      const request = responsesRequest(raw)
      const overrides = { redirect: 'manual' }
      await globalThis.fetch(request, overrides)
      assert.strictEqual(fake.calls[1].input, request)
      assert.strictEqual(fake.calls[1].init, overrides)
      assert.equal(await request.text(), raw)
    })
  }
})

test('other API endpoints with input arrays are never stripped', async () => {
  await withPatch({ rules: [stripRule()] }, async ({ fake }) => {
    for (const path of ['/v1/chat/completions', '/v1/messages', '/v1/embeddings', '/v1/responses/resp_1']) {
      const request = new Request(`https://agentrouter.org${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: itemBody })
      request.clone = () => { throw new Error('must not read non-Responses body') }
      await globalThis.fetch(request)
      assert.strictEqual(fake.calls.at(-1).input, request)
      assert.equal(await request.text(), itemBody)
    }
  })
})

test('Request init overrides remain effective during both body and header rewrites', async () => {
  await withPatch({ rules: [stripRule({ userAgent: CLI_UA })] }, async ({ fake }) => {
    const request = responsesRequest(itemBody, { headers: { 'content-type': 'text/plain', 'x-original': 'discard' } })
    const controller = new AbortController()
    const raw = JSON.stringify({ input: [{ id: 'msg_override', content: 'override' }] })
    await globalThis.fetch(request, {
      method: 'POST',
      body: raw,
      headers: { 'content-type': 'application/json', 'x-override': 'keep' },
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
    })
    const next = fake.calls[0].input
    assert.deepEqual(await next.json(), { input: [{ content: 'override' }] })
    assert.equal(next.headers.get('x-original'), null)
    assert.equal(next.headers.get('x-override'), 'keep')
    assert.equal(next.headers.get('user-agent'), CLI_UA)
    assert.equal(next.credentials, 'omit')
    assert.equal(next.redirect, 'error')
    controller.abort()
    assert.equal(next.signal.aborted, true)
    assert.equal(await request.text(), itemBody)
  })
})

test('body no-ops and disabled stripping still honor existing header rules', async () => {
  for (const enabled of [false, true]) {
    await withPatch({ rules: [stripRule({ stripResponsesItemIds: enabled, userAgent: CLI_UA })] }, async ({ fake }) => {
      const raw = '{invalid but header rewrite still applies'
      await globalThis.fetch(responsesRequest(raw))
      assert.equal(fake.calls[0].input.headers.get('user-agent'), CLI_UA)
      assert.equal(await fake.calls[0].input.text(), raw)
    })
  }
})

test('a clone failure forwards the original arguments without logging exception body text', async () => {
  const logs = []
  await withPatch({ rules: [stripRule()] }, async ({ fake }) => {
    const request = responsesRequest()
    request.clone = () => { throw new Error('BODYSECRET') }
    await globalThis.fetch(request)
    assert.strictEqual(fake.calls[0].input, request)
    assert.equal(await request.text(), itemBody)
    assert.equal(logs.length, 1)
    assert.equal(JSON.stringify(logs).includes('BODYSECRET'), false)
  }, { logger: { warn: (...args) => logs.push(args) } })
})

test('Responses query strings and trailing slash are supported without logging body content', async () => {
  const logs = []
  await withPatch({ diagnostics: true, rules: [stripRule()] }, async ({ fake }) => {
    const request = new Request(`${responsesUrl}/?api-version=2025-04-01`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: itemBody })
    const response = await globalThis.fetch(request)
    assert.equal(await response.text(), 'ok')
    assert.equal(Object.hasOwn((await fake.calls[0].input.json()).input[0], 'id'), false)
    assert.equal(logs.length, 1)
    assert.match(logs[0], /strippedItems=1/u)
    assert.equal(logs[0].includes('BODYSECRET'), false)
  }, { logger: { info: (message) => logs.push(message) } })
})

test('pending clone reads stop on abort and forward the original aborted Request', async () => {
  for (const preAborted of [false, true]) {
    await withPatch({ rules: [stripRule()] }, async ({ fake }) => {
      const controller = new AbortController()
      let source
      const stream = new ReadableStream({ start(value) { source = value } })
      const request = responsesRequest(stream, { duplex: 'half', signal: controller.signal })
      if (preAborted) controller.abort()
      const pending = globalThis.fetch(request)
      const abortTimer = setTimeout(() => controller.abort(), 10)
      let deadline
      try {
        await Promise.race([
          pending,
          new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('aborted body read hung')), 1000) }),
        ])
        assert.equal(fake.calls.length, 1)
        assert.strictEqual(fake.calls[0].input, request)
        assert.equal(fake.calls[0].input.signal.aborted, true)
      } finally {
        clearTimeout(abortTimer)
        clearTimeout(deadline)
        source.close()
        await pending
      }
    })
  }
})

test('consumed Request accepts a fresh init body and still strips it', async () => {
  await withPatch({ rules: [stripRule({ userAgent: CLI_UA })] }, async ({ fake }) => {
    const request = responsesRequest()
    await request.text()
    const init = { body: itemBody }
    await globalThis.fetch(request, init)
    assert.notStrictEqual(fake.calls[0].input, request)
    assert.equal(fake.calls[0].input.headers.get('user-agent'), CLI_UA)
    assert.equal(Object.hasOwn((await fake.calls[0].input.json()).input[0], 'id'), false)
  })
})

test('Request plus init without body changes never leaves an unused clone branch', async () => {
  await withPatch({ rules: [stripRule({ stripResponsesItemIds: false })] }, async ({ fake }) => {
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(itemBody)); controller.close() } })
    const request = responsesRequest(stream, { duplex: 'half' })
    let clones = 0
    const clone = request.clone.bind(request)
    request.clone = () => { clones += 1; return clone() }
    const init = { redirect: 'manual' }
    await globalThis.fetch(request, init)
    assert.strictEqual(fake.calls[0].input, request)
    assert.strictEqual(fake.calls[0].init, init)
    assert.equal(clones, 0)
    assert.equal(await request.text(), itemBody)
  })
})

test('caller-owned init streams stay readable instead of being locked by inspection', async () => {
  for (const userAgent of ['', CLI_UA]) {
    await withPatch({ rules: [stripRule({ userAgent })] }, async ({ fake }) => {
      const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(itemBody)); controller.close() } })
      const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' }
      await globalThis.fetch(responsesUrl, init)
      if (userAgent === '') {
        assert.strictEqual(fake.calls[0].input, responsesUrl)
        assert.strictEqual(fake.calls[0].init, init)
      }
      const received = new Request(fake.calls[0].input, fake.calls[0].init)
      assert.equal(await received.text(), itemBody)
      assert.equal(received.headers.get('user-agent'), userAgent || null)
    })
  }
})

test('native receives the original Response stream without reading or cloning it', async () => {
  const native = globalThis.fetch
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: token\n\n')); controller.close() } }), { headers: { 'content-type': 'text/event-stream' } })
  response.clone = () => { throw new Error('must not clone Response') }
  globalThis.fetch = () => Promise.resolve(response)
  const dispose = installIdentityPatch({ read: () => ({ rules: [stripRule()] }) })
  try {
    const returned = await globalThis.fetch(responsesRequest())
    assert.strictEqual(returned, response)
    assert.equal(returned.bodyUsed, false)
    assert.equal(await returned.text(), 'data: token\n\n')
  } finally {
    dispose()
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
