[简体中文](README.md) | English

# @dsh-external/dsh-session-recap

**A session-recap plugin for DeepSeek Harness (DSH).** Switch to another session or leave the Web window unfocused, and the plugin generates a short recap in the background. When you come back, a card summarizes the session's current task, completed progress, and the suggested next action.

The plugin is currently at **0.1.7**, with a peer compatibility range of DSH `>=0.1.6-alpha.1 <0.2.0-0`. Builds run through Node on Windows and Linux.

## Why this plugin exists

People step away from the screen for all sorts of reasons, and the session is still sitting there when they return. The thread of thought is gone, though, and scrolling back through the message history takes a while. After a spell away you read a short recap first, then decide where to pick up. This plugin brings that behavior to the DSH Web. A separate auxiliary LLM request produces the recap, and the finished text is never appended to the conversation message history.

## Capabilities

- Generates automatically after you leave the Web page or switch sessions, once `idleMs` and `minTurns` are satisfied; focused-window idleness never spends an LLM call.
- Runs `/recap` on demand. The Web menu keeps the official icon, English and Chinese labels, and description; a headless profile can enable `hostCommand` to receive plain text.
- Shows the recap above the composer and lets you dismiss it. A new message or session switch hides it, and each session keeps only its current recap.
- Drops tool output, keeps the compaction summary, and anchors the task on the newest real user message. The recap follows the user's language, and inline think tags from older model services are removed.
- Aggregates presence across page clients with heartbeats and leases, and discards a result when the session changes while it is being generated.
- Stores results in the plugin sidecar without changing the DSH session log. Provider, model, output size, and timeout are configurable.

## How it works

1. The Web client reports `active` / `away` for each page and session. The Host marks a session away only after all valid pages have left.
2. The Host checks `idleMs`, `minTurns`, and the latest completed turn, then sends a bounded transcript to the auxiliary model.
3. A new turn, session advance, or disposal invalidates the old result. Valid output goes to the sidecar and is shown in the Web card or through `CommandResult.text`.

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

See [development](docs/development.md) for the full build, test and upstream-structure commands.

## Configuration

The bundle supplies the default entry. To override it, use this bare entry in the profile's `cordis.patch.yml`.

```yaml
- id: dsh-session-recap
  config:
    enabled: true        # automatic recaps only; /recap remains available
    hostCommand: false   # keep false for Web; headless profiles may set true
    idleMs: 180000       # minimum age of the latest completed turn, in milliseconds
    minTurns: 3          # minimum completed turns for automatic recaps
    recentMessages: 80   # recent conversation messages in the recap window (tool results excluded)
    maxChars: 400        # recap text limit (also the model's hard budget; output is plain text, never Markdown)
    maxInputChars: 24000 # recap input limit in bytes
    maxOutputTokens: 2048 # recap-model output token budget (reasoning models spend it on thinking too)
    timeoutMs: 30000
    manualRequestTimeoutMs: 70000 # browser deadline (ms) for waiting on a manual /recap; generation can take up to 2x timeoutMs, and giving up never cancels server-side generation
    provider: ''         # empty: reuse the session's latest effective provider
    model: ''            # empty: reuse the session's latest effective model; set with provider for a fixed route
    reasoningEffort: ''  # empty: the plugin sends no effort; otherwise use an id supported by the target adapter
    # temperature: 0.2   # optional; omit to use the target model/adapter default
    stopSequences: []    # optional stop-sequence list
```

`provider` and `model` must be supplied together. Leaving both empty makes automatic recaps and `/recap` reuse the effective route from the session's latest `request/context`, so the recap follows whatever the session is actually using and needs no route of its own. By default the plugin neither inherits nor sends the session's `reasoningEffort`; the target adapter may still apply its own default. When a reasoning model exhausts `maxOutputTokens`, the plugin immediately delivers any complete sentences already produced; it retries once at 4x budget (capped at 4096) only when no complete sentence exists. These overrides, input/output bounds, and timeout apply to both automatic and manual recaps.

`hostCommand` selects the sole owner of `/recap`. Keep the default in a Web profile so the client contribution can render the complete menu row. Set it to `true` only in a profile that does not load the Web client; the host command then returns recap text through the terminal or another command surface. Do not enable both owners in one profile.

## Storage layout

```text
<home>/.dsh/plugin-data/dsh-session-recap/
└── <encoded-session-id>.json
```

The sidecar stores the current recap text, generation time, and completed-turn anchor. The DSH session log is append-only, and the plugin neither extends its event vocabulary nor writes plugin-defined events into it. Stale recaps are removed after the session advances, so each session keeps only its current recap on disk.

## Security boundary

The `/api/dsh-session-recap` route accepts loopback connections only: it validates the remote address, the `Host` header, and the `Origin`. `Host` is matched by an anchored regex, blocking DNS rebinding; cross-port, cross-scheme, and forged-`Host` requests are rejected. The write side (POST presence reports and manual generation) requires an exact same-origin browser `Origin`, and an invalid origin never starts generation. The read side (GET) does not require an `Origin`: any local process that reaches the port and passes the address and `Host` checks can read a session's recap text, which is equivalent to reading the plugin sidecar file directly and adds no further exposure. The route is exempt from host authentication by design; its trust rests entirely on the loopback and origin checks above. It never touches credentials and never returns raw session logs; responses carry no CORS headers and set `Cache-Control: no-store` plus `X-Content-Type-Options: nosniff`.

## Compatibility

| Item | Version or scope |
| --- | --- |
| dsh-session-recap | `0.1.7` (`package.json`) |
| DeepSeek Harness packages | Compatible range `>=0.1.6-alpha.1 <0.2.0-0` (peerDependencies); builds and tests pin `0.1.6-alpha.1` (devDependencies/overrides, for reproducible builds and git-hosted install resolution), verified running on `0.1.6-alpha.2` hosts |
| Node.js | `^22.19.0 \|\| >=24.0.0` (the current DSH runtime range) |
| Surface | Any DSH profile with LLM and session-projection services. The host command additionally needs commands; the Web card needs locale, conversation, slots, and Web-server services |

## Related

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [pi-recap](https://github.com/DDDFXYqiming/pi-recap): the same behavior for the Pi Coding Agent TUI
- [GitHub Releases](https://github.com/DDDFXYqiming/dsh-session-recap/releases)

## License

MIT
