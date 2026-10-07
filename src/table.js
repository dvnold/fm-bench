import { stripAnsi } from './ansi.js';
import { formatCapabilitySummary } from './metrics.js';

export function renderTable(headers, rows, options = {}) {
  const ascii = Boolean(options.ascii);
  const maxCellWidth = options.maxCellWidth || 60;
  const wrapColumns = normalizeWrapColumns(headers, options.wrapColumns);
  const normalizedRows = rows.map((row) => row.map((cell, index) => {
    const normalized = normalizeCell(cell);
    return {
      ...normalized,
      text: wrapColumns.has(index) ? normalized.text : truncate(normalized.text, maxCellWidth)
    };
  }));
  const widths = fitTableWidths(headers, headers.map((header, index) => {
    const values = [truncate(header, maxCellWidth), ...normalizedRows.map((row) => row[index]?.text ?? '')];
    if (wrapColumns.has(index)) {
      return Math.max(...values.map((value) => Math.min(maxCellWidth, visibleLength(value))));
    }
    return Math.max(...values.map(visibleLength));
  }), wrapColumns, terminalWidth(options));
  const style = ascii ? ASCII_TABLE : UNICODE_TABLE;

  const top = rule(style.topLeft, style.topJoin, style.topRight, style.horizontal, widths);
  const middle = rule(style.midLeft, style.midJoin, style.midRight, style.horizontal, widths);
  const bottom = rule(style.bottomLeft, style.bottomJoin, style.bottomRight, style.horizontal, widths);
  const headerLine = rowLine(headers.map((header) => truncate(header, maxCellWidth)), widths, style, true, options);
  const bodyLines = wrapColumns.size > 0
    ? normalizedRows.flatMap((row) => wrappedRowLines(row, widths, style, wrapColumns, options))
    : normalizedRows.map((row) => rowLine(row, widths, style, false, options));

  return [top, headerLine, middle, ...bodyLines, bottom].join('\n');
}

export function renderBenchmarkReport(payload, options = {}) {
  const width = terminalWidth(options);
  const mode = options.compact || width < 88
    ? 'compact'
    : width < 140
      ? 'medium'
      : 'wide';
  const lines = [];
  const elapsedMs = Date.parse(payload.finishedAt) - Date.parse(payload.startedAt);
  const skipped = payload.summary.filter((item) => !item.available).length;
  const measured = payload.summary.reduce((sum, item) => sum + item.successes, 0);
  const failed = payload.summary.reduce((sum, item) => sum + item.failures, 0);
  const concurrencies = payload.options.sweepConcurrency?.length
    ? payload.options.sweepConcurrency.join(',')
    : String(payload.options.concurrency);
  const slo = formatSlo(payload.options.slo);

  const title = `fm-bench ${payload.version} | ${payload.environment.platform}/${payload.environment.arch} | ${payload.environment.fmBin}`;
  const meta = `prompts ${payload.prompts.length} | runs ${payload.options.runs} | concurrency ${concurrencies} | stream ${payload.options.stream ? 'on' : 'off'} | measured ${measured} | failed ${failed} | skipped ${skipped} | elapsed ${formatMs(elapsedMs)}${slo ? ` | ${slo}` : ''}`;
  const tags = payload.options?.tags?.length ? payload.options.tags : [];
  const note = payload.options?.note ?? null;
  lines.push(...wrapText(title, width));
  lines.push(...wrapText(meta, width));
  const identities = (payload.models ?? [])
    .filter((model) => model.available && model.identity)
    .map((model) => `${model.name} = ${model.identity}`);
  if (identities.length > 0) {
    lines.push(...wrapText(`models: ${identities.join(', ')}`, width));
  }
  if (tags.length > 0) {
    for (const line of wrapText(`tags: ${tags.join(', ')}`, width)) lines.push(line);
  }
  if (note) {
    for (const line of wrapText(`note: ${note}`, width)) lines.push(line);
  }
  for (const metricNote of unavailableMetricNotes(payload.metrics)) {
    for (const line of wrapText(`unavailable: ${metricNote}`, width)) {
      lines.push(line);
    }
  }
  lines.push('');

  if (mode === 'compact') {
    lines.push(renderCompactSummary(payload.summary, { ...options, width, slo: payload.options.slo }));
  } else {
    lines.push(renderSummaryTable(payload.summary, { ...options, mode, width, slo: payload.options.slo }));
    lines.push('');
    lines.push(renderDetailTable(payload.summary, { ...options, mode, width, slo: payload.options.slo }));
  }

  return lines.join('\n');
}

