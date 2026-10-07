import { stripAnsi } from './ansi.js';
import { compareCompatibility } from './schema.js';
import { formatMs, formatNumber, formatPercent } from './table.js';

export function diffReports(before, after) {
  const compatibility = compareCompatibility(before, after);
  const beforeByKey = indexSummary(before.summary ?? []);
  const afterByKey = indexSummary(after.summary ?? []);

  const keys = new Set([...beforeByKey.keys(), ...afterByKey.keys()]);
  const rows = [];

  for (const key of [...keys].sort()) {
    const b = beforeByKey.get(key);
    const a = afterByKey.get(key);
    rows.push(buildDiffRow(key, b ?? null, a ?? null));
  }

  return {
    before: reportMeta(before),
    after: reportMeta(after),
    compatibility,
    rows
  };
}

function reportMeta(report) {
  const tags = report.options?.tags;
  const macOS = report.suite?.fingerprint?.macOSProductVersion
    ?? report.environment?.macOS?.match(/ProductVersion:\s*([^\n]+)/)?.[1]?.trim()
    ?? null;
  const macOSBuild = report.suite?.fingerprint?.macOSBuildVersion
    ?? report.environment?.macOS?.match(/BuildVersion:\s*([^\n]+)/)?.[1]?.trim()
    ?? null;
  return {
    version: report.version ?? '?',
    schemaVersion: report.schemaVersion ?? null,
    reportId: report.reportId ?? null,
    startedAt: report.startedAt ?? '',
    finishedAt: report.finishedAt ?? '',
    runs: report.options?.runs ?? null,
    profile: report.options?.profile ?? null,
    concurrency: report.options?.concurrency ?? null,
    tags: Array.isArray(tags) ? tags : [],
    note: report.options?.note ?? null,
    hwModel: report.environment?.hwModel ?? report.suite?.fingerprint?.hwModel ?? null,
    macOS,
    macOSBuild
  };
}

function indexSummary(summary) {
  const map = new Map();
  for (const item of summary) {
    const key = `${item.model}::${item.concurrency ?? 1}`;
    map.set(key, item);
  }
  return map;
}

function buildDiffRow(key, before, after) {
  const [model, concurrencyStr] = key.split('::');
  return {
    model,
    concurrency: Number.parseInt(concurrencyStr, 10) || 1,
    available: {
      before: before?.available ?? null,
      after: after?.available ?? null
    },
    ttftP50: diffMs(before?.ttft?.p50, after?.ttft?.p50),
    ttftP95: diffMs(before?.ttft?.p95, after?.ttft?.p95),
    e2eP50: diffMs(before?.latency?.p50, after?.latency?.p50),
    e2eP95: diffMs(before?.latency?.p95, after?.latency?.p95),
    e2eP99: diffMs(before?.latency?.p99, after?.latency?.p99),
    tpotP50: diffMs(before?.tpot?.p50, after?.tpot?.p50),
    successRate: diffPercent(before?.successRate, after?.successRate),
    goodputRate: diffPercent(before?.goodputRate, after?.goodputRate),
    tokensPerSecond: diffNumber(before?.tokensPerSecond?.avg, after?.tokensPerSecond?.avg, false),
    rps: diffNumber(before?.rps, after?.rps, false),
    cv: diffPercent(...comparableCv(before, after))
  };
}

// Compare the run-to-run CV only when both reports carry it; otherwise fall
// back to the suite-wide latency CV on both sides so the definitions match.
function comparableCv(before, after) {
  const bothStable = before && after && Object.hasOwn(before, 'stabilityCv') && Object.hasOwn(after, 'stabilityCv');
  return bothStable
    ? [before.stabilityCv, after.stabilityCv]
    : [before?.latency?.cv, after?.latency?.cv];
}

function diffMs(before, after) {
  return {
    before: before ?? null,
    after: after ?? null,
    delta: numDelta(before, after),
    deltaPercent: percentDelta(before, after)
  };
}

function diffNumber(before, after, lowerIsBetter = true) {
  return {
    before: before ?? null,
    after: after ?? null,
    delta: numDelta(before, after),
    deltaPercent: percentDelta(before, after),
    lowerIsBetter
  };
}

