import crypto from 'node:crypto';
import { detectFmCapabilities } from './capabilities.js';
import {
  calibrateTokenCounter,
  checkModelAvailability,
  collectEnvironment,
  countTokens,
  fmBinaryFromOptions,
  getQuotaUsage,
  listModelStatus,
  respond
} from './fm.js';
import { metricAvailability } from './metrics.js';
import { loadPrompts } from './prompts.js';
import { finalizeReportPayload } from './schema.js';
import { summarizeByModel } from './stats.js';

export async function inspectModels(options = {}) {
  const fmBin = fmBinaryFromOptions(options);
  const capabilities = options.capabilities ?? await detectFmCapabilities(fmBin, options);
  const discovered = {
    fmBin,
    models: capabilities.models,
    help: capabilities.help,
    capabilities
  };
  const requested = normalizeModelSelection(options.models);
  const models = requested.length > 0
    ? requested.map((name) => discovered.models.find((model) => model.name === name)
      ?? { name, description: 'Requested model not reported by this fm build' })
    : discovered.models;

  const modelList = models.length > 0 ? await listModelStatus(discovered.fmBin, { ...options, capabilities }) : null;
  const inspected = [];
  for (const model of models) {
    const availability = await checkModelAvailability(discovered.fmBin, model.name, {
      ...options,
      capabilities,
      modelList
    });
    // A model the build does not have has no quota; asking would only put fm's
    // text for some other model where the "not supported" reason belongs.
    const quota = availability.unsupported
      ? { supported: false, raw: '', reason: '' }
      : await getQuotaUsage(discovered.fmBin, model.name, { ...options, capabilities });
    inspected.push({
      ...model,
      identity: availability.identity || '',
      available: availability.available,
      unsupported: Boolean(availability.unsupported),
      reason: availability.available ? '' : (availability.reason || availability.raw || 'unavailable'),
      quota: quota.supported ? (quota.raw || quota.reason) : '',
      quotaSupported: quota.supported,
      quotaReason: quota.reason
    });
  }

  return {
    fmBin: discovered.fmBin,
    models: inspected,
    help: discovered.help,
    capabilities
  };
}

