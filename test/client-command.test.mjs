import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * The Web slash row is a client contribution: it is the only place a
 * third-party command can carry the built-in row face (glyph, localized label
 * and description), and its action posts the manual recap to the host route.
 * It must also stay out of the menu while the host still owns the name — two
 * owners of one slash name make ui-commands fail the whole menu.
 */
let handoff
const react = {
  createElement() { return null },
  useState(value) { return [value, () => {}] },
  useRef(value) { return { current: value } },
  useEffect() {},
}
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
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { IconListPenOutline16() {} }
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

test('a free slash name yields the localized contribution and posts the manual action', async () => {
  const posted = []
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('action=capabilities')) return { ok: true, json: async () => ({ hostRecap: false }) }
    posted.push({ url, method: options.method })
    return { ok: true, json: async () => ({ ok: true }) }
  }
  const { dictionaries, contrib } = mount(await loadBundle(), posted)

  const dict = dictionaries['@dsh-external/dsh-session-recap']
  assert.deepEqual(Object.keys(dict.zh).sort(), Object.keys(dict.en).sort())
  for (const key of ['command.label', 'command.description', 'failed']) assert.ok(key in dict.zh && key in dict.en)

  assert.equal(contrib.value.name, 'recap')
  assert.equal(contrib.value.ui.kind, 'action')
  assert.equal(contrib.value.label(), 'command.label')
  assert.equal(contrib.value.description(), 'command.description')
  assert.equal(typeof contrib.value.icon, 'function')
  assert.equal(contrib.value.available({ sessionId: 'session-1' }), false, 'unavailable until the host answers')
  await tick()
  assert.equal(contrib.value.available({ sessionId: 'session-1' }), true)

  contrib.value.ui.run({ sessionId: 'session-1' })
  await tick()
  assert.deepEqual(posted, [{ url: '/api/dsh-session-recap?sessionId=session-1&action=generate', method: 'POST' }])

  globalThis.fetch = async () => ({ ok: true, json: async () => ({ error: 'Recap failed: another recap is already generating' }) })
  contrib.value.ui.run({ sessionId: 'session-1' })
  await tick()
})

test('a host generation without the probe keeps the name, so the menu never sees two owners', async () => {
  globalThis.fetch = async () => ({ ok: false, json: async () => ({ error: 'sessionId is required' }) })
  const { contrib } = mount(await loadBundle(), [])
  await tick()
  assert.equal(contrib.value.available({ sessionId: 'session-1' }), false)
})