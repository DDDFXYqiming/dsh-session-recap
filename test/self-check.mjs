#!/usr/bin/env node
/** Self-check for recap input framing: node test/self-check.mjs (after build). */
import assert from 'node:assert/strict'
import { Config, internals } from '../lib/index.js'

const { frameTranscript, systemPrompt, languageDirective } = internals

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
  assert.match(prompt, /language the user writes their own sentences in/)
  assert.match(prompt, /pasted logs, code, and quoted material/)
  assert.ok(!prompt.includes('overall goal'))
})

check('recentMessages default widened to 80', () => {
  assert.equal(Config.dict.recentMessages.meta.default, 80)
})

check('maxOutputTokens default raised to 1024 and Config fills it', () => {
  assert.equal(Config.dict.maxOutputTokens.meta.default, 1024)
  assert.equal(Config({}).maxOutputTokens, 1024)
})

check('transcript keeps only real human input as user entries', () => {
  const injected = (kind, text) => ({ role: 'user', source: { kind }, content: [{ type: 'text', text }] })
  const transcript = frameTranscript([
    injected('plugin', 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots in English.'),
    injected('subagent-report', 'Background subagent finished with an English report.'),
    injected('agent-instructions', '<system-reminder> English instructions </system-reminder>'),
    assistant('English assistant prose about code and logs.'),
    user('修 recap 的语言判定'),
  ], 80, 24000)
  const parsed = JSON.parse(transcript)
  const userEntries = parsed.recent.filter((entry) => entry.role === 'user')
  assert.equal(userEntries.length, 1)
  assert.ok(userEntries[0].text.includes('修 recap 的语言判定'))
})

check('goal anchor ignores injected user-role messages', () => {
  const injected = { role: 'user', source: { kind: 'plugin' }, content: [{ type: 'text', text: 'English injected context that is not the human' }] }
  const messages = [user('真正的最新请求'), assistant('ok'), injected]
  for (let index = 0; index < 90; index++) messages.push(assistant('步骤 ' + index))
  const parsed = JSON.parse(frameTranscript(messages, 5, 24000))
  assert.equal(parsed.goal, '真正的最新请求')
})

check('language directive carries multi-samples plus paste-aware hierarchy, no language names', () => {
  const d = languageDirective(['修 recap 的语言判定', 'Error: ENOENT: no such file or directory, open C:\\x', '还是不行，你自己看日志'])
  assert.match(d, /recap-language/)
  assert.match(d, /pasted logs, code/)
  assert.match(d, /mirror the language the assistant entries reply in/)
  assert.ok(d.includes('修 recap 的语言判定'))
  assert.ok(d.includes('还是不行，你自己看日志'))
  assert.ok(d.indexOf('修 recap') < d.indexOf('还是不行'), 'samples keep chronological order')
  assert.ok(!/中文|English|日本語/.test(d))
  assert.match(languageDirective([]), /user-role entries above/)
})
check('frameTranscript survives image-only and empty user messages', () => {
  const img = { role: 'user', source: { kind: 'user' }, content: [{ type: 'image', name: 'x', contentType: 'image/png', url: '' }] }
  const t = frameTranscript([img, user('看图'), assistant('ok')], 80, 24000)
  const parsed = JSON.parse(t)
  assert.equal(parsed.recent.filter((e) => e.role === 'user').length, 1)
})

console.log('PASS all ' + checks + ' self-checks')