export async function runBenchmark(options = {}) {
  const startedAt = new Date().toISOString();
  const fmBin = fmBinaryFromOptions(options);

  notify(options, { type: 'phase', phase: 'capabilities', message: 'probing fm capabilities' });
  const capabilities = options.capabilities ?? await detectFmCapabilities(fmBin, options);
  if (!capabilities.ok) {
    const error = new Error(capabilities.error
      ? `${capabilities.error}\nInstall Apple's fm CLI (macOS 27+) or point --fm-bin / FM_BIN at a compatible binary.`
      : `No usable fm commands were found in ${fmBin} --help.`);
    error.exitCode = 2;
    throw error;
  }

  notify(options, { type: 'phase', phase: 'prompts', message: 'loading prompts' });
  const prompts = await loadPrompts(options);
  notify(options, { type: 'phase', phase: 'models', message: 'discovering models' });
  const inspection = await inspectModels({ ...options, capabilities });
  const modelStatuses = options.availableOnly
    ? inspection.models.filter((model) => model.available)
    : inspection.models;
  const runnableModels = modelStatuses.filter((model) => model.available);
  if (runnableModels.length === 0) {
    throw noRunnableModelsError(inspection.models, capabilities.models, options);
  }
  const environment = await collectEnvironment(inspection.fmBin, { ...options, capabilities });
  const metrics = metricAvailability(capabilities, {
    stream: options.stream,
    slo: Boolean(options.sloTtftMs || options.sloE2eMs || options.sloTpotMs)
  });
  const promptTokenCounts = new Map();
  const concurrencies = normalizeConcurrencySweep(options);
  const totalRuns = concurrencies.length * runnableModels.length * prompts.length * options.runs;

  const tokenCounter = {
    command: capabilities.features.tokenCountCommand,
    overhead: 0,
    calibrated: false
  };
  if (metrics.outputTokens.available) {
    notify(options, { type: 'phase', phase: 'tokens', message: 'calibrating token counter' });
    Object.assign(tokenCounter, await calibrateTokenCounter(inspection.fmBin, { ...options, capabilities }));
  }

  notify(options, {
    type: 'tokens:start',
    total: prompts.length,
    supported: metrics.promptTokens.available,
    message: metrics.promptTokens.available ? 'counting prompt tokens' : 'token counting unavailable'
  });
  for (const prompt of prompts) {
    const counted = metrics.promptTokens.available
      ? await countTokens(inspection.fmBin, prompt.prompt, { ...options, capabilities })
      : { ok: false, count: null };
    promptTokenCounts.set(prompt.id, counted.ok ? counted.count : null);
    notify(options, {
      type: 'tokens:progress',
      completed: promptTokenCounts.size,
      total: prompts.length,
      promptId: prompt.id
    });
  }

  const results = [];
  const scenarios = [];
  let completedRuns = 0;
  let failedRuns = 0;
  notify(options, {
    type: 'benchmark:start',
    total: totalRuns,
    modelCount: runnableModels.length,
    promptCount: prompts.length,
    scenarioCount: concurrencies.length
  });
  for (const [scenarioIndex, concurrency] of concurrencies.entries()) {
    const scenario = await runScenario({
      fmBin: inspection.fmBin,
      capabilities,
      prompts,
      runnableModels,
      modelStatuses,
      promptTokenCounts,
      tokenCounting: metrics.outputTokens.available,
      tokenOverhead: tokenCounter.overhead,
      options,
      concurrency,
      scenarioIndex: scenarioIndex + 1,
      scenarioCount: concurrencies.length,
      onMeasuredResult: (result) => {
        completedRuns += 1;
        if (!result.ok) failedRuns += 1;
        notify(options, {
          type: 'benchmark:progress',
          completed: completedRuns,
          failed: failedRuns,
          total: totalRuns,
          concurrency,
          model: result.model,
          promptId: result.promptId,
          run: result.run,
          ok: result.ok,
          durationMs: result.durationMs,
          firstTokenMs: result.firstTokenMs
        });
      }
    });
    scenarios.push(scenario);
    results.push(...scenario.results);
  }

  results.sort((a, b) => a.model.localeCompare(b.model)
    || (a.concurrency ?? 0) - (b.concurrency ?? 0)
    || a.promptId.localeCompare(b.promptId)
    || a.run - b.run);

  const summary = summarizeByModel(results, modelStatuses, { concurrencies });
  const payload = finalizeReportPayload({
    tool: 'fm-bench',
    version: options.version,
    startedAt,
    finishedAt: new Date().toISOString(),
    options: publicOptions(options),
    environment,
    capabilities: {
      bin: capabilities.bin,
      digest: capabilities.digest,
      commands: capabilities.commands,
      models: capabilities.models,
      features: capabilities.features,
      warnings: capabilities.warnings
    },
    metrics,
    tokenCounter,
    prompts: prompts.map((prompt) => ({
      id: prompt.id,
      prompt: prompt.prompt,
      promptTokens: promptTokenCounts.get(prompt.id)
    })),
    models: modelStatuses,
    scenarios,
    summary,
    results
  });
  notify(options, {
    type: 'benchmark:complete',
    completed: completedRuns,
    failed: failedRuns,
    total: totalRuns
  });
  return payload;
}

