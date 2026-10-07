import os from 'node:os';
import { stripAnsi } from './ansi.js';
import { detectFmCapabilities } from './capabilities.js';
import { firstLine, isUnsupportedModelError, parseAvailabilityOutput, parseModelList, withoutWarnings } from './fm-help.js';
import { runProcess } from './process.js';
import { parseBatteryOutput, parseThermalOutput } from './system.js';

export { parseModelsFromHelp, parseAvailabilityOutput } from './fm-help.js';

export function fmBinaryFromOptions(options = {}) {
  return options.fmBin || process.env.FM_BIN || 'fm';
}

export async function getFmHelp(fmBin, timeoutMs = 10_000) {
  const result = await runProcess(fmBin, ['--help'], { timeoutMs });
  if (result.error) {
    const error = new Error(`Unable to execute ${fmBin}: ${result.stderr || result.error.message}`);
    error.exitCode = 2;
    throw error;
  }
  return {
    ok: result.code === 0,
    text: `${result.stdout}${result.stderr}`,
    result
  };
}

/**
 * Ask `fm models` once for every model's status. Returns `null` when the
 * build has no `models` command (older builds use per-model `fm available`).
 * @returns {Promise<{ entries: Map<string, { name: string, available: boolean, identity: string, reason: string }>, error: string } | null>}
 */
export async function listModelStatus(fmBin, options = {}) {
  if (options.capabilities?.features?.modelListCommand !== 'models') return null;
  const result = await runProcess(fmBin, ['models'], {
    timeoutMs: options.timeoutMs ?? 15_000
  });
  const output = `${result.stdout}${result.stderr}`;
  const entries = new Map(parseModelList(output).map((entry) => [entry.name, entry]));
  const error = result.error
    ? (result.stderr || result.error.message)
    : (entries.size === 0 ? firstLine(output) || `fm models exited with code ${result.code}` : '');
  return { entries, error };
}

/**
 * Check one model against the detected `fm` build.
 *
 * Models the build does not expose are reported as unsupported without
 * spawning `fm` at all, so a raw argument-error blob from `fm` can never end
 * up in a report or in `fm-bench models` output.
 *
 * Pass `options.modelList` (from `listModelStatus`) to reuse one `fm models`
 * call across several models.
 */
export async function checkModelAvailability(fmBin, model, options = {}) {
  const capabilities = options.capabilities;
  const known = capabilities?.models?.map((entry) => entry.name) ?? [];
  if (capabilities && known.length > 0 && !known.includes(model)) {
    return {
      model,
      available: false,
      unsupported: true,
      identity: '',
      raw: '',
      reason: `not supported by this fm build (supported: ${known.join(', ')})`
    };
  }

  const listCommand = capabilities ? capabilities.features?.modelListCommand : 'available';
  if (listCommand === 'models') {
    const list = options.modelList ?? await listModelStatus(fmBin, options);
    const entry = list?.entries.get(model);
    if (entry) {
      return { model, available: entry.available, identity: entry.identity, raw: '', reason: entry.reason };
    }
    return {
      model,
      available: false,
      identity: '',
      raw: '',
      reason: list?.error || 'not reported by fm models'
    };
  }
  if (listCommand == null) {
    // No availability command at all: the first fm respond call is the only
    // way to find out, and a failure there is recorded per run.
    return { model, available: true, identity: '', raw: '', reason: '' };
  }

  const result = await runProcess(fmBin, ['available', '--model', model], {
    timeoutMs: options.timeoutMs ?? 15_000
  });
  const output = `${result.stdout}${result.stderr}`;
  const parsed = parseAvailabilityOutput(model, output, result.code);
  if (result.error) {
    parsed.available = false;
    parsed.reason = result.stderr || result.error.message;
    return parsed;
  }
  if (isUnsupportedModelError(output)) {
    parsed.available = false;
    parsed.unsupported = true;
    const supported = known.length > 0 ? ` (supported: ${known.join(', ')})` : '';
    parsed.reason = `not supported by this fm build${supported}`;
  }
  return { identity: '', ...parsed };
}

/**
 * Whether the fm Legal Notice & Terms have been accepted. `fm respond` cannot
 * run until they are, so `doctor` reports it explicitly.
 * @returns {Promise<{ supported: boolean, agreed: boolean|null, detail: string }>}
 */