export function legendEntries() {
  return [
    entry('summary', 'C', 'Concurrency operating point for this row.', 'Higher C means more parallel fm respond processes.', 'controlled'),
    entry('summary', 'MODEL', 'fm model name reported by the detected fm build.', '', 'measured'),
    entry('summary', 'STATUS', 'Run status for this model and operating point.', 'ok = all measured jobs passed; partial = at least one failed; skipped = unavailable or unsupported.', 'measured'),
    entry('summary', 'OK / OK/RUNS', 'Successful measured runs over attempted measured runs.', 'Green when no failures; yellow when partial.', 'measured'),
    entry('summary', 'SUCC / SUCCESS', 'Success rate: successful runs divided by attempted runs.', 'Green 100%, yellow >=95%, red <95%.', 'measured'),
    entry('summary', 'GOOD', 'Goodput rate: successful runs that also met every configured SLO.', 'Only appears when SLO flags are set. Runs whose SLO metric is unmeasurable count as not good.', 'derived'),
    entry('summary', 'GOOD RPS', 'SLO-passing requests per second during this measured window.', 'Zero is shown when SLOs are set and no request meets them.', 'derived'),
    entry('summary', 'TTFT', 'Time from starting fm respond to the first streamed stdout chunk, p50.', 'Proxy for time to first token: measured at chunk granularity, and the first chunk can already hold many tokens (see 1ST CHUNK). Lower is better.', 'proxy'),
    entry('summary', 'TTFT P95', '95th percentile time to the first streamed stdout chunk.', 'Lower is better.', 'proxy'),
    entry('summary', 'E2E', 'End-to-end latency, p50, from starting fm respond until full response exits.', 'Lower is better. This is a direct wall-clock measurement.', 'measured'),
    entry('summary', 'E2E P95', '95th percentile end-to-end latency.', 'Lower is better; this is usually the main interactive tail-latency signal.', 'measured'),
    entry('summary', 'TPOT', 'Time per output token for tokens that arrived after the first streamed chunk, p50.', 'Derived from fm token counts and stream timings. Lower is better.', 'derived'),
    entry('summary', 'TPOT P95', '95th percentile time per output token after the first streamed chunk.', 'Lower is better.', 'derived'),
    entry('summary', 'USER/S / USER T/S', 'Per-request output tokens per second.', 'Derived from fm token counts. Higher is better.', 'derived'),
    entry('summary', 'SYS/S / SYS T/S', 'Aggregate successful output-token throughput for the model row.', 'Higher is better.', 'derived'),
    entry('summary', 'RPS', 'Successful requests per second over the model row measured window.', 'Measured from process timings. Higher is better.', 'measured'),
    entry('summary', 'CV', 'Run-to-run E2E variation: coefficient of variation of each prompt across its repeated runs, averaged over prompts.', 'Lower is steadier. Green <=10%, yellow <=25%, red >25%. Blank until a prompt has two successful runs (use --runs 2 or more).', 'derived'),
    entry('summary', 'NOTE', 'Short unavailable, skipped, or error note.', '', 'measured'),
    entry('detail', 'IN AVG / IN TOK AVG', 'Average prompt/input token count from fm count-tokens.', 'Blank when the fm build cannot count tokens.', 'measured'),
    entry('detail', 'OUT AVG / OUT TOK AVG', 'Average output token count from fm count-tokens, minus its constant framing token.', 'Blank when the fm build cannot count tokens.', 'measured'),
    entry('detail', '1ST CHUNK', 'Average output tokens carried by the first streamed stdout chunk.', 'Shows what TTFT really measures: fm streams coarse deltas (about 20 tokens in the first chunk on macOS 27.2). Wide layout only.', 'measured'),
    entry('detail', 'PREFILL/S / PREFILL TOK/S', 'Prompt tokens divided by TTFT seconds.', 'Proxy: prefill is inferred from time to first chunk, not observed directly. Higher is better.', 'proxy'),
    entry('detail', 'DECODE/S / DECODE TOK/S', 'Output tokens that arrived after the first streamed delivery, summed over runs, divided by the summed generation time.', 'Derived and token-weighted, so long generations dominate short tails; requires streaming and token counts. Higher is better.', 'derived'),
    entry('detail', '2ND CHUNK', 'Delay between the first and second streamed stdout chunks, p50.', 'Lower is smoother startup. Chunk-based, not raw token telemetry.', 'proxy'),
    entry('detail', 'CHUNK P95', '95th percentile gap between consecutive streamed stdout chunks.', 'Proxy for decode smoothness at chunk granularity. Lower is smoother.', 'proxy'),
    entry('detail', 'E2E P99', '99th percentile end-to-end latency.', 'Lower is better; useful for worst-case UX.', 'measured'),
    entry('detail', 'E2E 95% CI', '95% confidence interval around mean E2E latency.', 'Blank with fewer than two successful samples; treat small samples carefully.', 'derived'),
    entry('detail', 'REPEAT', 'Share of repeated runs for a prompt that produced the most common normalized output hash.', 'Green 90%+, yellow 50%+, red below 50%. Blank when there are not repeated comparable outputs.', 'derived'),
    entry('detail', 'ATTEMPTS', 'Total fm invocations including retries.', 'Shown in reports; a retried run is still one measured result.', 'measured'),
    entry('detail', 'DESCRIPTION', 'Model description discovered from fm help.', '', 'measured'),
    entry('models', 'AVAILABLE', 'Whether fm models (fm available on older builds) reports the model as usable on this machine right now.', '', 'measured'),
    entry('models', 'IDENTITY', 'Model identity reported by fm models, for example AFM 3 Core Advanced.', 'Recorded in reports; compare warns when it changes between two runs.', 'measured'),
    entry('models', 'QUOTA', 'Quota information when the fm build exposes a quota command.', 'Column is omitted entirely when the installed fm has no quota command.', 'measured'),
    entry('metrics', 'SOURCE', 'How a metric is obtained: measured, proxy, derived, or controlled.', 'measured = observed directly; proxy = observed at coarser granularity; derived = computed from measured values.', 'measured'),
    entry('compact', 'GOOD / CV / TPOT / CHUNK', 'Compact output combines the same summary and detail metrics into model cards.', 'Same definitions and color rules as table columns.', 'derived'),
    entry('colors', 'GREEN', 'Passing, steadier, faster, or better within this benchmark context.', '', 'controlled'),
    entry('colors', 'YELLOW', 'Marginal, partial, near a budget, or middle-ranked within this benchmark context.', '', 'controlled'),
    entry('colors', 'RED', 'Failed budget, unstable, slower, lower, or worse within this benchmark context.', '', 'controlled'),
    entry('colors', 'MUTED', 'Unavailable model, skipped value, or descriptive text.', '', 'controlled')
  ];
}