async function runScenario(context) {
  const {
    fmBin,
    capabilities,
    prompts,
    runnableModels,
    modelStatuses,
    promptTokenCounts,
    tokenCounting,
    tokenOverhead,
    options,
    concurrency,
    scenarioIndex,
    scenarioCount,
    onMeasuredResult
  } = context;
  const startedAt = new Date().toISOString();

  const warmupTotal = options.warmup * runnableModels.length;
  if (warmupTotal > 0) {
    notify(options, {
      type: 'warmup:start',
      concurrency,
      scenarioIndex,
      scenarioCount,
      total: warmupTotal
    });
  }
  let warmupCompleted = 0;
  for (let warmupIndex = 0; warmupIndex < options.warmup; warmupIndex += 1) {
    for (const model of runnableModels) {
      await respond(fmBin, model.name, prompts[0].prompt, {
        ...options,
        capabilities,
        stream: false
      });
      warmupCompleted += 1;
      notify(options, {
        type: 'warmup:progress',
        concurrency,
        scenarioIndex,
        scenarioCount,
        completed: warmupCompleted,
        total: warmupTotal,
        model: model.name
      });
    }
  }

  const jobs = [];
  const benchmarkStartedAt = process.hrtime.bigint();
  for (const model of runnableModels) {
    for (const prompt of prompts) {
      for (let run = 1; run <= options.runs; run += 1) {
        jobs.push({ model, prompt, run, concurrency });
      }
    }
  }

  const results = [];
  notify(options, {
    type: 'scenario:start',
    concurrency,
    scenarioIndex,
    scenarioCount,
    total: jobs.length
  });
  await runLimited(jobs, concurrency, async (job) => {
    const result = await runSingleBenchmark({
      fmBin,
      capabilities,
      job,
      promptTokenCounts,
      tokenCounting,
      tokenOverhead,
      options,
      benchmarkStartedAt
    });
    results.push(result);
    if (onMeasuredResult) onMeasuredResult(result);
    if (!result.ok && options.failFast) {
      const error = new Error(result.error || `Benchmark failed for ${job.model.name}`);
      error.exitCode = 1;
      throw error;
    }
  }, options);

  results.sort((a, b) => a.model.localeCompare(b.model)
    || a.promptId.localeCompare(b.promptId)
    || a.run - b.run);

  return {
    concurrency,
    startedAt,
    finishedAt: new Date().toISOString(),
    summary: summarizeByModel(results, modelStatuses, { concurrencies: [concurrency] }),
    results
  };
}

