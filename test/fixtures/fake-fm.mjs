#!/usr/bin/env node
// Deterministic fake `fm` used by the integration tests.
//
// It mimics the observable surface fm-bench depends on: `--help` (with a
// command list and a MODELS section), `respond --help`, `models` (and the
// deprecated `available`), `count-tokens`/`token-count`, `quota-usage`,
// `license --status`, and `respond` (streaming and not). Scenarios are
// selected with FAKE_FM_SCENARIO so the benchmark path can be driven through
// real, slow, malformed, failing, and interrupted behaviour without Apple's
// binary.
//
// The default surface follows the real macOS 27.2 `fm` output captured in
// test/fixtures/*-macos27.2.txt. FAKE_FM_SCENARIO=legacy-available emulates
// the macOS 27.0 surface (`available` instead of `models`, no quota command)
// captured in test/fixtures/*-macos27.txt.

import process from 'node:process';
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const scenario = process.env.FAKE_FM_SCENARIO || 'normal';
const command = args[0] && !args[0].startsWith('-') ? args[0] : null;
const legacy = scenario === 'legacy-available';

const PCC_REASON = 'Private Cloud Compute is not available in this context. Please use the Terminal app.';
const SYSTEM_REASON = 'Apple Intelligence is not enabled on this Mac.';

