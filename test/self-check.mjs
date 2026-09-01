#!/usr/bin/env node
/** Self-check for recap input framing: node test/self-check.mjs (after build). */
import assert from 'node:assert/strict'
import { Config, internals } from '../lib/index.js'

const { frameTranscript, systemPrompt } = internals

const user = (text) => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const assistant = (text) => ({ role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text }, { type: 'tool-call', toolCallId: 'c1', name: 'bash', input: {} }] })
// dsh records every tool result as its own user-role message holding raw output
const toolResult = (text) => ({ role: 'user', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text }], isError: false }] })

let checks = 0
const check = (name, fn) => { fn(); checks += 1; console.log('PASS ' + name) }

check('tool results never enter the recap window or the byte budget', () => {
  const transcript = frameTranscript([
    user('开场任务：接入新模型'),
    toolResult('RAW_LOG_MARKER ' + 'x'.repeat(4000)),
    assistant('我看了一下'),
    user('当前任务：修 recap 过期问题'),
  ], 2, 24000)
  assert.ok(!transcript.includes('RAW_LOG_MARKER'))
  const parsed = JSON.parse(transcript)
  // The newest user request is inside the window, so it must not be duplicated as goal.
  assert.equal(parsed.goal, '')
})

check('goal anchors on the newest request, not the session opening', () => {
  const messages = [user('开场目标：把 OpenRouter 模型改为 glm5.3flash'), user('当前任务：修复 recap 会话漂移')]
  for (let index = 0; index < 90; index++) messages.push(assistant('步骤 ' + index + ' 完成'))
  const transcript = frameTranscript(messages, 5, 24000)
  const parsed = JSON.parse(transcript)
  assert.ok(transcript.includes('当前任务'))
  assert.ok(!transcript.includes('开场目标'))
  assert.equal(parsed.goal, '当前任务：修复 recap 会话漂移')
})

check('transcript stays valid JSON within the UTF-8 byte bound', () => {
  const transcript = frameTranscript([user('很长的目标。'.repeat(600)), user('下一个请求')], 30, 500)
  assert.ok(Buffer.byteLength(transcript, 'utf8') <= 500)
  JSON.parse(transcript)
})

check('prompt leads with the current task and names tool noise', () => {
  const prompt = systemPrompt()
  assert.match(prompt, /Lead with the current task/)
  assert.match(prompt, /as noise, not intent/)
  assert.match(prompt, /same language the user writes in/)
  assert.ok(!prompt.includes('overall goal'))
})

check('recentMessages default widened to 80', () => {
  assert.equal(Config.dict.recentMessages.meta.default, 80)
})

console.log('PASS all ' + checks + ' self-checks')
