import { z as zod } from 'zod';
import { BlockAssembler, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_TIMER_DELAY_MS, deadline } from '@deepseek-ai/dsh-timeout';
import z from '@deepseek-ai/schemastery';
export const name = '@dsh-external/dsh-session-recap';
/** `llm` generates recaps; `sessionProjections` supplies current durable turn state. */
export const inject = ['llm', 'sessionProjections'];
/** 回顾文本默认硬上限（字符），同时是提示词里向模型声明的硬预算。 */
const DEFAULT_MAX_CHARS = 400;
export const Config = z.object({
    enabled: z.boolean().default(true),
    hostCommand: z.boolean().default(false).description('Register the host /recap command. Enable for headless profiles; leave false when the Web client owns the styled row.'),
    idleMs: z.number().step(1).min(1000).max(MAX_TIMER_DELAY_MS).default(180000),
    minTurns: z.number().step(1).min(1).max(1000).default(5),
    minConversationChars: z.number().step(1).min(1).max(1000000).default(1000),
    recentMessages: z.number().step(1).min(1).max(200).default(80),
    maxChars: z.number().step(1).min(80).max(2000).default(DEFAULT_MAX_CHARS).description('Hard cap on the recap text length (characters); also the hard character budget stated to the model.'),
    maxInputChars: z.number().step(1).min(1000).max(200000).default(24000),
    maxOutputTokens: z.number().step(1).min(16).max(4096).default(2048).description('Recap-model output token budget. Reasoning routes spend this budget on thinking tokens too; complete sentences survive exhaustion, otherwise one escalated retry runs.'),
    timeoutMs: z.number().step(1).min(1000).max(MAX_TIMER_DELAY_MS).default(30000).description('Recap generation timeout in milliseconds.'),
    manualRequestTimeoutMs: z.number().step(1).min(5000).max(600000).default(70000).description('Abort deadline for the browser POST that starts a manual /recap, in milliseconds. Generation can take up to 2x timeoutMs (first pass plus one escalated retry); raise this together with timeoutMs. Giving up never cancels server-side generation - the recap still arrives through the route poll.'),
    provider: z.string().default('').description('Optional fixed provider; set together with model. Empty reuses the session route.'),
    model: z.string().default('').description('Optional fixed model; set together with provider. Empty reuses the session route.'),
    reasoningEffort: z.string().default('').description('Optional adapter-owned effort id. Empty sends no reasoningEffort.'),
    temperature: z.number().min(0).max(2).description('Optional sampling temperature. Omit to use the adapter default.'),
    stopSequences: z.array(z.string().min(1).max(200)).default([]).description('Optional stop sequences passed to the recap model.'),
    routeProbe: z.boolean().default(false).description('Write the per-request routing verdict to <plugin-data>/route-probe.log. Off by default: the probe appends synchronously on the recap route and logs every rejection forever, so leaving it on under a polling client keeps hitting the disk.'),
});
/** Capability-owned timeout reason code for auxiliary recap requests. */
const RECAP_TIMEOUT_CODE = 'SESSION_RECAP_TIMEOUT';
/** Route used by the Web client to read the in-memory/sidecar snapshot. */
const RECAP_ROUTE = '/api/dsh-session-recap';
/** Maximum accepted size of one sidecar snapshot. */
const MAX_STORED_RECAP_CHARS = 2000;
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/;
/** active 需要续租；过期只说明失联，不能据此确认用户离开。 */
const PRESENCE_LEASE_MS = 45000;
const recapSessionStateSchema = zod.object({
    openTurn: zod.boolean(),
    completedTurns: zod.number().int().nonnegative(),
    lastTurnEnd: zod.object({
        seq: zod.number().int().nonnegative(),
        time: zod.number(),
        completed: zod.boolean(),
    }).nullable(),
});
const recapProjectionDefinition = {
    key: 'sessionRecap',
    stateVersion: 1,
    stateSchema: recapSessionStateSchema,
    init: () => ({ openTurn: false, completedTurns: 0, lastTurnEnd: null }),
    apply: (state, event) => {
        if (event.type === 'turn/start')
            return state.openTurn ? state : { ...state, openTurn: true };
        if (event.type !== 'turn/end')
            return state;
        const completed = event.data.reason.kind === 'completed';
        return {
            openTurn: false,
            completedTurns: state.completedTurns + (completed ? 1 : 0),
            lastTurnEnd: { seq: event.seq, time: event.time, completed },
        };
    },
};
/**
 * Recursively freeze a value, skipping `AbortSignal`. Plugin-local on purpose:
 * `deepFreeze` was exported by `dsh-llm` on older hosts and moved to
 * `dsh-util-values` on newer ones, and a static import of either breaks on the
 * other. The recap request options only need plain object/array recursion.
 */
