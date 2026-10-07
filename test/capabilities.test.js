import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  detectFmCapabilities,
  hasFlagInHelp,
  helpDigest,
  parseCommandsFromHelp,
  resolveModelListCommand,
  resolveTokenCountCommand
} from '../src/capabilities.js';
import { parseModelsFromHelp } from '../src/fm-help.js';
import { fakeFmPath } from './helpers.js';

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const realHelp = readFileSync(join(fixtureDir, 'fixtures/fm-help-macos27.txt'), 'utf8');
const realRespondHelp = readFileSync(join(fixtureDir, 'fixtures/fm-respond-help-macos27.txt'), 'utf8');

test('parseCommandsFromHelp reads the captured macOS 27 fm help', () => {
  assert.deepEqual(parseCommandsFromHelp(realHelp), [
    'available',
    'chat',
    'count-tokens',
    'license',
    'respond',
    'schema',
    'serve'
  ]);
});

test('parseCommandsFromHelp stops at the next section header', () => {
  const commands = parseCommandsFromHelp(`
  COMMANDS
    alpha         First command
    beta          Second command

  MODELS
    system        On-device model
`);
  assert.deepEqual(commands, ['alpha', 'beta']);
});

test('parseCommandsFromHelp returns nothing for unrelated output', () => {
  assert.deepEqual(parseCommandsFromHelp('not a cli\n'), []);
});

test('resolveTokenCountCommand prefers count-tokens and accepts the legacy name', () => {
  assert.equal(resolveTokenCountCommand(['available', 'count-tokens']), 'count-tokens');
  assert.equal(resolveTokenCountCommand(['available', 'token-count']), 'token-count');
  assert.equal(resolveTokenCountCommand(['available', 'respond']), null);
  assert.equal(resolveTokenCountCommand([]), null);
});

test('hasFlagInHelp understands Apple negatable flag syntax', () => {
  assert.equal(hasFlagInHelp(realRespondHelp, '--no-stream'), true);
  assert.equal(hasFlagInHelp(realRespondHelp, '--use-case'), true);
  assert.equal(hasFlagInHelp(realRespondHelp, '--guardrails'), true);
  assert.equal(hasFlagInHelp(realRespondHelp, '--model'), true);
  assert.equal(hasFlagInHelp(realRespondHelp, '--not-a-real-flag'), false);
});

test('helpDigest is stable and ignores ANSI escapes', () => {
  assert.equal(helpDigest(realHelp), helpDigest(realHelp));
  assert.equal(helpDigest(`\u001b[32m${realHelp}\u001b[0m`), helpDigest(realHelp));
  assert.equal(helpDigest(''), null);
  assert.match(helpDigest(realHelp), /^[0-9a-f]{16}$/);
});

test('detectFmCapabilities describes the macOS 27.2 fm surface', async () => {
  const capabilities = await detectFmCapabilities(fakeFmPath(), {
    env: { ...process.env, FAKE_FM_SCENARIO: 'normal' }
  });
  assert.equal(capabilities.ok, true);
  assert.deepEqual(capabilities.commands, [
    'chat',
    'config',
    'count-tokens',
    'license',
    'models',
    'quota-usage',
    'respond',
    'schema',
    'serve'
  ]);
  assert.deepEqual(capabilities.models.map((model) => model.name), ['system']);
  assert.equal(capabilities.features.tokenCounting, true);
  assert.equal(capabilities.features.tokenCountCommand, 'count-tokens');
  assert.equal(capabilities.features.modelListCommand, 'models');
  assert.equal(capabilities.features.license, true);
  assert.equal(capabilities.features.streaming, true);
  assert.equal(capabilities.features.useCase, false);
  assert.equal(capabilities.features.quota, true);
  assert.deepEqual(capabilities.warnings, []);
});

test('detectFmCapabilities describes the macOS 27.0 fm surface', async () => {
  const capabilities = await detectFmCapabilities(fakeFmPath(), {
    env: { ...process.env, FAKE_FM_SCENARIO: 'legacy-available' }
  });
  assert.deepEqual(capabilities.commands, [
    'available',
    'chat',
    'count-tokens',
    'license',
    'respond',
    'schema',
    'serve'
  ]);
  assert.equal(capabilities.features.modelListCommand, 'available');
  assert.equal(capabilities.features.quota, false);
  assert.match(capabilities.warnings.join('\n'), /no quota command/);
});

