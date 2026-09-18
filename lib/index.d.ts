/**
 * dsh-session-recap — automatic session recap for DeepSeek Harness.
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
import type { Context } from '@deepseek-ai/cordis';
import { z as zod } from 'zod';
import type LlmService from '@deepseek-ai/dsh-llm';
import type { Message } from '@deepseek-ai/dsh-llm';
import type { IncomingMessage } from 'node:http';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import z from '@deepseek-ai/schemastery';
export declare const name = "@dsh-external/dsh-session-recap";
/** `llm` generates recaps; `sessionProjections` supplies current durable turn state. */
export declare const inject: string[];
export interface Config {
    /** Automatic recap toggle; manual `/recap` remains available. */
    enabled: boolean;
    /** Register the host `/recap` command for profiles without the Web client. */
    hostCommand: boolean;
    /** Away window after a completed turn before auto-generating a recap (ms). */
    idleMs: number;
    /** Minimum completed turns before any automatic recap is generated. */
    minTurns: number;
    /** How many recent conversation messages (tool results excluded) feed the recap window. */
    recentMessages: number;
    /** Hard cap on the recap text length (characters). */
    maxChars: number;
    /** Byte cap for the framed transcript sent to the model. */
    maxInputChars: number;
    /** LLM output token budget for one recap. */
    maxOutputTokens: number;
    /** Timeout for one recap generation call (ms). */
    timeoutMs: number;
    /** Abort deadline the Web client applies to a manual /recap request (ms). */
    manualRequestTimeoutMs: number;
    /** Optional fixed route; both provider and model must be set together. */
    provider: string;
    model: string;
    /** Optional adapter-owned reasoning effort; empty means do not pass one. */
    reasoningEffort: string;
    /** Optional sampling temperature; absent means use the adapter default. */
    temperature?: number;
    /** Optional stop sequences passed to the recap model. */
    stopSequences: string[];
}
export declare const Config: z<Schemastery.ObjectS<{
    enabled: z<boolean, boolean>;
    hostCommand: z<boolean, boolean>;
    idleMs: z<number, number>;
    minTurns: z<number, number>;
    recentMessages: z<number, number>;
    maxChars: z<number, number>;
    maxInputChars: z<number, number>;
    maxOutputTokens: z<number, number>;
    timeoutMs: z<number, number>;
    manualRequestTimeoutMs: z<number, number>;
    provider: z<string, string>;
    model: z<string, string>;
    reasoningEffort: z<string, string>;
    temperature: z<number, number>;
    stopSequences: z<string[], string[]>;
}>, Schemastery.ObjectT<{
    enabled: z<boolean, boolean>;
    hostCommand: z<boolean, boolean>;
    idleMs: z<number, number>;
    minTurns: z<number, number>;
    recentMessages: z<number, number>;
    maxChars: z<number, number>;
    maxInputChars: z<number, number>;
    maxOutputTokens: z<number, number>;
    timeoutMs: z<number, number>;
    manualRequestTimeoutMs: z<number, number>;
    provider: z<string, string>;
    model: z<string, string>;
    reasoningEffort: z<string, string>;
    temperature: z<number, number>;
    stopSequences: z<string[], string[]>;
}>>;
type AppContext = Context & {
    llm: LlmService;
};
type ClientPresence = {
    active: boolean;
    sequence: number;
    expiresAt: number;
};
type RecapSessionState = {
    openTurn: boolean;
    completedTurns: number;
    lastTurnEnd: {
        seq: number;
        time: number;
        completed: boolean;
    } | null;
};
declare module '@deepseek-ai/dsh-session-projection/types' {
    interface SessionProjectionStateMap {
        sessionRecap: RecapSessionState;
    }
}
/** Extract readable context from provider-neutral message content. */
declare function contentText(content: unknown): string;
/** Keep both the beginning (goal) and end (next action) when bounding text. */
declare function shortenText(text: string, maxChars: number): string;
/** Fall back to the last complete sentence so a cut recap never ends mid-sentence. */
declare function trimToSentence(text: string): string;
/** Return only complete sentences; unlike trimToSentence, no terminator means no salvage. */
declare function completeSentences(text: string): string | undefined;
/**
 * Older model services emit chain-of-thought inline in the text channel
 * as think / thinking / thought tag blocks instead of using a separate
 * reasoning channel; strip those blocks so only the answer reaches the
 * recap card. (Tag literals omitted here on purpose: agent tool-call
 * payloads strip them, which once silently broke this module's tests.)
 */
declare function stripThink(text: string): string;
declare function frameTranscript(messages: readonly Message[], recentMessages: number, maxBytes: number): string;
declare function framedTranscriptHasContent(framed: string): boolean;
/** @internal Pure framing helpers, exported only for `test/self-check.mjs`. */
/**
 * Closing directive appended after the transcript. The plugin quotes up to
 * the three newest real-user messages as samples; deciding which parts are
 * the user's own sentences versus pasted logs/code/quotes is a semantic call
 * left to the recap model — that is exactly what script counting cannot do.
 * Fallback ladder: samples + user entries → assistant reply language (the
 * assistant mirrors the user). No language names, no classification in code.
 */
declare function languageDirective(samples: readonly string[]): string;
export declare const internals: {
    contentText: typeof contentText;
    shortenText: typeof shortenText;
    stripThink: typeof stripThink;
    trimToSentence: typeof trimToSentence;
    completeSentences: typeof completeSentences;
    frameTranscript: typeof frameTranscript;
    framedTranscriptHasContent: typeof framedTranscriptHasContent;
    updateClientPresence: typeof updateClientPresence;
    presenceIsAway: typeof presenceIsAway;
    nextPresenceExpiry: typeof nextPresenceExpiry;
    allowedLoopbackRequest: typeof allowedLoopbackRequest;
    recapProjectionDefinition: {
        key: "sessionRecap";
        stateVersion: number;
        stateSchema: zod.ZodObject<{
            openTurn: zod.ZodBoolean;
            completedTurns: zod.ZodNumber;
            lastTurnEnd: zod.ZodNullable<zod.ZodObject<{
                seq: zod.ZodNumber;
                time: zod.ZodNumber;
                completed: zod.ZodBoolean;
            }, zod.core.$strip>>;
        }, zod.core.$strip>;
        init: () => RecapSessionState;
        apply: (state: RecapSessionState, event: SessionEvent) => RecapSessionState;
    };
    systemPrompt: typeof systemPrompt;
    languageDirective: typeof languageDirective;
};
/** Bounded away-summary instruction sent to the auxiliary model. */
declare function systemPrompt(): string;
declare function allowedLoopbackRequest(req: IncomingMessage, requireOrigin: boolean): boolean;
declare function updateClientPresence(clients: Map<string, ClientPresence>, clientId: string, sequence: number, active: boolean, now: number): boolean;
declare function presenceIsAway(clients: Map<string, ClientPresence>, now: number): boolean;
declare function nextPresenceExpiry(clients: Map<string, ClientPresence>): number | undefined;
export declare function apply(ctx: AppContext, config: Config): void;
export {};
