// Capability detection for the installed `fm` CLI.
//
// fm-bench talks to whatever `fm` build is on the machine, and Apple has
// changed subcommand names and flags between releases (for example
// `count-tokens` replaces the older `token-count`). Everything downstream
// reads this detection result instead of hardcoding subcommand names, so a
// compatible `fm` build is supported without a code change and an
// incompatible one is reported instead of producing wrong numbers.

import crypto from 'node:crypto';
import { stripAnsi } from './ansi.js';
import { parseAvailabilityList, parseModelList, parseModelsFromHelp } from './fm-help.js';
import { runProcess } from './process.js';

const SECTION_HEADER = /^\s*[A-Z][A-Z0-9 /-]+\s*$/;

/**
 * Parse the COMMANDS section of `fm --help`.
 * @param {string} helpText
 * @returns {string[]}
 */
export function parseCommandsFromHelp(helpText = '') {
  const lines = stripAnsi(helpText).split(/\r?\n/);
  const commands = [];
  let inCommands = false;

  for (const line of lines) {
    if (/^\s*COMMANDS\s*$/.test(line)) {
      inCommands = true;
      continue;
    }
    if (inCommands && SECTION_HEADER.test(line)) {
      inCommands = false;
    }
    if (!inCommands) continue;

    const match = line.match(/^\s{2,}([a-z][a-z0-9-]*)\s{2,}\S/);
    if (match) commands.push(match[1]);
  }

  return commands;
}

/**
 * True when a long flag appears in `fm` help text. Apple prints boolean flags
 * with a negatable form (`--[no-]stream`), so accept that shape too.
 * @param {string} helpText
 * @param {string} flag e.g. "--use-case"
 */
export function hasFlagInHelp(helpText, flag) {
  const clean = stripAnsi(helpText);
  if (new RegExp(`${escapeRegExp(flag)}\\b`).test(clean)) return true;
  if (flag.startsWith('--no-')) {
    return clean.includes(`[no-]${flag.slice('--no-'.length)}`);
  }
  return false;
}

export function helpDigest(helpText = '') {
  const text = stripAnsi(helpText).trim();
  if (!text) return null;
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * Pick the subcommand this `fm` build exposes for token counting.
 * @returns {string|null}
 */
export function resolveTokenCountCommand(commands = []) {
  if (commands.includes('count-tokens')) return 'count-tokens';
  if (commands.includes('token-count')) return 'token-count';
  return null;
}

/**
 * Pick the subcommand this `fm` build uses to report model availability.
 * macOS 27.2 renamed `available` to `models`; the old name still works there
 * but prints a deprecation warning, so prefer the new one.
 * @returns {'models'|'available'|null}
 */
export function resolveModelListCommand(commands = []) {
  if (commands.includes('models')) return 'models';
  if (commands.includes('available')) return 'available';
  return null;
}

function buildFeatures(helpText, respondHelpText, commands) {
  const tokenCountCommand = resolveTokenCountCommand(commands);
  const respondHelp = respondHelpText || '';
  return {
    tokenCounting: tokenCountCommand != null,
    tokenCountCommand,
    modelListCommand: resolveModelListCommand(commands),
    license: commands.includes('license'),
    quota: commands.includes('quota-usage'),
    streaming: hasFlagInHelp(respondHelp, '--no-stream') || hasFlagInHelp(respondHelp, '--stream'),
    modelSelection: hasFlagInHelp(respondHelp, '--model'),
    instructions: hasFlagInHelp(respondHelp, '--instructions'),
    greedy: hasFlagInHelp(respondHelp, '--greedy'),
    useCase: hasFlagInHelp(respondHelp, '--use-case'),
    guardrails: hasFlagInHelp(respondHelp, '--guardrails'),
    images: hasFlagInHelp(respondHelp, '--image'),
    tools: hasFlagInHelp(respondHelp, '--tool'),
    structuredOutput: hasFlagInHelp(respondHelp, '--schema'),
    server: commands.includes('serve')
  };
}

function capabilityWarnings(commands, features, models) {
  const warnings = [];
  if (!features.tokenCounting) {
    warnings.push('this fm build exposes no token-counting command, so token counts and token throughput are unavailable');
  }
  if (!features.quota) {
    warnings.push('this fm build exposes no quota command, so quota is not reported');
  }
  if (!features.streaming) {
    warnings.push('this fm build does not document a streaming flag, so TTFT cannot be measured');
  }
  if (models.length === 0) {
    warnings.push('could not discover any models from fm help output');
  }
  if (commands.length === 0) {
    warnings.push('could not read the command list from fm --help');
  }
  return warnings;
}

/**
 * Probe the installed `fm` binary once and describe what it can do.
 *
 * @param {string} fmBin
 * @param {{ timeoutMs?: number, env?: NodeJS.ProcessEnv, help?: { text: string } }} [options]
 */
export async function detectFmCapabilities(fmBin, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const env = options.env ?? process.env;
  let helpText = options.help?.text ?? null;

  if (helpText == null) {
    const help = await runProcess(fmBin, ['--help'], { timeoutMs, env });
    if (help.error) {
      return {
        ok: false,
        bin: fmBin,
        error: `Unable to execute ${fmBin}: ${help.stderr || help.error.message}`,
        commands: [],
        models: [],
        features: buildFeatures('', '', []),
        digest: null,
        help: '',
        warnings: [`cannot execute ${fmBin}`]
      };
    }
    helpText = `${help.stdout}${help.stderr}`;
  }

  const cleanHelp = stripAnsi(helpText);
  const commands = parseCommandsFromHelp(cleanHelp);

  let respondHelpText = '';
  if (commands.includes('respond')) {
    const respondHelp = await runProcess(fmBin, ['respond', '--help'], { timeoutMs, env });
    if (!respondHelp.error) respondHelpText = `${respondHelp.stdout}${respondHelp.stderr}`;
  }

  const features = buildFeatures(cleanHelp, respondHelpText, commands);
  let models = parseModelsFromHelp(cleanHelp);

  if (models.length === 0 && features.modelListCommand) {
    models = await discoverModelsFromList(fmBin, features.modelListCommand, { ...options, env });
  }

  return {
    ok: commands.length > 0,
    bin: fmBin,
    commands,
    models,
    features,
    digest: helpDigest(cleanHelp),
    help: cleanHelp,
    warnings: capabilityWarnings(commands, features, models)
  };
}

/**
 * Fallback discovery: ask `fm models` (or legacy `fm available`) without a
 * model filter and read the model names it reports. Used when `fm --help` has
 * no MODELS section.
 */
async function discoverModelsFromList(fmBin, command, options = {}) {
  const result = await runProcess(fmBin, [command], {
    timeoutMs: options.timeoutMs ?? 15_000,
    env: options.env ?? process.env
  });
  if (result.error) return [];
  const output = `${result.stdout}${result.stderr}`;
  const listed = parseModelList(output);
  const models = listed.length > 0 ? listed : parseAvailabilityList(output);
  return models.map((model) => ({ name: model.name, description: '' }));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
