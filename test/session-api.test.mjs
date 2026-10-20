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
      assert.deepEqual(responses.shift(), { status: 200, body: { recap: null, manualRequestTimeoutMs: 70000 } })
      await route({ ...req, headers: { ...req.headers, origin: 'http://localhost:5173' } }, res)
      assert.deepEqual(responses.shift(), { status: 403, body: { error: 'forbidden origin' } })
      assert.equal(calls, 0, 'cross-origin write never starts generation')
      await route({ ...req, headers: { ...req.headers, 'sec-fetch-site': 'cross-site' } }, res)
      assert.deepEqual(responses.shift(), { status: 403, body: { error: 'forbidden origin' } })
      assert.equal(calls, 0, 'explicit cross-site write never starts generation')
      const { origin: _origin, ...headersWithoutOrigin } = req.headers
      await route({ ...req, headers: headersWithoutOrigin }, res)
      assert.deepEqual(responses.shift(), { status: 200, body: { ok: true } })
      assert.equal(calls, 1, 'origin-less loopback write runs — the DSH desktop-transport shape')
      await route(req, res)
      assert.deepEqual(responses, [{ status: 200, body: { ok: true } }])
      assert.equal(calls, 2)
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

const flushRecap = () => new Promise((resolve) => setImmediate(resolve))

async function appPresenceHarness(t, { hold = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'recap-presence-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  const { apply, Config } = await import('../lib/index.js')
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 200000 })
  const sessions = new Map()
  const listeners = new Map()
  const dispose = []
  const calls = []
  let route
  const ctx = {
    on(name, handler) { listeners.set(name, handler) },
    effect(setup) { dispose.push(setup()) },
    inject(_names, setup) { setup(ctx) },
    sessionProjections: projectionRuntime(),
    webServer: { register(spec) { route = spec.handler; return () => {} } },
    sessions: { get(id) { return sessions.get(id) } },
    llm: { async *stream(options) {
      const call = { sessionId: options.sessionId, signal: options.signal, release() {} }
      calls.push(call)
      const text = '回顾' + calls.length + '。'
      if (hold) await new Promise((resolve) => { call.release = resolve })
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } },
  }
  t.after(async () => {
    for (const fn of dispose) fn?.()
    for (const call of calls) call.release()
    await flushRecap()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  })
  apply(ctx, Config({ provider: 'test-provider', model: 'test-model', idleMs: 1000, minTurns: 1 }))
  const request = async (params, method = 'POST') => {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) query.set(key, String(value))
    }
    let response
    const res = {
      writeHead(status) { this.status = status },
      end(body) { response = { status: this.status, body: body === undefined ? undefined : JSON.parse(String(body)) } },
    }
    await route({
      method,
      url: '/api/dsh-session-recap?' + query,
      headers: { host: 'localhost:3080', origin: 'http://localhost:3080' },
      socket: { remoteAddress: '127.0.0.1' },
    }, res)
    return response
  }
  return {
    calls,
    request,
    addSession(id, parentSession) {
      const events = [{ type: 'turn/end', seq: 1, time: Date.now() - 60000, data: { reason: { kind: 'completed' } } }]
      const session = {
        id,
        header: parentSession === undefined ? {} : { parentSession },
        snapshotEvents() { return [...events] },
        deriveMessages() { return [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '回顾当前任务' }] }] },
      }
      sessions.set(id, session)
      return {
        completeTurn() {
          for (const type of ['turn/start', 'turn/end']) {
            const event = { type, seq: events.length + 1, time: Date.now(), data: { reason: { kind: 'completed' } } }
            events.push(event)
            listeners.get('session/event')(session, event)
          }
        },
      }
    },
    presence(presence, clientId, seq, sessionId) {
      return request({ scope: 'app', presence, clientId, seq, sessionId })
    },
    async tick(ms) {
      t.mock.timers.tick(ms)
      await flushRecap()
    },
    async recap(sessionId) {
      return (await request({ sessionId }, 'GET')).body.recap
    },
  }
}

test('全局 presence 可无会话，旧协议拒绝且不污染状态', async (t) => {
  const h = await appPresenceHarness(t)
  h.addSession('visited')
  const legacy = await h.request({ presence: 'active', clientId: 'legacy', seq: 1, sessionId: 'visited' })
  assert.equal(legacy.status, 409)
  assert.match(legacy.body.error, /Refresh/)
  assert.equal((await h.request({}, 'GET')).status, 400)
  assert.equal((await h.request({ action: 'generate' })).status, 400)
  assert.equal((await h.request({ action: 'generate', sessionId: 'missing' })).status, 404)
  assert.equal((await h.presence('away', 'page', 1)).status, 204)
  await h.tick(1000)
  assert.equal(h.calls.length, 0, '没有访问记录时不自动枚举会话')
  assert.equal((await h.presence('away', 'page', 2, 'missing')).status, 204)
  await h.tick(1000)
  assert.equal(h.calls.length, 0)
  await h.presence('active', 'page', 3, 'visited')
  await h.presence('away', 'page', 4)
  await h.tick(1000)
  assert.deepEqual(h.calls.map((call) => call.sessionId), ['visited'])
})

