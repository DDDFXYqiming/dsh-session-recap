import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import React from 'react'
import { act, create } from 'react-test-renderer'

// 卡片仅依赖回顾路由，可选的 turnSeq/turnOpen 用于识别过期结果。
// 现有宿主通过 recap: null 清除旧回顾。
function loadPlugin(dismissed, state) {
  let bundle
  let slot
  const listeners = { window: {}, document: {} }
  const on = (scope) => (type, fn) => { (listeners[scope][type] ??= []).push(fn) }
  const off = (scope) => (type, fn) => { listeners[scope][type] = (listeners[scope][type] ?? []).filter(value => value !== fn) }
  const disposers = []
  const requests = []
  const sandbox = {
    window: {
      __ModuleLoader__: { load(value) { bundle = value } },
      sessionStorage: { getItem: key => dismissed.get(key) ?? null, setItem: (key, value) => dismissed.set(key, value) },
      addEventListener: on('window'), removeEventListener: off('window'),
    },
    document: {
      hidden: false, hasFocus: () => true,
      querySelector: () => ({ dataset: {}, style: {} }),
      addEventListener: on('document'), removeEventListener: off('document'),
    },
    fetch: async (url, options) => {
      requests.push({ url: new URL(url, 'http://localhost'), options })
      return { ok: true, json: async () => state.body }
    },
    setTimeout, clearTimeout, setInterval, clearInterval, AbortController, AbortSignal,
  }
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), sandbox)
  const plugin = bundle.factory(name => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(name)
  })
  plugin.apply({
    effect: setup => { const dispose = setup(); if (dispose) disposers.push(dispose) },
    locale: { register: () => () => {}, bind: () => key => key },
    inject() {},
    slots: { inject(_name, setup) { setup() }, register(_spec, render) { slot = render; return () => {} } },
  })
  // 卡片的数据只走 HTTP 轮询；窗口重新获得焦点会立刻补一次拉取，
  // 这既是“用户回来了”的时刻，也是测试推进一轮轮询的入口。
  const fire = async (scope, type) => {
    await act(async () => {
      for (const fn of listeners[scope][type] ?? []) fn()
      await new Promise(resolve => setTimeout(resolve, 30))
    })
  }
  return { slot, fire, requests, document: sandbox.document, listeners, dispose: () => disposers.reverse().forEach(fn => fn()) }
}

test('卡片只认路由响应，宿主未提供新鲜度字段时照常显示', async () => {
  const dismissed = new Map()
  const recap = { text: '已完成文件验证。', turnSeq: 10, at: 123456 }
  const state = { body: { recap, turnSeq: 10, turnOpen: false } }
  const { slot, fire, dispose } = loadPlugin(dismissed, state)
  const props = { sessionId: 'refresh-fixture' }
  let renderer
  const render = async () => {
    await act(async () => {
      if (renderer) renderer.update(slot(props))
      else renderer = create(slot(props))
    })
  }
  const notes = () => renderer.root.findAllByProps({ role: 'note' }).length
  try {
    await render()
    await fire('window', 'focus')
    assert.equal(notes(), 1, '回顾可先于历史消息显示')

    // 新回合开始：宿主报 turnOpen，卡片必须收起且写进关闭记录。
    state.body = { recap, turnSeq: 10, turnOpen: true }
    await fire('window', 'focus')
    assert.equal(notes(), 0, '宿主开启新回合即收起旧回顾')
    assert.equal(dismissed.size, 1, '收起要落关闭记录，避免闪回')

    // 旧宿主：响应里没有 turnSeq/turnOpen，只有 sidecar 说话。
    // 换一个会话 id：上一轮已经写入关闭记录（内存镜像 + sessionStorage），
    // 同一会话理应继续保持收起。
    props.sessionId = 'legacy-host-fixture'
    state.body = { recap, manualRequestTimeoutMs: 70000 }
    await render()
    await fire('window', 'focus')
    assert.equal(notes(), 1, '缺少新鲜度字段的宿主不能把卡片判死')
    await act(async () => renderer.root.findByProps({ 'aria-label': 'dismiss' }).props.onClick())
    assert.equal(notes(), 0, '关闭按钮保持有效')
  } finally {
    if (renderer) await act(async () => renderer.unmount())
    dispose()
  }
})

