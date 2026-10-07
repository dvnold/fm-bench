import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { inspectModels, runBenchmark } from './bench.js';
import { diffReports, renderCompareReport } from './compare.js';
import { renderHtmlReport } from './export.js';
import { getLicenseStatus } from './fm.js';
import { formatCapabilitySummary } from './metrics.js';
import { validateReport } from './schema.js';
import { loadHistory, renderHistoryReport } from './history.js';
import { detectMacosVersion, evaluateMacosSupport, formatMacosRequirementError, MIN_SUPPORTED_MACOS, parseMacosVersion } from './macos.js';
import { runProcess } from './process.js';
import { createProgress } from './progress.js';
import { flattenResults, toCsv, writeReport } from './report.js';
import { parseBatteryOutput, parseThermalOutput } from './system.js';
import { legendEntries, renderBenchmarkReport, renderLatencyHistogram, renderLegend, renderModelsReport } from './table.js';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json');

/** Usage / environment error: bad flags, missing arguments, unsupported host. */
function usageError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

/** Operational failure: invalid report data, failed benchmark gate. */
function operationalError(message) {
  const error = new Error(message);
  error.exitCode = 1;
  return error;
}

// One unmeasured call per model absorbs the cold model load, which otherwise
// dominates the first measured run (several hundred ms on Apple silicon).
const DEFAULT_WARMUP = 1;

const COMMANDS = ['run', 'models', 'doctor', 'legend', 'metrics', 'compare', 'history', 'validate', 'export', 'help'];

const KNOWN_OPTIONS = [
  '--help', '--version', '--model', '--models', '--runs', '--warmup', '--concurrency', '--sweep-concurrency',
  '--request-rate', '--ramp-up-ms', '--timeout', '--timeout-ms', '--slo-ttft-ms', '--slo-e2e-ms', '--slo-tpot-ms',
  '--prompt', '--prompt-file', '--profile', '--instructions', '--fm-bin', '--use-case', '--guardrails',
  '--greedy', '--no-greedy', '--stream', '--no-stream', '--json', '--csv', '--format', '--ascii', '--color',
  '--no-color', '--progress', '--no-progress', '--compact', '--width', '--histogram', '--export-html', '--strict',
  '--out', '--output-dir', '--capture-output', '--available-only', '--fail-fast', '--retry', '--ci', '--tag',
  '--note', '--verbose'
];

/** Closest candidate within a small edit distance, or null. */
function closestMatch(input, candidates) {
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = editDistance(input, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  const limit = input.replace(/^-+/, '').length <= 6 ? 1 : 2;
  return bestDistance > 0 && bestDistance <= limit ? best : null;
}

/** Optimal string alignment distance: an adjacent swap counts as one edit. */
function editDistance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
      }
    }
  }
  return rows[a.length][b.length];
}