async function runSingleBenchmark(context) {
  const { fmBin, capabilities, job, promptTokenCounts, tokenCounting, tokenOverhead = 0, options, benchmarkStartedAt } = context;
  const maxAttempts = 1 + Math.max(0, options.retry ?? 0);
  const startOffsetMs = Number(process.hrtime.bigint() - benchmarkStartedAt) / 1e6;
  let response;
  let attempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    response = await respond(fmBin, job.model.name, job.prompt.prompt, {
      ...options,
      capabilities,
      stream: options.stream
    });
    if (response.ok || attempt >= maxAttempts) break;
    const backoffMs = Math.min(500 * 2 ** (attempt - 1), 4000);
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }
  const endOffsetMs = Number(process.hrtime.bigint() - benchmarkStartedAt) / 1e6;

  const ok = response.ok;
  const seconds = response.durationMs / 1000;

  // When one delivery carries the whole answer, the streamed portion is not
  // separable: report generation time and TPOT as unavailable rather than as
  // a near-zero decode phase. Otherwise the generation window runs from the
  // first to the last delivery, which excludes process teardown.
  const firstTokenMs = ok ? response.firstOutputMs : null;
  const deliveryTimes = response.deliveryTimesMs ?? [];
  const generationMs = ok && firstTokenMs != null && deliveryTimes.length > 1
    ? Math.max(0, deliveryTimes[deliveryTimes.length - 1] - firstTokenMs)
    : null;

  const countOptions = { ...options, capabilities };
  const countedOutputTokens = ok && tokenCounting
    ? await countOutputTokens(fmBin, response.output, tokenOverhead, countOptions)
    : null;
  // fm streams coarse deltas: the first delivery carries about 20 tokens on
  // macOS 27.2. Decode cadence is therefore measured over the tokens that
  // arrived after it, not over "all tokens but one".
  const firstChunkTokens = generationMs != null && countedOutputTokens != null
    ? await countOutputTokens(fmBin, response.firstChunkText ?? '', tokenOverhead, countOptions)
    : null;
  // Two decode tokens is the minimum for an inter-token interval that is not
  // simply the inverse of a single chunk gap.
  const tokensAfterFirstChunk = firstChunkTokens != null
    ? countedOutputTokens - Math.min(firstChunkTokens, countedOutputTokens)
    : null;
  const decodeTokenCount = tokensAfterFirstChunk != null && tokensAfterFirstChunk >= 2
    ? tokensAfterFirstChunk
    : null;
  const hasDecodeCadence = generationMs != null && generationMs > 0 && decodeTokenCount != null;
  const tpotMs = hasDecodeCadence ? generationMs / decodeTokenCount : null;
  const decodeTokensPerSecond = hasDecodeCadence ? decodeTokenCount / (generationMs / 1000) : null;

  const chars = response.output.length;
  const words = response.output.trim() ? response.output.trim().split(/\s+/).length : 0;
  const promptTokens = promptTokenCounts.get(job.prompt.id) ?? null;
  const prefillTokensPerSecond = promptTokens != null && firstTokenMs != null && firstTokenMs > 0
    ? promptTokens / (firstTokenMs / 1000)
    : null;
  const chunkGapsMs = ok ? chunkGaps(deliveryTimes) : [];
  const secondChunkMs = chunkGapsMs.length > 0 ? chunkGapsMs[0] : null;

  return {
    model: job.model.name,
    concurrency: job.concurrency,
    promptId: job.prompt.id,
    run: job.run,
    attempts,
    ok,
    durationMs: response.durationMs,
    firstTokenMs,
    generationMs,
    tpotMs,
    promptTokens,
    outputTokens: countedOutputTokens,
    firstChunkTokens,
    decodeTokens: hasDecodeCadence ? decodeTokenCount : null,
    chars,
    words,
    tokensPerSecond: countedOutputTokens != null && seconds > 0 ? countedOutputTokens / seconds : null,
    decodeTokensPerSecond,
    prefillTokensPerSecond,
    charsPerSecond: seconds > 0 ? chars / seconds : null,
    startOffsetMs,
    endOffsetMs,
    streamed: response.streamed,
    stdoutChunks: response.stdoutChunks,
    secondChunkMs,
    chunkGapsMs,
    chunkGapAvgMs: average(chunkGapsMs),
    chunkGapMaxMs: chunkGapsMs.length > 0 ? Math.max(...chunkGapsMs) : null,
    outputHash: ok ? hashOutput(response.output) : null,
    good: ok ? evaluateSlo({
      firstTokenMs,
      durationMs: response.durationMs,
      tpotMs
    }, options) : false,
    output: options.captureOutput ? response.output : undefined,
    error: ok ? '' : (response.error || `fm exited with code ${response.code ?? response.signal}`)
  };
}

/**
 * Output token count with the token counter's framing overhead removed.
 * Empty text is zero tokens; `fm count-tokens` rejects an empty prompt.
 * @returns {Promise<number|null>}
 */
async function countOutputTokens(fmBin, text, overhead, options) {
  if (!String(text).trim()) return 0;
  const counted = await countTokens(fmBin, text, options);
  return counted.ok ? Math.max(0, counted.count - overhead) : null;
}

async function runLimited(items, concurrency, worker, options = {}) {
  let nextIndex = 0;
  // fail-fast stops admitting new work; calls already in flight are allowed to
  // finish so no `fm` process is abandoned mid-run.
  let cancelled = false;
  const waitForSlot = createPacer(options.requestRate, options.rampUpMs);
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!cancelled && nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await waitForSlot(index);
      if (cancelled) break;
      try {
        await worker(items[index]);
      } catch (error) {
        cancelled = true;
        throw error;
      }
    }
  });
  await Promise.all(workers);
}

