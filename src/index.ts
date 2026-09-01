/**
 * dsh-session-recap — Claude Code-style session recap for DeepSeek Harness.
 *
 * Host half: watches completed turns and Web focus/session presence. Once the
 * last completed turn is old enough and the user is genuinely away, one bounded
 * auxiliary LLM call distills the recent conversation into a short recap. The
 * result is kept in a plugin-owned sidecar rather than the append-only session
 * log, because the current DSH release has no public custom-event registration
 * surface. A same-origin Web route carries presence and the current snapshot.
 *
 * @module @dsh-external/dsh-session-recap
 */
import type { Context } from '@deepseek-ai/cordis'
import type LlmService from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { BlockAssembler, createUserMessage, deepFreeze, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { CommandInvocation, CommandRuntime } from '@deepseek-ai/dsh-commands'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type WebServer from '@deepseek-ai/dsh-host-webserver'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { MAX_TIMER_DELAY_MS, deadline } from '@deepseek-ai/dsh-timeout'
import type { Session, SessionEvent, SessionStore } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import type { RecapProjection, RecapResponse } from './types.js'

export const name = '@dsh-external/dsh-session-recap'
/** `llm` is accessed directly by the host generation paths. */
export const inject = ['llm']

export interface Config {
  /** Automatic recap toggle; manual `/recap` remains available. */
  enabled: boolean
  /** Away window after a completed turn before auto-generating a recap (ms). */
  idleMs: number
  /** Minimum completed turns before any automatic recap is generated. */
  minTurns: number
  /** How many recent derived conversation messages feed the recap input. */
  recentMessages: number
  /** Hard cap on the recap text length (characters). */
  maxChars: number
  /** Byte cap for the framed transcript sent to the model. */
  maxInputChars: number
  /** LLM output token budget for one recap. */
  maxOutputTokens: number
  /** Timeout for one recap generation call (ms). */
  timeoutMs: number
  /** Optional fixed route; both provider and model must be set together. */
  provider: string
  model: string
  /** Optional adapter-owned reasoning effort; empty means do not pass one. */
  reasoningEffort: string
  /** Optional sampling temperature; absent means use the adapter default. */
  temperature?: number
  /** Optional stop sequences passed to the recap model. */
  stopSequences: string[]
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  idleMs: z.number().step(1).min(1000).max(MAX_TIMER_DELAY_MS).default(180000),
  minTurns: z.number().step(1).min(1).max(1000).default(3),
  recentMessages: z.number().step(1).min(1).max(200).default(30),
  maxChars: z.number().step(1).min(80).max(400).default(400),
  maxInputChars: z.number().step(1).min(1000).max(200000).default(24000),
  maxOutputTokens: z.number().step(1).min(16).max(4096).default(512).description('Recap-model output token budget.'),
  timeoutMs: z.number().step(1).min(1000).max(MAX_TIMER_DELAY_MS).default(30000).description('Recap generation timeout in milliseconds.'),
  provider: z.string().default('').description('Optional fixed provider; set together with model. Empty reuses the session route.'),
  model: z.string().default('').description('Optional fixed model; set together with provider. Empty reuses the session route.'),
  reasoningEffort: z.string().default('').description('Optional adapter-owned effort id. Empty sends no reasoningEffort.'),
  temperature: z.number().min(0).max(2).description('Optional sampling temperature. Omit to use the adapter default.'),
  stopSequences: z.array(z.string().min(1).max(200)).default([]).description('Optional stop sequences passed to the recap model.'),
})

/** Capability-owned timeout reason code for auxiliary recap requests. */
const RECAP_TIMEOUT_CODE = 'SESSION_RECAP_TIMEOUT'
/** Route used by the Web client to read the in-memory/sidecar snapshot. */
const RECAP_ROUTE = '/api/dsh-session-recap'
/** Maximum accepted size of one sidecar snapshot. */
const MAX_STORED_RECAP_CHARS = 400
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/
const LOOPBACK_ORIGIN = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/

type AppContext = Context & {
  llm: LlmService
}