export async function runCli(argv = process.argv.slice(2), env = {}) {
  const parsed = parseArgs(argv);

  if (parsed.help) {
    console.log(helpText());
    return;
  }

  if (parsed.versionOnly) {
    console.log(packageJson.version);
    return;
  }

  await assertSupportedMacos(parsed, env);

  if (parsed.command === 'legend') {
    if (parsed.format === 'json') {
      console.log(JSON.stringify(legendEntries(), null, 2));
    } else if (parsed.format === 'csv') {
      console.log(toCsv(legendEntries()));
    } else {
      console.log(renderLegend(renderOptions(parsed)));
    }
    return;
  }

  if (parsed.command === 'doctor') {
    await runDoctor(parsed);
    return;
  }

  if (parsed.command === 'compare') {
    await runCompare(parsed, renderOptions(parsed));
    return;
  }

  if (parsed.command === 'validate') {
    await runValidate(parsed);
    return;
  }

  if (parsed.command === 'export') {
    await runExport(parsed);
    return;
  }

  if (parsed.command === 'history') {
    await runHistory(parsed, renderOptions(parsed));
    return;
  }

  if (parsed.command === 'models') {
    const inspection = await inspectModels(parsed);
    if (parsed.format === 'json') {
      // Shape stays a plain array so existing automation keeps working;
      // full capability detail lives in `doctor --json` and in report payloads.
      console.log(JSON.stringify(inspection.models, null, 2));
    } else {
      console.log(renderModelsReport(inspection.models, {
        ...renderOptions(parsed),
        capabilities: inspection.capabilities
      }));
    }
    return;
  }

  if (parsed.ci) {
    if (parsed.color === 'auto') parsed.color = 'never';
    if (parsed.progress === 'auto') parsed.progress = 'never';
  }

  const progress = createProgress({
    ...renderOptions(parsed),
    enabled: resolveProgress(parsed),
    stream: process.stderr
  });
  let payload;
  try {
    payload = await runBenchmark({
      ...parsed,
      version: packageJson.version,
      onProgress: (event) => progress.update(event)
    });
  } finally {
    progress.stop();
  }

  if (parsed.format === 'json') {
    console.log(JSON.stringify(payload, null, 2));
  } else if (parsed.format === 'csv') {
    console.log(toCsv(flattenResults(payload.results)));
  } else {
    console.log(renderBenchmarkReport(payload, renderOptions(parsed)));
    if (parsed.histogram) {
      console.log();
      console.log(renderLatencyHistogram(payload.results, renderOptions(parsed)));
    }
    if (parsed.verbose) {
      console.log();
      console.log(toCsv(flattenResults(payload.results)));
    }
  }

  if (parsed.out) {
    const reportFormat = parsed.out.endsWith('.csv') ? 'csv'
      : parsed.out.endsWith('.html') ? 'html'
        : 'json';
    const written = await writeReport(parsed.out, payload, reportFormat);
    if (parsed.format !== 'json') {
      console.error(`Saved ${reportFormat.toUpperCase()} report to ${written}`);
    }
  }

  if (parsed.outputDir) {
    const stamp = payload.startedAt.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const firstModel = parsed.models?.flatMap((m) => String(m).split(',')).map((m) => m.trim()).filter(Boolean)[0] || 'all';
    const modelSlug = firstModel.replace(/[^a-z0-9]/gi, '_');
    const tagSlug = parsed.tags?.length ? `_${parsed.tags.join('-').replace(/[^a-z0-9-]/gi, '_')}` : '';
    const base = `fm-bench_${stamp}_${modelSlug}${tagSlug}`;
    const jsonPath = `${parsed.outputDir}/${base}.json`;
    const written = await writeReport(jsonPath, payload, 'json');
    if (parsed.exportHtml) {
      const htmlPath = `${parsed.outputDir}/${base}.html`;
      await writeReport(htmlPath, payload, 'html');
      if (parsed.format !== 'json') {
        console.error(`Saved HTML report to ${htmlPath}`);
      }
    }
    if (parsed.format !== 'json') {
      console.error(`Saved JSON report to ${written}`);
    }
  }

  if (parsed.ci) {
    const ciResult = evaluateCi(payload);
    if (!ciResult.passed) {
      const reasons = ciResult.reasons.join('; ');
      console.error(`fm-bench ci: FAIL — ${reasons}`);
      throw operationalError(`CI checks failed: ${reasons}`);
    }
    console.error(`fm-bench ci: PASS`);
  }
}

// Offline report tools stay usable anywhere. `doctor` is also allowed through so
// it can print the detected version and the latest supported macOS when the host
// is too old. Only commands that launch `fm` benchmarks are hard-gated.
const SKIP_MACOS_GATE = new Set(['compare', 'history', 'validate', 'export', 'legend', 'doctor']);

async function assertSupportedMacos(parsed, env = {}) {
  if (SKIP_MACOS_GATE.has(parsed.command)) return;

  // The gate guards the default fm discovery path, because Apple only ships the
  // CLI from macOS 27. An explicitly configured binary is honoured on any host;
  // the capability probe below still fails with exit 2 if it is unusable.
  if (parsed.fmBin || env.FM_BIN || process.env.FM_BIN) return;

  const evaluation = evaluateMacosSupport(
    env.platform ?? process.platform,
    parseMacosVersion(await detectMacosVersion(env))
  );
  if (evaluation.supported) return;

  const error = usageError(formatMacosRequirementError(evaluation));
  throw error;
}

