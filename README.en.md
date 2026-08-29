[简体中文](README.md) | English

# @dsh-external/dsh-session-recap

**A session-recap plugin for DeepSeek Harness (DSH)** — generates Claude Code-style Away Summaries after a session goes idle, covering what was completed, the current state, and the next action.

## Capabilities

- Automatically generates a recap after an idle window and a configurable minimum number of completed turns.
- Provides `/recap` for on-demand generation.
- Renders the recap as a short banner above the Web conversation composer.
- Scopes dismissal to the session and the completed turn represented by that recap; switching sessions does not resurrect a dismissed banner.
- Hides the current recap after a new message, session switch, or manual dismissal; hidden tabs display it when visible again.
- Includes English and Simplified Chinese UI labels, with optional fixed provider/model routing or reuse of the session's latest route.
- Stores recap state in a plugin sidecar instead of adding plugin-defined events to the DSH append-only session log.

## How it works

1. The plugin watches completed `turn/end` events, waits for the configured idle window, and selects recent derived session messages.
2. One bounded auxiliary LLM request produces a concise goal / progress / next-step recap.
3. If a new turn starts, a newer turn completes, or the session is disposed while the request is running, the stale result is cancelled or discarded.
4. The result is stored in a local sidecar and served to the client through a loopback, same-origin Web route; it expires when the session advances.

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
    enabled: true
    idleMs: 180000       # idle window in milliseconds
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
- [GitHub Releases](https://github.com/DDDFXYqiming/dsh-session-recap/releases)

## License

MIT
