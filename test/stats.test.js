import test from 'node:test';
import assert from 'node:assert/strict';
import { percentile, summarizeByModel, summarizeNumbers } from '../src/stats.js';

test('summarizeNumbers computes basic latency stats', () => {
  const summary = summarizeNumbers([30, 10, 20]);
  assert.equal(summary.min, 10);
  assert.equal(summary.max, 30);
  assert.equal(summary.avg, 20);
  assert.equal(summary.p50, 20);
  assert.equal(summary.p90, 28);
  assert.ok(Math.abs(summary.p99 - 29.8) < 0.0001);
});

test('summarizeByModel includes skipped unavailable models', () => {
  const summary = summarizeByModel([], [
    { name: 'pcc', description: 'cloud', available: false, reason: 'not available' }
  ]);

  assert.equal(summary[0].model, 'pcc');
  assert.equal(summary[0].available, false);
  assert.equal(summary[0].attempted, 0);
});

test('summarizeByModel computes streaming and throughput metrics', () => {
  const summary = summarizeByModel([
    {
      model: 'system',
      promptId: 'p1',
      ok: true,
      durationMs: 1000,
      firstTokenMs: 200,
      generationMs: 800,
      tpotMs: 100,
      promptTokens: 20,
      outputTokens: 9,
      tokensPerSecond: 9,
      decodeTokensPerSecond: 10,
      prefillTokensPerSecond: 100,
      charsPerSecond: 90,
      startOffsetMs: 0,
      endOffsetMs: 1000,
      secondChunkMs: 50,
      chunkGapsMs: [50, 70],
      outputHash: 'a',
      good: true
    },
    {
      model: 'system',
      promptId: 'p1',
      ok: true,
      durationMs: 1200,
      firstTokenMs: 300,
      generationMs: 900,
      tpotMs: 112.5,
      promptTokens: 20,
      outputTokens: 9,
      tokensPerSecond: 7.5,
      decodeTokensPerSecond: 8.9,
      prefillTokensPerSecond: 66.67,
      charsPerSecond: 70,
      startOffsetMs: 1000,
      endOffsetMs: 2200,
      secondChunkMs: 80,
      chunkGapsMs: [80, 120],
      outputHash: 'a',
      good: false
    }
  ], [
    { name: 'system', description: 'local', available: true }
  ]);

  assert.equal(summary[0].successes, 2);
  assert.equal(summary[0].ttft.p50, 250);
  assert.equal(summary[0].outputTokenThroughput, 18 / 2.2);
  assert.equal(summary[0].totalTokenThroughput, 58 / 2.2);
  assert.equal(summary[0].goodputRps, 1 / 2.2);
  assert.equal(summary[0].secondChunk.p50, 65);
  assert.ok(Math.abs(summary[0].chunkGap.p95 - 114) < 0.0001);
  assert.ok(Math.abs(summary[0].prefillTokensPerSecond.avg - 83.335) < 0.0001);
  assert.equal(summary[0].repeatability, 1);
  assert.equal(summary[0].goodputRate, 0.5);
});

test('summarizeByModel keeps concurrency operating points separate', () => {
  const summary = summarizeByModel([
    {
      model: 'system',
      concurrency: 1,
      promptId: 'p1',
      ok: true,
      durationMs: 1000,
      firstTokenMs: 100,
      generationMs: 900,
      tpotMs: 100,
      outputTokens: 10,
      tokensPerSecond: 10,
      charsPerSecond: 10,
      startOffsetMs: 0,
      endOffsetMs: 1000
    },
    {
      model: 'system',
      concurrency: 2,
      promptId: 'p1',
      ok: true,
      durationMs: 2000,
      firstTokenMs: 200,
      generationMs: 1800,
      tpotMs: 200,
      outputTokens: 10,
      tokensPerSecond: 5,
      charsPerSecond: 5,
      startOffsetMs: 0,
      endOffsetMs: 2000
    }
  ], [
    { name: 'system', description: 'local', available: true }
  ], {
    concurrencies: [1, 2]
  });

  assert.equal(summary.length, 2);
  assert.deepEqual(summary.map((item) => item.concurrency), [1, 2]);
  assert.deepEqual(summary.map((item) => item.latency.avg), [1000, 2000]);
});

test('summarizeNumbers reports no spread for a single sample', () => {
  const summary = summarizeNumbers([42]);
  assert.equal(summary.count, 1);
  assert.equal(summary.min, 42);
  assert.equal(summary.max, 42);
  assert.equal(summary.avg, 42);
  assert.equal(summary.p50, 42);
  // A one-sample "0% variation" or zero-width CI would be invented precision.
  assert.equal(summary.stddev, null);
  assert.equal(summary.cv, null);
  assert.equal(summary.ci95Low, null);
  assert.equal(summary.ci95High, null);
});

test('summarizeNumbers returns nulls for zero samples', () => {
  const summary = summarizeNumbers([]);
  assert.deepEqual(summary, {
    count: 0,
    min: null,
    max: null,
    avg: null,
    sum: 0,
    stddev: null,
    cv: null,
    ci95Low: null,
    ci95High: null,
    p50: null,
    p90: null,
    p95: null,
    p99: null
  });
});

test('summarizeNumbers computes known two-sample statistics', () => {
  const summary = summarizeNumbers([100, 200]);
  assert.equal(summary.count, 2);
  assert.equal(summary.avg, 150);
  assert.ok(Math.abs(summary.stddev - 70.710678) < 1e-5);
  assert.ok(Math.abs(summary.cv - 0.4714045) < 1e-6);
  // Two samples use t(1) = 12.706, so the interval is deliberately wide.
  assert.ok(Math.abs(summary.ci95Low - (150 - 12.706 * 50)) < 1e-6);
  assert.ok(Math.abs(summary.ci95High - (150 + 12.706 * 50)) < 1e-6);
  assert.equal(summary.p50, 150);
});