function evaluateCi(payload) {
  const reasons = [];
  const totalFailed = payload.summary.reduce((sum, item) => sum + item.failures, 0);
  if (totalFailed > 0) {
    reasons.push(`${totalFailed} run(s) failed`);
  }

  const hasSlo = payload.options?.slo && (
    payload.options.slo.ttftMs || payload.options.slo.e2eMs || payload.options.slo.tpotMs
  );
  if (hasSlo) {
    for (const item of payload.summary) {
      if (!item.available) continue;
      if (item.goodputRate != null && item.goodputRate < 1) {
        const pct = Math.round((1 - item.goodputRate) * 100);
        reasons.push(`${item.model} c${item.concurrency ?? 1}: ${pct}% of runs violated SLO`);
      }
    }
  }

  return {
    passed: reasons.length === 0,
    reasons
  };
}

export function parseArgs(argv) {
  const options = {
    command: 'run',
    compareFiles: [],
    models: [],
    prompts: [],
    runs: 1,
    warmup: DEFAULT_WARMUP,
    concurrency: 1,
    sweepConcurrency: [],
    requestRate: null,
    rampUpMs: 0,
    timeoutMs: 60_000,
    profile: 'standard',
    greedy: true,
    stream: true,
    sloTtftMs: null,
    sloE2eMs: null,
    sloTpotMs: null,
    format: 'table',
    captureOutput: false,
    availableOnly: false,
    failFast: false,
    retry: 0,
    ci: false,
    tags: [],
    note: null,
    verbose: false,
    ascii: false,
    color: 'auto',
    progress: 'auto',
    compact: false,
    width: null,
    histogram: false,
    exportHtml: false,
    strictCompare: false,
    validateFiles: []
  };

  const args = [...argv];
  if (args[0] && !args[0].startsWith('-') && COMMANDS.includes(args[0])) {
    options.command = args.shift();
  } else if (args[0] && /^[a-z]{3,}$/.test(args[0])) {
    // A bare word is a prompt, but one that is a near miss for a command is
    // almost always a typo; benchmarking "modles" as a prompt helps nobody.
    const suggestion = closestMatch(args[0], COMMANDS);
    if (suggestion) {
      throw usageError(`Unknown command "${args[0]}". Did you mean "${suggestion}"? To benchmark it as a prompt, use: fm-bench -- ${args[0]}`);
    }
  }

  if (options.command === 'metrics') {
    options.command = 'legend';
  }

  if (options.command === 'help') {
    options.help = true;
    return options;
  }

  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '--version':
        options.versionOnly = true;
        break;
      case '-m':
      case '--model':
      case '--models':
        options.models.push(requireValue(arg, args));
        break;
      case '-r':
      case '--runs':
        options.runs = parsePositiveInt(requireValue(arg, args), arg);
        break;
      case '--warmup':
        options.warmup = parseNonNegativeInt(requireValue(arg, args), arg);
        break;
      case '-c':
      case '--concurrency':
        options.concurrency = parsePositiveInt(requireValue(arg, args), arg);
        break;
      case '--sweep-concurrency':
        options.sweepConcurrency = parsePositiveIntList(requireValue(arg, args), arg);
        if (options.sweepConcurrency.length > 0) {
          options.concurrency = options.sweepConcurrency[0];
        }
        break;
      case '--request-rate':
        options.requestRate = parsePositiveNumber(requireValue(arg, args), arg);
        break;
      case '--ramp-up-ms':
        options.rampUpMs = parseNonNegativeInt(requireValue(arg, args), arg);
        break;
      case '--timeout':
      case '--timeout-ms':
        options.timeoutMs = parsePositiveInt(requireValue(arg, args), arg);
        break;
      case '--slo-ttft-ms':
        options.sloTtftMs = parsePositiveInt(requireValue(arg, args), arg);
        break;
      case '--slo-e2e-ms':
        options.sloE2eMs = parsePositiveInt(requireValue(arg, args), arg);
        break;
      case '--slo-tpot-ms':
        options.sloTpotMs = parsePositiveInt(requireValue(arg, args), arg);
        break;
      case '-p':
      case '--prompt':
        options.prompts.push(requireValue(arg, args));
        break;
      case '--prompt-file':
        options.promptFile = requireValue(arg, args);
        break;
      case '--profile':
        options.profile = requireValue(arg, args);
        if (!['quick', 'standard', 'interactive', 'throughput', 'client', 'stress', 'reasoning', 'coding', 'creative'].includes(options.profile)) {
          throw usageError('--profile must be one of: quick, standard, interactive, throughput, client, stress, reasoning, coding, creative');
        }
        break;
      case '-i':
      case '--instructions':
        options.instructions = requireValue(arg, args);
        break;
      case '--fm-bin':
        options.fmBin = requireValue(arg, args);
        break;
      case '--use-case':
        options.useCase = requireValue(arg, args);
        break;
      case '--guardrails':
        options.guardrails = requireValue(arg, args);
        break;
      case '--greedy':
        options.greedy = true;
        break;
      case '--no-greedy':
        options.greedy = false;
        break;
      case '--stream':
        options.stream = true;
        break;
      case '--no-stream':
        options.stream = false;
        break;
      case '--json':
        options.format = 'json';
        break;
      case '--csv':
        options.format = 'csv';
        break;
      case '--format':
        options.format = requireValue(arg, args);
        if (!['table', 'json', 'csv'].includes(options.format)) {
          throw usageError('--format must be one of: table, json, csv');
        }
        break;
      case '--ascii':
        options.ascii = true;
        break;
      case '--color':
        options.color = 'always';
        break;
      case '--no-color':
        options.color = 'never';
        break;
      case '--progress':
        options.progress = 'always';
        break;
      case '--no-progress':
        options.progress = 'never';
        break;
      case '--compact':
        options.compact = true;
        break;
      case '--width':
        options.width = parsePositiveInt(requireValue(arg, args), arg);
        break;
      case '--histogram':
        options.histogram = true;
        break;
      case '--export-html':
        options.exportHtml = true;
        break;
      case '--strict':
        options.strictCompare = true;
        break;
      case '-o':
      case '--out':
        options.out = requireValue(arg, args);
        break;
      case '--output-dir':
        options.outputDir = requireValue(arg, args);
        break;
      case '--capture-output':
        options.captureOutput = true;
        break;
      case '--available-only':
        options.availableOnly = true;
        break;
      case '--fail-fast':
        options.failFast = true;
        break;
      case '--retry':
        options.retry = parseNonNegativeInt(requireValue(arg, args), arg);
        break;
      case '--ci':
        options.ci = true;
        break;
      case '--tag':
        options.tags.push(requireValue(arg, args));
        break;
      case '--note':
        options.note = requireValue(arg, args);
        break;
      case '-v':
      case '--verbose':
        options.verbose = true;
        break;
      case '--':
        if (args.length > 0) {
          options.prompts.push(args.join(' '));
          args.length = 0;
        }
        break;
      default:
        if (arg.startsWith('-')) {
          const suggestion = arg.startsWith('--') ? closestMatch(arg, KNOWN_OPTIONS) : null;
          throw usageError(`Unknown option: ${arg}${suggestion ? `. Did you mean ${suggestion}?` : ''} (see fm-bench --help)`);
        }
        if (options.command === 'compare') {
          options.compareFiles.push(arg);
        } else if (options.command === 'history') {
          options.historyDir = arg;
        } else if (options.command === 'validate' || options.command === 'export') {
          options.validateFiles.push(arg);
        } else {
          options.prompts.push([arg, ...args].join(' '));
          args.length = 0;
        }
        break;
    }
  }

  return options;
}