export function renderLegend(options = {}) {
  const width = terminalWidth(options);
  const rows = legendEntries().map((item) => [
    item.table,
    item.column,
    item.kind || 'measured',
    item.definition,
    item.rule || '-'
  ]);

  if (options.compact || width < 88) {
    return renderCompactLegend(width);
  }

  return renderWrappedTable(['table', 'column', 'source', 'definition', 'rule'], rows, legendColumnWidths(width), options);
}

export function renderLatencyHistogram(results, options = {}) {
  const { ascii = false, color = false, width: termWidth = 80 } = options;
  const successes = results.filter((r) => r.ok && Number.isFinite(r.durationMs));
  if (successes.length === 0) return 'No successful results to histogram.';

  const values = successes.map((r) => r.durationMs).sort((a, b) => a - b);
  const min = values[0];
  const max = values[values.length - 1];

  if (min === max) {
    return `E2E latency histogram: all ${values.length} values = ${formatMs(min)}`;
  }

  const numBuckets = Math.min(20, Math.max(5, Math.floor((termWidth - 20) / 4)));
  const bucketSize = (max - min) / numBuckets;
  const counts = new Array(numBuckets).fill(0);

  for (const v of values) {
    const idx = Math.min(numBuckets - 1, Math.floor((v - min) / bucketSize));
    counts[idx] += 1;
  }

  const maxCount = Math.max(...counts);
  const barWidth = Math.max(1, termWidth - 24);
  const lines = [];
  const bar = ascii ? '#' : '█';
  const halfBar = ascii ? ':' : '▌';

  lines.push(`E2E latency distribution (n=${values.length}, ${formatMs(min)}…${formatMs(max)}):`);

  for (let i = 0; i < numBuckets; i += 1) {
    const bucketMin = min + i * bucketSize;
    const bucketMax = bucketMin + bucketSize;
    const label = `${formatMs(bucketMin)}`.padStart(7);
    const fillLength = Math.round((counts[i] / maxCount) * barWidth);
    const filled = bar.repeat(fillLength);
    const countStr = counts[i] > 0 ? String(counts[i]) : '';
    lines.push(`${label} ${filled}${countStr ? ` ${countStr}` : ''}`);
  }

  return lines.join('\n');
}

export function formatMs(value) {
  if (value == null || !Number.isFinite(value)) return '-';
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
  return `${Math.round(value)}ms`;
}

export function formatNumber(value, digits = 1) {
  if (value == null || !Number.isFinite(value)) return '-';
  if (Math.abs(value) >= 100) return Math.round(value).toLocaleString('en-US');
  return value.toFixed(digits);
}

export function formatPercent(value, digits = 0) {
  if (value == null || !Number.isFinite(value)) return '-';
  return `${(value * 100).toFixed(digits)}%`;
}

