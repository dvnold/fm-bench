# Report format (schema v1)

Every measured run can be saved as JSON. Reports from fm-bench **0.6.0+** include a versioned schema so you can validate, share, and compare results across machines. The schema version is still `1`: the `capabilities`, `metrics`, and per-result `attempts` fields (0.7.0) and the `tokenCounter`, `models[].identity`, `firstChunkTokens`, and `stabilityCv` fields (0.8.0) are additive, so older readers and older reports both keep working.

## Top-level fields

| Field | Description |
|-------|-------------|
| `tool` | Always `"fm-bench"` |
| `version` | fm-bench package version that produced the report |
| `schemaVersion` | `"1"` for reports from 0.6.0+ (older reports omit this) |
| `reportId` | Random hex id for citing a single run |
| `startedAt` / `finishedAt` | ISO-8601 timestamps |
| `options` | Public run configuration (profile, runs, concurrency, SLOs, tags, note) |
| `environment` | Host fingerprint: platform, arch, Node, hardware model, CPU, memory, macOS version/build, `fm` help digest, thermal/power snapshot |
| `capabilities` | What the installed `fm` build exposes (see below) |
| `metrics` | Per-metric availability and provenance for this run (see below) |
| `tokenCounter` | `{ command, overhead, calibrated }`: the token-counting command and the framing overhead removed from output counts (see [methodology](./methodology.md#caveats)) |
| `suite` | Derived suite key + fingerprint for apples-to-apples comparison. `suite.fingerprint.modelIdentities` maps model names to identities, for example `{ "system": "AFM 3 Core Advanced" }` |
| `prompts` | Prompt ids, text, and token counts |
| `models` | Discovered models, availability, `reason` when unavailable, and `identity` as reported by `fm models` |
| `summary` | Per-model / per-concurrency roll-up statistics, including `stabilityCv` (run-to-run CV), `decodeThroughput` (token-weighted decode tokens/s), and `firstChunkTokens` |
| `results` | Per-run measurements (optional `output` when `--capture-output`) |

## `capabilities`

Detected once per run from `fm --help` and `fm respond --help`.

```json
{
  "capabilities": {
    "bin": "fm",
    "digest": "a45f2838f399c5da",
    "commands": ["chat", "config", "count-tokens", "license", "models", "quota-usage", "respond", "schema", "serve"],
    "models": [
      { "name": "system", "description": "On-device Apple Foundation Model" },
      { "name": "pcc", "description": "Apple Foundation Model on Private Cloud Compute" }
    ],
    "features": {
      "tokenCounting": true,
      "tokenCountCommand": "count-tokens",
      "modelListCommand": "models",
      "license": true,
      "quota": true,
      "streaming": true,
      "modelSelection": true,
      "instructions": true,
      "greedy": true,
      "useCase": true,
      "guardrails": true,
      "images": true,
      "tools": true,
      "structuredOutput": true,
      "server": true
    },
    "warnings": []
  }
}
```

On a macOS 27.0 build the same block has `"modelListCommand": "available"`, `"quota": false`, and the warning `this fm build exposes no quota command, so quota is not reported`.

`digest` is a short hash of the normalized `fm --help` output, so a report records which CLI surface produced it. Reports from two different `fm` builds are not directly comparable even on the same machine.

## `metrics`

Each entry states how a metric was obtained for this run and whether it was available. `kind` is one of `measured`, `proxy`, `derived`, or `controlled`.

```json
{
  "metrics": {
    "ttft": {
      "label": "TTFT",
      "kind": "proxy",
      "source": "arrival time of the first streamed stdout chunk",
      "available": true,
      "unavailableReason": ""
    },
    "quota": {
      "label": "quota",
      "kind": "measured",
      "source": "fm quota-usage",
      "available": true,
      "unavailableReason": ""
    }
  }
}
```

Consumers should read `available` before trusting a metric. When a metric is unavailable, the corresponding fields are `null` (JSON) or blank (CSV) — never `0`.

Per-run rows in `results` carry:

| Field | Notes |
|-------|-------|
| `attempts` | Total `fm` invocations for this measured run, including retries. `1` when no retry was needed. |
| `ok` | Whether the call produced a response and exited cleanly. |
| `firstTokenMs`, `generationMs`, `tpotMs` | `null` when the run cannot supply them (no streaming, single-chunk answer, failed run). `generationMs` runs from the first to the last streamed chunk. |
| `promptTokens`, `outputTokens`, `tokensPerSecond`, `decodeTokensPerSecond`, `prefillTokensPerSecond` | `null` when the `fm` build cannot count tokens. `promptTokens` is fm's own count; `outputTokens` has `tokenCounter.overhead` removed. |
| `firstChunkTokens`, `decodeTokens` | Output tokens carried by the first streamed delivery (overhead removed), and the tokens that arrived after it. `tpotMs` and `decodeTokensPerSecond` use only `decodeTokens`. `null` for single-delivery or non-streamed answers. |
| `error` | Actionable failure text (`timed out after 30000ms`, `fm exited with code 3`, the first actionable line of `fm` stderr). |

## CSV

`--format csv` and `--out runs.csv` write per-run rows. Columns are stable; `attempts` was added in 0.7.0, and `first_chunk_tokens` was appended as the last column in 0.8.0 so positional readers keep working. Text cells that begin with `=`, `+`, `@`, or a non-numeric `-` are prefixed with a single quote so spreadsheets do not execute prompt or model output as a formula.

## Sharing results

1. **JSON** — best for automation and `fm-bench compare`. Save with `--out bench.json` or `--output-dir reports/`.
2. **HTML** — self-contained page for humans: `--out bench.html`, `fm-bench export bench.json -o bench.html`, or `--output-dir reports/ --export-html`.
3. **CSV** — per-run rows only: `--format csv` or `--out runs.csv`.

Validate before publishing:

```sh
fm-bench validate my-report.json
```

## Comparable benchmarks

For fair comparison, match:

- Same `--profile` (or same `--prompt-file`)
- Same `--runs` and `--warmup`
- Same concurrency operating points (`--concurrency` or `--sweep-concurrency`)
- Same `fm` build (compare `capabilities.digest` / `environment.fmHelpDigest`)
- Same or intentionally changed macOS build (especially for beta-to-beta comparisons)
- Similar power/thermal state (see `environment.power` and `environment.thermal`)

```sh
fm-bench compare before.json after.json
fm-bench compare before.json after.json --strict   # exit 2 if suites differ
```

`compare` warns when hardware, macOS product version, macOS build, or suite configuration differ. Use `--tag` and `--note` so `fm-bench history` stays readable.

## Legacy reports

Reports from fm-bench before 0.6.0 remain valid JSON. They lack `schemaVersion`, `reportId`, `suite`, `capabilities`, and the enriched `environment`. `validate` still checks required fields, and `compare` works on `summary` as before.