type WebContext = AppContext & {
  webServer: WebServer
  sessions: SessionStore
}

type RecapStore = {
  directory: string
  values: Map<string, RecapProjection | null>
}

/** Whether the log holds an opened turn without its closing `turn/end`. */
function hasOpenTurn(events: readonly SessionEvent[]): boolean {
  let open = false
  for (const event of events) {
    if (event.type === 'turn/start') open = true
    else if (event.type === 'turn/end') open = false
  }
  return open
}

/** Number of successfully completed turns in the log. */
function turnCount(events: readonly SessionEvent[]): number {
  let count = 0
  for (const event of events) {
    if (event.type === 'turn/end' && event.data.reason.kind === 'completed') count += 1
  }
  return count
}

/** The last `turn/end` event, or undefined for an empty/never-ending log. */
function lastTurnEnd(events: readonly SessionEvent[]): SessionEvent<'turn/end'> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/end') return event
  }
  return undefined
}

/** Extract readable context from provider-neutral message content. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map((block) => {
    if (typeof block !== 'object' || block === null) return ''
    const value = block as { type?: unknown; text?: unknown; name?: unknown; content?: unknown }
    if (value.type === 'text' && typeof value.text === 'string') return value.text
    if (value.type === 'tool-call' && typeof value.name === 'string') return `[tool: ${value.name}]`
    if (value.type === 'tool-result') return contentText(value.content)
    return ''
  }).filter(Boolean).join(' ')
}

/** Keep both the beginning (goal) and end (next action) when bounding text. */
function shortenText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= 24) return text.slice(0, maxChars)
  const head = Math.ceil((maxChars - 21) * 0.65)
  const tail = maxChars - 21 - head
  return `${text.slice(0, head)} … [truncated] … ${text.slice(-tail)}`
}

/**
 * Build a bounded, valid JSON transcript from recent complete messages. The
 * opening user request is retained as `goal` when it has fallen out of the
 * recent window, matching Claude Code's broader-session context effect.
 */
function frameTranscript(messages: readonly Message[], recentMessages: number, maxBytes: number): string {
  const selected = messages.slice(-recentMessages)
  const opening = messages.find((message) => message.role === 'user')
  const openingText = opening === undefined ? '' : contentText(opening.content).replace(/\s+/g, ' ').trim()
  const recent = selected.map((message) => ({
    role: message.role,
    text: contentText(message.content).replace(/\s+/g, ' ').trim(),
  })).filter((entry) => entry.text !== '')
  const frame = {
    goal: opening !== undefined && selected.includes(opening) ? '' : openingText,
    recent,
  }
  const values: Array<{ get: () => string; set: (value: string) => void }> = [
    { get: () => frame.goal, set: (value) => { frame.goal = value } },
    ...recent.map((entry) => ({ get: () => entry.text, set: (value: string) => { entry.text = value } })),
  ]
  const stringify = (): string => JSON.stringify(frame)
  let json = stringify()
  while (Buffer.byteLength(json, 'utf8') > maxBytes) {
    let longestIndex = -1
    for (let index = 0; index < values.length; index += 1) {
      if (longestIndex === -1 || values[index]!.get().length > values[longestIndex]!.get().length) longestIndex = index
    }
    if (longestIndex === -1) break
    const longest = values[longestIndex]!
    const current = longest.get()
    if (current.length === 0) break
    longest.set(shortenText(current, Math.max(0, Math.floor(current.length * 0.75))))
    json = stringify()
  }
  return Buffer.byteLength(json, 'utf8') <= maxBytes ? json : JSON.stringify({ goal: '', recent: [] })
}

/** Bounded away-summary instruction sent to the auxiliary model. */
function systemPrompt(): string {
  return 'The user stepped away and is coming back. Recap in under 40 words, 1-2 plain sentences, no markdown. Write the recap in the same language the user writes in, regardless of the language of these instructions. Lead with the overall goal and current task, then the one next action. Skip root-cause narrative, fix internals, secondary to-dos, and em-dash tangents.'
}

