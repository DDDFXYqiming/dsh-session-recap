# DSH Session Recap

Claude Code-style **Session recap / Away summary** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

After a completed turn has been idle for the configured interval, the host makes one bounded auxiliary LLM call and produces a short summary of the session's overall goal, current task, and next action. The summary appears above the conversation composer when the Web tab is visible. Sending a new message or dismissing the banner hides that recap.

## Features

- Automatic recap after an idle window, with a minimum completed-turn threshold.
- Manual `/recap` command.
- Claude-style concise output with configurable text, input, token, and time limits.
- Banner is scoped to the current session and turn; it survives session switching and browser remounts without resurfacing a dismissed recap.
- Hidden tabs defer display until they become visible.
- English and Simplified Chinese UI labels.
- Host-side sidecar persistence; no plugin-owned events are appended to the DSH session log.

## Install

The bundle patch is included in the package, so installing the plugin into a profile activates the host and Web halves together.

### From a local checkout

```bash
dsh plugin --profile web add file:/absolute/path/to/dsh-session-recap
```

### From GitHub

```bash
git clone https://github.com/DDDFXYqiming/dsh-session-recap.git
dsh plugin --profile web add file:/absolute/path/to/dsh-session-recap
```

Restart the DSH Web profile after a persistent installation, then refresh the browser page. The plugin can also be installed from the `.tgz` asset attached to a GitHub release.

## Configuration

Override the bundle entry in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-session-recap
      name: '@dsh-external/dsh-session-recap'
      config:
        enabled: true
        idleMs: 180000       # idle window in milliseconds
        minTurns: 3          # minimum completed turns
        recentMessages: 30   # recent derived messages sent to the recap call
        maxChars: 400         # recap text limit
        maxInputChars: 24000 # transcript byte limit
        maxOutputTokens: 512
        timeoutMs: 30000
        provider: ''         # empty: reuse the session's latest route
        model: ''            # set provider and model together for a fixed route
```

An explicit `provider` and `model` must be supplied as a pair; leaving both empty reuses the latest route recorded by the session.

## How it works

The host watches completed `turn/end` events and cancels an idle timer when a newer turn or session disposal occurs. A recap generation is committed only if the session is still idle and anchored to the same turn when the call finishes.

The result is stored in:

```text
~/.dsh/plugin-data/dsh-session-recap/<session-id>.json
```

The Web client reads the current snapshot through a loopback, same-origin route and polls while the conversation dock is mounted. A stale snapshot is discarded when the session advances. This sidecar design keeps recap state across host restarts while avoiding unsupported custom durable session events.

## Development

```bash
npm install
npm run typecheck
npm run build
npm pack
```

The build helper uses local dependencies first. When developing against a DSH checkout, set `DSH_CHECKOUT` to its root; alternatively set `DSH_GLOBAL_NODE_MODULES` to a compatible global `node_modules` directory. Only missing build links are created, and existing packages are left untouched.

## Compatibility

- DeepSeek Harness packages: `0.1.1-rc.2` or newer within the current major line.
- Web profile with the client modules, locale, conversation, slots, session, commands, LLM, and host web-server services.
- Node.js 18 or newer.

## License

[MIT](LICENSE)
