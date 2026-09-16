import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('manual recap uses rc.1 snapshots, publishes a sidecar and rejects open turns', async () => {
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
    apply(ctx, Config({ provider: 'test-provider', model: 'test-model' }))
    const invoke = () => command.handler({ agent: { session }, signal: new AbortController().signal })
    assert.deepEqual(await invoke(), { kind: 'success' })
    assert.ok(snapshots >= 3)
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

/**
 * An interactive profile owns the slash name on the client: only a client
 * contribution can carry the built-in menu row face (glyph, localized label and
 * description), and a host command of the same name would fail the whole menu.
 * So the Web profile releases the host command — in either inject order — and
 * manual recaps arrive through the route action instead.
 */
test('a web profile releases the slash name and generates manual recaps through the route', async () => {
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
      assert.equal(command, undefined, order.join('>' ) + ': the host command is not registered in a web profile')
      assert.equal(typeof route, 'function', order.join('>') + ': the web route is mounted')
      const probe = { ...req, method: 'GET', url: '/api/dsh-session-recap?action=capabilities' }
      await route(probe, res)
      assert.deepEqual(responses.shift(), { status: 200, body: { hostRecap: false } })
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
