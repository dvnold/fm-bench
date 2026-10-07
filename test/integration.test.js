// Integration tests: drive the shipped CLI entry point against a deterministic
// fake `fm` so behaviour is checked through the real code path rather than
// around it.
//
// Covered failure modes: normal response, streaming, slow output, malformed
// output, process failure, timeout, unavailable model, quota failure,
// partial stream, and interrupted process.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliPath, fakeFmPath, runCli, runCliWithFakeFm } from './helpers.js';

const QUICK = ['--profile', 'quick', '--runs', '1', '--no-progress'];

function parseJsonReport(stdout) {
  return JSON.parse(stdout);
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'fm-bench-int-'));
}

test('models on a macOS 27.0 build lists models without leaking fm error text', () => {
  const result = runCliWithFakeFm(['models'], 'legacy-available');
  assert.equal(result.code, 0);
  assert.match(result.stdout, /system/);
  assert.match(result.stdout, /count-tokens/);
  assert.match(result.stdout, /available/);
  assert.doesNotMatch(result.stdout, /Unknown command/);
  assert.doesNotMatch(result.stdout, /quota-usage/);
  assert.doesNotMatch(result.stdout, /QUOTA/);
  assert.match(result.stdout, /no quota command/);
});

test('models on a macOS 27.2 build reads fm models, identity, and quota', () => {
  const result = runCliWithFakeFm(['models', '--width', '160']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /commands {2}chat, config, count-tokens, license, models, quota-usage/);
  assert.match(result.stdout, /IDENTITY/);
  assert.match(result.stdout, /AFM 3 Core Advanced/);
  assert.match(result.stdout, /QUOTA/);
  assert.match(result.stdout, /Not applicable \(quota only applies to PCC\)/);
  assert.doesNotMatch(result.stdout, /deprecated/);
});

test('models keeps the full Private Cloud Compute reason including its hint', () => {
  const result = runCliWithFakeFm(['models', '--json'], 'multi-model');
  assert.equal(result.code, 0);
  const pcc = JSON.parse(result.stdout).find((model) => model.name === 'pcc');
  assert.equal(pcc.available, false);
  assert.equal(pcc.reason, 'Private Cloud Compute is not available in this context. Please use the Terminal app.');
});

test('models --json stays a plain array of models', () => {
  const result = runCliWithFakeFm(['models', '--json']);
  assert.equal(result.code, 0);
  const models = JSON.parse(result.stdout);
  assert.ok(Array.isArray(models));
  assert.equal(models[0].name, 'system');
  assert.equal(models[0].available, true);
});

test('a benchmark run produces measured TTFT, latency, and token counts', () => {
  const result = runCliWithFakeFm([...QUICK, '--json']);
  assert.equal(result.code, 0);

  const report = parseJsonReport(result.stdout);
  assert.equal(report.tool, 'fm-bench');
  assert.equal(report.schemaVersion, '1');
  const measured = report.results.filter((run) => run.ok);
  assert.equal(measured.length, 1);
  assert.ok(measured[0].firstTokenMs > 0, 'expected a measured TTFT');
  assert.ok(measured[0].durationMs > 0, 'expected a measured end-to-end latency');
  assert.ok(measured[0].firstTokenMs <= measured[0].durationMs);
  assert.equal(measured[0].attempts, 1);
  // Prompt tokens are fm's own count (4 words + 1 framing token); output
  // tokens have the calibrated framing token removed.
  assert.equal(measured[0].promptTokens, 5);
  assert.deepEqual(report.tokenCounter, { command: 'count-tokens', overhead: 1, calibrated: true });
  assert.equal(measured[0].outputTokens, 8, '"The on-device model replies with a deterministic answer." is 8 words');
  assert.equal(measured[0].firstChunkTokens, 3, '"The on-device model " arrives as the first chunk');
  assert.ok(measured[0].tpotMs > 0, 'expected a derived TPOT for a multi-chunk stream');
  assert.ok(
    Math.abs(measured[0].decodeTokensPerSecond - (5 / (measured[0].generationMs / 1000))) < 1e-6,
    'decode rate covers only the tokens after the first chunk'
  );
  assert.equal(report.models[0].identity, 'AFM 3 Core Advanced');
  assert.deepEqual(report.suite.fingerprint.modelIdentities, { system: 'AFM 3 Core Advanced' });
  assert.equal(report.summary[0].successes, 1);
  assert.equal(report.summary[0].failures, 0);
  assert.equal(report.summary[0].latency.ci95Low, null, 'one sample has no confidence interval');
  assert.equal(report.summary[0].latency.cv, null, 'one sample has no coefficient of variation');
});