test('任意页面活跃保护所有已访问会话，重复 away 不重置计时', async (t) => {
  const h = await appPresenceHarness(t)
  const a = h.addSession('a')
  h.addSession('b')
  h.addSession('unvisited')
  h.addSession('child', 'a')
  await h.presence('active', 'page-a', 1, 'a')
  await h.presence('active', 'page-a', 2, 'b')
  await h.presence('active', 'page-a', 3, 'child')
  a.completeTurn()
  await h.tick(1000)
  assert.equal(h.calls.length, 0, '切换会话后旧会话仍受全局焦点保护')
  await h.presence('active', 'page-b', 1)
  await h.presence('away', 'page-a', 4)
  await h.tick(1000)
  assert.equal(h.calls.length, 0, '另一个标签活跃仍阻止自动总结')
  await h.presence('away', 'page-b', 2)
  await h.tick(500)
  await h.presence('away', 'page-a', 5)
  await h.tick(499)
  assert.equal(h.calls.length, 0)
  await h.tick(1)
  assert.deepEqual(h.calls.map((call) => call.sessionId).sort(), ['a', 'b'])
})

test('租约失联保持 unknown，旧序号不能解除阻断', async (t) => {
  const h = await appPresenceHarness(t)
  h.addSession('a')
  await h.presence('active', 'page-a', 1, 'a')
  await h.tick(45000)
  assert.equal(h.calls.length, 0)
  await h.presence('away', 'page-b', 1)
  await h.presence('away', 'page-a', 1)
  await h.tick(1000)
  assert.equal(h.calls.length, 0)
  await h.presence('away', 'page-a', 2)
  await h.tick(999)
  assert.equal(h.calls.length, 0)
  await h.tick(1)
  assert.equal(h.calls.length, 1)
})

test('恢复焦点取消全部在途自动任务，保留手动任务与新离开周期', async (t) => {
  const h = await appPresenceHarness(t, { hold: true })
  for (const id of ['a', 'b', 'manual']) h.addSession(id)
  await h.presence('active', 'page', 1, 'a')
  await h.presence('active', 'page', 2, 'b')
  await h.presence('away', 'page', 3)
  await h.tick(1000)
  assert.equal(h.calls.length, 2)
  const manual = h.request({ action: 'generate', sessionId: 'manual' })
  await flushRecap()
  assert.equal(h.calls.length, 3)
  await h.presence('active', 'page', 4)
  assert.equal(h.calls[0].signal.aborted, true)
  assert.equal(h.calls[1].signal.aborted, true)
  assert.equal(h.calls[2].signal.aborted, false)
  await h.presence('away', 'page', 5)
  await h.tick(1000)
  assert.equal(h.calls.length, 5, '新周期无需等待已取消的旧流退出')
  h.calls[0].release()
  h.calls[1].release()
  await flushRecap()
  assert.equal(await h.recap('a'), null)
  assert.equal(await h.recap('b'), null)
  assert.equal((await h.request({ action: 'generate', sessionId: 'a' })).status, 409, '旧任务退出不能释放新任务槽位')
  h.calls[2].release()
  assert.equal((await manual).status, 200)
  assert.equal((await h.recap('manual')).text, '回顾3。')
  h.calls[3].release()
  h.calls[4].release()
  await flushRecap()
  assert.equal((await h.recap('a')).text, '回顾4。')
  assert.equal((await h.recap('b')).text, '回顾5。')
})

test('重新聚焦重置离开计时，离开期间的新回合仍需冷却', async (t) => {
  const h = await appPresenceHarness(t)
  const a = h.addSession('a')
  await h.presence('away', 'page', 1, 'a')
  await h.tick(900)
  await h.presence('active', 'page', 2)
  await h.tick(200)
  assert.equal(h.calls.length, 0)
  await h.presence('away', 'page', 3)
  await h.tick(900)
  a.completeTurn()
  await h.tick(999)
  assert.equal(h.calls.length, 0)
  await h.tick(1)
  assert.equal(h.calls.length, 1)
})