// A benchmark with nothing to run is a configuration error, not an empty
// report: say which models were asked for and which ones the build supports.
function noRunnableModelsError(models, discoveredModels, options) {
  const requested = normalizeModelSelection(options.models);
  const supported = discoveredModels.map((model) => model.name);
  const lines = ['No benchmark was run: none of the requested models are usable right now.'];
  if (requested.length > 0) lines.push(`  requested: ${requested.join(', ')}`);
  if (supported.length > 0) lines.push(`  models reported by this fm build: ${supported.join(', ')}`);
  for (const model of models) {
    if (model.reason) lines.push(`  ${model.name}: ${model.reason}`);
  }
  lines.push('  run "fm-bench models" to see availability and reasons');
  const error = new Error(lines.join('\n'));
  error.exitCode = 2;
  return error;
}

function normalizeModelSelection(models) {
  if (!models) return [];
  const values = Array.isArray(models) ? models : [models];
  return values.flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

function publicOptions(options) {
  const concurrencies = normalizeConcurrencySweep(options);
  return {
    models: normalizeModelSelection(options.models),
    runs: options.runs,
    warmup: options.warmup,
    concurrency: options.concurrency,
    sweepConcurrency: concurrencies.length > 1 ? concurrencies : [],
    timeoutMs: options.timeoutMs,
    requestRate: options.requestRate || null,
    rampUpMs: options.rampUpMs || null,
    profile: options.profile,
    promptCount: options.promptCount,
    greedy: options.greedy,
    stream: options.stream,
    slo: {
      ttftMs: options.sloTtftMs || null,
      e2eMs: options.sloE2eMs || null,
      tpotMs: options.sloTpotMs || null
    },
    instructions: options.instructions ? '[set]' : '',
    retry: options.retry ?? 0,
    tags: options.tags?.length ? options.tags : [],
    note: options.note ?? null
  };
}

function normalizeConcurrencySweep(options) {
  if (options.sweepConcurrency?.length) {
    return [...new Set(options.sweepConcurrency)]
      .filter((value) => Number.isInteger(value) && value > 0)
      .sort((a, b) => a - b);
  }
  return [Math.max(1, options.concurrency || 1)];
}

function hashOutput(output) {
  return crypto.createHash('sha256')
    .update(output.replace(/\s+/g, ' ').trim())
    .digest('hex')
    .slice(0, 16);
}

function chunkGaps(times = []) {
  const gaps = [];
  for (let index = 1; index < times.length; index += 1) {
    gaps.push(Math.max(0, times[index] - times[index - 1]));
  }
  return gaps;
}

function average(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  if (clean.length === 0) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function createPacer(requestRate, rampUpMs = 0) {
  if (!Number.isFinite(requestRate) || requestRate <= 0) {
    return async () => {};
  }

  const startedAt = process.hrtime.bigint();
  const offsets = [];
  const steadyIntervalMs = 1000 / requestRate;
  const warmIntervalMs = steadyIntervalMs * 4;

  return async (index) => {
    while (offsets.length <= index) {
      const previousOffset = offsets.length === 0 ? 0 : offsets[offsets.length - 1];
      const fraction = rampUpMs > 0 ? Math.min(1, previousOffset / rampUpMs) : 1;
      const interval = warmIntervalMs + ((steadyIntervalMs - warmIntervalMs) * fraction);
      offsets.push(offsets.length === 0 ? 0 : previousOffset + interval);
    }

    const targetMs = offsets[index];
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const waitMs = targetMs - elapsedMs;
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  };
}

function notify(options, event) {
  if (typeof options.onProgress === 'function') {
    options.onProgress(event);
  }
}

function evaluateSlo(metrics, options) {
  const thresholds = [
    ['firstTokenMs', options.sloTtftMs],
    ['durationMs', options.sloE2eMs],
    ['tpotMs', options.sloTpotMs]
  ].filter(([, threshold]) => Number.isFinite(threshold));

  if (thresholds.length === 0) return null;

  return thresholds.every(([field, threshold]) => metrics[field] != null && metrics[field] <= threshold);
}