function diffPercent(before, after) {
  return {
    before: before ?? null,
    after: after ?? null,
    delta: numDelta(before, after),
    deltaPercent: percentDelta(before, after)
  };
}

function numDelta(before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
  return after - before;
}

function percentDelta(before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after) || before === 0) return null;
  return (after - before) / Math.abs(before);
}

export function renderCompareReport(diff, options = {}) {
  const { color = false, ascii = false } = options;
  const width = options.width || process.stdout.columns || 120;
  const V = ascii ? '|' : '│';
  const H = ascii ? '-' : '─';
  const TL = ascii ? '+' : '┌';
  const TR = ascii ? '+' : '┐';
  const BL = ascii ? '+' : '└';
  const BR = ascii ? '+' : '┘';
  const ML = ascii ? '+' : '├';
  const MR = ascii ? '+' : '┤';
  const TJ = ascii ? '+' : '┬';
  const MJ = ascii ? '+' : '┼';
  const BJ = ascii ? '+' : '┴';

  const lines = [];

  const beforeLabel = `${diff.before.version}  ${diff.before.startedAt ? diff.before.startedAt.slice(0, 19).replace('T', ' ') : '?'}`;
  const afterLabel = `${diff.after.version}  ${diff.after.startedAt ? diff.after.startedAt.slice(0, 19).replace('T', ' ') : '?'}`;

  lines.push(`fm-bench compare`);
  lines.push(`  before: ${beforeLabel}${diff.before.hwModel ? ` | ${diff.before.hwModel}` : ''}${formatMacOSMeta(diff.before)}`);
  lines.push(`  after:  ${afterLabel}${diff.after.hwModel ? ` | ${diff.after.hwModel}` : ''}${formatMacOSMeta(diff.after)}`);
  if (diff.before.profile || diff.after.profile) {
    lines.push(`  suite:  profile=${diff.before.profile ?? '?'} runs=${diff.before.runs ?? '?'} (before) → profile=${diff.after.profile ?? '?'} runs=${diff.after.runs ?? '?'}`);
  }
  const compat = diff.compatibility;
  if (compat?.warnings?.length) {
    for (const w of compat.warnings) {
      lines.push(`  warn:   ${w}`);
    }
  }
  if (compat && !compat.suiteMatch) {
    lines.push('  note:   use identical --profile, --runs, and prompts for apples-to-apples comparison');
  }
  lines.push('');

  const colWidths = [8, 3, 10, 10, 10, 10, 10, 10, 8, 8, 9, 7, 7];
  const headers = ['MODEL', 'C', 'TTFT P50', 'TTFT P95', 'E2E P50', 'E2E P95', 'E2E P99', 'TPOT P50', 'SUCC', 'GOOD', 'USER T/S', 'RPS', 'CV'];

  const renderRule = (l, j, r) => `${l}${colWidths.map((w) => H.repeat(w + 2)).join(j)}${r}`;
  const renderRow = (cells) => `${V}${cells.map((cell, i) => ` ${fitCell(cell, colWidths[i])} `).join(V)}${V}`;

  lines.push(renderRule(TL, TJ, TR));
  lines.push(renderRow(headers.map((h, i) => pad(h, colWidths[i]))));
  lines.push(renderRule(ML, MJ, MR));

  for (const row of diff.rows) {
    const bLine = renderRow([
      fitCell(row.model, colWidths[0]),
      fitCell(String(row.concurrency), colWidths[1]),
      fmtDiffMs(row.ttftP50, 'before', color),
      fmtDiffMs(row.ttftP95, 'before', color),
      fmtDiffMs(row.e2eP50, 'before', color),
      fmtDiffMs(row.e2eP95, 'before', color),
      fmtDiffMs(row.e2eP99, 'before', color),
      fmtDiffMs(row.tpotP50, 'before', color),
      fitCell(row.successRate.before != null ? formatPercent(row.successRate.before) : '-', colWidths[8]),
      fitCell(row.goodputRate.before != null ? formatPercent(row.goodputRate.before) : '-', colWidths[9]),
      fitCell(row.tokensPerSecond.before != null ? formatNumber(row.tokensPerSecond.before) : '-', colWidths[10]),
      fitCell(row.rps.before != null ? formatNumber(row.rps.before) : '-', colWidths[11]),
      fitCell(row.cv.before != null ? formatPercent(row.cv.before) : '-', colWidths[12])
    ]);

    const deltaLine = renderRow([
      fitCell('', colWidths[0]),
      fitCell('', colWidths[1]),
      fmtDelta(row.ttftP50, true, color, colWidths[2]),
      fmtDelta(row.ttftP95, true, color, colWidths[3]),
      fmtDelta(row.e2eP50, true, color, colWidths[4]),
      fmtDelta(row.e2eP95, true, color, colWidths[5]),
      fmtDelta(row.e2eP99, true, color, colWidths[6]),
      fmtDelta(row.tpotP50, true, color, colWidths[7]),
      fmtDelta(row.successRate, false, color, colWidths[8]),
      fmtDelta(row.goodputRate, false, color, colWidths[9]),
      fmtDelta(row.tokensPerSecond, false, color, colWidths[10]),
      fmtDelta(row.rps, false, color, colWidths[11]),
      fmtDelta(row.cv, true, color, colWidths[12])
    ]);

    const aLine = renderRow([
      fitCell('', colWidths[0]),
      fitCell('', colWidths[1]),
      fmtDiffMs(row.ttftP50, 'after', color),
      fmtDiffMs(row.ttftP95, 'after', color),
      fmtDiffMs(row.e2eP50, 'after', color),
      fmtDiffMs(row.e2eP95, 'after', color),
      fmtDiffMs(row.e2eP99, 'after', color),
      fmtDiffMs(row.tpotP50, 'after', color),
      fitCell(row.successRate.after != null ? formatPercent(row.successRate.after) : '-', colWidths[8]),
      fitCell(row.goodputRate.after != null ? formatPercent(row.goodputRate.after) : '-', colWidths[9]),
      fitCell(row.tokensPerSecond.after != null ? formatNumber(row.tokensPerSecond.after) : '-', colWidths[10]),
      fitCell(row.rps.after != null ? formatNumber(row.rps.after) : '-', colWidths[11]),
      fitCell(row.cv.after != null ? formatPercent(row.cv.after) : '-', colWidths[12])
    ]);

    lines.push(bLine);
    lines.push(deltaLine);
    lines.push(aLine);
  }

  lines.push(renderRule(BL, BJ, BR));
  lines.push('');
  lines.push('Rows: before → delta (% change) → after  |  Lower is better for latency and CV; higher for throughput and success.');

  return lines.join('\n');
}

