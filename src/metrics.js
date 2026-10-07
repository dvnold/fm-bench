// Metric provenance catalog.
//
// fm-bench measures `fm` from the outside, so not every named metric can be
// observed directly. Each metric declares how it is obtained:
//
//   measured   — observed directly (process timings, exit codes, token counts)
//   proxy      — observed at a coarser granularity than the ideal metric
//   derived    — computed from other measured values
//   controlled — an input setting, not a measurement
//
// A metric whose requirement is missing from the detected `fm` build is
// reported as unavailable with a reason instead of a blank or invented value.

const DEFINITIONS = [
  {
    key: 'ttft',
    label: 'TTFT',
    kind: 'proxy',
    source: 'arrival time of the first streamed stdout chunk',
    requires: ['streaming'],
    reason: 'requires an fm build whose output can be streamed'
  },
  {
    key: 'e2eLatency',
    label: 'E2E latency',
    kind: 'measured',
    source: 'wall clock from spawning fm until it exits',
    requires: []
  },
  {
    key: 'generationMs',
    label: 'generation time',
    kind: 'derived',
    source: 'last streamed stdout delivery minus the first (chunks under 5 ms apart are one delivery)',
    requires: ['streaming'],
    reason: 'requires at least two streamed output chunks to separate prefill from decode'
  },
  {
    key: 'tpot',
    label: 'TPOT',
    kind: 'derived',
    source: 'generation time / output tokens that arrived after the first chunk',
    requires: ['streaming', 'tokenCounting'],
    reason: 'requires streaming, a token-counting fm command, and at least two tokens after the first chunk'
  },
  {
    key: 'firstChunkTokens',
    label: 'first-chunk tokens',
    kind: 'measured',
    source: 'fm count-tokens on the first streamed stdout delivery, minus the counter framing overhead',
    requires: ['streaming', 'tokenCounting'],
    reason: 'requires streaming plus a token-counting fm command'
  },
  {
    key: 'promptTokens',
    label: 'prompt tokens',
    kind: 'measured',
    source: 'fm count-tokens on the prompt',
    requires: ['tokenCounting'],
    reason: 'this fm build exposes no token-counting command'
  },
  {
    key: 'outputTokens',
    label: 'output tokens',
    kind: 'measured',
    source: 'fm count-tokens on the captured output, minus the calibrated counter framing overhead',
    requires: ['tokenCounting'],
    reason: 'this fm build exposes no token-counting command'
  },
  {
    key: 'tokensPerSecond',
    label: 'per-request output tokens/s',
    kind: 'derived',
    source: 'output tokens / E2E seconds',
    requires: ['tokenCounting'],
    reason: 'requires a token-counting fm command'
  },
  {
    key: 'decodeTokensPerSecond',
    label: 'decode tokens/s',
    kind: 'derived',
    source: 'output tokens after the first chunk / generation seconds',
    requires: ['streaming', 'tokenCounting'],
    reason: 'requires streaming, a token-counting fm command, and at least two tokens after the first chunk'
  },
  {
    key: 'prefillTokensPerSecond',
    label: 'prefill tokens/s',
    kind: 'proxy',
    source: 'prompt tokens / TTFT seconds',
    requires: ['streaming', 'tokenCounting'],
    reason: 'requires streaming plus a token-counting fm command'
  },
  {
    key: 'outputTokenThroughput',
    label: 'aggregate output token throughput',
    kind: 'derived',
    source: 'successful output tokens / measured wall-clock window',
    requires: ['tokenCounting'],
    reason: 'requires a token-counting fm command'
  },
  {
    key: 'rps',
    label: 'request throughput',
    kind: 'measured',
    source: 'successful requests / measured wall-clock window',
    requires: []
  },
  {
    key: 'chunkGaps',
    label: 'chunk gaps and second-chunk delay',
    kind: 'proxy',
    source: 'gaps between consecutive streamed stdout deliveries (chunks under 5 ms apart are one delivery)',
    requires: ['streaming'],
    reason: 'requires an fm build whose output can be streamed'
  },
  {
    key: 'percentiles',
    label: 'percentiles',
    kind: 'derived',
    source: 'percentile interpolation over successful samples',
    requires: []
  },
  {
    key: 'successRate',
    label: 'success rate',
    kind: 'measured',
    source: 'successful runs / attempted runs',
    requires: []
  },
  {
    key: 'goodput',
    label: 'goodput',
    kind: 'derived',
    source: 'successful runs meeting every configured SLO / runs with an SLO verdict',
    requires: ['slo'],
    reason: 'set --slo-ttft-ms, --slo-e2e-ms, or --slo-tpot-ms to enable goodput'
  },
  {
    key: 'repeatability',
    label: 'repeatability',
    kind: 'derived',
    source: 'most common normalized output hash share across repeated runs',
    requires: []
  },
  {
    key: 'variability',
    label: 'CV and 95% confidence interval',
    kind: 'derived',
    source: 'sample standard deviation over successful samples',
    requires: [],
    reason: 'needs at least two successful samples'
  },
  {
    key: 'quota',
    label: 'quota',
    kind: 'measured',
    source: 'fm quota-usage',
    requires: ['quota'],
    reason: 'this fm build exposes no quota command'
  }
];

function requirementsMet(requires = [], context = {}) {
  return requires.every((name) => {
    if (name === 'streaming') return Boolean(context.streaming);
    if (name === 'tokenCounting') return Boolean(context.tokenCounting);
    if (name === 'quota') return Boolean(context.quota);
    if (name === 'slo') return Boolean(context.slo);
    return true;
  });
}

/**
 * Describe which metrics the detected `fm` build can support for a run.
 *
 * @param {{ features?: Record<string, any> }} [capabilities]
 * @param {{ stream?: boolean, slo?: boolean }} [options]
 */
export function metricAvailability(capabilities = {}, options = {}) {
  const features = capabilities.features ?? {};
  const context = {
    streaming: options.stream !== false && features.streaming !== false,
    tokenCounting: features.tokenCounting !== false,
    quota: features.quota === true,
    slo: options.slo === true
  };

  const metrics = {};
  for (const definition of DEFINITIONS) {
    const available = requirementsMet(definition.requires, context);
    metrics[definition.key] = {
      label: definition.label,
      kind: definition.kind,
      source: definition.source,
      available,
      unavailableReason: available ? '' : (definition.reason ?? 'unavailable in this environment')
    };
  }
  return metrics;
}

/** Short human line for CLI output, e.g. "token counting: yes, quota: no". */
export function formatCapabilitySummary(capabilities = {}) {
  const features = capabilities.features ?? {};
  return [
    `token counting ${features.tokenCounting ? 'yes' : 'no'}`,
    `streaming ${features.streaming ? 'yes' : 'no'}`,
    `quota ${features.quota ? 'yes' : 'no'}`
  ].join(', ');
}
