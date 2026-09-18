# pi-jev

A typed classification layer for the [Pi coding agent](https://pi.dev), backed by
[TypeSafe](https://typesafe.ai)'s `jev-latest` System One model.

Coding agents make dozens of implicit decisions per session that nobody classifies:
which model tier a prompt deserves, whether a shell command is recoverable, whether
a 4,000-line build log is worth a place in the context window, whether the agent is
still working on what was asked. `pi-jev` turns each of those into an explicit Jev
question with a calibrated probability, a confidence value, and a threshold that is
reviewable in one file.

Five independently switchable modules, one request per hook, shadow mode by default.

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 0 | config, client, cache, budget, telemetry, `/jev` | implemented |
| 1 | `router` | implemented, shadow |
| 2 | `gate` | implemented, shadow; `block` opt-in |
| 3 | `shield` | implemented, shadow |
| 4 | `prune` + `watchdog` | implemented, disabled by default |
| 5 | release + measured numbers | pending fixtures run against the live API |

Every module ships in **shadow mode**: it classifies, logs the counterfactual
decision, and changes nothing until you promote it. See [Promoting a module](#promoting-a-module).

> The acceptance numbers (`≥ 80 %` route accuracy, `0` missed dangerous commands…)
> are **not quoted here**. `pi-jev` reports only what `tools/evaluate.ts` produces
> from the fixtures in this repository. Run it yourself; the fixtures are public.

## Install

Requires Pi `>= 0.85.0` (Node `>= 22.19`), matching Pi's own engine requirement.

```bash
# from git
pi install git:github.com/<org>/pi-jev

# or from npm
pi install npm:pi-jev
```

For local development, run Pi with the extension directly:

```bash
pi -e ./src/index.ts
```

Set the API key before starting Pi:

```bash
export TYPESAFE_API_KEY=...
```

`pi-jev` sends metadata and sampled tool output to `api.typesafe.ai`. Read
[Privacy](#privacy) before enabling it on a repository you care about.

## How it works

```
user prompt ─► router (before_agent_start) ─► model tier, thinking level, tool loadout
                                              │
agent loop ─┬─► gate (tool_call) ─────────────┤ allow / confirm / block
            │                                 │
            ├─► shield + prune (tool_result)  │ one shared request
            │                                 │
            └─► watchdog (turn_end, every N) ─┘ loop / false-completion advice
```

`index.ts` contains no decision logic. It loads config, builds the client,
redactor and telemetry singletons, and calls each module's `register(pi, deps)`.
Modules never import each other; shared state goes through `deps`.

### The two files that matter

- [`src/questions.ts`](src/questions.ts) — every question, with its rationale.
- [`src/config.ts`](src/config.ts) — every default and threshold.

A `QUESTIONS_VERSION` hash is computed from `questions.ts`; editing it invalidates
the in-memory cache, the on-disk gate cache, and marks log records as a different
generation so calibration never mixes generations.

## Configuration

Resolution order: built-in defaults → `~/.pi/agent/jev.json` → `.pi/jev.json`
(only when `ctx.isProjectTrusted()`) → environment overrides. An invalid file
disables the extension with a clear message rather than falling back silently.

A complete annotated example lives in [`examples/jev.json`](examples/jev.json).

Frequently changed values:

```jsonc
{
  "model": "jev-latest",
  "modules": {
    "router": { "shadow": true, "tiers": { "cheap": { "provider": "anthropic", "model": "claude-haiku-4-5", "thinking": "off" } } },
    "gate":   { "shadow": true, "allowBlock": false, "onFailure": "allow" },
    "prune":  { "enabled": false, "minLines": 150 }
  },
  "residency": { "enabled": false, "allowedModels": [], "allowedRepos": [] },
  "telemetry": { "logStateContent": false }
}
```

Environment overrides: `PI_JEV_MODEL`, `PI_JEV_BASE_URL`, `PI_JEV_API_KEY_ENV`,
`PI_JEV_LOG_DIR`, `PI_JEV_LOG_STATE_CONTENT`, `PI_JEV_OFF`,
`PI_JEV_<MODULE>_ENABLED`, `PI_JEV_<MODULE>_SHADOW`, `PI_JEV_MAX_REQUESTS`,
`PI_JEV_MAX_TOKENS`.

### Timeouts, budget and failure

Timeouts are per request class: `router` 800 ms, `gate` 400 ms,
`shield`+`prune` 1500 ms, `watchdog` 1000 ms. On expiry, a missing key, a `401`, or
a budget breach the client returns `null` and the module fails **open** — Pi
behaves exactly as if the extension were not installed.

- `401` disables the layer for the session.
- `422` disables the offending request class and logs the question id (a bug in
  `questions.ts`).
- three consecutive timeouts or network failures disable that class.
- budget breach disables or warns per `budget.onBreach`.

When the gate is live and non-shadow, a classification failure falls back to
`allow` by default; set `gate.onFailure: "deny"` for fail-closed.

## Modules

| Module | Hook | Default | What it does |
| --- | --- | --- | --- |
| `router` | `before_agent_start` | enabled, shadow | picks a model tier, thinking level and tool loadout; nudges on underspecification |
| `gate` | `tool_call` | enabled, shadow | allow / confirm / block based on blast radius, reversibility, intent drift, secrets, exfiltration, unverified code |
| `shield` | `tool_result` | enabled, shadow | withholds prompt-injected output, masks secrets and personal data |
| `prune` | `tool_result` | disabled | replaces low-relevance output with a summary and a temp-file pointer |
| `watchdog` | `turn_end` | disabled | detects looping and unverified completion; injects advice, never aborts |

`shield` and `prune` share **one** Jev request on `tool_result` and split the
answers in code. That orchestration lives in `index.ts` so the two modules stay
independent and the "one request per hook" rule holds.

### Promoting a module

1. Run in shadow long enough to collect data (target: 200+ router decisions,
   300+ gate decisions).
2. Sweep the thresholds:
   ```bash
   node --experimental-strip-types tools/calibrate.ts .pi/jev-log --question confirmBlastRadius --from 1 --to 3 --step 0.25
   ```
3. Adjust `config.ts` / `.pi/jev.json`. No code changes.
4. For the gate, the `userChoice` recorded on every confirm prompt is a free label.
5. Flip one module out of shadow (`/jev shadow gate off`, then set it in config).
   Watch for a week. Repeat.

For the gate specifically: `confirm` first; leave `allowBlock: false` until the
log shows zero false negatives on `fixtures/commands.jsonl` and the disk-cache hit
rate clears 50 %.

## Commands

| Command | Does |
| --- | --- |
| `/jev` | module status, shadow flags, request count, token/cost usage |
| `/jev explain` | the last decision with its probabilities and the threshold that fired |
| `/jev shadow <module> on\|off` | toggle shadow for one module, this session only |
| `/jev off` / `/jev on` | disable or enable the whole layer for the session |
| `/jev stats [days]` | decision mix and gate labels from the local log |

The status line shows `jev <tier> · <n> req · <cost|tokens>` and degrades to
`jev off — <reason>` on failure.

## Privacy

**What leaves the machine.** Prompts, shell commands, file paths, diff summaries
and sampled tool output are sent to `api.typesafe.ai`. That is the whole point of
the layer and it is not a footnote. Do not enable it where repository content may
not leave.

**Redaction.** `src/redact.ts` runs deterministic, pattern-based scrubbing before
any request leaves: credential shapes, bearer tokens, private key blocks,
connection strings, `.env` assignments, JWTs, emails, and absolute paths reduced
to basenames. It is deliberately over-eager. `redaction.patterns: "strict"` adds
cards, national identifiers, IPs and phone numbers; a custom JSON array of regex
sources is also accepted.

**The known limitation.** `shield` exists to catch secrets patterns miss, but
content must reach Jev to be classified. Pattern redaction reduces exposure; it
does not eliminate it. A deployment where no repository content may leave should
run `router` and `gate` on redacted metadata only, with `shield` and `prune`
disabled.

**Controls.** Opt-in per project (`residency.enabled` + `residency.allowedRepos`),
project trust for project-local config, hash-only telemetry by default
(`logStateContent: false`), and a kill switch (`/jev off` or unset API key).
`baseUrl` is configurable for a self-hosted proxy that terminates TLS and applies
organisational redaction.

## Testing

```bash
npm test          # 110 unit + integration tests, no network
npm run typecheck
npm run test:coverage
```

The client and the shell wiring are tested against a **real local HTTP server**
speaking the TypeSafe wire shape (`test/helpers.ts`), not a stubbed `fetch`. That
covers timeout, abort, `401`/`422`/`429`, cache hit/miss/versioning, disk cache,
budget breach and redaction. Decision tables (including boundaries) are tested
with stubbed answers. `test/index.test.ts` embeds a fake Pi harness and asserts
real hook effects: model switched, tool call confirmed/blocked, result content
replaced.

A live smoke test runs only when `TYPESAFE_API_KEY` is set:

```bash
TYPESAFE_API_KEY=... npm test -- test/live.test.ts
```

## Evaluation and calibration

```bash
# acceptance metrics from the labelled fixtures (needs a key)
node --experimental-strip-types tools/evaluate.ts --json

# threshold sweep over a log (no key needed)
node --experimental-strip-types tools/calibrate.ts <file-or-dir> --question confirmBlastRadius --from 1 --to 3 --step 0.25

# re-issue recorded states against edited questions (needs a key + logStateContent)
node --experimental-strip-types tools/replay.ts <file-or-dir> --limit 50
```

Fixtures live in [`fixtures/`](fixtures/): 100 labelled prompts, 61 labelled
commands weighted toward the grey zone, and 24 synthetic injection cases.

> These fixtures are a v0 seed. The SDD calls for prompts drawn from public issue
> trackers; the current set is representative but not yet that. Treat the numbers
> as a smoke signal, not the published figure.

## Repository layout

```
src/            index, config, questions, client, redact, telemetry, types, modules/
tools/          calibrate.ts, replay.ts, evaluate.ts
fixtures/       prompts.jsonl, commands.jsonl, injections.jsonl
examples/       jev.json
docs/           SDD.md
test/           unit, client integration, and index wiring tests
```

## Known limitations

- The fixtures are not yet sourced from public trackers (see above).
- `matches_intent` and `is_underspecified` are unproven; watch them in shadow.
- `watchdog` turn summaries are built locally from tool names and error lines; no
  second model call. Whether they are good enough as state is an open question.
- Where TypeSafe processes and retains request data is not documented publicly and
  must be established before a regulated deployment. `shield` sends the most
  sensitive content and is gated on that answer.
- The extension is Pi-only. The question catalogue is portable; the hook bindings
  are not.

## Licence

MIT, matching Pi.
