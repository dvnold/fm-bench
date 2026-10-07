import test from 'node:test';
import assert from 'node:assert/strict';
import { DELIVERY_COALESCE_MS, groupDeliveries, parseAvailabilityOutput, parseModelsFromHelp } from '../src/fm.js';

test('parseModelsFromHelp extracts models from fm help', () => {
  const models = parseModelsFromHelp(`
  MODELS
    system        On-device Apple Foundation Model (default)
    pcc           Apple Foundation Model on Private Cloud Compute
  `);

  assert.deepEqual(models, [
    { name: 'system', description: 'On-device Apple Foundation Model' },
    { name: 'pcc', description: 'Apple Foundation Model on Private Cloud Compute' }
  ]);
});

test('parseModelsFromHelp also uses model option lists', () => {
  const models = parseModelsFromHelp('    -m, --model <model>     Model to use (system, pcc, future-model)');
  assert.deepEqual(models.map((model) => model.name), ['system', 'pcc', 'future-model']);
});

test('parseAvailabilityOutput treats explicit errors as unavailable', () => {
  const parsed = parseAvailabilityOutput('pcc', 'Error: PCC inference is not available in this context.', 0);
  assert.equal(parsed.available, false);
});

test('parseAvailabilityOutput detects available model line', () => {
  const parsed = parseAvailabilityOutput('system', 'System model available', 0);
  assert.equal(parsed.available, true);
});

test('groupDeliveries merges write bursts under 5 ms and keeps real stream steps apart', () => {
  // Shape captured from real fm on macOS 27.2: first chunk, a real 54 ms
  // delta, then the tail written as a burst 0.11 ms later.
  const deliveries = groupDeliveries([680, 734, 734.11], [90, 30, 2]);
  assert.deepEqual(deliveries, [
    { atMs: 680, endChars: 90 },
    { atMs: 734, endChars: 122 }
  ]);
  assert.deepEqual(groupDeliveries([500, 500.04, 500.5], [40, 20, 1]), [{ atMs: 500, endChars: 61 }]);
  assert.deepEqual(groupDeliveries([], []), []);
  assert.equal(DELIVERY_COALESCE_MS, 5);
});
