import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const projectionRuntime = () => {
  let definition
  return {
    register(value) { definition = value; return () => {} },
    stateOf(session, key) {
      assert.equal(key, 'sessionRecap')
      assert.ok(definition, 'projection is registered before it is read')
      let state = definition.init({}, 0)
      for (const event of session.snapshotEvents()) state = definition.apply(state, event)
      return state
    },
  }
}

test('manual recap uses the registered projection, publishes a sidecar and rejects open turns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recap-api-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  const { apply, Config } = await import('../lib/index.js')
  let command
  let snapshots = 0
  let calls = 0
  const dispose = []
  let events = []
  const ctx = {
    on() {},
    effect(setup) { dispose.push(setup()) },
    inject(names, setup) { if (names.includes('commands')) setup(ctx) },
    commands: { register(value) { command = value } },
    sessionProjections: projectionRuntime(),
    llm: { async *stream(options) {
      calls++
      assert.equal(options.provider, 'test-provider')
      yield { type: 'text-delta', index: 0, text: '兼容测试通过。' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } },
  }
  const session = {
    id: 'snapshot-only',
    snapshotEvents() { snapshots++; return [...events] },
    deriveMessages() { return [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '测试新版接口' }] }] },
  }
  // Deliberately no session.events property: removed by the current host SDK.
  try {
    apply(ctx, Config({ provider: 'test-provider', model: 'test-model', hostCommand: true }))
    const invoke = () => command.handler({ agent: { session }, signal: new AbortController().signal })
    assert.deepEqual(await invoke(), { kind: 'success', text: '兼容测试通过。' })
    assert.ok(snapshots >= 2)
    assert.equal(calls, 1)
    const stored = JSON.parse(readFileSync(join(root, 'plugin-data/dsh-session-recap/snapshot-only.json'), 'utf8'))
    assert.equal(stored.text, '兼容测试通过。')
    events = [{ type: 'turn/start', seq: 1 }]
    assert.match((await invoke()).text, /wait until the current turn finishes/)
    assert.equal(calls, 1)
  } finally {
    for (const fn of dispose) fn?.()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test('max-token output with a complete sentence is delivered without retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recap-max-token-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  const { apply, Config } = await import('../lib/index.js')
  let command
  let calls = 0
  const dispose = []
  const ctx = {
    on() {},
    effect(setup) { dispose.push(setup()) },
    inject(names, setup) { if (names.includes('commands')) setup(ctx) },
    commands: { register(value) { command = value } },
    sessionProjections: projectionRuntime(),
    llm: { async *stream() {
      calls++
      yield { type: 'text-delta', index: 0, text: '已有完整正文。下一步继续验证。' }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    } },
  }
  const session = {
    id: 'max-token-complete',
    snapshotEvents() { return [] },
    deriveMessages() { return [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '生成回顾' }] }] },
  }
  try {
    apply(ctx, Config({ provider: 'test-provider', model: 'test-model', maxOutputTokens: 4096, hostCommand: true }))
    const result = await command.handler({ agent: { session }, signal: new AbortController().signal })
    assert.deepEqual(result, { kind: 'success', text: '已有完整正文。下一步继续验证。' })
    assert.equal(calls, 1)
  } finally {
    for (const fn of dispose) fn?.()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test('filtered-empty transcript fails before calling the model', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recap-empty-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  const { apply, Config } = await import('../lib/index.js')
  let command
  let calls = 0
  const dispose = []
  const ctx = {
    on() {},
    effect(setup) { dispose.push(setup()) },
    inject(names, setup) { if (names.includes('commands')) setup(ctx) },
    commands: { register(value) { command = value } },
    sessionProjections: projectionRuntime(),
    llm: { async *stream() { calls++; yield { type: 'finish', reason: { kind: 'stop' } } } },
  }
  const session = {
    id: 'filtered-empty',
    snapshotEvents() { return [] },
    deriveMessages() {
      return [{ role: 'user', source: { kind: 'plugin', plugin: 'other' }, content: [{ type: 'text', text: 'injected only' }] }]
    },
  }
  try {
    apply(ctx, Config({ provider: 'test-provider', model: 'test-model', hostCommand: true }))
    const result = await command.handler({ agent: { session }, signal: new AbortController().signal })
    assert.equal(result.kind, 'error')
    assert.match(result.text, /no usable conversation messages/)
    assert.equal(calls, 0)
  } finally {
    for (const fn of dispose) fn?.()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * The Web profile leaves the optional host command disabled, so the client
 * contribution remains the only slash-catalog owner in every inject order.
 */
test('a web profile omits the host slash command and generates manual recaps through the route', async () => {
  const scenario = async (order) => {
    const root = mkdtempSync(join(tmpdir(), 'recap-web-'))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = root
    const { apply, Config } = await import('../lib/index.js')
    let command
    let route
    let calls = 0
    const dispose = []
    const session = {
      id: 'web-' + order.join('-'),
      snapshotEvents() { return [] },
      deriveMessages() { return [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '测试 Web 手动回顾' }] }] },
    }
    const pending = new Map()
    const ctx = {
      on() {},
      effect(setup) { dispose.push(setup()) },
      inject(names, setup) { pending.set(names.includes('webServer') ? 'web' : 'commands', setup) },
      commands: { register(value) { command = value; return () => { command = undefined } } },
      sessionProjections: projectionRuntime(),
      webServer: { register(spec) { route = spec.handler; return () => {} } },
      sessions: { get(id) { return id === session.id ? session : undefined } },
      llm: { async *stream() {
        calls++
        yield { type: 'text-delta', index: 0, text: 'Web 手动回顾可用。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } },
    }
    const responses = []
    const res = {
      writeHead(status) { this.status = status },
      end(body) { responses.push({ status: this.status, body: JSON.parse(String(body)) }) },
    }
    const req = {
      method: 'POST',
      url: '/api/dsh-session-recap?sessionId=' + session.id + '&action=generate',
      headers: { host: 'localhost:3080', origin: 'http://localhost:3080' },
      socket: { remoteAddress: '127.0.0.1' },
    }
    try {
      apply(ctx, Config({ provider: 'test-provider', model: 'test-model' }))
      assert.equal(pending.size, 2, 'both capability injects are requested')
      for (const kind of order) pending.get(kind)(ctx)
      assert.equal(command, undefined, order.join('>') + ': no host slash owner is registered')
      assert.equal(typeof route, 'function', order.join('>') + ': the web route is mounted')
      await route({ ...req, method: 'GET', url: '/api/dsh-session-recap?sessionId=' + session.id }, res)
      assert.deepEqual(responses.shift(), { status: 200, body: { recap: null } })
      await route({ ...req, headers: { ...req.headers, origin: 'http://localhost:5173' } }, res)
      assert.deepEqual(responses.shift(), { status: 403, body: { error: 'forbidden origin' } })
      assert.equal(calls, 0, 'cross-origin write never starts generation')
      const { origin: _origin, ...headersWithoutOrigin } = req.headers
      await route({ ...req, headers: headersWithoutOrigin }, res)
      assert.deepEqual(responses.shift(), { status: 403, body: { error: 'forbidden origin' } })
      assert.equal(calls, 0, 'origin-less write never starts generation')
      await route(req, res)
      assert.deepEqual(responses, [{ status: 200, body: { ok: true } }])
      assert.equal(calls, 1)
      const stored = JSON.parse(readFileSync(join(root, 'plugin-data/dsh-session-recap/' + session.id + '.json'), 'utf8'))
      assert.equal(stored.text, 'Web 手动回顾可用。')
    } finally {
      for (const fn of dispose) fn?.()
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      rmSync(root, { recursive: true, force: true })
    }
  }
  await scenario(['web', 'commands'])
  await scenario(['commands', 'web'])
})
