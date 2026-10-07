# Methodology

`fm-bench` measures local `fm` command behavior from the client side. It is meant to answer: "What does this Mac deliver to a terminal user for this prompt suite right now?"

## Sources

The metric set follows common LLM inference benchmark practice:

- Apple introduces the macOS 27 `fm` command as a preinstalled way to use Foundation Models from the terminal and scripts: <https://developer.apple.com/videos/play/wwdc2026/334/>
- NVIDIA NIM benchmarking defines TTFT, end-to-end latency, inter-token latency / TPOT, tokens per second, and requests per second: <https://docs.nvidia.com/nim/benchmarking/llm/latest/metrics.html>
- NVIDIA GenAI-Perf reports TTFT, inter-token latency, request latency, sequence lengths, output token throughput, and JSON/CSV artifacts: <https://docs.nvidia.com/deeplearning/triton-inference-server/user-guide/docs/perf_analyzer/genai-perf/README.html>
- NVIDIA AIPerf documents time to second token, inter-token latency, inter-chunk latency, per-user output throughput, and prefill throughput: <https://docs.nvidia.com/aiperf/reference/ai-perf-metrics-reference>
- vLLM benchmark tooling reports TTFT, TPOT, ITL, E2E percentiles and SLO-oriented goodput: <https://docs.vllm.ai/en/stable/cli/bench/serve/>
- MLCommons describes varying concurrency and reporting verified operating points for TTFT, throughput, interactivity, and response latency rather than interpolated performance: <https://mlcommons.org/2026/03/mlperf-endpoints-gen-ai-benchmarking/>
- MLPerf Client emphasizes local client workloads with multiple task types and varying prompt/response lengths: <https://mlcommons.org/benchmarks/client/>

## What `fm` can actually tell us

`fm-bench` never invents precision the CLI cannot provide. Every metric is classified by how it is obtained:

| Kind | Meaning |
|------|---------|
| **measured** | Observed directly: process wall clock, exit codes, stdout chunk arrival, `fm`-reported token counts. |
| **proxy** | Observed at a coarser granularity than the ideal metric (for example chunk arrival instead of token timestamps). |
| **derived** | Computed from measured values (for example output tokens divided by elapsed seconds). |
| **controlled** | An input setting rather than a measurement, such as the concurrency operating point. |

The same classification is machine-readable in every JSON report under `metrics` and in the CLI via `fm-bench legend` (SOURCE column). A metric the installed `fm` build cannot support is `available: false` with a reason, and renders as `-` rather than a plausible-looking number.

## Metrics

For a column-by-column terminal reference, run `fm-bench legend`.

- `TTFT` — *proxy*. Time from starting `fm respond` to the first streamed stdout chunk. `fm` exposes no per-token timestamps, so this is a terminal-side approximation of time to first token. `fm` streams coarse deltas: on macOS 27.2 the first chunk consistently carries about 20 tokens (the same through a pseudo-terminal and through `fm serve`), so TTFT is closer to "time to the first ~20 tokens". `first_chunk_tokens` records the exact count per run.
- `E2E latency` — *measured*. Time from starting `fm respond` until the process exits and the full response is captured.
- **Deliveries.** `fm` often writes the tail of a short answer as several `write()` calls well under a millisecond apart. Stdout chunks that arrive less than 5 ms after the previous one are therefore grouped into one *delivery*. Real streaming deltas on macOS 27.2 arrive about 50–250 ms apart, so this only removes write bursts. Generation time, TPOT, decode rate, `second_chunk_ms`, and `chunk_gap` are computed over deliveries; `stdout_chunks` still counts raw chunks.
- `generation_ms` — *derived*. Last streamed delivery minus first streamed delivery, reported only when the answer arrives in more than one delivery. When a single chunk carries the whole answer, prefill and decode are not separable and the value is unavailable instead of near zero. Process teardown after the last chunk is excluded.
- `TPOT` — *derived*. `generation_ms / (output_tokens - first_chunk_tokens)`: the tokens that arrived during the generation window divided into it. Reported when at least two tokens arrived after the first chunk, so the interval is an average rather than the inverse of a single chunk gap. Requires streaming and a token-counting `fm`. Before 0.8.0 the denominator was `output_tokens - 1`, which credited the ~20 first-chunk tokens to the decode window and overstated decode speed by up to several times on short answers.
- `second_chunk_ms` — *proxy*. Time between the first and second streamed deliveries: a terminal-side signal for startup smoothness.
- `chunk_gap` — *proxy*. Distribution of time between consecutive streamed deliveries. Useful for spotting streaming jitter; delivery-based, not token-based.
- `prefill_tokens_per_second` — *proxy*. Input prompt tokens divided by TTFT seconds. Because TTFT includes process startup and first-token latency, this systematically understates true prefill speed and should be read as an upper-bound-constrained estimate, not a kernel measurement.
- `tokens_per_second` — *derived*. Output tokens divided by E2E seconds for one request.
- `decode_tokens_per_second` — *derived*. Per run: output tokens that arrived after the first delivery divided by generation seconds. Short answers finish in two or three deliveries, so their per-run rate rests on few tokens. The table's DECODE/S column is therefore the token-weighted `decodeThroughput` (decode tokens summed over runs divided by the summed generation time), so long generations dominate. The `throughput` profile gives the most trustworthy decode figure (about 51–53 tokens/s on an M5 Pro with macOS 27.2).
- `output token throughput` — *derived*. All successful output tokens for a model divided by that model's measured wall-clock window.
- `total token throughput` — *derived*. Successful prompt and output tokens divided by the model's measured wall-clock window.
- `RPS` — *measured*. Successful requests divided by the model's measured wall-clock window.
- `goodput` — *derived*. Successful requests that also satisfy every provided SLO threshold. A run whose SLO metric is unavailable counts as not good, so an unverifiable SLO can never inflate goodput.
- `goodput RPS` — *derived*. SLO-passing requests divided by the model's measured wall-clock window. Zero is reported when SLOs are set and nothing passes.
- `repeatability` — *derived*. For repeated runs of the same prompt, the average share of runs that produced the most common normalized output hash.
- `CV` — *derived*. Run-to-run stability: the E2E coefficient of variation (sample standard deviation divided by the mean) of each prompt across its repeated runs, averaged over prompts (`stabilityCv` in JSON). Reported once at least one prompt has two successful runs. The pooled `latency.cv` over every sample is still in the JSON, but it mostly reflects that prompts have different lengths, so the table no longer shows it. Before 0.8.0 the CV column used the pooled value.
- `95% CI` — *derived*. t-distribution confidence interval around the sample mean, using exact t critical values up to 30 degrees of freedom and the standard 2.0 / 1.96 approximations beyond that. Reported only with two or more successful samples. Treat it as context, not proof, at small sample sizes.
- `quota` — *measured*, when the `fm` build exposes a quota command. macOS 27.2 has `quota-usage` (the on-device `system` model reports "Not applicable", since quota only applies to `pcc`); macOS 27.0 has none, in which case `fm-bench` reports quota as unavailable rather than empty.