export function renderSummaryTable(summary, options = {}) {
  const mode = options.mode || 'wide';
  const hasGoodput = summary.some((item) => item.goodputRate != null);
  const ranks = rankSummary(summary);
  const rows = summary.map((item) => {
    const status = item.available ? (item.failures > 0 ? 'partial' : 'ok') : 'skipped';
    const tones = metricTones(item, ranks, options.slo);
    const base = [
      cell(formatConcurrency(item.concurrency)),
      cell(item.model, item.available ? null : 'muted'),
      cell(status, statusTone(status)),
      cell(item.attempted ? `${item.successes}/${item.attempted}` : '-', item.failures > 0 ? 'yellow' : item.available ? 'green' : 'muted'),
      cell(formatPercent(item.successRate), percentTone(item.successRate, 0.95, 1)),
      cell(formatPercent(item.goodputRate), percentTone(item.goodputRate, 0.8, 1)),
      cell(formatNumber(item.goodputRps), tones.goodputRps),
      cell(formatMs(item.ttft.p50), tones.ttft),
      cell(formatMs(item.ttft.p95), tones.ttftP95),
      cell(formatMs(item.latency.p50), tones.e2e),
      cell(formatMs(item.latency.p95), tones.e2eP95),
      cell(formatNumber(item.tokensPerSecond.avg), tones.userTps),
      cell(formatNumber(item.outputTokenThroughput), tones.systemTps),
      cell(formatNumber(item.rps), tones.rps),
      cell(formatPercent(stabilityCv(item)), cvTone(stabilityCv(item))),
      cell(item.available ? '' : cleanReason(item.skippedReason), item.available ? null : 'yellow')
    ];

    if (mode === 'medium') {
      const medium = [
        base[0],
        base[1],
        base[2],
        base[3]
      ];
      if (hasGoodput) medium.push(base[5], base[6]);
      medium.push(base[7], base[9], base[10], base[11], base[12], base[14], base[15]);
      return medium;
    }

    const wide = [base[0], base[1], base[2], base[3], base[4]];
    if (hasGoodput) wide.push(base[5], base[6]);
    wide.push(
      base[7],
      base[8],
      base[9],
      base[10],
      cell(formatMs(item.tpot.p50), tones.tpot),
      cell(formatMs(item.tpot.p95), tones.tpotP95),
      base[11],
      base[12],
      base[13],
      base[14],
      base[15]
    );
    return wide;
  });

  const mediumHeaders = ['c', 'model', 'status', 'ok', 'good', 'good rps', 'ttft', 'e2e', 'e2e p95', 'user/s', 'sys/s', 'cv', 'note'];
  const wideHeaders = ['c', 'model', 'status', 'ok/runs', 'succ', 'good', 'good rps', 'ttft', 'ttft p95', 'e2e', 'e2e p95', 'tpot', 'tpot p95', 'user t/s', 'sys t/s', 'rps', 'cv', 'note'];
  const headers = mode === 'medium'
    ? (hasGoodput ? mediumHeaders : mediumHeaders.filter((header) => header !== 'good' && header !== 'good rps'))
    : (hasGoodput ? wideHeaders : wideHeaders.filter((header) => header !== 'good' && header !== 'good rps'));

  return renderTable(headers, rows, { ...options, maxCellWidth: mode === 'medium' ? 24 : 52, wrapColumns: ['note'] });
}

export function renderDetailTable(summary, options = {}) {
  const mode = options.mode || 'wide';
  const ranks = rankSummary(summary);
  const rows = summary.map((item) => {
    const tones = metricTones(item, ranks, options.slo);
    const base = [
      cell(formatConcurrency(item.concurrency)),
      cell(item.model, item.available ? null : 'muted'),
      cell(formatNumber(item.promptTokens.avg, 0)),
      cell(formatNumber(item.outputTokens.avg, 0)),
      cell(formatNumber(item.prefillTokensPerSecond?.avg), tones.prefillTps),
      cell(formatNumber(decodeRate(item)), tones.decodeTps),
      cell(formatMs(item.secondChunk?.p50), tones.secondChunk),
      cell(formatMs(item.chunkGap?.p95), tones.chunkGapP95),
      cell(formatMs(item.latency.p99), tones.e2eP99),
      cell(formatRangeMs(item.latency.ci95Low, item.latency.ci95High), cvTone(stabilityCv(item))),
      cell(formatPercent(item.repeatability), percentTone(item.repeatability, 0.5, 0.9)),
      cell(item.description || '-', 'muted'),
      cell(formatNumber(item.firstChunkTokens?.avg, 0))
    ];

    if (mode === 'medium') {
      return [base[0], base[1], base[2], base[3], base[4], base[5], base[7], base[8], base[10]];
    }

    return [base[0], base[1], base[2], base[3], base[12], ...base.slice(4, 12)];
  });

  const headers = mode === 'medium'
    ? ['c', 'model', 'in avg', 'out avg', 'prefill/s', 'decode/s', 'chunk p95', 'e2e p99', 'repeat']
    : [
      'c',
      'model',
      'in tok avg',
      'out tok avg',
      '1st chunk',
      'prefill tok/s',
      'decode tok/s',
      '2nd chunk',
      'chunk p95',
      'e2e p99',
      'e2e 95% ci',
      'repeat',
      'description'
    ];

  return renderTable(headers, rows, { ...options, maxCellWidth: mode === 'medium' ? 34 : 52, wrapColumns: ['description'] });
}