async function runHistory(options, renderOpts) {
  const dir = options.historyDir || options.outputDir || '.';
  const reports = await loadHistory(dir);

  if (options.format === 'json') {
    const data = reports.map(({ filePath, report }) => ({
      file: filePath,
      startedAt: report.startedAt,
      version: report.version,
      summary: report.summary
    }));
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(renderHistoryReport(reports, renderOpts));
  }
}

async function runCompare(options, renderOpts) {
  const files = options.compareFiles;
  if (files.length < 2) {
    throw usageError('compare requires two JSON report files: fm-bench compare before.json after.json');
  }
  if (files.length > 2) {
    throw usageError('compare accepts exactly two JSON report files');
  }

  const [beforePath, afterPath] = files;
  let beforeText;
  let afterText;
  try {
    [beforeText, afterText] = await Promise.all([
      fs.readFile(beforePath, 'utf8'),
      fs.readFile(afterPath, 'utf8')
    ]);
  } catch (error) {
    throw operationalError(`Cannot read report: ${error.message}`);
  }

  const before = parseReportJson(beforeText, beforePath);
  const after = parseReportJson(afterText, afterPath);

  const diff = diffReports(before, after);

  if (options.format === 'json') {
    console.log(JSON.stringify(diff, null, 2));
  } else {
    console.log(renderCompareReport(diff, renderOpts));
  }

  if (options.out) {
    await fs.writeFile(options.out, `${JSON.stringify(diff, null, 2)}\n`, 'utf8');
    console.error(`Saved compare report to ${options.out}`);
  }

  if (options.strictCompare && diff.compatibility && !diff.compatibility.suiteMatch) {
    throw usageError('compare: benchmark suites differ (--strict)');
  }
}