test('report records capabilities and per-metric availability', () => {
  const result = runCliWithFakeFm([...QUICK, '--json']);
  const report = parseJsonReport(result.stdout);

  assert.deepEqual(report.capabilities.models.map((model) => model.name), ['system']);
  assert.equal(report.capabilities.features.tokenCountCommand, 'count-tokens');
  assert.equal(report.capabilities.bin, fakeFmPath());
  assert.match(report.capabilities.digest, /^[0-9a-f]{16}$/);

  assert.equal(report.metrics.e2eLatency.available, true);
  assert.equal(report.metrics.e2eLatency.kind, 'measured');
  assert.equal(report.metrics.ttft.available, true);
  assert.equal(report.metrics.ttft.kind, 'proxy');
  assert.equal(report.metrics.quota.available, true);

  const legacy = parseJsonReport(runCliWithFakeFm([...QUICK, '--json'], 'legacy-available').stdout);
  assert.equal(legacy.metrics.quota.available, false);
  assert.match(legacy.metrics.quota.unavailableReason, /no quota command/);
  assert.equal(legacy.capabilities.features.modelListCommand, 'available');
});

test('--no-stream reports TTFT as unavailable instead of inventing it', () => {
  const result = runCliWithFakeFm([...QUICK, '--json', '--no-stream']);
  assert.equal(result.code, 0);
  const report = parseJsonReport(result.stdout);
  assert.equal(report.metrics.ttft.available, false);
  assert.equal(report.results[0].firstTokenMs, null);
  assert.equal(report.results[0].tpotMs, null);
  assert.ok(report.results[0].durationMs > 0);
});

test('a build without token counting reports blank token metrics and a warning', () => {
  const result = runCliWithFakeFm([...QUICK, '--json'], 'no-token-count');
  assert.equal(result.code, 0);
  const report = parseJsonReport(result.stdout);
  assert.equal(report.metrics.promptTokens.available, false);
  assert.equal(report.results[0].promptTokens, null);
  assert.equal(report.results[0].outputTokens, null);
  assert.equal(report.results[0].tokensPerSecond, null);
  assert.equal(report.results[0].firstTokenMs > 0, true, 'latency is still measurable');
  assert.match(report.capabilities.warnings.join('\n'), /no token-counting command/);
});

test('a legacy token-count command is still used', () => {
  const result = runCliWithFakeFm([...QUICK, '--json'], 'legacy-token-count');
  assert.equal(result.code, 0);
  const report = parseJsonReport(result.stdout);
  assert.equal(report.capabilities.features.tokenCountCommand, 'token-count');
  assert.equal(report.results[0].promptTokens, 5);
});

test('table output names unavailable metrics instead of leaving blank columns', () => {
  const result = runCliWithFakeFm([...QUICK], 'no-token-count');
  assert.equal(result.code, 0);
  assert.match(result.stdout, /unavailable:/);
  assert.match(result.stdout, /token-counting command/);
});

test('models the fm build does not expose are refused with our own wording', () => {
  // The verified macOS 27 build only ships the `system` model, so asking for
  // `pcc` must not surface fm's raw argument-error text.
  const json = runCliWithFakeFm(['models', '--models', 'pcc', '--json']);
  assert.equal(json.code, 0);
  const [model] = JSON.parse(json.stdout);
  assert.equal(model.name, 'pcc');
  assert.equal(model.available, false);
  assert.equal(model.unsupported, true);
  assert.equal(model.reason, 'not supported by this fm build (supported: system)');

  const text = runCliWithFakeFm(['models', '--models', 'pcc']);
  assert.equal(text.code, 0);
  assert.match(text.stdout, /pcc/);
  assert.doesNotMatch(text.stdout, /is invalid for/);
  assert.doesNotMatch(text.stdout, /Usage:/);
  const normalized = text.stdout.replace(/[\u2500-\u257f]/g, ' ').replace(/\s+/g, ' ');
  assert.match(normalized, /not supported by this fm build/);
});

