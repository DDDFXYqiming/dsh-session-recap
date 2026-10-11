[简体中文](README.md) | English

# @dsh-external/dsh-session-recap

**A contextual session recap extension for the DeepSeek Harness (DSH) Web client.**

When working across complex development workflows, engineers constantly multitask across different tabs and sessions. `dsh-session-recap` runs in the background to monitor window visibility and session inactivity. When you switch away or leave a session idle past a set threshold, it uses an auxiliary LLM to summarize the task's active objective, completed code changes, and immediate next steps—restoring lost focus instantly when you return.

---

## Key Features

* **Multi-Client Presence Tracking**: Uses heartbeats and lease renewal to accurately distinguish between active and away states across browser instances. Invocations occur strictly when the session is unfocused and idle past thresholds (defaults to 3 minutes and at least 3 completed turns).
* **Zero-Pollution Sidecar Storage**: Summaries are isolated in sidecar files under `~/.dsh/plugin-data/dsh-session-recap/`. It never mutates DSH's append-only event logs and consumes zero conversational token context.
* **Bounded Input & Crisp Verdicts**: Strips verbose tool output, retains compaction summaries, and anchors directly to the human user's latest command. Delivers 2–4 concise sentences matching the user's primary language without robotic conversational filler.
* **Hardened Security Perimeter**: Enforces strict loopback verification, exact Host header matching, and same-origin validation, safeguarding against DNS rebinding and cross-port forged queries.
* **Dual Operation Modes**: Renders an interactive card directly above the composer in the Web UI, with full support for headless CLI terminals via the `/recap` command.

---

## Architecture & Lifecycle

```
[Web Window Blur / Session Switch] ──> [Presence Lease Declares Away]
                                                │
                                                ▼ (Threshold: idleMs + minTurns)
[Sidecar Storage] <── [Filter Logs / Extract Intent] <── [Auxiliary LLM Inference]
        │
        ▼
[Return to Session ──> Render Context Card Above Composer]
```

---

## Installation & Quick Start

### Install via DSH Plugin Manager (Recommended)

```bash
dsh plugin --profile web add github:DDDFXYqiming/dsh-session-recap
```

### Local Development

```bash
git clone https://github.com/DDDFXYqiming/dsh-session-recap.git
cd dsh-session-recap
npm install && npm run build
dsh plugin --profile web add .
```

*Note: If running pnpm 10+ with strict build security, ensure `@dsh-external/dsh-session-recap` is set to `allowBuilds: true` inside your profile's `pnpm-workspace.yaml`.*

Restart the Web profile and reload the browser page after installation.

---

## Configuration

Default settings work out of the box. To customize, add an entry to your profile's `cordis.patch.yml`:

```yaml
- id: dsh-session-recap
  config:
    enabled: true        # Toggle automatic recaps (/recap remains manually accessible)
    hostCommand: false   # Keep false for Web UI; set true for headless CLI profiles
    idleMs: 180000       # Required idle delay in ms (default: 3 minutes)
    minTurns: 3          # Minimum completed turns required to trigger
    recentMessages: 80   # Message window inspected for intent
    maxChars: 400        # Character ceiling for plain-text recap summary
    maxInputChars: 24000 # Maximum input characters extracted
    maxOutputTokens: 2048 # Output token ceiling
    timeoutMs: 30000     # Inference timeout limit
    provider: ''         # Empty string inherits the session's active provider
    model: ''            # Empty string inherits the session's active model
```

---

## License

This project is open-sourced under the [MIT License](LICENSE).