function parseReportJson(text, filePath) {
  try {
    return JSON.parse(text);
  } catch {
    throw operationalError(`Cannot parse ${filePath} as JSON`);
  }
}

async function runValidate(options) {
  const files = options.validateFiles;
  if (files.length === 0) {
    throw usageError('validate requires at least one JSON report: fm-bench validate report.json');
  }

  const results = [];
  for (const filePath of files) {
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
      results.push({ file: filePath, ok: false, errors: [error.code === 'ENOENT'
        ? 'file not found'
        : 'cannot read or parse JSON'] });
      continue;
    }
    const result = validateReport(parsed);
    results.push(result.ok
      ? { file: filePath, ok: true, schema: result.report.schemaVersion ?? 'legacy', id: result.report.reportId ?? null }
      : { file: filePath, ok: false, errors: result.errors });
  }

  if (options.format === 'json') {
    console.log(JSON.stringify({ ok: results.every((item) => item.ok), files: results }, null, 2));
  } else {
    for (const item of results) {
      if (item.ok) {
        console.log(`ok       ${item.file}  schema=${item.schema} id=${item.id ?? '—'}`);
      } else {
        console.error(`invalid  ${item.file}  ${item.errors.join('; ')}`);
      }
    }
  }

  const failed = results.filter((item) => !item.ok).length;
  if (failed > 0) {
    throw operationalError(`${failed} report(s) failed validation`);
  }
}

async function runExport(options) {
  const files = options.validateFiles;
  if (files.length === 0) {
    throw usageError('export requires a JSON report: fm-bench export report.json [-o out.html]');
  }

  const filePath = files[0];
  let report;
  try {
    report = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    throw error.code === 'ENOENT'
      ? operationalError(`Cannot read ${filePath}: file not found`)
      : operationalError(`Cannot parse ${filePath} as JSON`);
  }
  const validation = validateReport(report);
  if (!validation.ok) {
    throw operationalError(`Not a valid fm-bench report: ${validation.errors.join('; ')}`);
  }

  const html = renderHtmlReport(validation.report);
  if (options.out) {
    await fs.writeFile(options.out, html, 'utf8');
    console.error(`Wrote HTML to ${options.out}`);
  } else {
    console.log(html);
  }
}

