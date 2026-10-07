/** @typedef {'1'} ReportSchemaVersion */

export const REPORT_SCHEMA_VERSION = '1';

const REQUIRED_TOP_LEVEL = ['tool', 'version', 'startedAt', 'summary', 'options', 'environment'];

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isFmBenchReport(value) {
  if (!value || typeof value !== 'object') return false;
  const report = /** @type {Record<string, unknown>} */ (value);
  if (report.tool !== 'fm-bench') return false;
  for (const key of REQUIRED_TOP_LEVEL) {
    if (!(key in report)) return false;
  }
  if (!Array.isArray(report.summary)) return false;
  return true;
}

/**
 * Stable key for comparing two runs (profile, prompts, runs, concurrency sweep).
 * @param {Record<string, unknown>} report
 */
export function suiteKey(report) {
  const options = /** @type {Record<string, unknown>} */ (report.options ?? {});
  const prompts = Array.isArray(report.prompts)
    ? report.prompts.map((p) => /** @type {{ id?: string }} */ (p).id).filter(Boolean).sort()
    : [];
  const sweep = Array.isArray(options.sweepConcurrency) ? [...options.sweepConcurrency].sort((a, b) => a - b) : [];
  return JSON.stringify({
    profile: options.profile ?? null,
    runs: options.runs ?? null,
    warmup: options.warmup ?? 0,
    concurrency: options.concurrency ?? 1,
    sweepConcurrency: sweep,
    promptIds: prompts,
    stream: options.stream ?? true,
    greedy: options.greedy ?? true
  });
}

/**
 * Human-readable hardware + OS fingerprint for sharing and leaderboards.
 * @param {Record<string, unknown>} report
 */
export function environmentFingerprint(report) {
  const env = /** @type {Record<string, unknown>} */ (report.environment ?? {});
  const mac = typeof env.macOS === 'string' ? env.macOS : '';
  const product = mac.match(/ProductVersion:\s*([^\n]+)/)?.[1]?.trim() ?? null;
  const build = mac.match(/BuildVersion:\s*([^\n]+)/)?.[1]?.trim() ?? null;
  return {
    platform: env.platform ?? null,
    arch: env.arch ?? null,
    node: env.node ?? null,
    host: env.host ?? null,
    hwModel: env.hwModel ?? null,
    cpuBrand: env.cpuBrand ?? null,
    memoryGb: env.memoryGb ?? null,
    macOSProductVersion: product,
    macOSBuildVersion: build,
    fmBin: env.fmBin ?? null,
    fmHelpDigest: env.fmHelpDigest ?? null,
    modelIdentities: modelIdentities(report),
    thermal: env.thermal ?? null,
    power: env.power ?? null
  };
}

/**
 * Model name → identity reported by `fm models` (for example
 * `{ system: 'AFM 3 Core Advanced' }`). Empty for reports from builds or
 * fm-bench versions that do not expose it.
 * @param {Record<string, unknown>} report
 * @returns {Record<string, string>}
 */
export function modelIdentities(report) {
  const identities = {};
  const models = Array.isArray(report.models) ? report.models : [];
  for (const model of models) {
    if (model && typeof model.name === 'string' && typeof model.identity === 'string' && model.identity) {
      identities[model.name] = model.identity;
    }
  }
  return identities;
}

/**
 * @param {Record<string, unknown>} before
 * @param {Record<string, unknown>} after
 */
export function compareCompatibility(before, after) {
  const warnings = [];
  const errors = [];

  if (!isFmBenchReport(before)) errors.push('before file is not a valid fm-bench report');
  if (!isFmBenchReport(after)) errors.push('after file is not a valid fm-bench report');
  if (errors.length > 0) {
    return { compatible: false, warnings, errors, suiteMatch: false };
  }

  const beforeKey = suiteKey(before);
  const afterKey = suiteKey(after);
  const suiteMatch = beforeKey === afterKey;
  if (!suiteMatch) {
    warnings.push('benchmark suites differ (profile, runs, prompts, or concurrency). Summary deltas may be misleading.');
  }

  const bFp = environmentFingerprint(before);
  const aFp = environmentFingerprint(after);
  if (bFp.hwModel && aFp.hwModel && bFp.hwModel !== aFp.hwModel) {
    warnings.push(`hardware model differs (${bFp.hwModel} vs ${aFp.hwModel})`);
  }
  if (bFp.macOSProductVersion && aFp.macOSProductVersion && bFp.macOSProductVersion !== aFp.macOSProductVersion) {
    warnings.push(`macOS version differs (${bFp.macOSProductVersion} vs ${aFp.macOSProductVersion})`);
  }
  if (bFp.macOSBuildVersion && aFp.macOSBuildVersion && bFp.macOSBuildVersion !== aFp.macOSBuildVersion) {
    warnings.push(`macOS build differs (${bFp.macOSBuildVersion} vs ${aFp.macOSBuildVersion})`);
  }
  for (const [name, identity] of Object.entries(bFp.modelIdentities)) {
    const other = aFp.modelIdentities[name];
    if (other && other !== identity) {
      warnings.push(`model ${name} differs (${identity} vs ${other})`);
    }
  }

  return {
    compatible: errors.length === 0,
    warnings,
    errors,
    suiteMatch,
    beforeSuite: beforeKey,
    afterSuite: afterKey,
    beforeFingerprint: bFp,
    afterFingerprint: aFp
  };
}

/**
 * @param {unknown} value
 * @returns {{ ok: true, report: Record<string, unknown> } | { ok: false, errors: string[] }}
 */
export function validateReport(value) {
  const errors = [];
  if (!value || typeof value !== 'object') {
    return { ok: false, errors: ['root must be a JSON object'] };
  }
  const report = /** @type {Record<string, unknown>} */ (value);
  if (report.tool !== 'fm-bench') errors.push('tool must be "fm-bench"');
  for (const key of REQUIRED_TOP_LEVEL) {
    if (!(key in report)) errors.push(`missing required field: ${key}`);
  }
  if (!Array.isArray(report.summary)) {
    errors.push('summary must be an array');
  } else {
    for (const [index, item] of report.summary.entries()) {
      if (!item || typeof item !== 'object') {
        errors.push(`summary[${index}] must be an object`);
        continue;
      }
      const row = /** @type {Record<string, unknown>} */ (item);
      if (typeof row.model !== 'string' || row.model === '') {
        errors.push(`summary[${index}].model must be a non-empty string`);
      }
    }
  }
  if (report.schemaVersion != null && report.schemaVersion !== REPORT_SCHEMA_VERSION) {
    errors.push(`unsupported schemaVersion: ${report.schemaVersion} (expected ${REPORT_SCHEMA_VERSION})`);
  }
  if (report.metrics != null && (typeof report.metrics !== 'object' || Array.isArray(report.metrics))) {
    errors.push('metrics must be an object when present');
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, report };
}

/**
 * Attach schema version and suite metadata without mutating caller's object deeply.
 * @param {Record<string, unknown>} payload
 * @param {{ reportId?: string }} [meta]
 */
export function finalizeReportPayload(payload, meta = {}) {
  const reportId = meta.reportId ?? cryptoRandomId();
  return {
    ...payload,
    schemaVersion: REPORT_SCHEMA_VERSION,
    reportId,
    suite: {
      key: suiteKey(payload),
      profile: payload.options?.profile ?? null,
      promptCount: Array.isArray(payload.prompts) ? payload.prompts.length : 0,
      fingerprint: environmentFingerprint(payload)
    }
  };
}

function cryptoRandomId() {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