// Lets a test verify that fm-bench cleans up the fm processes it started.
if (process.env.FAKE_FM_PID_FILE) {
  appendFileSync(process.env.FAKE_FM_PID_FILE, `${process.pid}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function tokenCountCommand() {
  if (scenario === 'no-token-count') return null;
  if (scenario === 'legacy-token-count') return 'token-count';
  return 'count-tokens';
}

function modelListCommand() {
  return legacy ? 'available' : 'models';
}

function hasQuota() {
  return !legacy;
}

function models() {
  const system = scenario === 'unavailable'
    ? { name: 'system', description: 'On-device Apple Foundation Model', available: false, reason: SYSTEM_REASON }
    : { name: 'system', description: 'On-device Apple Foundation Model', available: true, identity: 'AFM 3 Core Advanced' };
  if (scenario === 'multi-model') {
    return [
      system,
      { name: 'pcc', description: 'Apple Foundation Model on Private Cloud Compute', available: false, reason: PCC_REASON }
    ];
  }
  return [system];
}

function helpText() {
  if (scenario === 'help-garbage') return 'not a cli\n';
  if (scenario === 'error-help') {
    process.stderr.write("Error: Unknown command 'reply'.\n");
    process.exit(1);
  }
  const commands = [];
  if (legacy) commands.push(['available', 'Check model availability']);
  commands.push(['chat', 'Start an interactive chat session']);
  if (!legacy) commands.push(['config', 'View and edit the CLI configuration']);
  const counter = tokenCountCommand();
  if (counter) commands.push([counter, 'Count tokens in a prompt or instructions']);
  commands.push(['license', 'Show and agree to the Legal Notice & Terms']);
  if (!legacy) commands.push(['models', 'Show available models']);
  if (hasQuota()) commands.push(['quota-usage', 'Check model quota usage']);
  commands.push(
    ['respond', 'Generate a response to a prompt'],
    ['schema', 'Generate a structured output generation schema'],
    ['serve', 'Start a Chat Completions API server']
  );

  const commandLines = commands
    .map(([name, description]) => `    ${name.padEnd(14)}${description}`)
    .join('\n');
  const modelLines = models()
    .map((model) => `    ${model.name.padEnd(14)}${model.description}${model.name === 'system' ? ' (default)' : ''}`)
    .join('\n');
  const providerLine = legacy ? '' : `\n    ${'<model>'.padEnd(14)}Model from a custom model provider`;
  const modelsSection = scenario === 'no-models-section' ? '' : `\n  MODELS\n${modelLines}${providerLine}\n`;

  return `\n Apple Foundation Models CLI\n\n  USAGE\n    % fm <command> [options]\n\n  COMMANDS\n${commandLines}\n${modelsSection}\n  Run 'fm <command> --help' for more information on a command.\n\n`;
}

function respondHelpText() {
  const names = models().map((model) => model.name).join(', ');
  const modelFlag = scenario === 'no-model-flag'
    ? ''
    : `    -m, --model <model>     Model to use (${names})\n`;
  const streamFlag = scenario === 'no-streaming'
    ? ''
    : "    --[no-]stream           Stream the output as it's generated (default: on)\n";
  return `
  fm respond
  Generate a response to a prompt.

  USAGE
    % fm respond 'What is Swift?'

  ARGUMENTS
    <prompt>                Prompt for the model to respond to

  OPTIONS
${modelFlag}    -i, --instructions <t>  Instructions for the model to follow
${streamFlag}    -g, --greedy            Use greedy sampling
    -v, --verbose           Print verbose output
    -h, --help              Show help information

  MODELS
    system                  On-device Apple Foundation Model (default)
`;
}

function modelListLine(model) {
  const detail = model.available ? model.identity : model.reason;
  return `  ${model.available ? '✓' : '✗'} ${model.name}${detail ? ` (${detail})` : ''}\n`;
}

function runModelList() {
  const listed = models();
  process.stdout.write('  Apple Foundation Models\n');
  for (const model of listed) process.stdout.write(modelListLine(model));
  process.exit(0);
}

function runLegacyAvailable() {
  if (scenario === 'unavailable') {
    process.stderr.write('Error: The system model is unavailable in this context.\n');
    process.exit(1);
  }
  const modelIndex = args.indexOf('--model');
  const requested = modelIndex >= 0 ? args[modelIndex + 1] : null;
  if (requested) {
    const model = models().find((entry) => entry.name === requested);
    if (!model) {
      process.stderr.write(`Error: The value '${requested}' is invalid for '--model <model>'. Please provide one of '${models().map((entry) => entry.name).join("', '")}'.\n`);
      process.exit(64);
    }
    process.stdout.write(`${requested === 'system' ? 'System' : requested} model ${model.available ? 'available' : 'unavailable'}\n`);
    process.exit(model.available ? 0 : 1);
  }
  for (const model of models()) {
    process.stdout.write(`${model.name.charAt(0).toUpperCase()}${model.name.slice(1)} model ${model.available ? 'available' : 'unavailable'}\n`);
  }
  process.exit(0);
}

function runDeprecatedAvailable() {
  process.stderr.write("warning: 'fm available' has been renamed to 'fm models'; 'available' still works but is deprecated.\n");
  const modelIndex = args.indexOf('--model');
  const requested = modelIndex >= 0 ? args[modelIndex + 1] : null;
  const listed = requested ? models().filter((model) => model.name === requested) : models();
  process.stdout.write('  Apple Foundation Models\n');
  for (const model of listed) process.stdout.write(modelListLine(model));
  process.exit(listed.every((model) => model.available) ? 0 : 1);
}

function runQuota() {
  const modelIndex = args.indexOf('--model');
  const requested = modelIndex >= 0 ? args[modelIndex + 1] : null;
  const lines = {
    system: 'System: Not applicable (quota only applies to PCC)',
    pcc: `PCC: unavailable (${PCC_REASON})`
  };
  const names = requested ? [requested] : models().map((model) => model.name);
  for (const name of names) {
    process.stdout.write(`${lines[name] ?? `${name}: unknown model`}\n`);
  }
  process.exit(0);
}

async function runRespond() {
  const streamed = !args.includes('--no-stream') && scenario !== 'no-streaming';
  const prompt = await readStdin();

  if (scenario === 'fail') {
    process.stderr.write('Error: The model failed to produce a response.\n');
    process.exit(3);
  }
  if (scenario === 'unavailable-model') {
    process.stderr.write("Error: The value 'system' is invalid for '--model <model>'. Please provide one of 'none'.\n");
    process.exit(64);
  }
  if (scenario === 'malformed') {
    // Invalid UTF-8 plus stray control bytes: fm-bench must not crash on it.
    process.stdout.write(Buffer.from([0xff, 0xfe, 0x80]));
    process.stdout.write('replacement bytes \u0007\n');
    process.exit(0);
  }
  if (scenario === 'timeout' || scenario === 'interrupt') {
    await sleep(600_000);
    process.exit(0);
  }
  if (scenario === 'burst') {
    // Real fm on macOS 27.2 writes a short answer's tail as several writes
    // well under a millisecond apart, right after the first chunk.
    process.stdout.write('The on-device model ');
    for (const part of ['replies ', 'with a ', 'deterministic ', 'answer.', '\n']) {
      process.stdout.write(part);
    }
    process.exit(0);
  }

  const chunks = scenario === 'short-answer'
    ? ['ok', '\n']
    : streamed
      ? ['The on-device model ', 'replies ', 'with a ', 'deterministic ', 'answer.']
      : [`The on-device model replies with a deterministic answer for "${prompt.trim()}".`];
  const delayMs = scenario === 'slow' ? 400 : 20;

  for (const [index, chunk] of chunks.entries()) {
    if (index > 0) await sleep(delayMs);
    process.stdout.write(chunk);
    if (scenario === 'partial' && index === 1) {
      process.stderr.write('Error: stream interrupted\n');
      process.exit(1);
    }
  }
  process.stdout.write(scenario === 'short-answer' ? '' : '\n');
  process.exit(0);
}

async function main() {
  if (args.includes('--help') && !command) {
    if (scenario === 'hang-help') {
      // Lets a test interrupt fm-bench while it is still probing capabilities.
      await sleep(600_000);
      process.exit(0);
    }
    process.stdout.write(helpText());
    process.exit(0);
  }
  if (command === 'respond' && args.includes('--help')) {
    process.stdout.write(respondHelpText());
    process.exit(0);
  }

  if (command === 'models' && !legacy) runModelList();
  if (command === 'available') {
    if (legacy) runLegacyAvailable();
    runDeprecatedAvailable();
  }

  if (command === 'license' && args.includes('--status')) {
    if (scenario === 'license-not-agreed') {
      process.stdout.write('You have not agreed to the Legal Notice & Terms. Run fm license to review them.\n');
      process.exit(1);
    }
    process.stdout.write('Agreed to license FM1 version 1.1 on Sep 30, 2026 at 4:45 PM.\n');
    process.exit(0);
  }

  const counter = tokenCountCommand();
  if (command === counter) {
    if (scenario === 'token-count-fails') {
      process.stderr.write("Error: The value 'system' is invalid for '--model <model>'.\n");
      process.exit(64);
    }
    const text = await readStdin();
    if (!text.trim()) {
      process.stderr.write('Error: Missing prompt. Provide a positional prompt, --text, or --image option.\n');
      process.exit(1);
    }
    // Real fm counts one framing token on top of the content tokens.
    const count = text.trim().split(/\s+/).length + 1;
    const quiet = args.includes('--quiet') || args.includes('-q');
    process.stdout.write(quiet || !process.stdout.isTTY ? `${count}\n` : `Token count: ${count}\n`);
    process.exit(0);
  }

  if (command === 'quota-usage' && hasQuota()) runQuota();

  if (command === 'respond') {
    await runRespond();
    return;
  }

  process.stderr.write(`Error: Unknown command '${command}'.\nRun 'fm --help' for the list of commands.\n`);
  process.exit(1);
}

await main();