async function runDoctor(options) {
  const json = options.format === 'json';
  const checks = [];
  checks.push(['node', process.version, true]);
  checks.push(['platform', `${process.platform}/${process.arch}`, process.platform === 'darwin']);

  const macOS = await detectMacosVersion();
  const parsedVersion = parseMacosVersion(macOS);
  const support = evaluateMacosSupport(process.platform, parsedVersion);
  checks.push(['macOS', parsedVersion?.version || 'unknown', support.supported]);
  if (!support.supported) {
    checks.push(['macOS support', support.reason, false]);
    checks.push(['latest supported', support.latestSupported, false]);
  }

  const hwModel = await runProcess('sysctl', ['-n', 'hw.model'], { timeoutMs: 3_000 });
  const hwModelStr = (hwModel.stdout || '').trim();
  if (hwModelStr) checks.push(['hw.model', hwModelStr, true]);

  const cpuBrand = await runProcess('sysctl', ['-n', 'machdep.cpu.brand_string'], { timeoutMs: 3_000 });
  const cpuBrandStr = (cpuBrand.stdout || '').trim();
  if (cpuBrandStr) checks.push(['cpu', cpuBrandStr, true]);

  const memBytes = await runProcess('sysctl', ['-n', 'hw.memsize'], { timeoutMs: 3_000 });
  const memRaw = (memBytes.stdout || '').trim();
  if (memRaw) {
    const gb = (Number(memRaw) / (1024 ** 3)).toFixed(0);
    checks.push(['memory', `${gb} GB`, true]);
  }

  const thermalResult = await runProcess('pmset', ['-g', 'therm'], { timeoutMs: 5_000 });
  const thermal = parseThermalOutput(`${thermalResult.stdout || ''}${thermalResult.stderr || ''}`);
  if (thermal.available && thermal.schedulerLimit != null) {
    const limit = thermal.schedulerLimit;
    checks.push(['thermal limit', `${limit}%`, limit >= 100]);
  } else if (thermal.available && thermal.healthyIdle) {
    checks.push(['thermal', 'no thermal pressure', true]);
  } else if (!thermal.available) {
    checks.push(['thermal', 'unavailable', true]);
  }

  const batteryResult = await runProcess('pmset', ['-g', 'batt'], { timeoutMs: 5_000 });
  const battery = parseBatteryOutput(`${batteryResult.stdout || ''}${batteryResult.stderr || ''}`);
  if (battery.present) {
    const pct = battery.pct != null ? `${battery.pct}%` : '?%';
    const source = battery.onAC ? 'charging/AC' : 'battery';
    const ok = battery.onAC || (battery.pct != null && battery.pct >= 20);
    checks.push(['battery', `${pct} (${source})`, ok]);
  }

  let models = [];
  let capabilities = null;
  try {
    const inspection = await inspectModels(options);
    models = inspection.models;
    capabilities = inspection.capabilities;
    checks.push(['fm', inspection.fmBin, capabilities.ok]);
    if (capabilities.digest) checks.push(['fm help digest', capabilities.digest, true]);
    checks.push(['fm commands', capabilities.commands.join(', ') || 'none found', capabilities.commands.length > 0]);
    checks.push(['fm token counting', capabilities.features.tokenCounting ? `yes (${capabilities.features.tokenCountCommand})` : 'no', capabilities.features.tokenCounting]);
    checks.push(['fm streaming', capabilities.features.streaming ? 'yes' : 'no', capabilities.features.streaming]);
    checks.push(['fm quota', capabilities.features.quota ? 'yes' : 'no (not exposed by this build)', true]);
    if (capabilities.features.license) {
      const license = await getLicenseStatus(inspection.fmBin, { capabilities });
      checks.push(['fm license', license.agreed === false
        ? `${license.detail || 'not agreed'} — run "fm license" to review and accept the terms`
        : license.detail, license.agreed !== false]);
    }
    for (const model of inspection.models) {
      const detail = model.available
        ? `available${model.identity ? ` (${model.identity})` : ''}`
        : model.reason || 'unavailable';
      checks.push([`model:${model.name}`, detail, model.available]);
    }
  } catch (error) {
    checks.push(['fm', error.message || String(error), false]);
  }

  const payload = {
    checks: checks.map(([name, detail, ok]) => ({ name, detail: String(detail), ok })),
    models,
    capabilities: capabilities ? describeCapabilities(capabilities) : null
  };

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    const nameWidth = Math.max(...checks.map(([name]) => name.length));
    const lines = checks.map(([name, detail, ok]) => `${ok ? 'ok  ' : 'warn'} ${name.padEnd(nameWidth)}  ${String(detail).replace(/\s+/g, ' ').trim()}`);
    console.log(lines.join('\n'));
    if (capabilities) {
      console.log('');
      console.log(`fm capabilities: ${formatCapabilitySummary(capabilities)}`);
      for (const warning of capabilities.warnings) {
        console.log(`limit: ${warning}`);
      }
    }
  }

  if (options.out) {
    await fs.writeFile(options.out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }
}