export async function getLicenseStatus(fmBin, options = {}) {
  if (options.capabilities && !options.capabilities.features?.license) {
    return { supported: false, agreed: null, detail: 'this fm build has no license command' };
  }
  const result = await runProcess(fmBin, ['license', '--status'], {
    timeoutMs: options.timeoutMs ?? 10_000
  });
  const output = withoutWarnings(`${result.stdout}${result.stderr}`).replace(/\s+/g, ' ').trim();
  if (result.error) {
    return { supported: true, agreed: null, detail: result.stderr || result.error.message };
  }
  const agreed = result.code === 0 && /\bagreed\b/i.test(output) && !/\bnot\b|\bnever\b/i.test(output);
  return { supported: true, agreed, detail: output || `fm license --status exited with code ${result.code}` };
}

/**
 * Query quota information when the build exposes it.
 * @returns {Promise<{ model: string, supported: boolean, ok: boolean, raw: string, reason: string }>}
 */
export async function getQuotaUsage(fmBin, model, options = {}) {
  const features = options.capabilities?.features;
  if (features && !features.quota) {
    return {
      model,
      supported: false,
      ok: false,
      raw: '',
      reason: 'unavailable: this fm build exposes no quota command'
    };
  }

  const result = await runProcess(fmBin, ['quota-usage', '--model', model], {
    timeoutMs: options.timeoutMs ?? 15_000
  });
  const output = stripAnsi(`${result.stdout}${result.stderr}`).trim();
  return {
    model,
    supported: true,
    ok: result.code === 0,
    raw: output,
    reason: result.code === 0 ? '' : firstLine(output)
  };
}

/**
 * Count tokens with whichever token-counting command this `fm` build exposes.
 * Returns `ok: false` with a reason when the build cannot count tokens; it
 * never invents a count.
 */
export async function countTokens(fmBin, text, options = {}) {
  const command = options.capabilities?.features?.tokenCountCommand ?? 'count-tokens';
  const supported = options.capabilities?.features?.tokenCounting ?? true;
  if (!supported || !command) {
    return {
      ok: false,
      count: null,
      unsupported: true,
      raw: '',
      reason: 'token counting is unavailable in this fm build'
    };
  }

  const result = await runProcess(fmBin, [command, '--quiet'], {
    input: text,
    timeoutMs: options.timeoutMs ?? 15_000
  });
  const output = stripAnsi(`${result.stdout}${result.stderr}`).trim();
  const match = output.match(/\d+/);
  if (result.error || result.code !== 0 || !match) {
    return {
      ok: false,
      count: null,
      raw: output,
      reason: result.error?.message || firstLine(output) || `fm ${command} exited with code ${result.code}`
    };
  }
  return {
    ok: true,
    count: Number.parseInt(match[0], 10),
    raw: output,
    reason: ''
  };
}

/**
 * Measure the constant framing overhead `fm count-tokens` adds to every count.
 *
 * On macOS 27.2 `count-tokens` reports 2 for "a", 3 for "a a", and 5 for
 * "a a a a": one token per word plus one framing token. Model output must not
 * carry that extra token, so the overhead is derived from three counts whose
 * per-word step must agree; anything inconsistent leaves counts uncorrected.
 *
 * @returns {Promise<{ overhead: number, calibrated: boolean }>}
 */
export async function calibrateTokenCounter(fmBin, options = {}) {
  const counts = [];
  for (const text of ['a', 'a a', 'a a a']) {
    const counted = await countTokens(fmBin, text, options);
    if (!counted.ok) return { overhead: 0, calibrated: false };
    counts.push(counted.count);
  }
  const step = counts[1] - counts[0];
  const overhead = counts[0] - step;
  const consistent = step >= 1 && counts[2] - counts[1] === step && overhead >= 0 && overhead <= 16;
  return consistent ? { overhead, calibrated: true } : { overhead: 0, calibrated: false };
}

// Stdout chunks closer together than this are one write burst from fm, not
// separate streaming steps. On macOS 27.2 a short answer's tail arrives as
// several writes well under 1 ms apart, while real deltas are 20 ms or more
// apart; counting the burst as decode steps reported tens of thousands of
// tokens per second.
export const DELIVERY_COALESCE_MS = 5;

/**
 * Group stdout chunk arrivals into deliveries: runs of chunks that each
 * arrived less than `coalesceMs` after the previous one.
 * @param {number[]} timesMs chunk arrival times
 * @param {number[]} lengths chunk lengths in characters
 * @returns {{ atMs: number, endChars: number }[]} delivery start time and the
 *   stdout length once the delivery is complete
 */