function deepFreeze(value) {
    const seen = new WeakSet();
    const pending = [value];
    while (pending.length > 0) {
        const node = pending.pop();
        if (node === null || typeof node !== 'object')
            continue;
        if (node instanceof AbortSignal || seen.has(node))
            continue;
        seen.add(node);
        Object.freeze(node);
        for (const key of Object.keys(node))
            pending.push(node[key]);
    }
    return value;
}
function recapSessionState(ctx, session) {
    const state = ctx.sessionProjections.stateOf(session, 'sessionRecap');
    if (state === undefined)
        throw new Error('dsh-session-recap: session projection is unavailable');
    return state;
}
/** Extract readable context from provider-neutral message content. */
function contentText(content) {
    if (!Array.isArray(content))
        return '';
    return content.map((block) => {
        if (typeof block !== 'object' || block === null)
            return '';
        const value = block;
        if (value.type === 'text' && typeof value.text === 'string')
            return value.text;
        if (value.type === 'tool-call' && typeof value.name === 'string')
            return `[tool: ${value.name}]`;
        if (value.type === 'tool-result')
            return contentText(value.content);
        return '';
    }).filter(Boolean).join(' ');
}
/** Keep both the beginning (goal) and end (next action) when bounding text. */
function shortenText(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    if (maxChars <= 24)
        return text.slice(0, maxChars);
    const head = Math.ceil((maxChars - 21) * 0.65);
    const tail = maxChars - 21 - head;
    return `${text.slice(0, head)} … [truncated] … ${text.slice(-tail)}`;
}
/** Fall back to the last complete sentence so a cut recap never ends mid-sentence. */
function trimToSentence(text) {
    const cjk = text.match(/^[\s\S]*[。！？；]/);
    const ascii = text.match(/^[\s\S]*[.!?;](?=\s|$)/);
    const best = cjk && ascii ? (cjk[0].length >= ascii[0].length ? cjk : ascii) : (cjk ?? ascii);
    return best ? best[0].trimEnd() : text;
}
/** Return only complete sentences; unlike trimToSentence, no terminator means no salvage. */
function completeSentences(text) {
    const trimmed = trimToSentence(text);
    return trimmed === text && !/[。！？；]|[.!?;](?=\s|$)/.test(text) ? undefined : trimmed;
}
/**
 * Older model services emit chain-of-thought inline in the text channel
 * as think / thinking / thought tag blocks instead of using a separate
 * reasoning channel; strip those blocks so only the answer reaches the
 * recap card. (Tag literals omitted here on purpose: agent tool-call
 * payloads strip them, which once silently broke this module's tests.)
 */
function stripThink(text) {
    return text
        .replace(/<\s*(?:think(?:ing)?|thought|reasoning)\s*>[\s\S]*?<\s*\/\s*(?:think(?:ing)?|thought|reasoning)\s*>/gi, '')
        .replace(/<\s*(?:think(?:ing)?|thought|reasoning)\s*>[\s\S]*$/i, '');
}
/**
 * 回顾卡片按纯文本渲染，模型偷带出来的 Markdown（**、##、反引号、[x](y) 等）会原样
 * 泄露成样式噪声。提示词禁不干净时在这里兜底：成对强调/删除线/代码/链接解包还原纯文本。
 * 下划线一律不动，保住 __init__.py、task_pdyx_20260922 这类标识符。
 */