function describeCapabilities(capabilities) {
  return {
    bin: capabilities.bin,
    ok: capabilities.ok,
    digest: capabilities.digest,
    commands: capabilities.commands,
    models: capabilities.models,
    features: capabilities.features,
    warnings: capabilities.warnings
  };
}

function requireValue(option, args) {
  const value = args.shift();
  if (value == null || value === '') throw usageError(`${option} requires a value`);
  return value;
}

function parsePositiveInt(value, option) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw usageError(`${option} must be a positive integer`);
  return parsed;
}

function parsePositiveNumber(value, option) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw usageError(`${option} must be a positive number`);
  return parsed;
}

function parseNonNegativeInt(value, option) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) throw usageError(`${option} must be a non-negative integer`);
  return parsed;
}

function parsePositiveIntList(value, option) {
  const parsed = String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => parsePositiveInt(item, option));
  if (parsed.length === 0) throw usageError(`${option} requires at least one positive integer`);
  return parsed;
}

function renderOptions(parsed) {
  return {
    ascii: parsed.ascii,
    color: resolveColor(parsed.color),
    compact: parsed.compact,
    width: parsed.width
  };
}

function resolveColor(value) {
  if (value === 'always') return true;
  if (value === 'never') return false;
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return Boolean(process.stdout.isTTY);
}

function resolveProgress(parsed) {
  if (parsed.progress === 'always') return true;
  if (parsed.progress === 'never') return false;
  return parsed.format === 'table' ? 'auto' : false;
}