function formatMacOSMeta(meta) {
  if (!meta.macOS && !meta.macOSBuild) return '';
  const label = meta.macOS ? `macOS ${meta.macOS}` : 'macOS';
  const build = meta.macOSBuild ? ` (${meta.macOSBuild})` : '';
  return ` | ${label}${build}`;
}

function fmtDiffMs(diff, which, color) {
  const value = diff[which];
  if (value == null) return '-';
  return formatMs(value);
}

function fmtDelta(diff, lowerIsBetter, color, width) {
  const { delta, deltaPercent } = diff;
  if (delta == null || deltaPercent == null) return fitCell('n/a', width ?? 10);

  const pct = Math.round(deltaPercent * 100);
  const sign = delta >= 0 ? '+' : '';
  const label = `${sign}${pct}%`;

  let tone = null;
  if (lowerIsBetter) {
    tone = pct < -5 ? 'green' : pct > 5 ? 'red' : 'yellow';
  } else {
    tone = pct > 5 ? 'green' : pct < -5 ? 'red' : 'yellow';
  }

  const text = fitCell(label, width ?? 10);
  if (color) return applyTone(text, tone);
  return text;
}

function applyTone(text, tone) {
  const TONES = { green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m' };
  const reset = '\x1b[0m';
  return tone && TONES[tone] ? `${TONES[tone]}${text}${reset}` : text;
}

function pad(text, width) {
  const str = safeCell(text);
  const len = str.length;
  return str + ' '.repeat(Math.max(0, width - len));
}

function fitCell(text, width) {
  const str = safeCell(text);
  if (str.length <= width) return str + ' '.repeat(width - str.length);
  return `${str.slice(0, width - 1)}…`;
}

// Values can originate from report files that fm-bench did not write, so strip
// ANSI escapes and control characters before they reach the terminal.
function safeCell(text) {
  return stripAnsi(String(text ?? '')).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}