function stripMarkdown(text) {
    return text
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/~~([^~]+)~~/g, '$1')
        .replace(/\x60([^\x60]+)\x60/g, '$1')
        .replace(/\*([^*\s][^*]*)\*/g, '$1')
        .replace(/(^|[\s:：，。；！？、（(【\[])#{1,6}\s*(?=[\s\u4e00-\u9fff]|$)/g, '$1')
        .replace(/(^|\s)>{1,3}\s+/g, '$1')
        .replace(/(^|\s)\d{1,2}[.\u3001\uff0e\uff09]\s*(?=[\s\u4e00-\u9fff（(【\[]|$)/g, '$1')
        .replace(/(^|\s)[-+\u2022*]\s+/g, '$1')
        .replace(/[*~\x60]/g, '');
}
/**
 * Build a bounded, valid JSON transcript from recent conversation messages.
 * Tool-result messages are dropped before windowing: dsh records every tool
 * result as its own user-role message holding raw command output, so left in,
 * `recentMessages` would count tool noise instead of conversation and the
 * byte budget would fill with command output. `goal` anchors on the NEWEST
 * user request (not the session opening) and is only injected when it has
 * fallen out of the recent window: by the time the opening request leaves the
 * window it describes work that is long finished.
 */
function isConversationMessage(message) {
    return message.role === 'assistant' || (message.role === 'user' && message.source.kind === 'user');
}
function conversationChars(messages) {
    let total = 0;
    for (const message of messages) {
        if (isConversationMessage(message))
            total += stripThink(contentText(message.content)).replace(/\s+/g, '').length;
    }
    return total;
}
function isCompactCheckpoint(message) {
    if (message.role !== 'user')
        return false;
    const source = message.source;
    return source.kind === 'compact-checkpoint'
        || source.kind === 'plugin:compact'
        || (source.kind === 'plugin' && source.plugin === 'compact');
}
function frameTranscript(messages, recentMessages, maxBytes) {
    const count = Math.max(1, Math.floor(recentMessages));
    // Transcript purity: only real human input counts as a user entry. Injected
    // context (runtime snapshots, skill catalog, agent instructions), subagent
    // reports, plugin notices, and tool echoes all arrive under role 'user'
    // with other source kinds and would poison the language and intent signal.
    const conversation = messages.filter(isConversationMessage);
    let historySummary = '';
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!message || !isCompactCheckpoint(message))
            continue;
        historySummary = stripThink(contentText(message.content)).replace(/\s+/g, ' ').trim();
        if (historySummary !== '')
            break;
    }
    const start = Math.max(0, conversation.length - count);
    const selected = conversation.slice(start);
    let anchorIndex = -1;
    for (let index = conversation.length - 1; index >= 0; index -= 1) {
        if (conversation[index]?.role === 'user') {
            anchorIndex = index;
            break;
        }
    }
    const anchor = anchorIndex < 0 ? '' : stripThink(contentText(conversation[anchorIndex].content)).replace(/\s+/g, ' ').trim();
    const recent = selected.map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        text: stripThink(contentText(message.content)).replace(/\s+/g, ' ').trim(),
    })).filter((entry) => entry.text !== '');
    const frame = {
        historySummary,
        goal: anchorIndex >= start ? '' : anchor,
        recent,
    };
    const values = [
        { get: () => frame.historySummary, set: (value) => { frame.historySummary = value; } },
        { get: () => frame.goal, set: (value) => { frame.goal = value; } },
        ...recent.map((entry) => ({ get: () => entry.text, set: (value) => { entry.text = value; } })),
    ];
    const stringify = () => JSON.stringify(frame);
    let json = stringify();
    while (Buffer.byteLength(json, 'utf8') > maxBytes) {
        let longestIndex = -1;
        for (let index = 0; index < values.length; index += 1) {
            if (longestIndex === -1 || values[index].get().length > values[longestIndex].get().length)
                longestIndex = index;
        }
        if (longestIndex === -1)
            break;
        const longest = values[longestIndex];
        const current = longest.get();
        if (current.length === 0)
            break;
        longest.set(shortenText(current, Math.max(0, Math.floor(current.length * 0.75))));
        json = stringify();
    }
    return Buffer.byteLength(json, 'utf8') <= maxBytes ? json : JSON.stringify({ historySummary: '', goal: '', recent: [] });
}
function framedTranscriptHasContent(framed) {
    try {
        const value = JSON.parse(framed);
        return value.historySummary !== '' || value.goal !== '' || (Array.isArray(value.recent) && value.recent.length > 0);
    }
    catch {
        return false;
    }
}
/** @internal Pure framing helpers, exported only for `test/self-check.mjs`. */
/**
 * Closing directive appended after the transcript. The plugin quotes up to
 * the three newest real-user messages as samples; deciding which parts are
 * the user's own sentences versus pasted logs/code/quotes is a semantic call
 * left to the recap model — that is exactly what script counting cannot do.
 * Fallback ladder: samples + user entries → assistant reply language (the
 * assistant mirrors the user). No language names, no classification in code.
 */