### Small samples

Statistics are computed over the successful samples of one model/concurrency row. With zero samples the row reports `null`; with one sample, percentiles and the mean are reported while spread metrics (`stddev`, `cv`, `ci95Low`, `ci95High`) are `null`. A single run cannot demonstrate stability, so `fm-bench` does not print `0%` variation for it.

## Operating Points

Use `--sweep-concurrency 1,2,4` to measure separate concurrency operating points. This follows the same idea as MLCommons endpoint reporting: a single peak number hides the tradeoff between system throughput and per-user responsiveness.

Use `--request-rate <rps>` to pace request starts independently of concurrency. Concurrency limits how many `fm respond` processes can be active at once; request rate controls how quickly new work is admitted. Use `--ramp-up-ms` to avoid instantly shocking a model or quota path when you start a higher-rate run.

`fm-bench` does not interpolate between operating points. It reports only what was actually measured.

## Warmups

`--warmup <n>` runs `n` unmeasured calls per model at the start of each operating point. The first `fm respond` after a cold start includes model load time, which can dominate a short prompt (observed at several hundred milliseconds on Apple silicon). Warmups are never mixed into the measured results.

Since 0.8.0 the default is one warmup per model, so a default run reports steady-state latency. Pass `--warmup 0` to measure cold start deliberately. `warmup` is part of the suite key, so `compare` flags a 0.7.x report (warmup 0) against a 0.8.0 default run as a different suite.

## Failures and retries

A failed call is recorded as a failed measurement with its error text, and is excluded from latency and throughput statistics. `--retry <n>` retries failed calls with exponential backoff before recording the failure; the report keeps the run count and records the number of attempts separately, so a retried success is still one sample and never silently duplicates work.

## Prompt Profiles

The `client` profile is a pragmatic local-machine mix inspired by MLPerf Client's emphasis on multiple task categories and prompt/response lengths. It includes short chat, content generation, structured extraction, light summarization, and code analysis prompts. It is not a formal MLPerf submission suite; it is a convenient built-in workload for comparing your own Mac, OS build, and `fm` models over time.

## Caveats

Token counts come from the `fm` build's own token-counting command (`count-tokens` on current builds, `token-count` on older ones). If a build has no such command, token-derived metrics are reported as unavailable rather than estimated.

`count-tokens` counts its input as a prompt and adds a constant framing token: on macOS 27.2 it reports 2 for `a`, 3 for `a a`, and 4 for `a a a`. Once per run fm-bench counts those three strings, derives the overhead from the consistent per-word step (`overhead = count(a) − step`), and subtracts it from output and first-chunk token counts. The result is saved as `tokenCounter: { command, overhead, calibrated }`. If the three counts are not consistent, no correction is applied and `calibrated` is `false`. Prompt token counts are left exactly as `fm` reports them, because the framing token is part of what the model processes. `count-tokens` always uses the on-device system tokenizer, so token counts for `pcc` are system-tokenizer counts. `fm-bench` cannot judge semantic quality unless you provide your own prompt suite and inspect captured outputs with `--capture-output`.

Client-side measurements include process startup, local queueing, model prefill, streaming, detokenization, and terminal pipe overhead. That is intentional for a command-line benchmark, but it is not the same as an internal model-kernel benchmark.

Stream smoothness metrics use stdout chunk arrival times. A chunk can contain more than one token, and pipe buffering can affect chunk boundaries. Treat `second_chunk_ms` and `chunk_gap` as user-visible streaming diagnostics, not raw decoder telemetry.

For serious comparisons, prefer at least three runs per prompt, include warmups, benchmark both interactive and throughput or client profiles, compare models at the same concurrency operating points, set SLOs that match your real UX budget, and save JSON reports for later analysis.

## Report artifacts

Saved JSON includes client-side environment metadata (hardware model, macOS build, `fm` help digest, power/thermal snapshot) plus the detected `fm` capabilities and per-metric availability, so shared results remain interpretable on other machines. Use `fm-bench validate` before publishing and `fm-bench compare --strict` when you require identical prompt suites. Format details: [report-format.md](./report-format.md).