/** Translate terminal finish reasons into an auxiliary-call failure. */
function finishError(finish: BlockAssembler['finish']): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens':
      return new Error('dsh-session-recap: recap output reached maxOutputTokens')
    case 'tool-calls':
      return new Error('dsh-session-recap: recap model unexpectedly requested a tool')
    default:
      return new Error(`dsh-session-recap: unsupported finish reason "${String((finish as { kind: string }).kind)}"`)
  }
}

/** Resolve the explicit route pair or the session's last logged route. */
function resolveRoute(config: Config, session: Session): { provider: string; model: string } {
  const hasProvider = config.provider !== ''
  const hasModel = config.model !== ''
  if (hasProvider !== hasModel) throw new Error('dsh-session-recap: provider and model must be configured together')
  if (hasProvider && hasModel) return { provider: config.provider, model: config.model }
  const context = session.requestContext()
  if (context !== undefined) return { provider: context.provider, model: context.model }
  throw new Error('dsh-session-recap: no logged model route is available; configure provider and model together')
}

/** One bounded auxiliary LLM call using only provider-neutral request fields. */
async function streamRecapOnce(
  ctx: AppContext,
  config: Config,
  route: { provider: string; model: string },
  system: string,
  messages: ReturnType<typeof createUserMessage>[],
  sessionId: Session['id'],
  signal: AbortSignal,
): Promise<string> {
  const callDeadline = deadline(signal, config.timeoutMs, RECAP_TIMEOUT_CODE)
  try {
    const options = deepFreeze({
      provider: route.provider,
      model: route.model,
      ...(config.reasoningEffort === '' ? {} : { reasoningEffort: ReasoningEffortId(config.reasoningEffort) }),
      ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
      ...(config.stopSequences.length === 0 ? {} : { stop: config.stopSequences }),
      messages,
      system,
      maxTokens: config.maxOutputTokens,
      sessionId,
      signal: callDeadline.signal,
    })
    callDeadline.signal.throwIfAborted()
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream(options)) {
      callDeadline.signal.throwIfAborted()
      assembler.push(chunk)
    }
    callDeadline.signal.throwIfAborted()
    const terminalError = finishError(assembler.finish)
    if (terminalError !== undefined) throw terminalError
    const blocks = assembler.blocks()
    if (blocks.some((block) => block.type === 'tool-call')) {
      throw new Error('dsh-session-recap: recap output must contain text only')
    }
    const text = blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, config.maxChars)
    if (text.length === 0) throw new Error('dsh-session-recap: recap model produced no text')
    return text
  } finally {
    const dispose = (callDeadline as { [Symbol.dispose]?: () => void })[Symbol.dispose]
    if (typeof dispose === 'function') dispose.call(callDeadline)
  }
}

/** Run one bounded auxiliary LLM call for the current session. */
async function generateRecap(
  ctx: AppContext,
  config: Config,
  session: Session,
  signal: AbortSignal,
): Promise<string> {
  const route = resolveRoute(config, session)
  const derived = session.deriveMessages()
  if (derived.length === 0) throw new Error('dsh-session-recap: no conversation messages are available')
  const framed = frameTranscript(derived, config.recentMessages, config.maxInputChars)
  const inputBytes = Buffer.byteLength(framed, 'utf8')
  if (inputBytes > config.maxInputChars) {
    throw new Error(`dsh-session-recap: transcript is ${inputBytes} bytes, exceeding maxInputChars ${config.maxInputChars}`)
  }
  const messages = [createUserMessage({
    content: [{ type: 'text', text: framed }],
    source: { kind: 'plugin', plugin: 'dsh-session-recap' },
  })]
  return streamRecapOnce(ctx, config, route, systemPrompt(), messages, session.id, signal)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRecap(value: unknown): RecapProjection | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.text !== 'string' || value.text.trim() === '' || value.text.length > MAX_STORED_RECAP_CHARS) return undefined
  if (typeof value.at !== 'number' || !Number.isFinite(value.at)) return undefined
  const turnSeq = value.turnSeq
  if (turnSeq !== null && (typeof turnSeq !== 'number' || !Number.isSafeInteger(turnSeq) || turnSeq < 0)) return undefined
  return { text: value.text, at: value.at, turnSeq: turnSeq === null ? null : turnSeq }
}