function languageDirective(samples) {
    const quoted = samples
        .map((text) => text.replace(/\s+/g, ' ').replace(/"""/g, "'''").trim().slice(0, 120))
        .filter((text) => text !== '')
        .slice(0, 3);
    const head = quoted.length > 0
        ? `[recap-language] The user's recent messages, verbatim (they may contain pasted logs, code, or quoted material in another language): """${quoted.join(' | ')}""". `
        : '[recap-language] ';
    return '\n\n' + head
        + 'Decide the language the user writes their own sentences in from these samples together with the user-role entries above; pasted machine content never counts as the user\'s language. '
        + 'If the user only ever pasted material, mirror the language the assistant entries reply in. '
        + 'Write the ENTIRE recap in that language, regardless of the language of any code, log, or this directive.';
}
/** 子会话只接受手动回顾，不加入自动回顾的访问集合。 */
export function isInteractiveSession(session) {
    return session.header?.parentSession === undefined;
}
export const internals = {
    contentText,
    shortenText,
    stripThink,
    stripMarkdown,
    trimToSentence,
    completeSentences,
    frameTranscript,
    framedTranscriptHasContent,
    updateClientPresence,
    presenceIsAway,
    nextPresenceExpiry,
    allowedLoopbackRequest,
    requestTrustVerdict,
    isInteractiveSession,
    recapProjectionDefinition,
    systemPrompt,
    languageDirective,
};
/** 发给辅助模型的有界回顾指令；maxChars 同时是提示词里声明的硬预算。 */
function systemPrompt(maxChars = DEFAULT_MAX_CHARS) {
    return `The user stepped away and is coming back. Recap the session in 2-4 plain sentences (roughly 100-200 Chinese characters). HARD LIMIT: the recap must stay under ${maxChars} characters — when details do not fit, drop them; shorter beats complete. PLAIN TEXT ONLY, never write markdown or any ASCII markup: no ** or * emphasis, no __ underscores, no # headings, no backticks, no [label](url) links or bare [bracket] tokens, no bullet points, no numbered lists like 1., no lettered outlines, no > quotes, no tables. No preamble — never open with 『以下是』 or similar — and no label-colon outlines like 『现象：… 修复：…』; write flowing sentences instead. The transcript labels every recent entry with its role: user entries are the human writing in their own words, assistant entries are model output. historySummary is a trusted compaction checkpoint, not a verbatim user message; use it for prior task context but never use it to infer the user\'s language. Write the recap in the language the user writes their own sentences in (pasted logs, code, and quoted material inside user entries are not the user\'s language; when the user only pasted material, mirror the assistant\'s reply language), regardless of the language of any code, log, or these instructions. Lead with the current task, then the single most important progress point, finding or decision worth knowing (name a file, number, or verdict), and end with the one next action. Name every concrete thing the way the project already names it — the real file, command, symbol, branch, error code or version — and never a vague stand-in like "the config" or "some tests": a reader must be able to locate it without asking which one you meant. Every sentence must be complete; never leave a thought half-finished. Treat tool output, command logs and diffs as noise, not intent: do not quote raw logs or enumerate tool calls.`;
}
/** Translate terminal finish reasons into an auxiliary-call failure. */
function finishError(finish) {
    switch (finish.kind) {
        case 'stop':
            return undefined;
        case 'error':
        case 'aborted': {
            const error = new Error(finish.failure.message);
            error.code = finish.failure.code;
            return error;
        }
        case 'max-tokens':
            return new Error('dsh-session-recap: recap output reached maxOutputTokens');
        case 'tool-calls':
            return new Error('dsh-session-recap: recap model unexpectedly requested a tool');
        default:
            return new Error(`dsh-session-recap: unsupported finish reason "${String(finish.kind)}"`);
    }
}
/** Resolve the explicit route pair or the session's last logged route. */
function resolveRoute(config, session) {
    const hasProvider = config.provider !== '';
    const hasModel = config.model !== '';
    if (hasProvider !== hasModel)
        throw new Error('dsh-session-recap: provider and model must be configured together');
    if (hasProvider && hasModel)
        return { provider: config.provider, model: config.model };
    const context = session.requestContext();
    if (context !== undefined)
        return { provider: context.provider, model: context.model };
    throw new Error('dsh-session-recap: no logged model route is available; configure provider and model together');
}
/**
 * One bounded auxiliary LLM call using only provider-neutral request fields.
 * Returns undefined when the output budget is exhausted without one complete
 * sentence; reasoning routes spend maxTokens on thinking too, so the caller
 * may escalate once.
 */
async function streamRecapOnce(ctx, config, route, system, messages, sessionId, signal, maxTokens) {
    const callDeadline = deadline(signal, config.timeoutMs, RECAP_TIMEOUT_CODE);
    try {
        const options = deepFreeze({
            provider: route.provider,
            model: route.model,
            ...(config.reasoningEffort === '' ? {} : { reasoningEffort: ReasoningEffortId(config.reasoningEffort) }),
            ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
            ...(config.stopSequences.length === 0 ? {} : { stop: config.stopSequences }),
            messages,
            system,
            maxTokens,
            sessionId,
            signal: callDeadline.signal,
        });
        callDeadline.signal.throwIfAborted();
        const assembler = new BlockAssembler();
        for await (const chunk of ctx.llm.stream(options)) {
            callDeadline.signal.throwIfAborted();
            assembler.push(chunk);
        }
        callDeadline.signal.throwIfAborted();
        const blocks = assembler.blocks();
        const raw = stripMarkdown(stripThink(blocks
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join(' ')))
            .replace(/\s+/g, ' ')
            .trim();
        const clipped = raw.slice(0, config.maxChars);
        // A recap cut mid-sentence (token budget or char cap) reads as a bug; keep only
        // complete sentences. First attempt returns undefined on max-tokens so the
        // caller escalates the budget instead of publishing half a sentence.
        const text = raw.length > clipped.length || assembler.finish.kind === 'max-tokens'
            ? trimToSentence(clipped)
            : clipped;
        if (assembler.finish.kind === 'max-tokens') {
            return completeSentences(clipped);
        }
        const terminalError = finishError(assembler.finish);
        if (terminalError !== undefined)
            throw terminalError;
        if (blocks.some((block) => block.type === 'tool-call')) {
            throw new Error('dsh-session-recap: recap output must contain text only');
        }
        if (text.length === 0)
            throw new Error('dsh-session-recap: recap model produced no text');
        return text;
    }
    finally {
        const dispose = callDeadline[Symbol.dispose];
        if (typeof dispose === 'function')
            dispose.call(callDeadline);
    }
}
/** Run one bounded auxiliary LLM call for the current session. */
async function generateRecap(ctx, config, session, signal) {
    const route = resolveRoute(config, session);
    const derived = session.deriveMessages();
    if (derived.length === 0)
        throw new Error('dsh-session-recap: no conversation messages are available');
    const framed = frameTranscript(derived, config.recentMessages, config.maxInputChars);
    if (!framedTranscriptHasContent(framed)) {
        throw new Error('dsh-session-recap: no usable conversation messages are available after filtering');
    }
    const inputBytes = Buffer.byteLength(framed, 'utf8');
    if (inputBytes > config.maxInputChars) {
        throw new Error(`dsh-session-recap: transcript is ${inputBytes} bytes, exceeding maxInputChars ${config.maxInputChars}`);
    }
    const samples = [];
    for (let index = derived.length - 1; index >= 0 && samples.length < 3; index -= 1) {
        const message = derived[index];
        if (!message || message.role !== 'user' || message.source.kind !== 'user')
            continue;
        const text = contentText(message.content);
        if (text.trim() !== '')
            samples.push(text);
    }
    samples.reverse();
    const withDirective = framed + languageDirective(samples);
    const messages = [createUserMessage({
            content: [{ type: 'text', text: withDirective }],
            source: { kind: 'plugin:dsh-session-recap' },
        })];
    const first = await streamRecapOnce(ctx, config, route, systemPrompt(config.maxChars), messages, session.id, signal, config.maxOutputTokens);
    if (first !== undefined)
        return first;
    // Escalation policy constants, not deployment knobs: the 4x factor, the 2048
    // floor, and the 4096 ceiling that mirrors the maxOutputTokens schema maximum.
    // DSH keeps strategy constants fixed and moves tunables to Config; the retry
    // ladder is also documented in the README.
    const escalated = Math.min(4096, Math.max(2048, config.maxOutputTokens * 4));
    const exhausted = (budget) => new Error(`dsh-session-recap: recap output reached maxOutputTokens (${budget}) with no text — the recap route spends the budget on reasoning. ` +
        `Raise maxOutputTokens, or set provider+model together to a non-thinking recap model.`);
    if (escalated === config.maxOutputTokens)
        throw exhausted(escalated);
    ctx.logger?.info?.(`[dsh-session-recap] no text at maxTokens=${config.maxOutputTokens}; retrying at ${escalated}`);
    const second = await streamRecapOnce(ctx, config, route, systemPrompt(config.maxChars), messages, session.id, signal, escalated);
    if (second === undefined)
        throw exhausted(escalated);
    return second;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parseRecap(value) {
    if (!isRecord(value))
        return undefined;
    if (typeof value.text !== 'string' || value.text.trim() === '' || value.text.length > MAX_STORED_RECAP_CHARS)
        return undefined;
    if (typeof value.at !== 'number' || !Number.isFinite(value.at))
        return undefined;
    const turnSeq = value.turnSeq;
    if (turnSeq !== null && (typeof turnSeq !== 'number' || !Number.isSafeInteger(turnSeq) || turnSeq < 0))
        return undefined;
    return { text: value.text, at: value.at, turnSeq: turnSeq === null ? null : turnSeq };
}
function recapFile(store, sessionId) {
    return join(store.directory, `${encodeURIComponent(sessionId)}.json`);
}
function removeRecapFile(store, sessionId) {
    try {
        unlinkSync(recapFile(store, sessionId));
    }
    catch {
        // Stale-file cleanup is best effort; it must not make the read route fail.
    }
}
function persistRecapFile(store, sessionId, recap) {
    mkdirSync(store.directory, { recursive: true });
    const target = recapFile(store, sessionId);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
        writeFileSync(temporary, `${JSON.stringify(recap)}\n`, 'utf8');
        renameSync(temporary, target);
    }
    finally {
        try {
            unlinkSync(temporary);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
    }
}
function readRecapFile(store, sessionId) {
    try {
        return parseRecap(JSON.parse(readFileSync(recapFile(store, sessionId), 'utf8')));
    }
    catch {
        return undefined;
    }
}
function isCurrentRecap(state, recap) {
    if (state.openTurn)
        return false;
    return recap.turnSeq === (state.lastTurnEnd?.seq ?? null);
}
/** Read a sidecar snapshot and discard it once the session has advanced. */
function currentRecap(ctx, store, session) {
    const id = session.id;
    const state = recapSessionState(ctx, session);
    if (store.values.has(id)) {
        const cached = store.values.get(id) ?? null;
        if (cached !== null && !isCurrentRecap(state, cached)) {
            store.values.set(id, null);
            removeRecapFile(store, id);
            return null;
        }
        return cached;
    }
    const recap = readRecapFile(store, id);
    if (recap === undefined || !isCurrentRecap(state, recap)) {
        store.values.set(id, null);
        if (recap !== undefined)
            removeRecapFile(store, id);
        return null;
    }
    store.values.set(id, recap);
    return recap;
}
function publishRecap(ctx, store, session, text, turnSeq) {
    const recap = { text, at: Date.now(), turnSeq };
    store.values.set(session.id, recap);
    try {
        persistRecapFile(store, session.id, recap);
    }
    catch (error) {
        ctx.logger?.warn?.('dsh-session-recap: sidecar write failed: %s', error instanceof Error ? error.message : String(error));
    }
}
function sendJson(res, status, body) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(body));
}
/**
 * Web 路由信任栅栏。判定口径与 DSH 自己的 `/api` 栅栏（client-connection 的
 * api-request-trust）一致，另加本插件自设的「只服务本机」收紧：
 *
 * 1. 远端地址必须是回环（127.0.0.1 / ::1 / ::ffff:127.0.0.1）；
 * 2. `Host` 头必须是回环 authority（锚定正则），阻断 DNS rebinding——浏览器
 *    按它以为的地址填 Host，rebind 页面带的是攻击者域名，这道栅栏拦得住；
 * 3. 浏览器标记按 DSH 口径：`Sec-Fetch-Site: cross-site` 一律拒；`Origin` 缺席
 *    放行（Host 栅栏已绑定请求，本地传输不补 Origin）；`Origin` 存在则必须可
 *    解析、非字面 "null"（file:/srcdoc 沙箱的不透明源），且 host 与 `Host` 头
 *    一致——协议差异不影响判定（TLS 代理终止后转发到明文端口是合法形态）。
 *
 * 旧实现要求写入面 POST 携带与 `protocol//host` 逐字节相同的 `Origin`。DSH 0.2
 * 桌面壳里合法的本机请求并不保证带上这个头，于是 `/recap` 与 presence 上报被
 * 全部误杀成 403 forbidden origin（2026-10-14 实测）。浏览器保留 `Origin` 头，
 * 客户端无法自行补写，修法只能是服务端判定与宿主 `/api` 同口径。
 */
function requestTrustVerdict(req) {
    const remote = String(req.socket.remoteAddress ?? '').toLowerCase();
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1')
        return { ok: false, reason: 'remote' };
    const host = String(req.headers.host ?? '').toLowerCase();
    if (!LOOPBACK_HOST.test(host))
        return { ok: false, reason: 'host' };
    const secFetchSite = String(req.headers['sec-fetch-site'] ?? '').toLowerCase();
    if (secFetchSite === 'cross-site')
        return { ok: false, reason: 'sec-fetch-site' };
    const origin = String(req.headers.origin ?? '').toLowerCase();
    if (origin === '')
        return { ok: true };
    if (origin === 'null')
        return { ok: false, reason: 'origin-null' };
    let originHost;
    try {
        originHost = new URL(origin).host;
    }
    catch {
        return { ok: false, reason: 'origin-unparsable' };
    }
    return originHost === host ? { ok: true } : { ok: false, reason: 'origin-mismatch' };
}
function allowedLoopbackRequest(req) {
    return requestTrustVerdict(req).ok;
}
const PROBE_ACCEPTED_LIMIT = 20;
/** 探针关闭时的空实现：判定逻辑一行都不进，路由热路径上不留任何同步 fs 调用。 */
const NO_ROUTE_PROBE = () => { };
function createRouteProbe(directory) {
    let accepted = 0;
    return (req, verdict) => {
        try {
            if (verdict.ok && accepted >= PROBE_ACCEPTED_LIMIT)
                return;
            if (verdict.ok)
                accepted += 1;
            mkdirSync(directory, { recursive: true });
            const facts = [
                verdict.ok ? 'allow' : `deny:${verdict.reason}`,
                `${String(req.method ?? '')} ${String(req.url ?? '').slice(0, 300)}`,
                `remote=${String(req.socket.remoteAddress ?? '')}`,
                `host=${String(req.headers.host ?? '')}`,
                `origin=${String(req.headers.origin ?? '')}`,
                `sfs=${String(req.headers['sec-fetch-site'] ?? '')}`,
                `tls=${req.socket.encrypted === true}`,
            ].join(' | ');
            appendFileSync(join(directory, 'route-probe.log'), `${new Date().toISOString()} ${facts}\n`, 'utf8');
        }
        catch {
        }
    };
}
function mountWebRoute(webCtx, store, setPresence, generate, config) {
    webCtx.effect(() => {
        const probe = config.routeProbe ? createRouteProbe(store.directory) : NO_ROUTE_PROBE;
        const dispose = webCtx.webServer.register({
            kind: 'exact',
            path: RECAP_ROUTE,
            handler: async (req, res) => {
                const method = String(req.method ?? 'GET').toUpperCase();
                if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
                    res.writeHead(405, { Allow: 'GET, HEAD, POST' });
                    res.end();
                    return;
                }
                const trust = requestTrustVerdict(req);
                probe(req, trust);
                if (!trust.ok)
                    return sendJson(res, 403, { error: 'forbidden origin' });
                const url = new URL(req.url ?? RECAP_ROUTE, 'http://localhost');
                const rawSessionId = url.searchParams.get('sessionId');
                const manual = method === 'POST' && url.searchParams.get('action') === 'generate';
                if ((method !== 'POST' || manual) && !rawSessionId) {
                    return sendJson(res, 400, { error: 'sessionId is required' });
                }
                if (rawSessionId !== null && rawSessionId.length > 256) {
                    return sendJson(res, 400, { error: 'sessionId is invalid' });
                }
                const session = rawSessionId ? webCtx.sessions.get(rawSessionId) : undefined;
                if (method === 'POST') {
                    if (manual) {
                        if (session === undefined)
                            return sendJson(res, 404, { error: 'session not found' });
                        // 手动请求在页面离开后继续生成，由后续轮询读取结果。
                        const result = await generate(session, new AbortController().signal);
                        if (result.kind === 'success')
                            return sendJson(res, 200, { ok: true });
                        return sendJson(res, 409, { error: result.text });
                    }
                    const presence = url.searchParams.get('presence');
                    if (presence !== 'active' && presence !== 'away') {
                        return sendJson(res, 400, { error: 'presence must be active or away' });
                    }
                    const clientId = url.searchParams.get('clientId') ?? '';
                    const sequence = Number(url.searchParams.get('seq'));
                    if (!/^[A-Za-z0-9_-]{1,128}$/.test(clientId)) {
                        return sendJson(res, 400, { error: 'clientId is required' });
                    }
                    if (!Number.isSafeInteger(sequence) || sequence < 0) {
                        return sendJson(res, 400, { error: 'seq must be a non-negative integer' });
                    }
                    if (url.searchParams.get('scope') !== 'app') {
                        return sendJson(res, 409, { error: 'Refresh the WebUI to report app-wide presence' });
                    }
                    setPresence(session, clientId, sequence, presence);
                    res.writeHead(204, { 'Cache-Control': 'no-store' });
                    res.end();
                    return;
                }
                const body = {
                    recap: session === undefined ? null : currentRecap(webCtx, store, session),
                    manualRequestTimeoutMs: config.manualRequestTimeoutMs,
                };
                if (method === 'HEAD') {
                    res.writeHead(200, {
                        'Content-Type': 'application/json; charset=utf-8',
                        'Cache-Control': 'no-store',
                        'X-Content-Type-Options': 'nosniff',
                    });
                    res.end();
                    return;
                }
                sendJson(res, 200, body);
            },
        });
        return dispose;
    }, 'dsh-session-recap: web route');
}
function beginCall(sessionId, mode, activeCalls, activeBySession) {
    if (activeBySession.has(sessionId))
        return undefined;
    const controller = new AbortController();
    activeCalls.add(controller);
    activeBySession.set(sessionId, { controller, mode });
    return controller;
}
function endCall(sessionId, controller, activeCalls, activeBySession) {
    activeCalls.delete(controller);
    if (activeBySession.get(sessionId)?.controller === controller)
        activeBySession.delete(sessionId);
}
function cancelCall(sessionId, activeBySession) {
    const call = activeBySession.get(sessionId);
    if (call === undefined)
        return;
    // 先释放槽位，新任务不必等待旧流退出。
    activeBySession.delete(sessionId);
    call.controller.abort();
}
function updateClientPresence(clients, clientId, sequence, state, now) {
    const current = clients.get(clientId);
    if (current !== undefined && sequence <= current.sequence)
        return false;
    clients.set(clientId, {
        state,
        sequence,
        expiresAt: state === 'active' ? now + PRESENCE_LEASE_MS : now,
    });
    return true;
}
function expireActiveClients(clients, now) {
    for (const state of clients.values()) {
        if (state.state === 'active' && state.expiresAt <= now)
            state.state = 'unknown';
    }
}
function presenceIsAway(clients, now) {
    if (clients.size === 0)
        return false;
    expireActiveClients(clients, now);
    for (const state of clients.values()) {
        if (state.state !== 'away')
            return false;
    }
    return true;
}
function nextPresenceExpiry(clients) {
    let next;
    for (const state of clients.values()) {
        if (state.state !== 'active')
            continue;
        if (next === undefined || state.expiresAt < next)
            next = state.expiresAt;
    }
    return next;
}
function automaticAnchor(ctx, config, session) {
    const state = recapSessionState(ctx, session);
    if (state.openTurn || state.completedTurns < config.minTurns)
        return null;
    if (conversationChars(session.deriveMessages()) < config.minConversationChars)
        return null;
    const anchor = state.lastTurnEnd;
    return anchor !== null && anchor.completed ? anchor : null;
}
/** Generate (if conditions hold) and publish a sidecar recap. */
async function maybeGenerate(ctx, config, session, store, activeCalls, activeBySession, isCurrentAway) {
    if (!isCurrentAway())
        return;
    const anchor = automaticAnchor(ctx, config, session);
    if (anchor === null || currentRecap(ctx, store, session)?.turnSeq === anchor.seq)
        return;
    const controller = beginCall(session.id, 'automatic', activeCalls, activeBySession);
    if (controller === undefined)
        return;
    try {
        const text = await generateRecap(ctx, config, session, controller.signal);
        if (controller.signal.aborted || !isCurrentAway())
            return;
        const nowAnchor = automaticAnchor(ctx, config, session);
        if (nowAnchor === null || nowAnchor.seq !== anchor.seq)
            return;
        if (currentRecap(ctx, store, session)?.turnSeq === anchor.seq)
            return;
        publishRecap(ctx, store, session, text, anchor.seq);
        ctx.logger?.info?.('dsh-session-recap: generated recap for %s (turn/end seq %s)', session.id, anchor.seq);
    }
    catch (error) {
        if (!controller.signal.aborted) {
            ctx.logger?.warn?.('dsh-session-recap: %s', error instanceof Error ? error.message : String(error));
        }
    }
    finally {
        endCall(session.id, controller, activeCalls, activeBySession);
    }
}
export function apply(ctx, config) {
    ctx.sessionProjections.register(recapProjectionDefinition);
    const timers = new Map();
    const clients = new Map();
    const visitedSessions = new Map();
    let presenceTimer;
    let awaySince;
    let awayEpoch = 0;
    const activeCalls = new Set();
    const activeBySession = new Map();
    const store = {
        directory: dshHomePath('plugin-data', 'dsh-session-recap'),
        values: new Map(),
    };
    function clearTimer(sessionId) {
        const timer = timers.get(sessionId);
        if (timer !== undefined)
            clearTimeout(timer);
        timers.delete(sessionId);
    }
    function clearPresenceTimer() {
        if (presenceTimer !== undefined)
            clearTimeout(presenceTimer);
        presenceTimer = undefined;
    }
    function isAwayEpoch(epoch) {
        return awaySince !== undefined && awayEpoch === epoch && presenceIsAway(clients, Date.now());
    }
    function clearRecap(sessionId) {
        store.values.set(sessionId, null);
        removeRecapFile(store, sessionId);
    }
    function armAutomatic(session) {
        clearTimer(session.id);
        if (!visitedSessions.has(session.id) || !config.enabled || awaySince === undefined)
            return;
        const epoch = awayEpoch;
        if (!isAwayEpoch(epoch))
            return;
        const anchor = automaticAnchor(ctx, config, session);
        if (anchor === null || currentRecap(ctx, store, session)?.turnSeq === anchor.seq)
            return;
        const dueAt = Math.max(anchor.time, awaySince) + config.idleMs;
        const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, dueAt - Date.now()));
        const timer = setTimeout(() => {
            timers.delete(session.id);
            void maybeGenerate(ctx, config, session, store, activeCalls, activeBySession, () => isAwayEpoch(epoch));
        }, delay);
        timers.set(session.id, timer);
    }
    function syncPresence() {
        clearPresenceTimer();
        const now = Date.now();
        if (presenceIsAway(clients, now)) {
            if (awaySince === undefined) {
                awaySince = now;
                awayEpoch += 1;
            }
            for (const session of visitedSessions.values())
                armAutomatic(session);
        }
        else {
            awaySince = undefined;
            for (const timer of timers.values())
                clearTimeout(timer);
            timers.clear();
            for (const [sessionId, call] of activeBySession) {
                if (call.mode === 'automatic')
                    cancelCall(sessionId, activeBySession);
            }
        }
        const expiresAt = nextPresenceExpiry(clients);
        if (expiresAt === undefined)
            return;
        presenceTimer = setTimeout(syncPresence, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, expiresAt - now)));
    }
    function setPresence(session, clientId, sequence, state) {
        if (!updateClientPresence(clients, clientId, sequence, state, Date.now()))
            return;
        if (session !== undefined && isInteractiveSession(session))
            visitedSessions.set(session.id, session);
        syncPresence();
    }
    ctx.inject(['webServer', 'sessions'], (webCtx) => {
        mountWebRoute(webCtx, store, setPresence, generateManual, config);
    });
    ctx.inject(['commands'], (commandCtx) => {
        if (!config.hostCommand)
            return;
        const commandsCtx = commandCtx;
        commandsCtx.commands.register({
            name: 'recap',
            description: 'Generate a session recap: current task, progress, key findings, next action.',
            handler: ({ agent, signal }) => generateManual(agent.session, signal),
        });
    });
    ctx.on('session/event', (session, event) => {
        if (event.type === 'turn/start') {
            clearTimer(session.id);
            cancelCall(session.id, activeBySession);
            clearRecap(session.id);
            return;
        }
        if (event.type !== 'turn/end')
            return;
        clearTimer(session.id);
        cancelCall(session.id, activeBySession);
        if (event.data.reason.kind === 'completed')
            armAutomatic(session);
    });
    ctx.on('session/disposed', (session) => {
        clearTimer(session.id);
        visitedSessions.delete(session.id);
        cancelCall(session.id, activeBySession);
        store.values.delete(session.id);
    });
    ctx.effect(() => () => {
        for (const timer of timers.values())
            clearTimeout(timer);
        timers.clear();
        clearPresenceTimer();
        clients.clear();
        visitedSessions.clear();
        awaySince = undefined;
        for (const controller of activeCalls)
            controller.abort();
        activeCalls.clear();
        activeBySession.clear();
        store.values.clear();
    });
    async function generateManual(session, signal) {
        const invokedState = recapSessionState(ctx, session);
        if (invokedState.openTurn) {
            return { kind: 'error', text: 'Recap failed: wait until the current turn finishes, then run /recap again' };
        }
        const invoked = invokedState.lastTurnEnd;
        const controller = beginCall(session.id, 'manual', activeCalls, activeBySession);
        if (controller === undefined) {
            return { kind: 'error', text: 'Recap failed: another recap is already generating' };
        }
        const onOuterAbort = () => controller.abort(signal.reason);
        if (signal.aborted)
            controller.abort(signal.reason);
        else
            signal.addEventListener('abort', onOuterAbort, { once: true });
        try {
            const text = await generateRecap(ctx, config, session, controller.signal);
            const nowState = recapSessionState(ctx, session);
            const nowEnd = nowState.lastTurnEnd;
            if (nowState.openTurn || nowEnd?.seq !== invoked?.seq) {
                return { kind: 'error', text: 'Recap failed: the session changed while generating; run /recap again' };
            }
            publishRecap(ctx, store, session, text, nowEnd?.seq ?? null);
            return { kind: 'success', text };
        }
        catch (error) {
            return { kind: 'error', text: `Recap failed: ${error instanceof Error ? error.message : String(error)}` };
        }
        finally {
            signal.removeEventListener('abort', onOuterAbort);
            endCall(session.id, controller, activeCalls, activeBySession);
        }
    }
    ctx.logger?.info?.('[dsh-session-recap] mounted (awayMs=%s minTurns=%s minConversationChars=%s maxChars=%s automatic=%s)', config.idleMs, config.minTurns, config.minConversationChars, config.maxChars, config.enabled);
}