test('summarizeNumbers CI narrows as the sample grows', () => {
  const small = summarizeNumbers([100, 200, 101, 199]);
  const large = summarizeNumbers([100, 200, 101, 199, 100, 200, 101, 199, 100, 200, 101, 199]);
  const smallWidth = small.ci95High - small.ci95Low;
  const largeWidth = large.ci95High - large.ci95Low;
  assert.ok(largeWidth < smallWidth);
  assert.ok(small.ci95Low < small.avg && small.ci95High > small.avg);
});

test('summarizeNumbers ignores non-finite values', () => {
  const summary = summarizeNumbers([10, null, undefined, Number.NaN, 20, Infinity]);
  assert.equal(summary.count, 2);
  assert.equal(summary.min, 10);
  assert.equal(summary.max, 20);
});

test('percentile interpolates and tolerates unsorted input', () => {
  assert.equal(percentile([10, 20, 30, 40], 25), 17.5);
  assert.equal(percentile([10, 20, 30, 40], 50), 25);
  assert.equal(percentile([10, 20, 30, 40], 100), 40);
  assert.equal(percentile([10, 20, 30, 40], 0), 10);
  assert.equal(percentile([3, 1, 2], 50), 2);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9.1);
});

test('summarizeByModel counts retries without inventing results', () => {
  const summary = summarizeByModel([
    {
      model: 'system',
      promptId: 'p1',
      ok: true,
      attempts: 3,
      durationMs: 100,
      charsPerSecond: 10,
      startOffsetMs: 0,
      endOffsetMs: 100
    }
  ], [{ name: 'system', available: true }]);

  assert.equal(summary[0].attempted, 1);
  assert.equal(summary[0].attempts, 3);
  assert.equal(summary[0].retried, 2);
  assert.equal(summary[0].successes, 1);
});

test('summarizeByModel marks unsupported models distinctly', () => {
  const summary = summarizeByModel([], [
    { name: 'pcc', available: false, unsupported: true, reason: 'not supported by this fm build (supported: system)' }
  ]);
  assert.equal(summary[0].available, false);
  assert.equal(summary[0].unsupported, true);
  assert.equal(summary[0].attempted, 0);
  assert.match(summary[0].skippedReason, /not supported by this fm build/);
});

test('summarizeByModel reports goodput as zero when no run meets the SLO', () => {
  const summary = summarizeByModel([
    {
      model: 'system',
      promptId: 'p1',
      ok: true,
      good: false,
      durationMs: 5000,
      firstTokenMs: 900,
      charsPerSecond: 10,
      startOffsetMs: 0,
      endOffsetMs: 5000
    }
  ], [{ name: 'system', available: true }]);

  assert.equal(summary[0].goodputRate, 0);
  assert.equal(summary[0].goodputRps, 0);
});

test('summarizeByModel leaves goodput unmeasured without an SLO verdict', () => {
  const summary = summarizeByModel([
    {
      model: 'system',
      promptId: 'p1',
      ok: true,
      good: null,
      durationMs: 500,
      charsPerSecond: 10,
      startOffsetMs: 0,
      endOffsetMs: 500
    }
  ], [{ name: 'system', available: true }]);

  assert.equal(summary[0].goodputRate, null);
  assert.equal(summary[0].goodputRps, null);
});

test('decodeThroughput is token-weighted so a short tail cannot dominate', () => {
  const run = (promptId, decodeTokens, generationMs) => ({
    model: 'system', promptId, run: 1, ok: true, durationMs: generationMs + 600,
    decodeTokens, generationMs, decodeTokensPerSecond: decodeTokens / (generationMs / 1000)
  });
  const [row] = summarizeByModel(
    [run('tail', 4, 20), run('long', 200, 4000)],
    [{ name: 'system', available: true }]
  );
  assert.equal(row.decodeTokensPerSecond.avg, 125, 'the plain mean is dragged up by the 200 tok/s tail');
  assert.ok(Math.abs(row.decodeThroughput - (204 / 4.02)) < 1e-9);

  const none = summarizeByModel([run('x', null, 0)], [{ name: 'system', available: true }]);
  assert.equal(none[0].decodeThroughput, null);
});

test('stabilityCv measures run-to-run variation per prompt, not the spread between prompts', () => {
  const run = (promptId, durationMs, index) => ({
    model: 'system', promptId, run: index, ok: true, durationMs, startOffsetMs: index * 1000, endOffsetMs: index * 1000 + durationMs
  });
  // Two perfectly steady prompts with very different lengths.
  const steady = [run('short', 200, 1), run('short', 200, 2), run('long', 2000, 3), run('long', 2000, 4)];
  const [row] = summarizeByModel(steady, [{ name: 'system', available: true }]);
  assert.equal(row.stabilityCv, 0, 'no run-to-run variation at all');
  assert.ok(row.latency.cv > 0.8, 'the pooled CV only reflects that the prompts differ');

  const single = summarizeByModel([run('short', 200, 1), run('long', 2000, 2)], [{ name: 'system', available: true }]);
  assert.equal(single[0].stabilityCv, null, 'one run per prompt cannot show stability');

  const noisy = summarizeByModel([run('a', 100, 1), run('a', 300, 2)], [{ name: 'system', available: true }]);
  assert.ok(Math.abs(noisy[0].stabilityCv - (Math.sqrt(20000) / 200)) < 1e-9);
});
