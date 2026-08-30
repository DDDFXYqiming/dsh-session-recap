[简体中文](README.md) | English

# @dsh-external/dsh-session-recap

**A session-recap plugin for DeepSeek Harness (DSH)** — generates Claude Code-style Away Summaries in the background after you switch sessions or leave the Web window unfocused, then shows a one-line goal, current-task, and next-action recap when you return.

## Capabilities

- Generates automatically only while the Web window is unfocused or the session is not selected; simple focused-window idleness never spends an LLM call.
- By default, requires at least three completed turns and three minutes since the latest completed turn, and never generates twice for the same turn.
- Provides `/recap` as command output on demand; disabling automatic recaps does not disable the command.
- Renders automatic output as a `※ recap:` one-line banner above the Web conversation composer, capped at 400 characters.
- Scopes dismissal to the session and the completed turn represented by that recap; switching sessions does not resurrect a dismissed banner.
- Hides the current recap after a new message, session switch, or manual dismissal; hidden tabs display it when visible again.
- Includes English and Simplified Chinese UI labels, with optional fixed provider/model routing or reuse of the session's latest route.
- Stores recap state in a plugin sidecar instead of adding plugin-defined events to the DSH append-only session log.

## How it works

1. The Web client maps window focus/blur, document visibility, and session switches to `active` / `away` presence for the current session.
2. The host starts an automatic recap only when the session is `away`, the latest completed `turn/end` is at least `idleMs` old, and `minTurns` is satisfied.
3. The plugin frames recent derived messages into bounded input and makes one independent auxiliary LLM request for an under-40-word, 1–2 sentence plain-text goal / progress / next-step recap.
4. If a new turn starts, a newer turn completes, or the session is disposed while the request is running, the stale result is cancelled or discarded.
5. Automatic output is stored in a local sidecar and served through a loopback-only, same-origin Web route. Manual `/recap` appends command output without replacing message history.

## Installation

```bash
# GitHub installation (recommended)
dsh plugin --profile web add github:DDDFXYqiming/dsh-session-recap
```

From a local checkout:

```bash
git clone https://github.com/DDDFXYqiming/dsh-session-recap.git
cd dsh-session-recap
npm install && npm run build
dsh plugin --profile web add <absolute-path-to-checkout>
```

The package includes `cordis.patch.yml`, which contributes the `dsh-session-recap` bundle entry automatically. Restart the Web profile after the first installation, then refresh the page.

## Configuration

The bundle supplies the default entry. To override it, use this bare entry in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-session-recap
  config:
    enabled: true        # automatic recaps only; /recap remains available
    idleMs: 180000       # minimum age of the latest completed turn, in milliseconds
    minTurns: 3          # minimum completed turns for automatic recaps
    recentMessages: 30   # recent derived messages sent to the recap request
    maxChars: 400        # recap text limit
    maxInputChars: 24000 # recap input limit in bytes
    maxOutputTokens: 512
    timeoutMs: 30000
    provider: ''         # empty: reuse the session's latest provider
    model: ''            # empty: reuse the session's latest model; set with provider for a fixed route
```

`provider` and `model` must be supplied together. Leaving both empty reuses the route from the session's latest request.

## Storage layout

```text
<home>/.dsh/plugin-data/dsh-session-recap/
└── <encoded-session-id>.json
```

The sidecar stores the current recap text, generation time, and completed-turn anchor. It does not extend the DSH session-log event vocabulary; stale recaps are removed after the session advances.

## Compatibility

- DeepSeek Harness packages: `>=0.1.1-rc.2 <1`
- Node.js: `^22.19.0 || >=24.0.0` (the current DSH runtime range)
- Surface: DSH Web profile with LLM, session, commands, locale, conversation, slots, and Web-server services

## Development and validation

```bash
npm install
npm run typecheck
npm run build
npm run build:client
npm pack
```

The build helper prefers local dependencies. When developing against a DSH checkout, set `DSH_CHECKOUT`, or set `DSH_GLOBAL_NODE_MODULES` to a compatible global `node_modules` directory. It only creates missing links and leaves existing packages untouched.

## Related

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [Claude Code: Session recap](https://code.claude.com/docs/en/interactive-mode#session-recap)
- [Claude Code: `/recap` and prompt caching](https://code.claude.com/docs/en/prompt-caching#running-%2Frecap)
- [GitHub Releases](https://github.com/DDDFXYqiming/dsh-session-recap/releases)

## License

MIT
