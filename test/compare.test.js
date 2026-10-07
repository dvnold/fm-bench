import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { diffReports, renderCompareReport } from '../src/compare.js';

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const before = JSON.parse(readFileSync(join(fixtureDir, 'fixtures/report-minimal.json'), 'utf8'));
const after = JSON.parse(readFileSync(join(fixtureDir, 'fixtures/report-minimal.json'), 'utf8'));
after.summary[0].ttft.p50 = 250;
after.summary[0].latency.p95 = 2800;

test('diffReports includes compatibility block', () => {
  const diff = diffReports(before, after);
  assert.ok(diff.compatibility);
  assert.equal(diff.compatibility.suiteMatch, true);
  assert.equal(diff.rows.length, 1);
  assert.equal(diff.rows[0].ttftP50.delta, -50);
});

test('renderCompareReport mentions suite warning when mismatched', () => {
  const mismatched = {
    ...after,
    options: { ...after.options, profile: 'quick' }
  };
  const diff = diffReports(before, mismatched);
  const text = renderCompareReport(diff, { color: false, ascii: true });
  assert.match(text, /warn:/);
});

test('renderCompareReport includes macOS build metadata', () => {
  const beta3 = {
    ...after,
    environment: {
      ...after.environment,
      macOS: 'ProductVersion:\t27.0\nBuildVersion:\t26A5378j'
    }
  };
  const diff = diffReports(before, beta3);
  const text = renderCompareReport(diff, { color: false, ascii: true });
  assert.match(text, /macOS 27\.0 \(25A123\)/);
  assert.match(text, /macOS 27\.0 \(26A5378j\)/);
  assert.match(text, /macOS build differs/);
});

test('diffReports flags invalid comparison inputs', () => {
  const invalid = diffReports(before, { tool: 'other', summary: [] });
  assert.equal(invalid.compatibility.compatible, false);
  assert.match(invalid.compatibility.errors.join(' '), /not a valid fm-bench report/);

  const rendered = renderCompareReport(invalid, { color: false, ascii: true });
  assert.match(rendered, /fm-bench compare/);
});

test('diffReports handles a model present in only one report', () => {
  const onlyAfter = {
    ...after,
    summary: [...after.summary, { model: 'pcc', concurrency: 1, available: true, successes: 2, failures: 0, successRate: 1, ttft: { p50: 100, p95: 120 }, latency: { p50: 900, p95: 1000, cv: 0.1 } }]
  };
  const diff = diffReports(before, onlyAfter);
  assert.equal(diff.rows.length, 2);
  const pcc = diff.rows.find((row) => row.model === 'pcc');
  assert.equal(pcc.ttftP50.before, null);
  assert.equal(pcc.ttftP50.delta, null);
  assert.equal(pcc.ttftP50.after, 100);
});

test('diffReports warns when hardware differs', () => {
  const otherHardware = {
    ...after,
    environment: { ...after.environment, hwModel: 'Mac16,1' }
  };
  const diff = diffReports(before, otherHardware);
  assert.ok(diff.compatibility.warnings.some((warning) => /hardware model differs/.test(warning)));
});

test('compare uses run-to-run CV only when both reports carry it', () => {
  const report = (summary) => ({
    tool: 'fm-bench', version: 'x', startedAt: '2026-01-01T00:00:00Z', options: {}, environment: {}, summary
  });
  const modern = (cv) => ({ model: 'system', concurrency: 1, stabilityCv: cv, latency: { cv: 0.9 } });
  const legacy = { model: 'system', concurrency: 1, latency: { cv: 0.5 } };

  const both = diffReports(report([modern(0.1)]), report([modern(0.2)]));
  assert.equal(both.rows[0].cv.before, 0.1);
  assert.equal(both.rows[0].cv.after, 0.2);

  const mixed = diffReports(report([legacy]), report([modern(0.2)]));
  assert.equal(mixed.rows[0].cv.before, 0.5, 'falls back to the pooled CV on both sides');
  assert.equal(mixed.rows[0].cv.after, 0.9);
});