export function renderCompactSummary(summary, options = {}) {
  const width = options.width || 80;
  const separator = options.ascii ? '-' : '─';
  const lines = [];
  const ranks = rankSummary(summary);

  for (const item of summary) {
    const status = item.available ? (item.failures > 0 ? 'partial' : 'ok') : 'skipped';
    const title = `${item.model} c${formatConcurrency(item.concurrency)} ${status} ${item.attempted ? `${item.successes}/${item.attempted}` : '-'}`;
    lines.push(toneText(truncate(title, width), statusTone(status), options));

    if (item.available) {
      const goodput = item.goodputRate == null ? '' : ` | good ${formatPercent(item.goodputRate)}`;
      const tones = metricTones(item, ranks, options.slo);
      lines.push(toneText(truncate(`  TTFT ${formatMs(item.ttft.p50)} p95 ${formatMs(item.ttft.p95)} | E2E ${formatMs(item.latency.p50)} p95 ${formatMs(item.latency.p95)} p99 ${formatMs(item.latency.p99)}`, width), worstTone(tones.ttft, tones.e2e, tones.e2eP95), options));
      lines.push(toneText(truncate(`  user ${formatNumber(item.tokensPerSecond.avg)} tok/s | system ${formatNumber(item.outputTokenThroughput)} tok/s | RPS ${formatNumber(item.rps)} | CV ${formatPercent(stabilityCv(item))}${goodput}`, width), worstTone(tones.userTps, tones.systemTps, cvTone(stabilityCv(item)), percentTone(item.goodputRate, 0.8, 1)), options));
      lines.push(toneText(truncate(`  prefill ${formatNumber(item.prefillTokensPerSecond?.avg)} tok/s | TPOT ${formatMs(item.tpot.p50)} | chunk p95 ${formatMs(item.chunkGap?.p95)}`, width), worstTone(tones.prefillTps, tones.tpot, tones.chunkGapP95), options));
      lines.push(toneText(truncate(`  in/out ${formatNumber(item.promptTokens.avg, 0)}/${formatNumber(item.outputTokens.avg, 0)} tok avg | repeat ${formatPercent(item.repeatability)}`, width), percentTone(item.repeatability, 0.5, 0.9), options));
    } else {
      lines.push(toneText(truncate(`  ${compactReason(item.skippedReason)}`, width), 'yellow', options));
    }
    lines.push(separator.repeat(Math.min(width, 72)));
  }

  if (lines.at(-1)?.startsWith(separator)) lines.pop();
  return lines.join('\n');
}

export function renderModelsTable(models, options = {}) {
  const width = terminalWidth(options);
  const compact = options.compact || width < 88;
  if (compact) {
    return models.map((model) => {
      const status = model.available ? 'yes' : 'no';
      const detail = model.available ? (model.identity || model.description) : model.reason;
      return `${model.name} ${toneText(status, model.available ? 'green' : 'yellow', options)} ${compactReason(detail || model.description || '-')}`;
    }).join('\n');
  }

  const quotaSupported = options.capabilities
    ? Boolean(options.capabilities.features?.quota)
    : models.some((model) => model.quotaSupported === true || (model.quota != null && model.quota !== ''));
  const hasIdentity = models.some((model) => model.identity);
  const base = (model) => {
    const cells = [
      cell(model.name),
      cell(model.available ? 'yes' : 'no', model.available ? 'green' : 'yellow')
    ];
    if (hasIdentity) cells.push(model.identity || '-');
    cells.push(model.description || '-');
    return cells;
  };
  const leading = hasIdentity ? ['model', 'available', 'identity', 'description'] : ['model', 'available', 'description'];

  if (!quotaSupported) {
    return renderTable([...leading, 'notes'], models.map((model) => [
      ...base(model),
      cleanReason(model.reason || '-')
    ]), { ...options, wrapColumns: ['identity', 'description', 'notes'] });
  }

  return renderTable([...leading, 'quota'], models.map((model) => [
    ...base(model),
    cleanReason(model.quota || model.reason || '-')
  ]), { ...options, wrapColumns: ['identity', 'description', 'quota'] });
}

/**
 * `fm-bench models` body: fm capability summary, then the model table.
 * Unsupported capabilities are stated up front so a missing quota column or
 * blank metric never looks like a bug.
 */
export function renderModelsReport(models, options = {}) {
  const capabilities = options.capabilities;
  const lines = [];
  if (capabilities) {
    lines.push(`fm        ${capabilities.bin}${capabilities.digest ? `  help ${capabilities.digest}` : ''}${capabilities.ok ? '' : '  (no commands detected)'}`);
    lines.push(`commands  ${capabilities.commands.join(', ') || 'none detected'}`);
    lines.push(`features  ${formatCapabilitySummary(capabilities)}`);
    for (const warning of capabilities.warnings) {
      lines.push(`warn      ${warning}`);
    }
    lines.push('');
  }
  lines.push(renderModelsTable(models, options));
  return lines.join('\n');
}

/**
 * Run-to-run CV for a summary row. Reports written before `stabilityCv`
 * existed only have the suite-wide `latency.cv`.
 */
export function stabilityCv(item) {
  return Object.hasOwn(item, 'stabilityCv') ? item.stabilityCv : item.latency?.cv ?? null;
}

/**
 * Token-weighted decode rate for a summary row. Reports written before
 * `decodeThroughput` existed only have the mean of per-run rates.
 */
export function decodeRate(item) {
  return Object.hasOwn(item, 'decodeThroughput') ? item.decodeThroughput : item.decodeTokensPerSecond?.avg ?? null;
}

