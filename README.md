---
description: "Generate a short recap for a DeepSeek Harness session while the user is away, and show it above the composer on return."
kind: "package-bundle"
---

# @dsh-external/dsh-session-recap

English | [中文](README.zh.md)

## Summary

This bundle adds away recaps to a DeepSeek Harness session. When every Web client for the session is away and the last completed turn is older than `idleMs`, the host asks an auxiliary model for a short plain-text recap and stores it in a plugin sidecar. The Web client shows that recap above the composer when the user returns, with the current task, the important progress, and the next action. `/recap` also generates one on demand, and `hostCommand: true` exposes the same command to profiles that have no Web client.

## Table of Contents

- [Install](#install)
- [Use this package](#use-this-package)
- [Configure](#configure)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="install"></a>
## Install

Install from GitHub into a profile.

```bash
dsh plugin --profile web add github:DDDFXYqiming/dsh-session-recap
```

A git install runs the package `prepare` script and rebuilds `lib/`. pnpm 10 and newer refuse that build until the profile allows it, so the first `add` can fail. Copy the exact package key pnpm prints into the profile's `pnpm-workspace.yaml`, then run `add` again.

```yaml
allowBuilds:
  '@dsh-external/dsh-session-recap': true
```

That permission lets the package run code on your machine during install. Pin a commit (`github:DDDFXYqiming/dsh-session-recap#<sha>`) if the repository may change. A tarball produced by `pnpm pack` installs without a build.

To install from a local checkout, build it first and point `add` at the directory.

```bash
git clone https://github.com/DDDFXYqiming/dsh-session-recap.git
cd dsh-session-recap
npm install && npm run build
dsh plugin --profile web add .
```

Restart the profile, then reload the page. Node.js `^22.19.0 || >=24.0.0` is required.

-----

<a id="use-this-package"></a>
## Use this package

When you return to a session, a recap card above the composer shows the current task, the most important progress point, and the next action. The × button closes it. The card disappears when the session advances, and a session keeps one current recap.

Automatic generation needs two conditions. The session must be away, which means no Web client for that session holds an active lease; each client renews a 45-second lease with a heartbeat every 20 seconds. The last completed turn must be at least `idleMs` old, and the session must have at least `minTurns` completed turns. Starting a new turn cancels a pending generation and clears the previous recap.

To generate a recap at any time, run `/recap` from the slash menu. Profiles without a Web client set `hostCommand: true` and receive the recap text from the host command instead of the card.

The recap follows the language of your own messages, not the language of pasted logs or quoted material.

-----

<a id="configure"></a>
## Configure

The bundle default row needs no configuration. To change a value, add an entry for `dsh-session-recap` to the profile's `cordis.patch.yml`. Unset keys take the schema defaults below.

```yaml
- id: dsh-session-recap
  config:
    enabled: true           # Automatic recaps. /recap stays available when false.
    hostCommand: false      # Register the host /recap command. Set true only without a Web client.
    idleMs: 180000          # Minimum age of the last completed turn, in milliseconds.
    minTurns: 3             # Completed turns required before an automatic recap.
    recentMessages: 80      # Recent conversation messages used for the recap.
    maxChars: 400           # Hard cap on the recap text, in characters.
    maxInputChars: 24000    # Byte cap on the transcript sent to the model.
    maxOutputTokens: 2048   # Output token budget for one recap request.
    timeoutMs: 30000        # Timeout for one recap request, in milliseconds.
    manualRequestTimeoutMs: 70000  # Browser deadline for a manual /recap request.
    provider: ''            # Fixed provider. Set together with model.
    model: ''               # Fixed model. Set together with provider.
    reasoningEffort: ''     # Adapter effort id. Empty passes no value.
    # temperature: 0.2      # Optional sampling temperature. Omitted uses the adapter default.
    stopSequences: []       # Optional stop sequences for the recap request.
    routeProbe: false       # Write route verdicts to route-probe.log.
```

`provider` and `model` work as a pair. Leave both empty to reuse the provider and model from the session's last logged request. A recap route that uses a thinking model spends `maxOutputTokens` on thinking tokens too; if the first attempt produces no complete sentence, the plugin retries once with `min(4096, max(2048, maxOutputTokens × 4))` tokens. `manualRequestTimeoutMs` bounds only the browser's wait for a manual request; generation continues on the host and a later poll updates the card.

A profile patch replaces the whole config for the row. Keys you omit take their schema defaults, so a partial override is enough.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Mechanics — click to expand</summary>

The host half tracks turn boundaries through a session projection and keeps a presence map per session. Every Web client reports `active` or `away` with a client id and an increasing sequence, and the host expires an active lease after 45 seconds. A session is away only when no client holds an active lease. Automatic generation arms a timer after a completed `turn/end`, checks the same conditions again when the timer fires, and allows one in-flight request per session. Starting a turn aborts that request and clears the stored recap.

Input framing keeps the conversation and drops tool output. The frame takes the last `recentMessages` messages from the assistant and from real user input, drops tool results and injected context, uses the newest compaction checkpoint as trusted history, and adds the newest user request as `goal` when it has fallen outside the window. The JSON frame is trimmed to the `maxInputChars` byte budget by shortening its longest strings.

Generation is one auxiliary model call with a fixed system prompt and one user message. The system prompt asks for two to four plain sentences, restates the `maxChars` hard limit, forbids Markdown, and orders the content as current task, one important progress point or decision, and one next action. The user message carries the JSON frame plus a `[recap-language]` directive with up to three recent user messages, so the model writes in the language the user writes in. The reply is cleaned of reasoning tags and Markdown, clipped to `maxChars`, and reduced to complete sentences when a cut lands mid-sentence.

The host stores and serves the text. A sidecar file at `$DSH_HOME/plugin-data/dsh-session-recap/<encoded-session-id>.json` stores `text`, `at`, and `turnSeq`, written through a temporary file and rename. The in-memory copy is served by `GET /api/dsh-session-recap?sessionId=...`; the Web client polls it, renders the card in the `conversation.input.dock` slot, and remembers a dismissal in `sessionStorage` for that session, turn, and timestamp. The route accepts `GET`, `HEAD`, and `POST` for presence or a manual generation request.

The route answers local callers only. The remote address must be a loopback address, the `Host` header must match an anchored loopback pattern, `Sec-Fetch-Site: cross-site` is refused, and a missing `Origin` is allowed while a present one must parse and its host must equal `Host`. Setting `routeProbe: true` writes allow and deny verdicts to `route-probe.log` in the plugin data directory for diagnosis.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — the host project this bundle extends.
- [Packaging and installing plugins](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish) — bundle manifests, profile layers, and git installs.
- [pi-recap](https://github.com/DDDFXYqiming/pi-recap) — the same away-recap behavior for Pi Coding Agent.
- [Releases](https://github.com/DDDFXYqiming/dsh-session-recap/releases) — published versions and notes.

-----

<a id="model-experience"></a>
## Model Experience

### Recap request

#### What the model sees

One recap call sends a fixed system prompt and one user message. The system prompt asks for two to four plain sentences in the user's language, restates the `maxChars` hard limit, forbids Markdown and label-colon outlines, and orders the content as current task, one important progress point or decision, and one next action. The user message carries the JSON transcript frame `{ historySummary, goal, recent }` and a `[recap-language]` directive built from up to three recent user messages. `historySummary` is the newest compaction checkpoint, `goal` is the newest real user request when it fell outside the window, and `recent` holds role-labelled conversation entries.

#### Token effect

The plugin adds one independent request per automatic trigger or manual `/recap`. The transcript is capped at `maxInputChars` bytes (24000 by default), and `recentMessages` (80 by default) bounds how many messages enter the frame. Output is capped at `maxOutputTokens` (2048 by default), with one retry at `min(4096, max(2048, maxOutputTokens × 4))` when the first attempt returns no complete sentence. The recap text is clipped to `maxChars` (400 by default) characters and never enters the session's model input or message history.

#### KV Cache effect

Each recap is an independent single-turn request. Its transcript changes with the session, so there is no stable prefix to reuse between recaps. The plugin does not modify session messages, the session system prompt, or tool definitions, so the session's own request prefix stays reusable.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Automatic recaps need a Web client.** Away detection depends on client presence. A profile without a Web client gets `/recap` only when `hostCommand: true`, and never generates a recap on its own.
- **A model route must be available.** The host uses the explicit `provider` and `model` pair, or the route from the session's last logged request. With neither, generation fails and the host logs a warning.
- **Thinking routes consume the output budget.** Reasoning tokens count against `maxOutputTokens`. A small budget can return no complete sentence; the single escalated retry may still fail, and `/recap` then reports the error.
- **Teammate and subagent sessions stay manual.** A session with a parent session never arms an automatic recap, so a teammate conversation generates one only through `/recap`.
- **The route answers loopback clients only.** A remote or LAN caller cannot read a recap from the host route, even with the right session id.
- **Dismissals are per browser tab.** The Web client records a dismissal in `sessionStorage`, and another tab does not inherit it.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Keep `routeProbe` off outside diagnosis. It appends synchronously on the route, and a polling client can hit the disk on every request. The escalation factor, 2048 floor, and 4096 ceiling in `generateRecap` are fixed strategy constants, not config values. Run `npm run build` and `npm test` before publishing.

</details>