test('a model listed by fm but reported unusable is skipped with the fm reason', () => {
  const result = runCliWithFakeFm(['models', '--models', 'pcc'], 'multi-model');
  assert.equal(result.code, 0);
  assert.match(result.stdout, /pcc/);
  assert.match(result.stdout, /unavailable/);
  assert.doesNotMatch(result.stdout, /is invalid for/);
});

test('a slow but successful model still measures correctly', () => {
  const result = runCliWithFakeFm([...QUICK, '--json'], 'slow');
  assert.equal(result.code, 0);
  const report = parseJsonReport(result.stdout);
  assert.equal(report.results[0].ok, true);
  assert.ok(report.results[0].firstTokenMs < 200, 'the first chunk is written immediately');
  assert.ok(report.results[0].secondChunkMs >= 380, 'expected the 400ms inter-chunk delay to be visible');
  assert.ok(report.results[0].generationMs >= 1500);
  assert.ok(report.results[0].stdoutChunks >= 3);
});

test('malformed fm output does not crash and still produces a valid report', () => {
  const result = runCliWithFakeFm([...QUICK, '--json'], 'malformed');
  assert.equal(result.code, 0);
  const report = parseJsonReport(result.stdout);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].ok, true);
  assert.ok(report.results[0].chars >= 0);
  assert.equal(typeof report.results[0].outputHash, 'string');
});

test('a failing fm process is reported honestly with a non-zero ci exit', () => {
  const result = runCliWithFakeFm([...QUICK, '--json'], 'fail');
  assert.equal(result.code, 0, 'a failed run is data, not a CLI failure');
  const report = parseJsonReport(result.stdout);
  assert.equal(report.results[0].ok, false);
  assert.match(report.results[0].error, /failed to produce a response/);
  assert.equal(report.results[0].firstTokenMs, null);
  assert.equal(report.results[0].outputTokens, null);
  assert.equal(report.summary[0].failures, 1);
  assert.equal(report.summary[0].successRate, 0);
  assert.equal(report.summary[0].latency.avg, null);
});

test('a failing run with --ci exits 1', () => {
  const result = runCliWithFakeFm([...QUICK, '--ci'], 'fail');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /fm-bench ci: FAIL/);
  assert.match(result.stderr, /1 run\(s\) failed/);
});

test('a timed-out fm call is reported as a timeout, not a measurement', () => {
  const result = runCliWithFakeFm(['--profile', 'quick', '--runs', '1', '--no-progress', '--json', '--timeout-ms', '300'], 'timeout');
  assert.equal(result.code, 0);
  const report = parseJsonReport(result.stdout);
  assert.equal(report.results[0].ok, false);
  assert.equal(report.results[0].timedOut ?? true, true);
  assert.match(report.results[0].error, /timed out after 300ms/);
  assert.equal(report.results[0].firstTokenMs, null);
  assert.equal(report.results[0].durationMs < 5000, true);
});

test('an unavailable model is skipped with the fm reason preserved', () => {
  const result = runCliWithFakeFm(['models', '--json'], 'unavailable');
  assert.equal(result.code, 0);
  const models = JSON.parse(result.stdout);
  assert.equal(models[0].available, false);
  assert.equal(models[0].reason, 'Apple Intelligence is not enabled on this Mac.');

  const legacy = JSON.parse(runCliWithFakeFm(['models', '--json'], 'legacy-available').stdout);
  assert.equal(legacy[0].available, true);
});

test('a partial stream is a failure and yields no fabricated decode metrics', () => {
  const result = runCliWithFakeFm([...QUICK, '--json'], 'partial');
  assert.equal(result.code, 0);
  const report = parseJsonReport(result.stdout);
  assert.equal(report.results[0].ok, false);
  assert.match(report.results[0].error, /stream interrupted/);
  assert.equal(report.results[0].tpotMs, null);
  assert.equal(report.results[0].decodeTokensPerSecond, null);
  assert.equal(report.results[0].outputTokenThroughput ?? null, null);
});

test('retries are counted without duplicating results', () => {
  const result = runCliWithFakeFm([...QUICK, '--json', '--retry', '1'], 'fail');
  assert.equal(result.code, 0);
  const report = parseJsonReport(result.stdout);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].attempts, 2);
  assert.equal(report.summary[0].attempted, 1);
  assert.equal(report.summary[0].retries ?? report.summary[0].retried, 1);
});

test('an unusable fm build fails fast with exit code 2', () => {
  const result = runCliWithFakeFm([...QUICK, '--json'], 'error-help');
  assert.equal(result.code, 2);
  assert.match(result.stderr, /No usable fm commands/);
  assert.equal(result.stdout, '');
});