test('the captured macOS 27.2 help parses to the real command, model, and flag set', () => {
  const help = readFileSync(join(fixtureDir, 'fixtures/fm-help-macos27.2.txt'), 'utf8');
  const respondHelp = readFileSync(join(fixtureDir, 'fixtures/fm-respond-help-macos27.2.txt'), 'utf8');
  const commands = parseCommandsFromHelp(help);
  assert.deepEqual(commands, ['chat', 'config', 'count-tokens', 'license', 'models', 'quota-usage', 'respond', 'schema', 'serve']);
  assert.equal(resolveModelListCommand(commands), 'models');
  assert.deepEqual(parseModelsFromHelp(help), [
    { name: 'system', description: 'On-device Apple Foundation Model' },
    { name: 'pcc', description: 'Apple Foundation Model on Private Cloud Compute' }
  ], 'the "<model>" custom-provider placeholder is not a model');
  for (const flag of ['--model', '--no-stream', '--instructions', '--greedy', '--use-case', '--guardrails']) {
    assert.equal(hasFlagInHelp(respondHelp, flag), true, flag);
  }
});

test('resolveModelListCommand prefers models over the deprecated available', () => {
  assert.equal(resolveModelListCommand(['available', 'models']), 'models');
  assert.equal(resolveModelListCommand(['available']), 'available');
  assert.equal(resolveModelListCommand(['respond']), null);
});

test('detectFmCapabilities recognises a legacy token-count command', async () => {
  const capabilities = await detectFmCapabilities(fakeFmPath(), {
    env: { ...process.env, FAKE_FM_SCENARIO: 'legacy-token-count' }
  });
  assert.equal(capabilities.features.tokenCounting, true);
  assert.equal(capabilities.features.tokenCountCommand, 'token-count');
  assert.ok(capabilities.commands.includes('token-count'));
});

test('detectFmCapabilities reports token counting unavailable instead of guessing', async () => {
  const capabilities = await detectFmCapabilities(fakeFmPath(), {
    env: { ...process.env, FAKE_FM_SCENARIO: 'no-token-count' }
  });
  assert.equal(capabilities.features.tokenCounting, false);
  assert.equal(capabilities.features.tokenCountCommand, null);
  assert.match(capabilities.warnings.join('\n'), /no token-counting command/);
});

test('detectFmCapabilities detects optional flags and quota support', async () => {
  const withQuota = await detectFmCapabilities(fakeFmPath(), {
    env: { ...process.env, FAKE_FM_SCENARIO: 'normal' }
  });
  assert.equal(withQuota.features.quota, true);
  assert.ok(withQuota.commands.includes('quota-usage'));

  const noStreaming = await detectFmCapabilities(fakeFmPath(), {
    env: { ...process.env, FAKE_FM_SCENARIO: 'no-streaming' }
  });
  assert.equal(noStreaming.features.streaming, false);
  assert.match(noStreaming.warnings.join('\n'), /streaming flag/);

  const noModelFlag = await detectFmCapabilities(fakeFmPath(), {
    env: { ...process.env, FAKE_FM_SCENARIO: 'no-model-flag' }
  });
  assert.equal(noModelFlag.features.modelSelection, false);
});

test('detectFmCapabilities fails cleanly when fm cannot be executed or lists nothing', async () => {
  const missing = await detectFmCapabilities('/nonexistent/fm-binary');
  assert.equal(missing.ok, false);
  assert.match(missing.error, /Unable to execute/);
  assert.deepEqual(missing.commands, []);

  const garbage = await detectFmCapabilities(fakeFmPath(), {
    env: { ...process.env, FAKE_FM_SCENARIO: 'help-garbage' }
  });
  assert.equal(garbage.ok, false);
  assert.deepEqual(garbage.commands, []);
  assert.match(garbage.warnings.join('\n'), /could not read the command list/);
});

test('parseModelsFromHelp reads the captured macOS 27 MODELS section', () => {
  const models = parseModelsFromHelp(realHelp);
  assert.deepEqual(models, [
    { name: 'system', description: 'On-device Apple Foundation Model' }
  ]);
});

test('parseModelsFromHelp does not invent cloud models', () => {
  const models = parseModelsFromHelp(`
  MODELS
    system        On-device Apple Foundation Model (default)
`);
  assert.deepEqual(models.map((model) => model.name), ['system']);
});

test('detectFmCapabilities falls back to fm models when help has no MODELS section', async () => {
  const capabilities = await detectFmCapabilities(fakeFmPath(), {
    env: { ...process.env, FAKE_FM_SCENARIO: 'no-models-section' }
  });
  assert.equal(capabilities.ok, true);
  assert.deepEqual(capabilities.models.map((model) => model.name), ['system']);
  assert.deepEqual(capabilities.commands.includes('count-tokens'), true);
});
