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
