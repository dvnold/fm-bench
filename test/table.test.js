import test from 'node:test';
import assert from 'node:assert/strict';
import { legendEntries, renderBenchmarkReport, renderLegend, renderModelsTable } from '../src/table.js';
import { stripAnsi } from '../src/ansi.js';

const payload = {
  version: '0.3.0',
  startedAt: '2026-06-14T00:00:00.000Z',
  finishedAt: '2026-06-14T00:00:02.000Z',
  environment: {
    platform: 'darwin',
    arch: 'arm64',
    fmBin: 'fm'
  },
  options: {
    runs: 2,
    concurrency: 1,
    sweepConcurrency: [1, 2],
    stream: true
  },
  prompts: [{ id: 'p1' }],
  summary: [
    {
      model: 'system',
      concurrency: 1,
      available: true,
      attempted: 2,
      successes: 2,
      failures: 0,
      successRate: 1,
      rps: 1.5,
      outputTokenThroughput: 42,
      repeatability: 1,
      skippedReason: '',
      description: 'local',
      ttft: { p50: 120, p95: 140 },
      latency: { p50: 900, p95: 1100, p99: 1120, cv: 0.1, ci95Low: 800, ci95High: 1200 },
      tpot: { p50: 12, p95: 15 },
      tokensPerSecond: { avg: 40 },
      promptTokens: { avg: 30 },
      outputTokens: { avg: 90 },
      decodeTokensPerSecond: { avg: 80 }
    }
  ]
};

test('renderBenchmarkReport uses compact layout for narrow width', () => {
  const report = renderBenchmarkReport(payload, { width: 60, ascii: true });
  assert.match(report, /system c1 ok 2\/2/);
  for (const line of report.split('\n')) {
    assert.ok(line.length <= 60);
  }
});

test('renderBenchmarkReport includes sweep concurrency in header', () => {
  const report = renderBenchmarkReport(payload, { width: 120, ascii: true });
  assert.match(report, /concurrency 1,2/);
  assert.match(report, /\| C \| MODEL/);
  assert.match(report, /\| 1 \| system/);
});

test('renderBenchmarkReport omits metric legend', () => {
  const report = renderBenchmarkReport(payload, { width: 120, ascii: true });
  assert.doesNotMatch(report, /CV = latency variation/);
  assert.doesNotMatch(report, /TTFT = first streamed output/);
});

test('renderLegend explains table columns and CV thresholds', () => {
  const report = renderLegend({ width: 100, ascii: true });
  assert.match(report, /TTFT/);
  assert.match(report, /GOOD RPS/);
  assert.match(report, /CV/);
  const normalized = stripAnsi(report).replace(/\s+/g, ' ');
  assert.match(normalized, /Lower is steadier\./);
  assert.match(normalized, /Green <=10%, yellow/);
  assert.match(normalized, /<=25%, red >25%/);
  assert.match(normalized, /\| TABLE \| COLUMN \| SOURCE \| DEFINITION \| RULE \|/);
  assert.match(legendEntries().find((item) => item.column === 'CV').rule, /^Lower is steadier\. Green <=10%, yellow <=25%, red >25%\. Blank until a prompt has two successful runs/);
  assert.doesNotMatch(report, /…/);
  for (const line of report.split('\n')) {
    assert.ok(stripAnsi(line).length <= 100);
  }
});

test('legendEntries include every table section', () => {
  const sections = new Set(legendEntries().map((item) => item.table));
  assert.ok(sections.has('summary'));
  assert.ok(sections.has('detail'));
  assert.ok(sections.has('models'));
  assert.ok(sections.has('colors'));
});

test('renderLegend compact layout wraps without truncating', () => {
  const report = renderLegend({ width: 50, ascii: true, compact: true });
  assert.match(report, /Definition: Run-to-run E2E variation/);
  assert.match(report, /Rule: Lower is steadier/);
  assert.doesNotMatch(report, /…/);
  for (const line of report.split('\n')) {
    assert.ok(stripAnsi(line).length <= 50);
  }
});