export function groupDeliveries(timesMs = [], lengths = [], coalesceMs = DELIVERY_COALESCE_MS) {
  const deliveries = [];
  let chars = 0;
  let previousAtMs = null;
  for (const [index, atMs] of timesMs.entries()) {
    chars += lengths[index] ?? 0;
    const current = deliveries.at(-1);
    if (current && atMs - previousAtMs < coalesceMs) {
      current.endChars = chars;
    } else {
      deliveries.push({ atMs, endChars: chars });
    }
    previousAtMs = atMs;
  }
  return deliveries;
}

export async function respond(fmBin, model, prompt, options = {}) {
  const features = options.capabilities?.features;
  const streamControl = features ? features.streaming : true;
  const modelSelection = features ? features.modelSelection : true;
  const streamed = streamControl && options.stream !== false;

  const args = ['respond'];
  if (modelSelection) args.push('--model', model);
  if (streamControl && !streamed) args.push('--no-stream');
  if (options.greedy && (features?.greedy ?? true)) args.push('--greedy');
  if (options.instructions && (features?.instructions ?? true)) args.push('--instructions', options.instructions);
  if (options.useCase && (features?.useCase ?? true)) args.push('--use-case', options.useCase);
  if (options.guardrails && (features?.guardrails ?? true)) args.push('--guardrails', options.guardrails);

  const result = await runProcess(fmBin, args, {
    input: prompt,
    timeoutMs: options.timeoutMs ?? 60_000
  });

  const output = stripAnsi(result.stdout).trim();
  const errorText = stripAnsi(result.stderr).trim();
  const failed = result.code !== 0 || result.timedOut;
  const deliveries = streamed ? groupDeliveries(result.stdoutChunkTimesMs, result.stdoutChunkLengths) : [];

  return {
    ok: !failed,
    model,
    prompt,
    output,
    stderr: errorText,
    code: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    firstOutputMs: streamed ? result.firstStdoutMs : null,
    firstChunkText: deliveries.length > 0 ? stripAnsi(result.stdout.slice(0, deliveries[0].endChars)) : null,
    streamed,
    stdoutChunks: result.stdoutChunks,
    stdoutChunkTimesMs: streamed ? result.stdoutChunkTimesMs : [],
    deliveryTimesMs: deliveries.map((delivery) => delivery.atMs),
    error: failed
      ? (result.timedOut
        ? `timed out after ${options.timeoutMs ?? 60_000}ms`
        : firstLine(errorText) || `fm exited with code ${result.code ?? result.signal}`)
      : ''
  };
}

export async function collectEnvironment(fmBin, options = {}) {
  const capabilities = options.capabilities;
  const swVers = await runProcess('sw_vers', [], { timeoutMs: 5_000 });
  const macOS = stripAnsi(swVers.stdout).trim() || null;

  const hwModel = await runProcess('sysctl', ['-n', 'hw.model'], { timeoutMs: 3_000 });
  const cpuBrand = await runProcess('sysctl', ['-n', 'machdep.cpu.brand_string'], { timeoutMs: 3_000 });
  const memBytes = await runProcess('sysctl', ['-n', 'hw.memsize'], { timeoutMs: 3_000 });

  const thermalResult = await runProcess('pmset', ['-g', 'therm'], { timeoutMs: 5_000 });
  const thermal = parseThermalOutput(`${thermalResult.stdout || ''}${thermalResult.stderr || ''}`);
  const batteryResult = await runProcess('pmset', ['-g', 'batt'], { timeoutMs: 5_000 });
  const battery = parseBatteryOutput(`${batteryResult.stdout || ''}${batteryResult.stderr || ''}`);

  let fmHelpDigest = capabilities?.digest ?? null;
  if (fmHelpDigest == null) {
    try {
      const help = await getFmHelp(fmBin, 10_000);
      const detected = await detectFmCapabilities(fmBin, { help: { text: help.text } });
      fmHelpDigest = detected.digest;
    } catch {
      fmHelpDigest = null;
    }
  }

  const memRaw = (memBytes.stdout || '').trim();
  const memoryGb = memRaw && Number.isFinite(Number(memRaw))
    ? Math.round(Number(memRaw) / (1024 ** 3))
    : null;

  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    host: os.hostname(),
    fmBin,
    macOS,
    hwModel: (hwModel.stdout || '').trim() || null,
    cpuBrand: (cpuBrand.stdout || '').trim() || null,
    memoryGb,
    fmHelpDigest,
    thermal: thermal.available
      ? {
        schedulerLimit: thermal.schedulerLimit,
        healthyIdle: Boolean(thermal.healthyIdle)
      }
      : null,
    power: battery.present
      ? {
        pct: battery.pct,
        onAC: battery.onAC
      }
      : null
  };
}