function helpText() {
  return `fm-bench ${packageJson.version}

Dynamic benchmark CLI for Apple's fm command on macOS ${MIN_SUPPORTED_MACOS}+.

Usage:
  fm-bench [run] [options]
  fm-bench models [options]
  fm-bench compare <before.json> <after.json> [options]
  fm-bench history [dir] [options]
  fm-bench validate <report.json> [more...] [options]
  fm-bench export <report.json> [-o report.html]
  fm-bench legend [options]
  fm-bench doctor [options]

Commands:
  run                  Benchmark discovered or selected fm models
  models               List discovered models, availability, and fm capabilities
  compare              Compare two saved JSON reports and show metric deltas
  history              Show a trend table from all fm-bench JSON reports in a directory
  validate             Verify report JSON structure (schema v1)
  export               Render a shareable standalone HTML report from JSON
  legend               Explain every terminal table column, color rule, and metric source
  doctor               Check Node, macOS, fm capabilities, and model availability
  metrics              Alias for legend

Run options:
  -m, --models <list>       Models to benchmark, comma-separated or repeated
  -r, --runs <n>            Runs per prompt/model (default: 1)
      --warmup <n>          Unmeasured warmup runs per model (default: 1; 0 measures cold start)
  -c, --concurrency <n>     Parallel fm processes (default: 1)
      --sweep-concurrency <list>
                            Run separate operating points, e.g. 1,2,4
      --request-rate <rps>  Pace request starts at a target requests/sec
      --ramp-up-ms <n>      Gradually ramp request pacing over n ms
      --timeout-ms <n>      Timeout per fm call in ms (default: 60000)
      --slo-ttft-ms <n>     Count request as good only if TTFT is <= n
      --slo-e2e-ms <n>      Count request as good only if E2E latency is <= n
      --slo-tpot-ms <n>     Count request as good only if TPOT is <= n
  -p, --prompt <text>       Prompt to benchmark; repeatable
      --prompt-file <file>  .json, .jsonl, or blank-line separated text prompts
      --profile <name>      quick, standard, interactive, throughput, client, stress, reasoning, coding, or creative
  -i, --instructions <text> Instructions passed to fm respond
      --use-case <case>     Pass a system model use case through to fm
      --guardrails <level>  Pass a system model guardrail level through to fm
      --greedy              Use greedy sampling (default)
      --no-greedy           Do not request greedy sampling
      --stream              Stream responses while measuring TTFT (default)
      --no-stream           Disable streaming; TTFT fields will be blank
      --available-only      Hide unavailable discovered models
      --capture-output      Include raw model output in JSON reports
      --fail-fast           Stop after the first failed measured run
      --retry <n>           Retry failed fm calls up to n times with exponential backoff
      --ci                  Exit 1 if any run fails or any SLO is violated; disables color and progress
      --tag <name>          Tag this run; repeatable; included in JSON payload and report header
      --note <text>         Freeform note included in JSON payload and report header

Output:
      --format <type>       table, json, or csv (default: table)
      --json                Alias for --format json
      --csv                 Alias for --format csv
      --ascii               Use plain ASCII tables instead of Unicode
      --color               Force ANSI colors in table output
      --no-color            Disable ANSI colors in table output
      --progress            Force live progress on stderr
      --no-progress         Disable live progress on stderr
      --compact             Force compact terminal layout
      --width <n>           Render for a specific terminal width
      --histogram           Print an ASCII latency distribution histogram after the report
  -o, --out <file>          Save JSON, CSV, or HTML report based on file extension
      --output-dir <dir>    Save a timestamped JSON report to a directory automatically
      --export-html         With --output-dir, also write a matching .html report
  -v, --verbose             Include per-run CSV after the summary table

Compare:
      --strict                Exit 2 when before/after benchmark suites differ

Environment:
      --fm-bin <path>       fm binary to execute (default: FM_BIN or fm)
      --                    Treat the rest of the line as the prompt
  -h, --help                Show this help
      --version             Print version

Machine-readable output:
  --json and --csv write only data to stdout; progress and diagnostics go to stderr.
  "validate --json" prints { ok, files }; "doctor --json" prints the full check list.

Exit codes:
  0   success
  1   operational failure (failed runs with --ci, invalid reports, fm errors)
  2   usage or environment error (bad flags, missing arguments, unsupported macOS, fm not found)

Capability detection:
  fm-bench probes "fm --help" and "fm respond --help" once per run and reads
  model status from "fm models" (or "fm available" on older builds). Metrics
  the installed fm cannot supply are reported as unavailable instead of being
  guessed, and unsupported models are refused before any benchmark starts.

Private Cloud Compute:
  fm reports the pcc model as "not available in this context" outside the
  Terminal app (for example in editor terminals). Run fm-bench from Terminal
  to benchmark pcc; elsewhere it is listed as skipped with that reason.

Examples:
  fm-bench
  fm-bench --models system --runs 3 --profile stress
  fm-bench --profile client --sweep-concurrency 1,2 --request-rate 0.5
  fm-bench --prompt "Reply with exactly: ok" --json --out bench.json
  fm-bench --profile reasoning --runs 5 --retry 2
  fm-bench models
  fm-bench doctor --json
  fm-bench compare before.json after.json
  fm-bench compare before.json after.json --json
  fm-bench compare before.json after.json --strict
  fm-bench validate reports/*.json
  fm-bench export bench.json -o bench.html
  fm-bench --output-dir reports/ --export-html --tag nightly
  fm-bench history ./reports
  fm-bench history ./reports --json
  fm-bench legend
`;
}