test('renderBenchmarkReport colors cells without changing visible width', () => {
  const report = renderBenchmarkReport(payload, { width: 60, ascii: true, color: true });
  assert.match(report, /\u001b\[/);
  for (const line of report.split('\n')) {
    assert.ok(stripAnsi(line).length <= 60);
  }
});

test('renderBenchmarkReport uses green yellow and red metric colors', () => {
  const slowItem = JSON.parse(JSON.stringify(payload.summary[0]));
  slowItem.model = 'slow';
  slowItem.goodputRate = 0.5;
  slowItem.ttft = { p50: 260, p95: 310 };
  slowItem.latency = { p50: 1300, p95: 1600, p99: 1800, cv: 0.35, ci95Low: 1200, ci95High: 1700 };
  slowItem.tpot = { p50: 35, p95: 40 };
  slowItem.tokensPerSecond = { avg: 12 };
  slowItem.outputTokenThroughput = 14;
  slowItem.rps = 0.3;
  slowItem.decodeTokensPerSecond = { avg: 18 };

  const report = renderBenchmarkReport({
    ...payload,
    options: {
      ...payload.options,
      slo: {
        ttftMs: 200,
        e2eMs: 1000,
        tpotMs: 30
      }
    },
    summary: [
      {
        ...payload.summary[0],
        goodputRate: 1
      },
      slowItem
    ]
  }, { width: 160, ascii: true, color: true });

  assert.match(report, /\u001b\[32m/);
  assert.match(report, /\u001b\[33m/);
  assert.match(report, /\u001b\[31m/);
});

test('renderBenchmarkReport wraps long note and description cells without ellipses', () => {
  const skippedItem = {
    model: 'pcc',
    concurrency: 1,
    available: false,
    attempted: 0,
    successes: 0,
    failures: 0,
    successRate: null,
    goodputRate: null,
    goodputRps: null,
    rps: null,
    outputTokenThroughput: null,
    totalTokenThroughput: null,
    repeatability: null,
    skippedReason: 'Error: PCC inference is not available in this context because Apple Intelligence quota or eligibility is unavailable.',
    description: 'Apple Foundation Model on Private Cloud Compute with remote inference eligibility and quota-dependent execution.',
    ttft: { p50: null, p95: null },
    latency: { p50: null, p95: null, p99: null, cv: null, ci95Low: null, ci95High: null },
    tpot: { p50: null, p95: null },
    tokensPerSecond: { avg: null },
    promptTokens: { avg: null },
    outputTokens: { avg: null },
    prefillTokensPerSecond: { avg: null },
    decodeTokensPerSecond: { avg: null },
    secondChunk: { p50: null },
    chunkGap: { p95: null }
  };

  const report = renderBenchmarkReport({
    ...payload,
    summary: [payload.summary[0], skippedItem]
  }, { width: 160, ascii: true, color: false });
  const normalized = stripAnsi(report).replace(/[|\n]/g, ' ').replace(/\s+/g, ' ');

  assert.doesNotMatch(report, /…|\.\.\./);
  assert.match(normalized, /PCC inference is not available/);
  assert.match(normalized, /quota or eligibility is unavailable/);
  assert.match(normalized, /Apple Foundation Model/);
  assert.match(normalized, /Private Cloud/);
  assert.match(normalized, /Compute with remote inference/);
  assert.match(normalized, /quota-dependent execution/);
  for (const line of report.split('\n')) {
    assert.ok(stripAnsi(line).length <= 160);
  }
});

test('renderModelsTable wraps long description and quota cells without ellipses', () => {
  const report = renderModelsTable([
    {
      name: 'pcc',
      available: false,
      description: 'Apple Foundation Model on Private Cloud Compute with remote inference eligibility and quota-dependent execution.',
      reason: 'PCC inference is not available in this context because Apple Intelligence quota or eligibility is unavailable.'
    }
  ], { width: 120, ascii: true, color: false });
  const normalized = stripAnsi(report).replace(/[|\n]/g, ' ').replace(/\s+/g, ' ');

  assert.doesNotMatch(report, /…|\.\.\./);
  assert.match(normalized, /Apple Foundation Model/);
  assert.match(normalized, /Private Cloud/);
  assert.match(normalized, /Compute with remote inference/);
  assert.match(normalized, /quota-dependent execution/);
  assert.match(normalized, /PCC inference is not available/);
  assert.match(normalized, /quota or eligibility/);
  assert.match(normalized, /is unavailable/);
  for (const line of report.split('\n')) {
    assert.ok(stripAnsi(line).length <= 120);
  }
});