function formatRangeMs(low, high) {
  if (low == null || high == null || !Number.isFinite(low) || !Number.isFinite(high)) return '-';
  return `${formatMs(Math.max(0, low))}..${formatMs(Math.max(0, high))}`;
}

function formatConcurrency(value) {
  return value == null ? '1' : String(value);
}

function terminalWidth(options = {}) {
  return options.width || process.stdout.columns || 120;
}

function formatSlo(slo = {}) {
  const parts = [];
  if (slo.ttftMs) parts.push(`TTFT<=${formatMs(slo.ttftMs)}`);
  if (slo.e2eMs) parts.push(`E2E<=${formatMs(slo.e2eMs)}`);
  if (slo.tpotMs) parts.push(`TPOT<=${formatMs(slo.tpotMs)}`);
  return parts.length ? `SLO ${parts.join(',')}` : '';
}

function entry(table, column, definition, rule, kind = 'measured') {
  return {
    table,
    column,
    definition,
    rule,
    kind
  };
}

/**
 * Reasons why metric columns are blank. Keeps "unavailable" visible in table
 * output instead of leaving readers to guess why a column is empty.
 */
function unavailableMetricNotes(metrics) {
  if (!metrics) return [];
  const notes = [];
  const tokenMetric = metrics.promptTokens;
  if (tokenMetric && !tokenMetric.available) {
    notes.push(`${tokenMetric.label} unavailable — ${tokenMetric.unavailableReason}`);
  }
  const ttft = metrics.ttft;
  if (ttft && !ttft.available) {
    notes.push(`${ttft.label} unavailable — ${ttft.unavailableReason}`);
  }
  const quota = metrics.quota;
  if (quota && !quota.available) {
    notes.push(`${quota.label} unavailable — ${quota.unavailableReason}`);
  }
  return notes;
}

const ASCII_TABLE = {
  topLeft: '+',
  topJoin: '+',
  topRight: '+',
  midLeft: '+',
  midJoin: '+',
  midRight: '+',
  bottomLeft: '+',
  bottomJoin: '+',
  bottomRight: '+',
  horizontal: '-',
  vertical: '|'
};

const UNICODE_TABLE = {
  topLeft: '┌',
  topJoin: '┬',
  topRight: '┐',
  midLeft: '├',
  midJoin: '┼',
  midRight: '┤',
  bottomLeft: '└',
  bottomJoin: '┴',
  bottomRight: '┘',
  horizontal: '─',
  vertical: '│'
};

function rule(left, join, right, horizontal, widths) {
  return `${left}${widths.map((width) => horizontal.repeat(width + 2)).join(join)}${right}`;
}

function renderWrappedTable(headers, rows, widths, options = {}) {
  const ascii = Boolean(options.ascii);
  const style = ascii ? ASCII_TABLE : UNICODE_TABLE;
  const top = rule(style.topLeft, style.topJoin, style.topRight, style.horizontal, widths);
  const middle = rule(style.midLeft, style.midJoin, style.midRight, style.horizontal, widths);
  const bottom = rule(style.bottomLeft, style.bottomJoin, style.bottomRight, style.horizontal, widths);
  const headerLine = rowLine(headers.map((header) => truncate(header, widths[headers.indexOf(header)])), widths, style, true, options);
  const bodyLines = [];

  for (const row of rows) {
    const wrappedCells = row.map((value, index) => wrapText(formatCell(value), widths[index]));
    const height = Math.max(...wrappedCells.map((lines) => lines.length));
    for (let lineIndex = 0; lineIndex < height; lineIndex += 1) {
      bodyLines.push(rowLine(wrappedCells.map((lines) => lines[lineIndex] ?? ''), widths, style, false, options));
    }
  }

  return [top, headerLine, middle, ...bodyLines, bottom].join('\n');
}

function normalizeWrapColumns(headers, wrapColumns = []) {
  const normalized = new Set();
  for (const column of wrapColumns || []) {
    if (Number.isInteger(column)) {
      if (column >= 0 && column < headers.length) normalized.add(column);
      continue;
    }

    const index = headers.findIndex((header) => String(header).toLowerCase() === String(column).toLowerCase());
    if (index >= 0) normalized.add(index);
  }
  return normalized;
}

function fitTableWidths(headers, widths, wrapColumns, targetWidth) {
  if (!targetWidth || wrapColumns.size === 0 || renderedTableWidth(widths) <= targetWidth) return widths;

  const fitted = [...widths];
  const minimums = fitted.map((width, index) => (
    wrapColumns.has(index)
      ? Math.max(visibleLength(String(headers[index]).toUpperCase()), Math.min(12, width))
      : width
  ));
  let excess = renderedTableWidth(fitted) - targetWidth;

  while (excess > 0) {
    const candidates = [...wrapColumns]
      .filter((index) => fitted[index] > minimums[index])
      .sort((a, b) => fitted[b] - fitted[a]);
    if (candidates.length === 0) break;

    for (const index of candidates) {
      if (excess <= 0) break;
      fitted[index] -= 1;
      excess -= 1;
    }
  }

  return fitted;
}

