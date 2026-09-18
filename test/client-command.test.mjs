import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * The Web bundle owns the styled slash row and posts manual generation to the
 * sidecar route. Headless profiles can opt into a separate host command.
 */
let handoff
const react = {
  createElement() { return null },
  useState(value) { return [value, () => {}] },
  useRef(value) { return { current: value } },
  useEffect() {},
}
const RecapIcon = () => null
const importBundle = async () => {
  if (handoff !== undefined) return handoff
  globalThis.window = {
    __ModuleLoader__: { load(value) { handoff = value } },
    sessionStorage: { getItem() { return null }, setItem() {} },
  }
  globalThis.document = {
    hidden: false,
    hasFocus() { return true },
    querySelector() { return { dataset: {}, style: {}, textContent: '' } },
    createElement() { return { dataset: {}, style: {} } },
    head: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
  }
  await import('../lib/client.js')
  assert.equal(handoff.id, '@dsh-external/dsh-session-recap')
  return handoff
}

/** One fresh module instance; a bundle load is import-once, the factory is per-call. */
const loadBundle = async () => {
  const loaded = await importBundle()
  return loaded.factory((name) => {
    if (name === 'react') return react
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { IconListPenOutline16: RecapIcon }
    throw new Error('unexpected require: ' + name)
  })
}

const mount = (module, posted) => {
  const dictionaries = {}
  const contrib = {}
  const ctx = {
    effect(setup) { setup() },
    locale: {
      register(namespace, values) { dictionaries[namespace] = values; return () => {} },
      bind() { return (key) => key },
    },
    inject(names, setup) {
      assert.ok(names.includes('commandUi'))
      setup({
        get() { return { register(value) { contrib.value = value; return () => {} } } },
        effect(setup2) { setup2() },
      })
    },
    slots: { inject() {} },
  }
  module.apply(ctx)
  return { dictionaries, contrib }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('the Web slash command keeps its localized official row and posts the manual action', async () => {
  const posted = []
  globalThis.fetch = async (url, options) => {
    posted.push({ url, method: options.method, hasDeadline: options.signal instanceof AbortSignal })
    return { ok: true, json: async () => ({ ok: true }) }
  }
  const { dictionaries, contrib } = mount(await loadBundle(), posted)

  const dict = dictionaries['@dsh-external/dsh-session-recap']
  assert.deepEqual(Object.keys(dict.zh).sort(), Object.keys(dict.en).sort())
  assert.ok('failed' in dict.zh && 'failed' in dict.en)
  assert.equal(dict.zh.commandLabel, '会话回顾')
  assert.match(dict.zh.commandDescription, /当前任务/)

  assert.equal(contrib.value.name, 'recap')
  assert.equal(contrib.value.label(), 'commandLabel')
  assert.equal(contrib.value.description(), 'commandDescription')
  assert.equal(contrib.value.icon, RecapIcon)
  assert.equal(contrib.value.ui.kind, 'action')
  assert.equal(contrib.value.available({ sessionId: 'session-1' }), true)

  contrib.value.ui.run({ sessionId: 'session-1' })
  await tick()
  assert.deepEqual(posted, [{ url: '/api/dsh-session-recap?sessionId=session-1&action=generate', method: 'POST', hasDeadline: true }])

  globalThis.fetch = async () => ({ ok: true, json: async () => ({ error: 'Recap failed: another recap is already generating' }) })
  contrib.value.ui.run({ sessionId: 'session-1' })
  await tick()
})

test('mounting the contribution performs no ownership probe', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; return { ok: false, json: async () => null } }
  const { contrib } = mount(await loadBundle(), [])
  await tick()
  assert.equal(contrib.value.name, 'recap')
  assert.equal(contrib.value.available({ sessionId: 'session-1' }), true)
  assert.equal(calls, 0)
})
