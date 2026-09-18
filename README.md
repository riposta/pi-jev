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
| 5 | release + measured numbers | fixtures measured; npm/git publish pending |

Every module ships in **shadow mode**: it classifies, logs the counterfactual
decision, and changes nothing until you promote it. See [Promoting a module](#promoting-a-module).

Verified end-to-end against Pi `0.85.1`: `test/pi/run-e2e.mjs` drives a real `pi`
session offline with a scripted model and asserts that the router classifies, a
live gate blocks, a live shield withholds, and a `pi install`ed package
auto-loads (see [Testing](#testing)).

### Measured results (v0 fixtures, tuned defaults)

Produced by `tools/evaluate.ts` against the labelled fixtures in this repository
(real `api.typesafe.ai`, `jev-latest`). These are the only numbers this project
quotes.

| Module | Metric | Target | Measured |
| --- | --- | --- | --- |
| router | tier accuracy vs labels | ≥ 80% | **90–92%** across runs |
| router | added latency p50 | ≤ 600 ms | **288–673 ms** (load-dependent) |
| gate | false negatives on dangerous | 0 | **0/19** |
| gate | false positives on safe | ≤ 10% | **5.0%** (1/20) |
| shield | injection detection | ≥ 90% | **93.3%** (14/15) |
| all | failures that block Pi | 0 | **0** |

Not yet measured: router net cost change (needs model pricing), gate disk-cache
hit rate over real sessions (needs a warm log), prune token saving. See
[Calibration notes](#calibration-notes) for what tuning the first run required.

> The numbers above are `pi-jev`'s own, from the fixtures in this repository,
> not a vendor benchmark. The fixtures are a v0 seed (see
> [Evaluation and calibration](#evaluation-and-calibration)); re-run
> `tools/evaluate.ts` yourself to reproduce or refute them.

## Install

`pi-jev` is a [Pi](https://pi.dev) extension, so Pi comes first.

### 1. Install Pi

Pi requires **Node `>= 22.19`**.

```bash
# installer (recommended)
curl -fsSL https://pi.dev/install.sh | sh

# or npm
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Verify with `pi --version`. Pi also needs its own model provider — an API key
(for example `ANTHROPIC_API_KEY`) or `/login` inside Pi. That is separate from
the TypeSafe key `pi-jev` uses. See the [Pi docs](https://pi.dev/docs/latest).

### 2. Set the TypeSafe API key

`pi-jev` reads the key from the environment of the process that starts Pi:

```bash
export TYPESAFE_API_KEY=...
```

The variable name is configurable (`apiKeyEnv`), and there is no phone-home: the
key is only used for requests to `api.typesafe.ai`.

### 3. Install pi-jev

Pi `>= 0.85.0` is required.

```bash
# from git
pi install git:github.com/riposta/pi-jev

# or from npm
pi install npm:pi-jev
```

For local development, run Pi with the extension directly:

```bash
npm install
pi -e ./src/index.ts

# or install this checkout as a package (no publish needed)
pi install /absolute/path/to/pi-jev
```

Every module starts in shadow mode, so installing it changes nothing until you
promote one (see [Promoting a module](#promoting-a-module)).

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
`PI_JEV_<MODULE>_ENABLED`, `PI_JEV_<MODULE>_SHADOW`, `PI_JEV_<MODULE>_TIMEOUT_MS`,
`PI_JEV_MAX_REQUESTS`, `PI_JEV_MAX_TOKENS`.

### Timeouts, budget and failure

Timeouts are per request class and configurable
(`PI_JEV_<MODULE>_TIMEOUT_MS`): `router` 2500 ms, `gate` 2000 ms,
`shield`+`prune` 3000 ms, `watchdog` 2000 ms. These are the calibrated defaults;
the initial plan's original 800/400/1500/1000 ms measured below the real p50/p95 and made
the hooks fail open (see [Calibration notes](#calibration-notes)). On expiry, a
missing key, a `401`, or a budget breach the client returns `null` and the module
fails **open** — Pi behaves exactly as if the extension were not installed.

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
| `gate` | `tool_call` | enabled, shadow | allow / confirm / block based on blast radius, reversibility, regenerable artefacts, intent drift, secrets, exfiltration, unverified code, installs and privilege/remote execution |
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

### Collecting real labels

Every confirm answer is a supervised label. The gate's `userChoice` records it
alongside the full probability vector for free. To collect them, make `confirm`
live (block stays off) and use Pi normally. Put this in `~/.pi/agent/jev.json`:

```jsonc
{ "modules": { "gate": { "enabled": true, "shadow": false, "allowBlock": false } } }
```

Then, in a project where you have been working:

```bash
node --experimental-strip-types tools/labels.ts .pi/jev-log
node --experimental-strip-types tools/labels.ts .pi/jev-log --sweep confirmBlastRadius --from 1 --to 3 --step 0.25
```

`labels` prints allow/deny totals, the deny rate per decision-table rule and the
commands you denied. With `--sweep` it replays the recorded answers and shows how
the deny rate moves as a threshold changes. Target 300+ gate decisions before
touching the numbers (initial_plan.md §13.3). Nothing is blocked while `allowBlock` is false.

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
npm test          # 119 unit + integration tests, no network
npm run typecheck
npm run test:coverage
npm run test:pi   # end-to-end against the real `pi` CLI (needs pi >= 0.85 on PATH)
```

The client and the shell wiring are tested against a **real local HTTP server**
speaking the TypeSafe wire shape (`test/helpers.ts`), not a stubbed `fetch`. That
covers timeout, abort, `401`/`422`/`429`, cache hit/miss/versioning, disk cache,
budget breach and redaction. Decision tables (including boundaries) are tested
with stubbed answers. `test/index.test.ts` embeds a fake Pi harness and asserts
real hook effects: model switched, tool call confirmed/blocked, result content
replaced.

### End-to-end against real Pi

`test/pi/run-e2e.mjs` runs the actual `pi` binary offline against local mocks —
an OpenAI-compatible model server and a TypeSafe `/v1/systemone` server — with a
scripted model. It verifies, three times:

1. **dev load** (`pi -e ./src/index.ts`): router classifies the prompt, a live
   `gate` blocks `git push --force` because there is no UI to confirm, and a live
   `shield` replaces injected `read` output with the withheld notice.
2. **package install** (`pi install /absolute/path/to/pi-jev`, then a normal run
   with no `-e`): the installed plugin auto-loads from settings and classifies.
3. **interactive confirm** (`pi --mode rpc`): the harness answers the
   `extension_ui_request` confirm dialog twice — deny then allow — and checks
   that the gate blocks then allows, that the allowed command actually ran, and
   that both `userChoice` labels land in the log.

```bash
npm run test:pi
# KEEP_TMP=1 npm run test:pi   # keep the temp workspace for inspection
```

Requires Pi's own engine: Node `>= 22.19`. Set `PI_BIN` to point at a specific
`pi` binary.

A live smoke test runs only when `TYPESAFE_API_KEY` is set:

```bash
TYPESAFE_API_KEY=... npm test -- test/live.test.ts
```

There is also a full live Pi run — a real `pi` session whose classification
calls go to the real `api.typesafe.ai` (only the LLM is scripted):

```bash
TYPESAFE_API_KEY=... npm run test:pi:live
```

And a fully live run with a real Anthropic-compatible model provider and the
router live, so it verifies that the router actually switches the model:

```bash
ANTHROPIC_API_KEY=... BASE_URL=https://api.deepseek.com/anthropic \
  TYPESAFE_API_KEY=... npm run test:pi:live-model
```

The last one was verified with `pi 0.85.1` + `deepseek-flash` → `deepseek-v4-pro`
(a `standard` classification) + real Jev. Note that Pi does not emit a
`model_select` event for a model set by an extension during `before_agent_start`;
the assertion uses the model on the assistant messages instead.

## Evaluation and calibration

```bash
# acceptance metrics from the labelled fixtures (needs a key)
node --experimental-strip-types tools/evaluate.ts --json

# threshold sweep over a log (no key needed)
node --experimental-strip-types tools/calibrate.ts <file-or-dir> --question confirmBlastRadius --from 1 --to 3 --step 0.25

# re-issue recorded states against edited questions (needs a key + logStateContent)
node --experimental-strip-types tools/replay.ts <file-or-dir> --limit 50

# offline threshold sweep over a saved evaluate report (no key needed)
node --experimental-strip-types tools/sweep.ts /tmp/jev-eval.json

# offline: score the gate against expert labels and sweep a threshold
node --experimental-strip-types tools/score-labels.ts fixtures/gate-real.jsonl
```

Fixtures live in [`fixtures/`](fixtures/): 100 labelled prompts, 61 labelled
commands weighted toward the grey zone, 24 synthetic injection cases, and 141
real commands labelled by the maintainer agent with the answers Jev produced.

> The fixture sets are a v0 seed except `gate-real.jsonl`. The initial plan calls for
> prompts drawn from public issue trackers; that sourcing is still pending. Treat
> the numbers as a smoke signal, not the published figure.

### Calibration notes

The first real run against `jev-latest` required three changes, all applied to
the defaults in this repository:

1. **Confidence floors were miscalibrated.** The initial plan applies one floor to every
   answer, but a multi-level Score spreads probability, so `reasoning_needed`
   confidence is naturally much lower than a Choice's. With the original 0.55
   floor, 40 of 48 `standard` prompts were escalated to `strong`. Added a
   separate `router.reasoningConfidenceFloor`, calibrated to `0`, and kept the
   Choice floor (`confidenceFloor: 0.4`). Router accuracy went from 47% to 90%.
2. **The gate missed one irreversible local command.** `git reset --hard` scored
   as low blast radius and reversible enough. Row 4 was extended (config-driven)
   with `confirmIrreversibleBlastRadius: 1.0` + `confirmReversibleFloor: 0.7`:
   *not cleanly reversible and beyond scratch files → confirm*. On the fixtures
   this catches all 19 dangerous commands and 0 safe ones.
3. **The initial plan timeouts were below real latency.** Measured p50 673 ms / p95
   1752 ms for a single `api.typesafe.ai` call, against budgets of 400–800 ms.
   The three-strike rule then disabled hooks, making the layer inert. Defaults
   raised to p95 + margin.
4. **The speculative `domain` question was pure cost by default.** It is only
   read when `router.skillRouting` is on, so it is now only sent in that case
   (initial_plan.md §8.2); this cuts ~18% of router input tokens. Router latency is
   network-bound and load-dependent (p50 ~300–670 ms), so the ≤600 ms target is
   met on a quiet link but not guaranteed.
5. **Drift confirmed on read-only exploration.** In a real-session sample, three
   ordinary exploration commands (`cat package.json`, `find …`) scored
   `matches_intent` 0.23–0.29 and so triggered the drift confirm, even though
   their blast radius was 0. The initial plan's drift example is mutating, so rule 3 is
   now gated on `blast_radius ≥ 1.0` (`confirmDriftBlastRadius`): read-only
   detours no longer confirm, mutating ones still do. Safe-local false confirms
   went from 3/9 to 0/9, and to **0/24 on a 141-decision sample**. That larger
   sample also showed build commands (`npm run build`, `make`, `docker build`)
   triggering the irreversible confirm; [`docs/calibration.md`](docs/calibration.md)
   records it as friction to re-validate once labelled data exists.
6. **Build friction needed a new question, not a number.** `npm run build` and
   `git reset --hard` scored almost the same `blast_radius` and `reversible`, so
   no threshold could separate a rebuild from a lost-work reset. Added a gate
   question, `regenerable`, and made the irreversible confirm require
   `regenerable < 0.6`. On the 141-decision sample confirms went 18 → 14 with the
   four build/repack confirms suppressed and every destructive/secret confirm
   kept. This is an addition to the [initial_plan.md §9.3](docs/initial_plan.md)
   question list, made per §7.2
   (split an ambiguous judgment into atomic questions); acceptance was unchanged.
7. **Expert labels over the real commands.** The 141 captured commands were
   labelled `safe`/`confirm`/`dangerous` and stored with Jev's answers as
   [`fixtures/gate-real.jsonl`](fixtures/gate-real.jsonl). At the previous floor
   the gate had 2 false positives (both `rm -rf` in a scratch dir, flagged by the
   uncertainty rule) and 5 missed confirms. With `regenerable` in place the
   reversibility floor could rise from 0.70 to **0.75**, catching
   `git reset --hard origin/main` without re-flagging builds: precision 86.7%,
   recall 76.5%, false positives 2/124 (1.6%), zero missed dangerous. The four
   remaining missed confirms (`ssh`, `sudo`, global installs) needed two more
   questions, not a threshold: `installs_software` and `privileged_or_remote`
   measured 0.99 and 0.98/0.89 with no safe command above 0.22/0.05, lifting
   recall to 100% at 89.5% precision. The gate now asks nine questions where
   [`initial_plan.md` §9.3](docs/initial_plan.md) listed six, each addition
   forced by labelled evidence.

Each is a number change or a config-driven rule; none rewrote a prompt. Re-run
`sweep.ts` and `evaluate.ts` after any `questions.ts` or threshold edit.

## Repository layout

```
src/            index, config, questions, client, redact, telemetry, types, modules/
tools/          calibrate.ts, replay.ts, evaluate.ts, sweep.ts, labels.ts, score-labels.ts
fixtures/       prompts.jsonl, commands.jsonl, injections.jsonl
examples/       jev.json
docs/           initial_plan.md, calibration.md
test/           unit, client integration, and index wiring tests
test/pi/        real-Pi end-to-end harness (mock model + mock Jev servers)
```

## Known limitations

- The fixtures are not yet sourced from public trackers (see above).
- `matches_intent` and `is_underspecified` are unproven; watch them in shadow. In
  the fully live run, ordinary exploratory commands (`find`, `ls`) scored
  `matches_intent` between 0.11 and 0.47 even though their blast radius was 0, so
  a live `confirm` would prompt often until this is calibrated on real sessions.
- TypeSafe has cold-start outliers: the first call after idle can take several
  seconds, well past the router budget, and the router then fails open. Warm the
  connection or raise `PI_JEV_ROUTER_TIMEOUT_MS` for latency-sensitive setups.
- `watchdog` turn summaries are built locally from tool names and error lines; no
  second model call. Whether they are good enough as state is an open question.
- Where TypeSafe processes and retains request data is not documented publicly and
  must be established before a regulated deployment. `shield` sends the most
  sensitive content and is gated on that answer.
- The extension is Pi-only. The question catalogue is portable; the hook bindings
  are not.

## Licence

MIT, matching Pi.