function renderedTableWidth(widths) {
  return widths.reduce((sum, width) => sum + width, 0) + (widths.length * 3) + 1;
}

function wrappedRowLines(row, widths, style, wrapColumns, options = {}) {
  const wrappedCells = row.map((value, index) => {
    const normalized = normalizeCell(value);
    return {
      tone: normalized.tone,
      lines: wrapColumns.has(index) ? wrapText(normalized.text, widths[index]) : [normalized.text]
    };
  });
  const height = Math.max(...wrappedCells.map((item) => item.lines.length));
  const lines = [];

  for (let lineIndex = 0; lineIndex < height; lineIndex += 1) {
    lines.push(rowLine(wrappedCells.map((item) => cell(item.lines[lineIndex] ?? '', item.tone)), widths, style, false, options));
  }

  return lines;
}

function rowLine(row, widths, style, header = false, options = {}) {
  return `${style.vertical}${row.map((cell, index) => {
    const normalized = header ? { text: String(cell).toUpperCase(), tone: 'header' } : normalizeCell(cell);
    const value = normalized.text;
    const padded = pad(value, widths[index], !header && isNumericCell(value));
    return ` ${toneText(padded, normalized.tone, options)} `;
  }).join(style.vertical)}${style.vertical}`;
}

function cell(text, tone = null) {
  return { text, tone };
}

function normalizeCell(value) {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'text')) {
    return {
      text: formatCell(value.text),
      tone: value.tone || null
    };
  }
  return {
    text: formatCell(value),
    tone: null
  };
}