test('关闭按钮的结果在重新挂载后保持', async () => {
  const dismissed = new Map()
  const recap = { text: '已完成文件验证。', turnSeq: 10, at: 123456 }
  const state = { body: { recap, turnSeq: 10, turnOpen: false } }
  const { slot, fire, dispose } = loadPlugin(dismissed, state)
  const props = { sessionId: 'remount-fixture' }
  let renderer
  const render = async () => {
    await act(async () => {
      if (renderer) renderer.update(slot(props))
      else renderer = create(slot(props))
    })
  }
  try {
    await render()
    await fire('window', 'focus')
    assert.equal(renderer.root.findAllByProps({ role: 'note' }).length, 1)
    await act(async () => renderer.root.findByProps({ 'aria-label': 'dismiss' }).props.onClick())
    await act(async () => renderer.unmount())
    renderer = null
    await render()
    await fire('window', 'focus')
    assert.equal(renderer.root.findAllByProps({ role: 'note' }).length, 0, '手动关闭结果在重新挂载后保持')
  } finally {
    if (renderer) await act(async () => renderer.unmount())
    dispose()
  }
})

test('全局焦点覆盖会话切换、组件卸载和无会话页面', async () => {
  const plugin = loadPlugin(new Map(), { body: { recap: null } })
  const presence = () => plugin.requests.filter(item => item.url.searchParams.has('presence'))
  let renderer
  try {
    assert.equal(presence()[0].url.searchParams.get('scope'), 'app')
    assert.equal(presence()[0].url.searchParams.has('sessionId'), false)
    await act(async () => { renderer = create(plugin.slot({ sessionId: 'first' })) })
    await act(async () => { renderer.update(plugin.slot({ sessionId: 'second' })) })
    assert.equal(presence().at(-1).url.searchParams.get('sessionId'), 'second')
    assert.ok(presence().every(item => item.url.searchParams.get('presence') === 'active'))
    const beforeUnmount = presence().length
    await act(async () => renderer.unmount())
    renderer = null
    assert.equal(presence().length, beforeUnmount, '会话组件卸载不代表离开应用')
    plugin.document.hasFocus = () => false
    await plugin.fire('window', 'blur')
    assert.equal(presence().at(-1).url.searchParams.get('presence'), 'away')
    assert.equal(presence().at(-1).url.searchParams.has('sessionId'), false)
    plugin.document.hasFocus = () => true
    await plugin.fire('window', 'focus')
    assert.equal(presence().at(-1).url.searchParams.get('presence'), 'active')
    await plugin.fire('window', 'pagehide')
    assert.equal(presence().at(-1).url.searchParams.get('presence'), 'away')
    await plugin.fire('window', 'pageshow')
    assert.equal(presence().at(-1).url.searchParams.get('presence'), 'active')
    assert.equal(new Set(presence().map(item => item.url.searchParams.get('clientId'))).size, 1)
    const sequences = presence().map(item => Number(item.url.searchParams.get('seq')))
    assert.ok(sequences.every((value, index) => index === 0 || value > sequences[index - 1]))
  } finally {
    if (renderer) await act(async () => renderer.unmount())
    plugin.dispose()
  }
  assert.equal(Object.values(plugin.listeners.window).flat().length, 0)
  assert.equal(Object.values(plugin.listeners.document).flat().length, 0)
})

test('客户端不再订阅 useSession/useConversation', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes('useConversation'), false, '时间线选择器必须从客户端消失')
  assert.equal(source.includes('useSession'), false, '会话 store 订阅必须从客户端消失')
})

test('src/client.js 与 lib/client.js 同步（构建产物不得落后于源码）', () => {
  assert.equal(
    readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'),
    'lib/client.js 与 src/client.js 不一致，先跑 npm run build:client',
  )
})
