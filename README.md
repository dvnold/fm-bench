# fm-bench

[![CI](https://github.com/dvnold/fm-bench/actions/workflows/ci.yml/badge.svg)](https://github.com/dvnold/fm-bench/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/fm-bench.svg)](https://www.npmjs.com/package/fm-bench)
[![node](https://img.shields.io/node/v/fm-bench.svg)](https://nodejs.org/)

Benchmark Apple's `fm` command on macOS 27+.

Measure latency, throughput, streaming smoothness, stability, and goodput across Apple Foundation Models — with repeatable prompt suites and JSON/CSV reports for automation.

## Why fm-bench exists

Apple's Foundation Models run on-device, and the `fm` CLI is the terminal and script interface to them. That makes raw model quality only half the story.

For real apps, the important questions are:

- How fast does the first token arrive?
- Does streaming stay smooth?
- How stable is latency over repeated runs?
- What happens under concurrency?
- Does this Mac meet an interactive SLO?

`fm-bench` answers those questions with repeatable local benchmarks. Think of it as GeekBench for Apple Foundation Models — run it, get numbers, compare across hardware, models, and macOS updates.

It is deliberately honest about what it can measure: the installed `fm` is probed for its actual capabilities, and any metric that build cannot supply is reported as unavailable rather than estimated. See [docs/compatibility.md](docs/compatibility.md).

## Quick Start

```sh
npm install -g fm-bench
fm-bench
```

One command discovers your models, warms each one up, runs the standard prompt suite, and prints a full benchmark report. Real output of `fm-bench --runs 3` on macOS 27.2 (26B5091g), Apple M5 Pro:

```text
fm-bench 0.8.0 | darwin/arm64 | fm
prompts 3 | runs 3 | concurrency 1 | stream on | measured 9 | failed 0 | skipped 0 | elapsed 11.07s
models: system = AFM 3 Core Advanced

┌───┬────────┬────────┬─────┬───────┬───────┬─────────┬────────┬───────┬────┬──────┐
│ C │ MODEL  │ STATUS │ OK  │ TTFT  │ E2E   │ E2E P95 │ USER/S │ SYS/S │ CV │ NOTE │
├───┼────────┼────────┼─────┼───────┼───────┼─────────┼────────┼───────┼────┼──────┤
│ 1 │ system │ ok     │ 9/9 │ 620ms │ 687ms │   1.43s │   40.6 │  37.7 │ 3% │      │
└───┴────────┴────────┴─────┴───────┴───────┴─────────┴────────┴───────┴────┴──────┘

┌───┬────────┬────────┬─────────┬───────────┬──────────┬───────────┬─────────┬────────┐
│ C │ MODEL  │ IN AVG │ OUT AVG │ PREFILL/S │ DECODE/S │ CHUNK P95 │ E2E P99 │ REPEAT │
├───┼────────┼────────┼─────────┼───────────┼──────────┼───────────┼─────────┼────────┤
│ 1 │ system │     27 │      38 │      40.7 │     78.1 │     197ms │   1.45s │   100% │
└───┴────────┴────────┴─────────┴───────────┴──────────┴───────────┴─────────┴────────┘
```

Default profile is `standard` (3 prompts) with one run each, so run-to-run CV shows `-` until you pass `--runs 2` or more. Use `--runs 5`, `--sweep-concurrency 1,2`, or `--profile client` for heavier suites. When a model is unavailable (for example `pcc` outside the Terminal app), it is listed as skipped with fm's reason; `--available-only` hides it.

Wide terminals add TTFT P95, TPOT, and RPS columns; medium terminals tighten the table; narrow terminals switch to compact model cards automatically. `--width <n>` previews any layout.

## Install

```sh
npm install -g fm-bench
```

Install directly from GitHub (always latest):

```sh
npm install -g --install-links git+https://github.com/dvnold/fm-bench.git
```

Local development:

```sh
npm install && npm link
fm-bench doctor   # verify your setup
```

**Requirements:** macOS 27+, Node.js 22+, Apple Intelligence enabled.

## Commands

| Command | What it does |
|---------|-------------|
| `fm-bench` | Run the full benchmark (default) |
| `fm-bench models` | Show the detected `fm` capabilities, discovered models, their identity (for example `AFM 3 Core Advanced`), availability, and quota |
| `fm-bench compare <a.json> <b.json>` | Regression diff with suite/hardware/macOS warnings; `--strict` exits 2 when suites differ |
| `fm-bench history [dir]` | Trend table from saved reports (sorted by time, tags visible) |
| `fm-bench validate <report.json>` | Verify report JSON (schema v1) before sharing; `--json` for CI |
| `fm-bench export <report.json>` | Standalone HTML report with embedded JSON |
| `fm-bench legend` | Definitions, provenance (measured/proxy/derived), and color rules for every column |
| `fm-bench doctor` | Environment, `fm` license, and capability check; `--json` for scripts |
| `fm-bench metrics` | Alias for `legend` |

Exit codes: `0` success, `1` operational failure (failed `--ci` gate, invalid reports), `2` usage or environment error (bad flags, unsupported macOS, unusable `fm`, no runnable model). Interrupting a run with Ctrl+C terminates in-flight `fm` processes.

Mistyped commands and flags are caught with a suggestion (`Unknown command "modles". Did you mean "models"?`) instead of being benchmarked as a prompt. To benchmark such a word anyway, put it after `--`.

## Common Recipes

```sh
# Quick smoke test
fm-bench --profile quick

# Standard 5-run benchmark with SLO budgets and warmups
fm-bench --runs 5 --warmup 1 --slo-ttft-ms 750 --slo-e2e-ms 4000

# Sweep concurrency to find your throughput ceiling
fm-bench --sweep-concurrency 1,2,4 --runs 3

# Reasoning and coding workloads
fm-bench --profile reasoning --runs 5
fm-bench --profile coding --runs 3 --histogram

# Archive runs and compare before/after a macOS update
fm-bench --output-dir reports/ --tag before-update --export-html
fm-bench --output-dir reports/ --tag after-update --export-html
fm-bench validate reports/*.json
fm-bench compare reports/fm-bench_*before*.json reports/fm-bench_*after*.json --strict

# Fail CI when SLOs regress or any run fails
fm-bench --ci --slo-ttft-ms 750 --slo-e2e-ms 4000 --runs 5

# Save JSON for automation
fm-bench --json --out bench.json
fm-bench --format csv --out bench.csv
```

## Options Reference

**Workload**

| Flag | Default | Description |
|------|---------|-------------|
| `-m, --models <list>` | discovered | Comma-separated or repeated model names |
| `-r, --runs <n>` | 1 | Measured runs per prompt/model |
| `--warmup <n>` | 1 | Unmeasured warmup runs per model before measurement; `0` measures cold start |
| `-c, --concurrency <n>` | 1 | Parallel `fm` processes |
| `--sweep-concurrency <list>` | — | Separate operating points, e.g. `1,2,4` |
| `--request-rate <rps>` | — | Pace request starts at a target rate |
| `--ramp-up-ms <n>` | 0 | Gradually ramp pacing over `n` ms |
| `--timeout-ms <n>` | 60000 | Timeout per `fm` call |
| `--retry <n>` | 0 | Retry failed calls with exponential backoff (500ms–4s) |
| `--profile <name>` | standard | Built-in prompt suite (see Profiles) |
| `-p, --prompt <text>` | — | Custom prompt, repeatable |
| `--prompt-file <file>` | — | JSON, JSONL, or blank-line separated prompts |
| `-i, --instructions <text>` | — | Passed to `fm respond` when the build supports it |
| `--use-case <case>` | — | System model use case, when supported |
| `--guardrails <level>` | — | System model guardrail level, when supported |

**Quality Gates**

| Flag | Description |
|------|-------------|
| `--slo-ttft-ms <n>` | Count a run as good only if TTFT ≤ n ms |
| `--slo-e2e-ms <n>` | Count a run as good only if E2E latency ≤ n ms |
| `--slo-tpot-ms <n>` | Count a run as good only if TPOT ≤ n ms |
| `--ci` | Exit 1 if any run fails or any SLO is violated (for pipelines) |
| `--fail-fast` | Stop after the first failed run |

**Output**

| Flag | Description |
|------|-------------|
| `--json` / `--csv` | Output format (also `--format table\|json\|csv`) |
| `-o, --out <file>` | Save JSON (`.json`), per-run CSV (`.csv`), or shareable HTML (`.html`) |
| `--output-dir <dir>` | Auto-save timestamped JSON (and optional HTML with `--export-html`) |
| `--export-html` | With `--output-dir`, also write a matching `.html` report |
| `--tag <name>` | Label this run; repeatable; appears in payload and header |
| `--note <text>` | Freeform annotation in payload and header |
| `--histogram` | Print ASCII latency distribution chart after the report |
| `--capture-output` | Include raw model output in JSON reports |
| `-v, --verbose` | Append per-run CSV after the summary table |

**Display**

| Flag | Description |
|------|-------------|
| `--no-stream` | Disable streaming; TTFT and decode metrics are reported as unavailable |
| `--greedy` / `--no-greedy` | Request or omit greedy sampling (default: greedy) |
| `--available-only` | Hide unavailable discovered models |
| `--color` / `--no-color` | Force or disable ANSI colors (auto on TTYs) |
| `--ascii` | Plain ASCII table borders instead of Unicode |
| `--compact` | Force narrow terminal layout |
| `--width <n>` | Render as if the terminal is `n` columns wide |
| `--progress` / `--no-progress` | Force or disable the live progress line |
| `--fm-bin <path>` | `fm` binary to execute (default: `FM_BIN` or `fm`) |

## Prompt Profiles

Nine built-in suites, choose the one that matches your use case:

| Profile | Prompts | Best for |
|---------|---------|----------|
| `quick` | 1 | Smoke test, fast health check |
| `standard` | 3 | Default — short chat, JSON generation, medium output |
| `interactive` | 3 | Conversational latency (TTFT-heavy) |
| `throughput` | 3 | Longer generation, token throughput signal |
| `client` | 5 | Real-world mix: chat, content, extraction, summarization, code |
| `stress` | 5 | High-load mix with math and reasoning |
| `reasoning` | 5 | Multi-step logic, estimation, debugging — capability + speed |
| `coding` | 5 | Code review, refactoring, algorithms, system design |
| `creative` | 5 | Product copy, analogies, commit messages, docs |

## Metrics

**Latency** — TTFT (p50/p95), E2E (p50/p95/p99), TPOT, 95% confidence interval, and run-to-run CV (per prompt across repeated runs, so mixing short and long prompts does not read as instability).

**Throughput** — prefill tokens/s, decode tokens/s, output tokens/s per request, aggregate system tokens/s, requests per second.

**Streaming quality** — first-chunk tokens, second-chunk delay, chunk-gap p95, captured from stdout chunk arrival during streaming runs.

**Reliability** — success rate, goodput rate and RPS against SLO budgets, repeatability (most common output hash frequency across repeated runs).

**Model identity** — the identity `fm models` reports (for example `system = AFM 3 Core Advanced`) is printed in the report header and saved in JSON, and `compare` warns when the model behind a name changed between two runs.

Every metric is labelled by provenance in JSON and in `fm-bench legend`:

- **measured** — process wall clock, exit codes, chunk arrival, `fm` token counts
- **proxy** — TTFT and chunk gaps (chunk granularity, not token timestamps); prefill tokens/s
- **derived** — TPOT, decode tokens/s, throughput, CV, confidence intervals, goodput

Token counts come from the `fm` build's own token-counting command (`count-tokens`, or `token-count` on older builds). `count-tokens` adds one framing token to every count; fm-bench calibrates that overhead once per run and removes it from output counts (`tokenCounter` in JSON). If the build cannot count tokens, token metrics render as `-`, JSON carries `null`, and `metrics.promptTokens.available` is `false`. Spread statistics (`CV`, 95% CI) need at least two successful samples; with one sample they are unavailable rather than `0`.

`fm` streams coarse deltas — on macOS 27.2 the first stdout chunk carries about 20 tokens — so TTFT is time to the first chunk, and TPOT and decode tokens/s are computed only over the tokens that arrive after it. See [docs/methodology.md](docs/methodology.md).

## fm compatibility

`fm-bench` probes `fm --help` and `fm respond --help` once per run and adapts:

- Subcommand names (`count-tokens` vs legacy `token-count`, `models` vs the deprecated `available`) are detected, not hardcoded.
- Model availability and identity come from one `fm models` call; reasons such as `Private Cloud Compute is not available in this context. Please use the Terminal app.` are shown in full.
- Flags the build does not document (`--stream`, `--use-case`, `--guardrails`, `--model`) are not passed through.
- Unsupported models are rejected before a benchmark starts, with the supported list in the error.
- Raw `fm` argument-error text never reaches reports, tables, or JSON.

`fm-bench doctor` shows exactly what was detected. Policy and the verified-build table: [docs/compatibility.md](docs/compatibility.md).

## Sharing and comparing results

Reports from 0.6.0+ include **schema v1**: `reportId`, hardware fingerprint, a **suite key** so you can tell if two JSON files used the same prompts and run settings, plus the detected `fm` capabilities and per-metric availability. See [docs/report-format.md](docs/report-format.md).

- Share **HTML** with teammates who do not use the CLI: `fm-bench export bench.json -o bench.html`
- Gate uploads in CI: `fm-bench validate artifact.json`
- Apples-to-apples regressions: same `--profile` and `--runs`, then `fm-bench compare a.json b.json`

## Regression Tracking

Track performance across macOS updates, model changes, or hardware swaps:

```sh
fm-bench --profile coding --runs 5 --output-dir reports/ --tag before
fm-bench --profile coding --runs 5 --output-dir reports/ --tag after
fm-bench compare reports/fm-bench_*before*.json reports/fm-bench_*after*.json
fm-bench history reports/
```

The compare output shows each model/concurrency row with the before value, a color-coded percent delta (green = improvement, red = regression), and the after value — for TTFT, E2E, TPOT, tokens/s, RPS, success rate, and CV. It warns when hardware, macOS version/build, or the prompt suite differ.

## CI Integration

Gate deployments or model updates on benchmark quality:

```sh
# Fails with exit code 1 if TTFT > 750ms, E2E > 4s, or any run fails
fm-bench --ci --slo-ttft-ms 750 --slo-e2e-ms 4000 --runs 5
```

Prints `fm-bench ci: PASS` or `fm-bench ci: FAIL — <reason>` to stderr. Designed for GitHub Actions, Buildkite, or any shell-based pipeline. `--json` and `--csv` write only data to stdout; progress and diagnostics go to stderr.

## Prompt Files

JSON array:

```json
[
  { "id": "tiny", "prompt": "Reply with exactly: ok" },
  { "id": "json", "prompt": "Convert alpha, beta, gamma into JSON." }
]
```

JSONL:

```jsonl
{"id":"tiny","prompt":"Reply with exactly: ok"}
{"id":"latency","prompt":"Explain p95 latency in one sentence."}
```

Plain text files are split on blank lines. Parse errors name the file and, for JSONL, the line number.

## Colors and Legend

Table output is color-coded on interactive terminals — **green** is better/passing, **yellow** is marginal/partial, **red** is failing/unstable. Fixed thresholds apply to success rate, goodput, CV, and repeatability. Latency uses SLO thresholds when set, otherwise lower-is-better relative ranking. Throughput uses higher-is-better relative ranking.

```sh
fm-bench legend          # definitions, provenance, and color rules
fm-bench legend --json   # machine-readable
```

`NO_COLOR=1` disables color; `FORCE_COLOR=1` or `--color` enables it. `--ascii` switches to plain ASCII borders for log systems. A live single-line progress indicator runs on stderr during interactive sessions; the final report always goes to stdout.

## Requirements

- macOS 27.0 or newer (Apple's `fm` CLI is preinstalled there).
- Node.js 22 or newer (CI covers Node 22, 24, and 26).
- Apple Intelligence enabled on the device, and the `fm` terms accepted once with `fm license` (`fm-bench doctor` checks this).
- To benchmark the Private Cloud Compute model (`pcc`), run fm-bench from the Terminal app: `fm` reports `pcc` as unavailable in other contexts such as editor terminals.

Benchmark commands refuse to start on older macOS versions and report the detected version plus the latest supported macOS — see [docs/supported-platforms.md](docs/supported-platforms.md).

## Development

```sh
npm install
npm test          # node --test (unit + integration against a fake fm)
npm run lint      # node --check on every source file
npm run check     # lint + tests + npm pack integrity — run this before pushing
```

No runtime npm dependencies. Integration tests drive the real CLI against `test/fixtures/fake-fm.mjs`, which emulates normal, streaming, slow, malformed, failing, timed-out, partial, and interrupted `fm` behaviour, so the suite runs on machines without `fm`.

Documentation: [methodology](docs/methodology.md) · [report format](docs/report-format.md) · [compatibility](docs/compatibility.md) · [supported platforms](docs/supported-platforms.md) · [releasing](docs/releasing.md).

## License

MIT