function formatCell(value) {
  if (value == null) return '';
  // Terminal output carries prompt text, captured model output, and fm
  // diagnostics. Strip ANSI escapes and control characters so they cannot
  // corrupt the table layout or emit terminal control sequences.
  return stripAnsi(String(value)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function pad(value, width, left = false) {
  const length = visibleLength(value);
  const padding = ' '.repeat(Math.max(0, width - length));
  return left ? `${padding}${value}` : `${value}${padding}`;
}

function isNumericCell(value) {
  return /^-?$|^[\d,.]+(?:ms|s|%)?$/.test(value);
}

function visibleLength(value) {
  return stripAnsi(value).length;
}

function cleanReason(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function compactReason(value) {
  const clean = cleanReason(value);
  if (clean.length <= 58) return clean;
  return `${clean.slice(0, 55)}...`;
}

function renderCompactLegend(width) {
  const lines = [];
  for (const item of legendEntries()) {
    lines.push(...wrapText(`${item.table.toUpperCase()} ${item.column} (${item.kind || 'measured'})`, width));
    lines.push(...wrapText(`  Definition: ${item.definition}`, width));
    if (item.rule) {
      lines.push(...wrapText(`  Rule: ${item.rule}`, width));
    }
    lines.push('');
  }
  if (lines.at(-1) === '') lines.pop();
  return lines.join('\n');
}

function legendColumnWidths(width) {
  const available = Math.max(40, width - 16);
  const tableWidth = 7;
  const columnWidth = Math.min(25, Math.max(18, Math.floor(available * 0.22)));
  const sourceWidth = 11;
  const remaining = Math.max(32, available - tableWidth - columnWidth - sourceWidth);
  const definitionWidth = Math.max(18, Math.floor(remaining * 0.58));
  const ruleWidth = Math.max(14, remaining - definitionWidth);
  return [tableWidth, columnWidth, sourceWidth, definitionWidth, ruleWidth];
}

function wrapText(value, width) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return [''];
  if (width <= 1) return [text];

  const lines = [];
  let current = '';
  for (const rawWord of text.split(' ')) {
    const pieces = splitLongWord(rawWord, width);
    for (const word of pieces) {
      if (!current) {
        current = word;
      } else if (visibleLength(`${current} ${word}`) <= width) {
        current = `${current} ${word}`;
      } else {
        lines.push(current);
        current = word;
      }
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

function splitLongWord(word, width) {
  if (visibleLength(word) <= width) return [word];
  const pieces = [];
  for (let index = 0; index < word.length; index += width) {
    pieces.push(word.slice(index, index + width));
  }
  return pieces;
}

function truncate(value, width) {
  const text = String(value ?? '');
  if (visibleLength(text) <= width) return text;
  if (width <= 1) return '…';
  return `${text.slice(0, width - 1)}…`;
}

const TONES = {
  header: ['\x1b[1m', '\x1b[0m'],
  green: ['\x1b[32m', '\x1b[0m'],
  yellow: ['\x1b[33m', '\x1b[0m'],
  red: ['\x1b[31m', '\x1b[0m'],
  muted: ['\x1b[2m', '\x1b[0m']
};

function toneText(text, tone, options = {}) {
  if (!options.color || !tone || !TONES[tone]) return text;
  const [open, close] = TONES[tone];
  return `${open}${text}${close}`;
}

function statusTone(status) {
  if (status === 'ok') return 'green';
  if (status === 'partial') return 'yellow';
  if (status === 'skipped') return 'yellow';
  return 'red';
}

function percentTone(value, yellowAt, greenAt) {
  if (value == null || !Number.isFinite(value)) return null;
  if (value >= greenAt) return 'green';
  if (value >= yellowAt) return 'yellow';
  return 'red';
}

function cvTone(value) {
  if (value == null || !Number.isFinite(value)) return null;
  if (value <= 0.1) return 'green';
  if (value <= 0.25) return 'yellow';
  return 'red';
}

function thresholdTone(value, threshold) {
  if (value == null || !Number.isFinite(value) || !Number.isFinite(threshold)) return null;
  if (value <= threshold * 0.8) return 'green';
  if (value <= threshold) return 'yellow';
  return 'red';
}

function rankSummary(summary) {
  return {
    ttft: collectMetric(summary, (item) => item.ttft?.p50),
    ttftP95: collectMetric(summary, (item) => item.ttft?.p95),
    e2e: collectMetric(summary, (item) => item.latency?.p50),
    e2eP95: collectMetric(summary, (item) => item.latency?.p95),
    e2eP99: collectMetric(summary, (item) => item.latency?.p99),
    tpot: collectMetric(summary, (item) => item.tpot?.p50),
    tpotP95: collectMetric(summary, (item) => item.tpot?.p95),
    secondChunk: collectMetric(summary, (item) => item.secondChunk?.p50),
    chunkGapP95: collectMetric(summary, (item) => item.chunkGap?.p95),
    userTps: collectMetric(summary, (item) => item.tokensPerSecond?.avg),
    systemTps: collectMetric(summary, (item) => item.outputTokenThroughput),
    totalTps: collectMetric(summary, (item) => item.totalTokenThroughput),
    rps: collectMetric(summary, (item) => item.rps),
    goodputRps: collectMetric(summary, (item) => item.goodputRps),
    decodeTps: collectMetric(summary, decodeRate),
    prefillTps: collectMetric(summary, (item) => item.prefillTokensPerSecond?.avg)
  };
}

function collectMetric(summary, accessor) {
  return summary.map(accessor).filter((value) => Number.isFinite(value));
}

function rankTone(value, values) {
  if (value == null || !Number.isFinite(value) || values.length === 0) return null;
  if (values.length === 1) return 'green';
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return 'green';
  const position = (value - min) / (max - min);
  if (position >= 0.67) return 'green';
  if (position >= 0.34) return 'yellow';
  return 'red';
}

function rankToneLower(value, values) {
  if (value == null || !Number.isFinite(value) || values.length === 0) return null;
  if (values.length === 1) return 'green';
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return 'green';
  const position = (max - value) / (max - min);
  if (position >= 0.67) return 'green';
  if (position >= 0.34) return 'yellow';
  return 'red';
}

function metricTones(item, ranks, slo = {}) {
  return {
    ttft: thresholdTone(item.ttft?.p50, slo.ttftMs) || rankToneLower(item.ttft?.p50, ranks.ttft),
    ttftP95: thresholdTone(item.ttft?.p95, slo.ttftMs) || rankToneLower(item.ttft?.p95, ranks.ttftP95),
    e2e: thresholdTone(item.latency?.p50, slo.e2eMs) || rankToneLower(item.latency?.p50, ranks.e2e),
    e2eP95: thresholdTone(item.latency?.p95, slo.e2eMs) || rankToneLower(item.latency?.p95, ranks.e2eP95),
    e2eP99: thresholdTone(item.latency?.p99, slo.e2eMs) || rankToneLower(item.latency?.p99, ranks.e2eP99),
    tpot: thresholdTone(item.tpot?.p50, slo.tpotMs) || rankToneLower(item.tpot?.p50, ranks.tpot),
    tpotP95: thresholdTone(item.tpot?.p95, slo.tpotMs) || rankToneLower(item.tpot?.p95, ranks.tpotP95),
    secondChunk: rankToneLower(item.secondChunk?.p50, ranks.secondChunk),
    chunkGapP95: rankToneLower(item.chunkGap?.p95, ranks.chunkGapP95),
    userTps: rankTone(item.tokensPerSecond?.avg, ranks.userTps),
    systemTps: rankTone(item.outputTokenThroughput, ranks.systemTps),
    totalTps: rankTone(item.totalTokenThroughput, ranks.totalTps),
    rps: rankTone(item.rps, ranks.rps),
    goodputRps: goodputRpsTone(item, ranks.goodputRps),
    decodeTps: rankTone(decodeRate(item), ranks.decodeTps),
    prefillTps: rankTone(item.prefillTokensPerSecond?.avg, ranks.prefillTps)
  };
}

function worstTone(...tones) {
  if (tones.includes('red')) return 'red';
  if (tones.includes('yellow')) return 'yellow';
  if (tones.includes('green')) return 'green';
  return null;
}

function goodputRpsTone(item, values) {
  const passTone = percentTone(item.goodputRate, 0.8, 1);
  if (passTone && passTone !== 'green') return passTone;
  return rankTone(item.goodputRps, values) || passTone;
}
