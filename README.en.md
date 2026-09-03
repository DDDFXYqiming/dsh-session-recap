[简体中文](README.md) | English

# @dsh-external/dsh-session-recap

**A session-recap plugin for DeepSeek Harness (DSH).** Switch to another session or leave the Web window unfocused, and the plugin generates a short recap in the background. When you come back, a card summarizes the session's current task, completed progress, and the suggested next action.

Current version: **0.0.4**

## Why this plugin exists

People step away from the screen for all sorts of reasons, and the session is still sitting there when they return. The thread of thought is gone, though, and scrolling back through the message history takes a while. After a spell away you read a short recap first, then decide where to pick up. This plugin brings that behavior to the DSH Web. A separate auxiliary LLM request produces the recap, and the finished text is never appended to the conversation message history.

## Capabilities

- Generates automatically only while the Web window is unfocused or the session is not selected; simple focused-window idleness never spends an LLM call.
- By default, requires at least three completed turns and three minutes since the latest completed turn, and never generates twice for the same turn. These two gates keep a brief distraction from producing a pointless recap.
- Provides `/recap` on demand through the same recap card; disabling automatic recaps does not disable the command.
- Writes the recap in the language the user writes in; the English prompt does not force English output.
- Legacy-model-service compatible: chain-of-thought inlined into the text as think / thinking / thought tag blocks is stripped before it reaches the recap input or the recap card.
- Renders automatic output as a card with a localized Recap badge and dismiss button above the Web conversation composer, capped at 400 characters.
- Scopes dismissal to the session and the completed turn represented by that recap; switching sessions does not resurrect a dismissed banner.
- Hides the current recap after a new message, session switch, or manual dismissal; hidden tabs display it when visible again.
- Includes English and Simplified Chinese UI labels; reuses the session's latest effective provider/model by default, with optional overrides for model, reasoning effort, temperature, output budget, stop sequences, and timeout.
- Stores recap state in a plugin sidecar instead of adding plugin-defined events to the DSH append-only session log.

## How it works

1. The Web client maps window focus/blur, document visibility, and session switches to `active` / `away` presence for the current session.
2. The host starts an automatic recap only when the session is `away`, the latest completed `turn/end` is at least `idleMs` old, and `minTurns` is satisfied. All three conditions must hold before any request goes out, so a brief distraction triggers nothing.
3. The plugin drops tool-result messages before framing bounded input (raw command output is not intent), anchors the current task on the newest user request (never restating a long-finished opening), and makes one independent auxiliary LLM request for a plain-text current-task / progress / next-step recap of at most 40 words in one or two sentences.
4. If a new turn starts, a newer turn completes, or the session is disposed while the request is running, the stale result is cancelled or discarded. What you see on return always matches the current progress.
5. Automatic and manual `/recap` results are stored in a local sidecar and served to the card through a loopback-only, same-origin Web route; recap text is not appended to the conversation message history.

## Installation

```bash
# GitHub installation (recommended)
dsh plugin --profile web add github:DDDFXYqiming/dsh-session-recap
```

To install from a local checkout, run the following.

```bash
git clone https://github.com/DDDFXYqiming/dsh-session-recap.git
cd dsh-session-recap
npm install && npm run build
dsh plugin --profile web add <absolute-path-to-checkout>
```

The GitHub route triggers the `prepare` script, which rebuilds `lib/` from source. On the first `add`, pnpm >= 10 refuses to run build scripts of git dependencies: copy the exact package key pnpm prints into the profile's `pnpm-workspace.yaml`, then re-run `add`:

```yaml
allowBuilds:
  '@dsh-external/dsh-session-recap': true
```

Treat this approval as "let this package run code on your machine at install time". Pin a commit (`github:DDDFXYqiming/dsh-session-recap#<sha>`) if you want later pushes to stop changing what gets built.

The package includes `cordis.patch.yml`, which contributes the `dsh-session-recap` bundle entry automatically. Restart the Web profile after the first installation, then refresh the page.

## Configuration

The bundle supplies the default entry. To override it, use this bare entry in the profile's `cordis.patch.yml`.

```yaml
- id: dsh-session-recap
  config:
    enabled: true        # automatic recaps only; /recap remains available
    idleMs: 180000       # minimum age of the latest completed turn, in milliseconds
    minTurns: 3          # minimum completed turns for automatic recaps
    recentMessages: 80   # recent conversation messages in the recap window (tool results excluded)
    maxChars: 400        # recap text limit
    maxInputChars: 24000 # recap input limit in bytes
    maxOutputTokens: 1024 # recap-model output token budget (reasoning models spend it on thinking too)
    timeoutMs: 30000
    provider: ''         # empty: reuse the session's latest effective provider
    model: ''            # empty: reuse the session's latest effective model; set with provider for a fixed route
    reasoningEffort: ''  # empty: the plugin sends no effort; otherwise use an id supported by the target adapter
    # temperature: 0.2   # optional; omit to use the target model/adapter default
    stopSequences: []    # optional stop-sequence list
```

`provider` and `model` must be supplied together. Leaving both empty makes automatic recaps and `/recap` reuse the effective route from the session's latest `request/context`, so the recap follows whatever the session is actually using and needs no route of its own. By default the plugin neither inherits nor sends the session's `reasoningEffort`; the target adapter may still apply its own default. When the recap follows a reasoning model, thinking tokens spend the `maxOutputTokens` budget too: an exhausted budget with salvageable text yields that truncated recap; an empty one triggers a single retry with a 4x budget (capped at 4096) before failing — then raise `maxOutputTokens` further or pin a non-thinking model via `provider`+`model`. These overrides, input/output bounds, and timeout apply to both automatic and manual recaps.

## Storage layout

```text
<home>/.dsh/plugin-data/dsh-session-recap/
└── <encoded-session-id>.json
```

The sidecar stores the current recap text, generation time, and completed-turn anchor. The DSH session log is append-only, and the plugin neither extends its event vocabulary nor writes plugin-defined events into it. Stale recaps are removed after the session advances, so each session keeps only its current recap on disk.

## Compatibility

| Item | Version or scope |
| --- | --- |
| dsh-session-recap | `0.0.4` (`package.json`) |
| DeepSeek Harness packages | `>=0.1.1-rc.2 <1` |
| Node.js | `^22.19.0 \|\| >=24.0.0` (the current DSH runtime range) |
| Surface | DSH Web profile with LLM, session, commands, locale, conversation, slots, and Web-server services |

## Development and validation

```bash
npm install
npm run typecheck
npm run build
npm test
npm run build:client
npm pack
```

The build helper prefers local dependencies. When developing against a DSH checkout, set `DSH_CHECKOUT`, or set `DSH_GLOBAL_NODE_MODULES` to a compatible global `node_modules` directory. It only creates missing links and leaves existing packages untouched.

The plugin does not import the host `deepFreeze` (that export lived in `dsh-llm` on older hosts and moved to `dsh-util-values` on newer ones, so statically importing either side breaks the other). Request freezing is a small plugin-local implementation, which keeps one artifact compatible with both DSH generations.

## Related

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [pi-recap](https://github.com/DDDFXYqiming/pi-recap): the same behavior for the Pi Coding Agent TUI
- [GitHub Releases](https://github.com/DDDFXYqiming/dsh-session-recap/releases)

## License

MIT
