import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import React from 'react'
import { act, create } from 'react-test-renderer'

// 用真实 React 生命周期复现回顾先返回、历史时间线后加载的顺序。
test('刷新恢复与加载旧页保留回顾，新消息和手动关闭仍能收起', async () => {
  const dismissed = new Map()
  let bundle
  let slot
  let chat = { order: [], nodes: new Map() }
  const recap = { text: '已完成文件验证。', turnSeq: 10, at: 123456 }
  const sandbox = {
    window: {
      __ModuleLoader__: { load(value) { bundle = value } },
      sessionStorage: { getItem: key => dismissed.get(key) ?? null, setItem: (key, value) => dismissed.set(key, value) },
      addEventListener() {}, removeEventListener() {},
    },
    document: {
      hidden: false, hasFocus: () => true,
      querySelector: () => ({ dataset: {}, style: {} }),
      addEventListener() {}, removeEventListener() {},
    },
    fetch: async () => ({ ok: true, json: async () => ({ recap }) }),
    setTimeout, clearTimeout, setInterval, clearInterval, AbortController, AbortSignal,
  }
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), sandbox)
  const plugin = bundle.factory(name => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(name)
  })
  plugin.apply({
    effect: setup => setup(),
    locale: { register: () => () => {}, bind: () => key => key },
    inject() {},
    slots: { inject(_name, setup) { setup() }, register(_spec, render) { slot = render; return () => {} } },
  })
  const props = {
    sessionId: 'refresh-fixture',
    useSession: selector => selector({ running: false }),
    useConversation: selector => selector({ views: { get: () => chat } }),
  }
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
    assert.equal(notes(), 1, '回顾可先于历史消息显示')
    chat = { order: ['history'], nodes: new Map([['history', { kind: 'message', anchorSeq: 9 }]]) }
    await render()
    assert.equal(notes(), 1, '历史回放不能关闭卡片')
    assert.equal(dismissed.size, 0, '历史回放不能写入关闭记录')
    chat = { order: ['history', 'tail'], nodes: new Map([
      ['history', { kind: 'user', anchorSeq: 9 }], ['tail', { kind: 'turn-tail', anchorSeq: 10.1 }],
    ]) }
    await render()
    assert.equal(notes(), 1, '尾部控件的小数排序坐标不属于新事件')
    assert.equal(dismissed.size, 0)
    chat = { order: ['older', 'history'], nodes: new Map([
      ['older', { kind: 'message', anchorSeq: 2 }], ['history', { kind: 'message', anchorSeq: 9 }],
    ]) }
    await render()
    assert.equal(notes(), 1, '加载更早的消息仍保留卡片')
    chat = { order: ['history', 'new'], nodes: new Map([
      ['history', { kind: 'message', anchorSeq: 9 }], ['new', { kind: 'message', anchorSeq: 11 }],
    ]) }
    await render()
    assert.equal(notes(), 0, '新消息正常收起旧回顾')
    assert.equal(dismissed.size, 1)

    await act(async () => renderer.unmount())
    renderer = null
    dismissed.clear()
    chat = { order: [], nodes: new Map() }
    await render()
    await act(async () => renderer.root.findByProps({ 'aria-label': 'dismiss' }).props.onClick())
    assert.equal(notes(), 0, '关闭按钮保持有效')
    await act(async () => renderer.unmount())
    renderer = null
    await render()
    assert.equal(notes(), 0, '手动关闭结果在重新挂载后保持')
  } finally {
    if (renderer) await act(async () => renderer.unmount())
  }
})
