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
import type { Context } from '@deepseek-ai/cordis';
import type LlmService from '@deepseek-ai/dsh-llm';
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
    /** How many recent derived conversation messages feed the recap input. */
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
}>>;
type AppContext = Context & {
    llm: LlmService;
};
export declare function apply(ctx: AppContext, config: Config): void;
export {};
