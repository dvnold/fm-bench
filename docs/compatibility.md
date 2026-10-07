# `fm` compatibility

`fm-bench` is a client of whatever `fm` binary is installed. Apple has already changed that surface between macOS 27 builds: `count-tokens` replaced `token-count`, macOS 27.2 renamed `available` to `models` (the old name still works there but prints a deprecation warning) and added `quota-usage`, `config`, and the `pcc` model. fm-bench therefore detects capabilities at runtime instead of assuming a fixed subcommand list.

## How detection works

Once per run, `fm-bench` spawns three cheap calls:

1. `fm --help` — the command list, the `MODELS` section, and (when present) a `--model` option list. The `<model>` custom-provider placeholder is not treated as a model.
2. `fm respond --help` — which flags `respond` actually accepts (`--model`, `--[no-]stream`, `--instructions`, `--greedy`, `--use-case`, `--guardrails`, `--image`, `--tool`, `--schema`).
3. `fm models` — one call that reports every model's availability, its identity (for example `✓ system (AFM 3 Core Advanced)`), and the reason for anything unavailable. Builds without `models` fall back to `fm available --model <name>` per model.

`warning:` lines that `fm` prints (such as the `available` rename notice) are discarded before parsing, so they can never be read as a model status or an error cause.

The result is recorded in the report (`capabilities`, `models[].identity`) and shown by `fm-bench models`, `fm-bench doctor`, and `fm-bench doctor --json`. `doctor` also runs `fm license --status`, because `fm respond` cannot run until the terms are accepted.

Detection is tolerant of formatting changes: section headers are matched case-insensitively on uppercase lines, model lines by their column layout, and boolean flags in either `--flag` or Apple's `--[no-]flag` spelling. ANSI escapes are stripped before parsing.

## Capability policy

| Capability | When missing |
|------------|--------------|
| Token counting (`count-tokens`, fallback `token-count`) | The run still benchmarks latency and streaming. Every token metric is `null` with `available: false` in `metrics`, the table prints an `unavailable:` note, and the report carries a warning. `fm count-tokens` is never called. |
| Model list (`models`, fallback `available`) | With neither command, models from `fm --help` are assumed runnable and any failure is recorded per run. Model identity is only available from `models`. |
| Streaming | TTFT, generation time, TPOT, prefill, and chunk-gap metrics are unavailable, and `--stream`/`--no-stream` is not passed through. E2E latency, success rate, and RPS still work. |
| Quota command | The `models` table omits the quota column and reports quota as unavailable. |
| Model selection (`--model`) | The flag is not passed; `fm` uses its default model. |
| `--use-case`, `--guardrails`, `--instructions`, `--greedy` | Silently not passed, instead of failing the run with an argument error. |
| No usable `fm` at all | The command exits `2` with the spawn error and a hint to install `fm` or point `--fm-bin` / `FM_BIN` at a compatible binary. |

Models the build does not list are refused before any benchmark starts, with the message `not supported by this fm build (supported: ...)`. Raw `fm` argument-error text (usage blocks, `Unknown command`) never reaches reports, tables, or JSON output.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success. A failed measured run is data, not a CLI failure — use `--ci` to make failures fatal. |
| `1` | Operational failure: `--ci` gate failed, reports failed validation, or an `fm` run could not produce data. |
| `2` | Usage or environment error: unknown flag, missing argument, unsupported macOS, unusable `fm`, malformed report input, or `compare --strict` suite mismatch. |
| `130` / `143` | Interrupted by SIGINT / SIGTERM. In-flight `fm` child processes are terminated first. |

The macOS 27 requirement is enforced only when `fm-bench` resolves the default `fm` from `PATH`. Supplying `--fm-bin <path>` or `FM_BIN` lets the CLI run on any host and instead fails on the binary's actual capabilities (exit `2` when it exposes no usable commands).

## Verified builds

| Platform | `fm` surface | Notes |
|----------|--------------|-------|
| macOS 27.2 (26B5091g), Apple M5 Pro (Mac17,9) | `chat`, `config`, `count-tokens`, `license`, `models`, `quota-usage`, `respond`, `schema`, `serve` (plus deprecated `available`); models `system` (`AFM 3 Core Advanced`) and `pcc`; `--model-provider` for custom Chat Completions providers; no `--version` | Real-machine runs in 0.8.0. `pcc` reports "not available in this context. Please use the Terminal app." outside Terminal. `count-tokens` adds one framing token per count. The first streamed chunk carries about 20 tokens. Fixtures: `test/fixtures/*-macos27.2.txt`. |
| macOS 27.0 (26A5425a), Apple M5 Pro (Mac17,9) | `available`, `chat`, `count-tokens`, `license`, `respond`, `schema`, `serve`; model `system` only; no quota command; no `--version` | Real-machine smoke tests in 0.7.0. `test/fixtures/fm-help-macos27.txt` captures this help output as a regression baseline; the fake `fm` emulates it with `FAKE_FM_SCENARIO=legacy-available`. |

If your `fm` build differs, `fm-bench doctor` shows exactly what was detected, and the report's `capabilities` block records it. Please open an issue with the `doctor --json` output and the report digest when something is missing.