test('a host without fm at all fails with an actionable error', () => {
  const result = runCli([...QUICK], { env: { FM_BIN: '/nonexistent/fm' } });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unable to execute/);
  assert.match(result.stderr, /FM_BIN/);
});

test('JSON stdout stays machine-readable when progress is forced on', () => {
  const result = runCliWithFakeFm([...QUICK, '--json', '--progress']);
  assert.equal(result.code, 0);
  assert.doesNotThrow(() => JSON.parse(result.stdout));
  assert.doesNotMatch(result.stdout, /fm-bench\s+(capabilities|prompts|benchmark)/);
});

test('interrupting the benchmark terminates the fm child process', async () => {
  const dir = tempDir();
  const pidFile = join(dir, 'pids.txt');
  const child = spawn(process.execPath, [cliPath(), '--profile', 'quick', '--runs', '1', '--no-progress'], {
    env: {
      ...process.env,
      FM_BIN: fakeFmPath(),
      FAKE_FM_SCENARIO: 'interrupt',
      FAKE_FM_PID_FILE: pidFile
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const pids = await waitForPids(pidFile);
  assert.ok(pids.length > 0, 'expected the fake fm to report its pid');

  child.kill('SIGINT');
  const exit = await new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

  assert.equal(exit.code, 130, `expected exit 130, got ${JSON.stringify(exit)}`);
  await waitFor(() => pids.every((pid) => !isAlive(pid)), 3_000);
});

test('validate and export round-trip a real report', () => {
  const dir = tempDir();
  const reportPath = join(dir, 'report.json');
  const run = runCliWithFakeFm([...QUICK, '--json', '--out', reportPath]);
  assert.equal(run.code, 0);
  assert.ok(existsSync(reportPath));

  const validate = runCli(['validate', reportPath, '--json']);
  assert.equal(validate.code, 0);
  const validated = JSON.parse(validate.stdout);
  assert.equal(validated.ok, true);

  const htmlPath = join(dir, 'report.html');
  const exported = runCli(['export', reportPath, '-o', htmlPath]);
  assert.equal(exported.code, 0);
  assert.match(readFileSync(htmlPath, 'utf8'), /fm-bench benchmark report/);

  const compare = runCli(['compare', reportPath, reportPath, '--json']);
  assert.equal(compare.code, 0);
  const diff = JSON.parse(compare.stdout);
  assert.equal(diff.compatibility.suiteMatch, true);
  assert.equal(diff.rows.length, 1);
  assert.equal(diff.rows[0].ttftP50.delta, 0);
});

test('history renders saved reports and json output is parseable', () => {
  const dir = tempDir();
  runCliWithFakeFm([...QUICK, '--json', '--output-dir', dir, '--tag', 'nightly']);
  const text = runCli(['history', dir]);
  assert.equal(text.code, 0);
  assert.match(text.stdout, /fm-bench history \(1 report\)/);
  assert.match(text.stdout, /nightly/);

  const json = runCli(['history', dir, '--json']);
  assert.equal(json.code, 0);
  const entries = JSON.parse(json.stdout);
  assert.equal(entries.length, 1);
  assert.match(entries[0].file, /fm-bench_.*\.json$/);
});

test('usage errors exit 2 and invalid reports exit 1', () => {
  const unknown = runCli(['--not-a-flag']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown option/);

  const badProfile = runCli(['--profile', 'nope']);
  assert.equal(badProfile.code, 2);

  const missingCompare = runCli(['compare', 'only-one.json']);
  assert.equal(missingCompare.code, 2);

  const missingValidate = runCli(['validate']);
  assert.equal(missingValidate.code, 2);

  const dir = tempDir();
  const invalid = join(dir, 'invalid.json');
  writeFileSync(invalid, '{"tool":"other"}');
  const badReport = runCli(['validate', invalid]);
  assert.equal(badReport.code, 1);
  assert.match(badReport.stderr, /invalid/);

  const notFound = runCli(['validate', join(dir, 'missing.json')]);
  assert.equal(notFound.code, 1);
  assert.match(notFound.stderr, /file not found/);

  const badJson = join(dir, 'broken.json');
  writeFileSync(badJson, '{not json');
  const unparseable = runCli(['validate', badJson, '--json']);
  assert.equal(unparseable.code, 1);
  assert.equal(JSON.parse(unparseable.stdout).ok, false);
});

test('doctor --json reports capabilities and exits 0', () => {
  const result = runCliWithFakeFm(['doctor', '--json']);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.ok(Array.isArray(payload.checks));
  assert.equal(payload.capabilities.features.tokenCountCommand, 'count-tokens');
  assert.ok(payload.checks.some((check) => check.name === 'model:system' && check.ok));
  assert.equal(result.stderr, '');
});

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPids(pidFile) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(pidFile)) {
      const pids = readFileSync(pidFile, 'utf8').trim().split('\n').filter(Boolean).map(Number);
      if (pids.length > 0) return pids;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return [];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const ok = predicate();
  assert.ok(ok, 'condition was not met before the timeout');
  return ok;
}

test('a benchmark with no usable model fails fast with exit code 2', () => {
  const unsupported = runCliWithFakeFm([...QUICK, '--json', '--models', 'pcc']);
  assert.equal(unsupported.code, 2);
  assert.match(unsupported.stderr, /none of the requested models are usable/);
  assert.match(unsupported.stderr, /not supported by this fm build \(supported: system\)/);
  assert.equal(unsupported.stdout, '', 'no partial report on stdout');

  const unavailable = runCliWithFakeFm([...QUICK, '--json'], 'unavailable');
  assert.equal(unavailable.code, 2);
  assert.match(unavailable.stderr, /none of the requested models are usable/);
  assert.match(unavailable.stderr, /system: Apple Intelligence is not enabled on this Mac\./);

  const pcc = runCliWithFakeFm([...QUICK, '--json', '--models', 'pcc'], 'multi-model');
  assert.equal(pcc.code, 2);
  assert.match(pcc.stderr, /models reported by this fm build: system, pcc/, 'lists discovered models, not the request');
  assert.match(pcc.stderr, /pcc: Private Cloud Compute is not available in this context\. Please use the Terminal app\./);
});

test('a very short answer yields generation time but no noise-dominated decode rate', () => {
  const result = runCliWithFakeFm([...QUICK, '--json'], 'short-answer');
  assert.equal(result.code, 0);
  const report = parseJsonReport(result.stdout);
  const run = report.results[0];
  assert.equal(run.ok, true);
  assert.equal(run.outputTokens, 1);
  assert.ok(run.generationMs > 0, 'two chunks still allow a generation time');
  assert.equal(run.tpotMs, null, 'one output token cannot produce an inter-token interval');
  assert.equal(run.decodeTokensPerSecond, null);
  assert.equal(report.summary[0].tpot.avg, null);
});

test('SIGINT while fm-bench is still probing capabilities exits 130', async () => {
  const child = spawn(process.execPath, [cliPath(), 'models', '--json'], {
    env: { ...process.env, FM_BIN: fakeFmPath(), FAKE_FM_SCENARIO: 'hang-help' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  await sleep(200);
  child.kill('SIGINT');
  const exit = await new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

  assert.equal(exit.code, 130, `expected 130 after SIGINT, got ${JSON.stringify(exit)}`);
});

test('SIGTERM exits 143 with the same cleanup guarantees', async () => {
  const child = spawn(process.execPath, [cliPath(), 'models', '--json'], {
    env: { ...process.env, FM_BIN: fakeFmPath(), FAKE_FM_SCENARIO: 'hang-help' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  await sleep(200);
  child.kill('SIGTERM');
  const exit = await new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

  assert.equal(exit.code, 143, `expected 143 after SIGTERM, got ${JSON.stringify(exit)}`);
});

test('--fail-fast stops admitting new work instead of finishing the queue', async () => {
  const countInvocations = (args) => {
    const dir = tempDir();
    const pidFile = join(dir, 'pids.txt');
    // runCliWithFakeFm is synchronous, so the pid file is complete on return.
    const result = runCliWithFakeFm([...args, '--json', '--no-progress'], 'fail', { env: { FAKE_FM_PID_FILE: pidFile } });
    const invocations = readFileSync(pidFile, 'utf8').trim().split('\n').filter(Boolean).length;
    return { invocations, result };
  };

  const plain = countInvocations(['--profile', 'quick', '--runs', '3']);
  assert.equal(plain.result.code, 0, 'a failed run is data, not a CLI failure');
  assert.equal(JSON.parse(plain.result.stdout).results.length, 3, 'all three runs are measured');

  const fast = countInvocations(['--profile', 'quick', '--runs', '3', '--fail-fast']);
  assert.equal(fast.result.code, 1, 'fail-fast surfaces the failure');
  assert.match(fast.result.stderr, /The model failed to produce a response/);
  assert.ok(fast.result.stdout === '', 'fail-fast prints no report');
  // Three sequential respond calls become one; every other fm call is a probe
  // or token count that happens before the queue, so the delta is exactly 2.
  assert.equal(plain.invocations - fast.invocations, 2, `fail-fast made ${fast.invocations} fm calls vs ${plain.invocations}`);
});

test('a mistyped command is refused with a suggestion instead of benchmarked as a prompt', () => {
  const typo = runCliWithFakeFm(['modles']);
  assert.equal(typo.code, 2);
  assert.match(typo.stderr, /Unknown command "modles"\. Did you mean "models"\?/);
  assert.match(typo.stderr, /fm-bench -- modles/);

  const prompt = runCliWithFakeFm([...QUICK, '--json', '--', 'modles']);
  assert.equal(prompt.code, 0, '-- still benchmarks the word as a prompt');
  assert.equal(JSON.parse(prompt.stdout).prompts[0].prompt, 'modles');

  const word = runCliWithFakeFm([...QUICK, '--json', 'hello']);
  assert.equal(word.code, 0, 'ordinary one-word prompts are not mistaken for commands');
});

test('a mistyped option names the closest real option', () => {
  const result = runCli(['--rnus', '3']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown option: --rnus\. Did you mean --runs\?/);
});

test('one warmup per model runs by default and --warmup 0 disables it', () => {
  const invocations = (args) => {
    const pidFile = join(tempDir(), 'pids.txt');
    const result = runCliWithFakeFm([...QUICK, '--json', ...args], 'normal', { env: { FAKE_FM_PID_FILE: pidFile } });
    assert.equal(result.code, 0);
    return { report: JSON.parse(result.stdout), calls: readFileSync(pidFile, 'utf8').trim().split('\n').length };
  };
  const warm = invocations([]);
  const cold = invocations(['--warmup', '0']);
  assert.equal(warm.report.options.warmup, 1);
  assert.equal(cold.report.options.warmup, 0);
  assert.equal(warm.calls - cold.calls, 1, 'exactly one extra unmeasured fm respond call');
  assert.equal(warm.report.results.length, cold.report.results.length, 'warmups are never measured');
});

test('doctor reports the fm license status and model identity', () => {
  const ok = JSON.parse(runCliWithFakeFm(['doctor', '--json']).stdout);
  const license = ok.checks.find((check) => check.name === 'fm license');
  assert.equal(license.ok, true);
  assert.match(license.detail, /Agreed to license/);
  assert.match(ok.checks.find((check) => check.name === 'model:system').detail, /available \(AFM 3 Core Advanced\)/);

  const missing = runCliWithFakeFm(['doctor'], 'license-not-agreed');
  assert.equal(missing.code, 0);
  assert.match(missing.stdout, /warn fm license +You have not agreed .* run "fm license" to review and accept the terms/);
});

test('compare warns when the model behind a name changed between reports', () => {
  const dir = tempDir();
  const beforePath = join(dir, 'before.json');
  const afterPath = join(dir, 'after.json');
  assert.equal(runCliWithFakeFm([...QUICK, '--json', '--out', beforePath]).code, 0);
  const after = JSON.parse(readFileSync(beforePath, 'utf8'));
  after.models[0].identity = 'AFM 4 Core';
  writeFileSync(afterPath, JSON.stringify(after));
  const result = runCli(['compare', beforePath, afterPath]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /warn: +model system differs \(AFM 3 Core Advanced vs AFM 4 Core\)/);
});

test('a write burst after the first chunk is one delivery, not a decode measurement', () => {
  const result = runCliWithFakeFm([...QUICK, '--json', '--runs', '3'], 'burst');
  assert.equal(result.code, 0);
  const report = parseJsonReport(result.stdout);
  for (const run of report.results) {
    assert.equal(run.ok, true);
    assert.equal(run.outputTokens, 8);
    assert.equal(run.generationMs, null, 'a burst cannot separate prefill from decode');
    assert.equal(run.tpotMs, null);
    assert.equal(run.decodeTokensPerSecond, null);
    assert.deepEqual(run.chunkGapsMs, []);
  }
});