function recapFile(store: RecapStore, sessionId: string): string {
  return join(store.directory, `${encodeURIComponent(sessionId)}.json`)
}

function removeRecapFile(store: RecapStore, sessionId: string): void {
  try {
    unlinkSync(recapFile(store, sessionId))
  } catch {
    // Stale-file cleanup is best effort; it must not make the read route fail.
  }
}

function persistRecapFile(store: RecapStore, sessionId: string, recap: RecapProjection): void {
  mkdirSync(store.directory, { recursive: true })
  const target = recapFile(store, sessionId)
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(recap)}\n`, 'utf8')
    renameSync(temporary, target)
  } finally {
    try { unlinkSync(temporary) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

function readRecapFile(store: RecapStore, sessionId: string): RecapProjection | undefined {
  try {
    return parseRecap(JSON.parse(readFileSync(recapFile(store, sessionId), 'utf8')))
  } catch {
    return undefined
  }
}

function isCurrentRecap(events: readonly SessionEvent[], recap: RecapProjection): boolean {
  if (hasOpenTurn(events)) return false
  const anchor = lastTurnEnd(events)
  return recap.turnSeq === (anchor?.seq ?? null)
}

/** Read a sidecar snapshot and discard it once the session has advanced. */
function currentRecap(store: RecapStore, session: Session): RecapProjection | null {
  const id = session.id
  if (store.values.has(id)) {
    const cached = store.values.get(id) ?? null
    if (cached !== null && !isCurrentRecap(session.events, cached)) {
      store.values.set(id, null)
      removeRecapFile(store, id)
      return null
    }
    return cached
  }
  const recap = readRecapFile(store, id)
  if (recap === undefined || !isCurrentRecap(session.events, recap)) {
    store.values.set(id, null)
    if (recap !== undefined) removeRecapFile(store, id)
    return null
  }
  store.values.set(id, recap)
  return recap
}

function publishRecap(ctx: AppContext, store: RecapStore, session: Session, text: string, turnSeq: number | null): void {
  const recap: RecapProjection = { text, at: Date.now(), turnSeq }
  store.values.set(session.id, recap)
  try {
    persistRecapFile(store, session.id, recap)
  } catch (error) {
    ctx.logger?.warn?.('dsh-session-recap: sidecar write failed: %s', error instanceof Error ? error.message : String(error))
  }
}

function sendJson(res: ServerResponse, status: number, body: RecapResponse | { error: string }): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

function allowedLoopbackRequest(req: IncomingMessage): boolean {
  const remote = String(req.socket.remoteAddress ?? '').toLowerCase()
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') return false
  const host = String(req.headers.host ?? '').toLowerCase()
  if (!LOOPBACK_HOST.test(host)) return false
  const origin = String(req.headers.origin ?? '').toLowerCase()
  return origin === '' || LOOPBACK_ORIGIN.test(origin)
}

function mountWebRoute(
  webCtx: WebContext,
  store: RecapStore,
  setAway: (session: Session, away: boolean) => void,
): void {
  webCtx.effect(() => {
    const dispose = webCtx.webServer.register({
      kind: 'exact',
      path: RECAP_ROUTE,
      handler: async (req, res) => {
        if (!allowedLoopbackRequest(req)) return sendJson(res, 403, { error: 'forbidden origin' })
        const method = String(req.method ?? 'GET').toUpperCase()
        if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
          res.writeHead(405, { Allow: 'GET, HEAD, POST' })
          res.end()
          return
        }
        const url = new URL(req.url ?? RECAP_ROUTE, 'http://localhost')
        const rawSessionId = url.searchParams.get('sessionId')
        if (rawSessionId === null || rawSessionId === '' || rawSessionId.length > 256) {
          return sendJson(res, 400, { error: 'sessionId is required' })
        }
        const session = webCtx.sessions.get(rawSessionId as Session['id'])
        if (method === 'POST') {
          if (session === undefined) return sendJson(res, 404, { error: 'session not found' })
          const presence = url.searchParams.get('presence')
          if (presence !== 'active' && presence !== 'away') {
            return sendJson(res, 400, { error: 'presence must be active or away' })
          }
          setAway(session, presence === 'away')
          res.writeHead(204, { 'Cache-Control': 'no-store' })
          res.end()
          return
        }
        const body: RecapResponse = { recap: session === undefined ? null : currentRecap(store, session) }
        if (method === 'HEAD') {
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          })
          res.end()
          return
        }
        sendJson(res, 200, body)
      },
    })
    return dispose
  }, 'dsh-session-recap: web route')
}

function beginCall(
  sessionId: string,
  activeCalls: Set<AbortController>,
  activeBySession: Map<string, AbortController>,
): AbortController | undefined {
  if (activeBySession.has(sessionId)) return undefined
  const controller = new AbortController()
  activeCalls.add(controller)
  activeBySession.set(sessionId, controller)
  return controller
}

function endCall(sessionId: string, controller: AbortController, activeCalls: Set<AbortController>, activeBySession: Map<string, AbortController>): void {
  activeCalls.delete(controller)
  if (activeBySession.get(sessionId) === controller) activeBySession.delete(sessionId)
}

function cancelCall(sessionId: string, activeBySession: Map<string, AbortController>): void {
  const controller = activeBySession.get(sessionId)
  if (controller === undefined) return
  // Release the per-session slot before aborting so a newer completed turn can
  // start its recap even while the old provider stream is still unwinding.
  activeBySession.delete(sessionId)
  controller.abort()
}

/** Generate (if conditions hold) and publish a sidecar recap. */
async function maybeGenerate(
  ctx: AppContext,
  config: Config,
  session: Session,
  store: RecapStore,
  activeCalls: Set<AbortController>,
  activeBySession: Map<string, AbortController>,
): Promise<void> {
  const events = session.events
  if (hasOpenTurn(events)) return
  if (turnCount(events) < config.minTurns) return
  const anchor = lastTurnEnd(events)
  if (anchor === undefined || anchor.data.reason.kind !== 'completed') return
  if (currentRecap(store, session)?.turnSeq === anchor.seq) return
  const controller = beginCall(session.id, activeCalls, activeBySession)
  if (controller === undefined) return
  try {
    const text = await generateRecap(ctx, config, session, controller.signal)
    const nowEvents = session.events
    const nowEnd = lastTurnEnd(nowEvents)
    if (hasOpenTurn(nowEvents) || nowEnd === undefined || nowEnd.seq !== anchor.seq || nowEnd.data.reason.kind !== 'completed') return
    if (currentRecap(store, session)?.turnSeq === anchor.seq) return
    publishRecap(ctx, store, session, text, anchor.seq)
    ctx.logger?.info?.('dsh-session-recap: generated recap for %s (turn/end seq %s)', session.id, anchor.seq)
  } catch (error) {
    if (!controller.signal.aborted) {
      ctx.logger?.warn?.('dsh-session-recap: %s', error instanceof Error ? error.message : String(error))
    }
  } finally {
    endCall(session.id, controller, activeCalls, activeBySession)
  }
}

export function apply(ctx: AppContext, config: Config): void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const awaySessions = new Set<string>()
  const activeCalls = new Set<AbortController>()
  const activeBySession = new Map<string, AbortController>()
  const store: RecapStore = {
    directory: dshHomePath('plugin-data', 'dsh-session-recap'),
    values: new Map(),
  }

  function clearTimer(sessionId: string): void {
    const timer = timers.get(sessionId)
    if (timer !== undefined) clearTimeout(timer)
    timers.delete(sessionId)
  }

  function clearRecap(sessionId: string): void {
    store.values.set(sessionId, null)
    removeRecapFile(store, sessionId)
  }

  function armAutomatic(session: Session): void {
    clearTimer(session.id)
    if (!config.enabled || !awaySessions.has(session.id)) return
    const events = session.events
    if (hasOpenTurn(events) || turnCount(events) < config.minTurns) return
    const anchor = lastTurnEnd(events)
    if (anchor === undefined || anchor.data.reason.kind !== 'completed') return
    if (currentRecap(store, session)?.turnSeq === anchor.seq) return
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, anchor.time + config.idleMs - Date.now()))
    const timer = setTimeout(() => {
      timers.delete(session.id)
      if (!awaySessions.has(session.id)) return
      void maybeGenerate(ctx, config, session, store, activeCalls, activeBySession)
    }, delay)
    timers.set(session.id, timer)
  }

  function setAway(session: Session, away: boolean): void {
    if (away) {
      awaySessions.add(session.id)
      armAutomatic(session)
      return
    }
    awaySessions.delete(session.id)
    clearTimer(session.id)
  }

  // Automatic recaps require interactive Web presence. A headless profile still
  // gets the manual command, matching Claude Code's non-interactive skip rule.
  ctx.inject(['webServer', 'sessions'], (webCtx) => {
    mountWebRoute(webCtx as WebContext, store, setAway)
  })

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      clearTimer(session.id)
      cancelCall(session.id, activeBySession)
      clearRecap(session.id)
      return
    }
    if (event.type !== 'turn/end') return
    clearTimer(session.id)
    cancelCall(session.id, activeBySession)
    if (event.data.reason.kind === 'completed') armAutomatic(session)
  })

  ctx.on('session/disposed', (session) => {
    clearTimer(session.id)
    awaySessions.delete(session.id)
    cancelCall(session.id, activeBySession)
    store.values.delete(session.id)
  })

  ctx.effect(() => () => {
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    awaySessions.clear()
    for (const controller of activeCalls) controller.abort()
    activeCalls.clear()
    activeBySession.clear()
    store.values.clear()
  })

  // Manual `/recap` publishes through the same sidecar-backed card as automatic
  // recaps. The command result itself stays textless, avoiding a duplicate row.
  ctx.inject(['commands'], (commandCtx) => {
    const commandsCtx = commandCtx as AppContext & { commands: CommandRuntime }
    commandsCtx.commands.register({
      name: 'recap',
      description: 'Generate a short session recap: the current task and one next action.',
      handler: async ({ agent, signal }: CommandInvocation) => {
        const session = agent.session
        if (hasOpenTurn(session.events)) {
          return { kind: 'error' as const, text: 'Recap failed: wait until the current turn finishes, then run /recap again' }
        }
        const invoked = lastTurnEnd(session.events)
        const controller = beginCall(session.id, activeCalls, activeBySession)
        if (controller === undefined) {
          return { kind: 'error' as const, text: 'Recap failed: another recap is already generating' }
        }
        const onOuterAbort = () => controller.abort(signal.reason)
        if (signal.aborted) controller.abort(signal.reason)
        else signal.addEventListener('abort', onOuterAbort, { once: true })
        try {
          const text = await generateRecap(ctx, config, session, controller.signal)
          const nowEvents = session.events
          const nowEnd = lastTurnEnd(nowEvents)
          if (hasOpenTurn(nowEvents) || nowEnd?.seq !== invoked?.seq) {
            return { kind: 'error' as const, text: 'Recap failed: the session changed while generating; run /recap again' }
          }
          publishRecap(ctx, store, session, text, nowEnd?.seq ?? null)
          return { kind: 'success' as const }
        } catch (error) {
          return { kind: 'error' as const, text: `Recap failed: ${error instanceof Error ? error.message : String(error)}` }
        } finally {
          signal.removeEventListener('abort', onOuterAbort)
          endCall(session.id, controller, activeCalls, activeBySession)
        }
      },
    })
  })

  ctx.logger?.info?.('[dsh-session-recap] mounted (awayMs=%s minTurns=%s maxChars=%s automatic=%s)', config.idleMs, config.minTurns, config.maxChars, config.enabled)
}
