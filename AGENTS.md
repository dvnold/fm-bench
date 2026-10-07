# AGENTS.md

## Working on fm-bench

`fm-bench` is a single Node.js CLI (ESM, `bin/fm-bench.js` → `src/`). It has **no runtime npm dependencies**, so `npm install` is effectively a no-op beyond Node itself. Node 22+ is required.

Standard commands:

- Test: `npm test` (`node --test test/*.test.js`)
- Lint: `npm run lint` (`node --check` on every `.js`/`.mjs`)
- Everything: `npm run check` (lint + tests + `npm pack` integrity)
- Run: `node bin/fm-bench.js <command>` (use the direct path; `npm link` can fail when the global prefix is read-only)

CI runs `npm run check` on Node 22, 24, and 26, plus CLI smoke tests against both `fm` surfaces. Workflows are linted with `actionlint`.

## Architecture notes

- `src/capabilities.js` — probes `fm --help` / `fm respond --help` and reports what the installed build supports. All subcommand and flag decisions come from here; do not hardcode `fm` subcommand names elsewhere.
- `src/fm-help.js` — pure parsers for `fm` help/status text, including the `fm models` list (unit tested against captured real output in `test/fixtures/`).
- `src/metrics.js` — metric provenance catalogue (`measured` / `proxy` / `derived` / `controlled`) and per-run availability.
- `src/process.js` — the only place that spawns processes; tracks live children so signals can clean up.
- `src/bench.js` — orchestration; must not render or print.
- `src/stats.js` — pure statistics; spread metrics are `null` below two samples.

## Running the benchmark without a real `fm`

The product benchmarks Apple's `fm` CLI, which only exists on macOS 27+ with Apple Intelligence. The CLI reads the binary from `--fm-bin <path>` or the `FM_BIN` environment variable, so the full pipeline can be exercised anywhere with the fake CLI:

```sh
FM_BIN=$PWD/test/fixtures/fake-fm.mjs FAKE_FM_SCENARIO=normal node bin/fm-bench.js --profile quick --runs 2
```

`FAKE_FM_SCENARIO` selects behaviour. `normal` mirrors the real macOS 27.2 surface (`models`, `quota-usage`, model identity, one framing token per `count-tokens` count); `legacy-available` mirrors macOS 27.0 (`available`, no quota). Others: `slow`, `malformed`, `fail`, `timeout`, `interrupt`, `hang-help`, `partial`, `short-answer`, `unavailable`, `unavailable-model`, `multi-model` (adds a `pcc` that is unavailable outside Terminal), `license-not-agreed`, `no-token-count`, `legacy-token-count`, `no-streaming`, `no-model-flag`, `no-models-section`, `token-count-fails`, `help-garbage`, `error-help`.

When the real `fm` changes shape, capture its output into `test/fixtures/` (for example `fm --help > test/fixtures/fm-help-macos27.2.txt`), update the fake to match, and add the build to `docs/compatibility.md`.

Commands that need no `fm` at all: `legend`, `validate <report.json>`, `export <report.json>`, `compare <a.json> <b.json>`, `history <dir>`, `--help`, `--version`.
