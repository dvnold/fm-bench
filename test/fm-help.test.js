import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  firstLine,
  isUnsupportedModelError,
  parseAvailabilityList,
  parseAvailabilityOutput,
  parseModelList,
  parseModelsFromHelp,
  withoutWarnings
} from '../src/fm-help.js';
import { fixturePath } from './helpers.js';

const realHelp = readFileSync(fixturePath('fm-help-macos27.txt'), 'utf8');
const realAvailable = readFileSync(fixturePath('fm-available-macos27.txt'), 'utf8');
const realModels272 = readFileSync(fixturePath('fm-models-macos27.2.txt'), 'utf8');
const realDeprecatedAvailable272 = readFileSync(fixturePath('fm-available-deprecated-macos27.2.txt'), 'utf8');
const PCC_REASON = 'Private Cloud Compute is not available in this context. Please use the Terminal app.';

test('parseModelList reads the captured macOS 27.2 fm models output', () => {
  assert.deepEqual(parseModelList(realModels272), [
    { name: 'system', available: true, identity: 'AFM 3 Core Advanced', reason: '' },
    { name: 'pcc', available: false, identity: '', reason: PCC_REASON }
  ]);
});

test('parseModelList ignores headers, warnings, and ANSI color', () => {
  const colored = `\u001b[31mwarning: 'fm available' has been renamed to 'fm models'.\u001b[0m\n  Apple Foundation Models\n  \u001b[32m✓\u001b[0m system (AFM 3 Core Advanced)\n  ✓ my-model\n`;
  assert.deepEqual(parseModelList(colored).map((model) => [model.name, model.available, model.identity]), [
    ['system', true, 'AFM 3 Core Advanced'],
    ['my-model', true, '']
  ]);
  assert.deepEqual(parseModelList('Apple Foundation Models\n'), []);
});

test('the deprecated fm available on macOS 27.2 is read by its list marks, not by the word "available"', () => {
  // The warning line contains "available" right before the model name, which
  // used to make an unavailable model look available.
  const parsed = parseAvailabilityOutput('pcc', realDeprecatedAvailable272, 1);
  assert.equal(parsed.available, false);
  assert.equal(parsed.reason, PCC_REASON);
  assert.doesNotMatch(parsed.raw, /deprecated/);

  const system = parseAvailabilityOutput('system', "warning: 'fm available' has been renamed to 'fm models'; 'available' still works but is deprecated.\n  ✓ system (AFM 3 Core Advanced)\n", 0);
  assert.equal(system.available, true);
  assert.equal(system.identity, 'AFM 3 Core Advanced');
});

test('withoutWarnings drops fm warning lines only', () => {
  assert.equal(withoutWarnings('warning: renamed\nreal line\n  Warning: also\n'), 'real line\n');
});

test('firstLine keeps the hint that follows the cause on the same line', () => {
  const realPccError = `Error: \u001b[38;2;255;107;128m${PCC_REASON}\u001b[0m\n`;
  assert.equal(firstLine(realPccError), PCC_REASON);
  assert.equal(firstLine("warning: 'fm available' has been renamed\nError: The model failed.\n"), 'The model failed.');
});

test('parseAvailabilityList reads the captured fm available output', () => {
  assert.deepEqual(parseAvailabilityList(realAvailable), [{ name: 'system', available: true }]);
});

test('parseAvailabilityList reads multiple models and unavailable states', () => {
  const parsed = parseAvailabilityList(`
System model available
PCC model unavailable
`);
  assert.deepEqual(parsed, [
    { name: 'system', available: true },
    { name: 'pcc', available: false }
  ]);
});

test('parseAvailabilityList ignores unrelated lines', () => {
  assert.deepEqual(parseAvailabilityList('Checking models...\n'), []);
});

test('parseAvailabilityOutput requires a clean exit and an availability statement', () => {
  assert.equal(parseAvailabilityOutput('system', 'System model available\n', 0).available, true);
  assert.equal(parseAvailabilityOutput('system', 'System model available\n', 1).available, false);
  assert.equal(parseAvailabilityOutput('system', '', 0).available, false);
});

test('parseAvailabilityOutput treats fm argument errors as unavailable', () => {
  const realError = "Error: The value 'pcc' is invalid for '--model <model>'. Please provide one of 'system'.\nHelp:  --model <model>  Model to check: system (default: all)\nUsage: fm available\n";
  const parsed = parseAvailabilityOutput('pcc', realError, 64);
  assert.equal(parsed.available, false);
  assert.match(parsed.reason, /invalid for '--model <model>'/);
  assert.doesNotMatch(parsed.reason, /Usage:|\n/);
});

test('parseAvailabilityOutput flags explicit unavailability', () => {
  const parsed = parseAvailabilityOutput('pcc', 'Error: PCC inference is not available in this context.', 0);
  assert.equal(parsed.available, false);
  assert.match(parsed.reason, /not available/);
});

test('isUnsupportedModelError distinguishes unsupported from unusable', () => {
  assert.equal(isUnsupportedModelError("Error: The value 'pcc' is invalid for '--model <model>'."), true);
  assert.equal(isUnsupportedModelError('Error: The model is unavailable right now.'), false);
});

test('firstLine collapses multi-line fm diagnostics to the actionable cause', () => {
  const text = "Error: The value 'pcc' is invalid for '--model <model>'.\nHelp:  --model <model>\nUsage: fm available\n";
  assert.equal(firstLine(text), "The value 'pcc' is invalid for '--model <model>'.");
  assert.equal(firstLine(''), '');
  assert.equal(firstLine('\u001b[31mplain message\u001b[0m'), 'plain message');
});

test('parseModelsFromHelp reads models and option lists together', () => {
  const models = parseModelsFromHelp(`
  OPTIONS
    -m, --model <model>     Model to use (system, pcc)

  MODELS
    system                  On-device Apple Foundation Model (default)
`);
  assert.deepEqual(models.map((model) => model.name), ['system', 'pcc']);
  assert.equal(models[0].description, 'On-device Apple Foundation Model');
});

test('parseModelsFromHelp does not mistake section headers for models', () => {
  assert.deepEqual(parseModelsFromHelp(realHelp).map((model) => model.name), ['system']);
});
