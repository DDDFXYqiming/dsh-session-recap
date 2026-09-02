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
import type LlmService from '@deepseek-ai/dsh-llm';
import type { Message } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';
export declare const name = "@dsh-external/dsh-session-recap";
/** `llm` is accessed directly by the host generation paths. */
export declare const inject: string[];
export interface Config {
    /** Automatic recap toggle; manual `/recap` remains available. */
    enabled: boolean;
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
    idleMs: z<number, number>;
    minTurns: z<number, number>;
    recentMessages: z<number, number>;
    maxChars: z<number, number>;
    maxInputChars: z<number, number>;
    maxOutputTokens: z<number, number>;
    timeoutMs: z<number, number>;
    provider: z<string, string>;
    model: z<string, string>;
    reasoningEffort: z<string, string>;
    temperature: z<number, number>;
    stopSequences: z<string[], string[]>;
}>, Schemastery.ObjectT<{
    enabled: z<boolean, boolean>;
    idleMs: z<number, number>;
    minTurns: z<number, number>;
    recentMessages: z<number, number>;
    maxChars: z<number, number>;
    maxInputChars: z<number, number>;
    maxOutputTokens: z<number, number>;
    timeoutMs: z<number, number>;
    provider: z<string, string>;
    model: z<string, string>;
    reasoningEffort: z<string, string>;
    temperature: z<number, number>;
    stopSequences: z<string[], string[]>;
}>>;
type AppContext = Context & {
    llm: LlmService;
};
/** Extract readable context from provider-neutral message content. */
declare function contentText(content: unknown): string;
/** Keep both the beginning (goal) and end (next action) when bounding text. */
declare function shortenText(text: string, maxChars: number): string;
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
declare function frameTranscript(messages: readonly Message[], recentMessages: number, maxBytes: number): string;
/** @internal Pure framing helpers, exported only for `test/self-check.mjs`. */
/**
 * Closing directive appended after the transcript. The language choice stays
 * with the recap model; the plugin only quotes the user's own latest message
 * verbatim as the sample to mirror — abstract "match the user's language"
 * rules lose to English-heavy transcripts, a concrete quoted sample does not.
 * No script detection, no hardcoded language names.
 */
declare function languageDirective(lastUserText: string): string;
export declare const internals: {
    contentText: typeof contentText;
    shortenText: typeof shortenText;
    frameTranscript: typeof frameTranscript;
    systemPrompt: typeof systemPrompt;
    languageDirective: typeof languageDirective;
};
/** Bounded away-summary instruction sent to the auxiliary model. */
declare function systemPrompt(): string;
export declare function apply(ctx: AppContext, config: Config): void;
export {};
