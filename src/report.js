import fs from 'node:fs/promises';
import path from 'node:path';
import { renderHtmlReport } from './export.js';

export function toCsv(rows) {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(','))
  ].join('\n');
}

export function flattenResults(results) {
  return results.map((result) => ({
    model: result.model,
    concurrency: result.concurrency ?? '',
    prompt_id: result.promptId,
    run: result.run,
    attempts: result.attempts ?? 1,
    ok: result.ok,
    duration_ms: round(result.durationMs),
    ttft_ms: round(result.firstTokenMs),
    generation_ms: round(result.generationMs),
    tpot_ms: round(result.tpotMs),
    prompt_tokens: result.promptTokens ?? '',
    output_tokens: result.outputTokens ?? '',
    chars: result.chars,
    words: result.words,
    tokens_per_second: result.tokensPerSecond == null ? '' : round(result.tokensPerSecond),
    decode_tokens_per_second: result.decodeTokensPerSecond == null ? '' : round(result.decodeTokensPerSecond),
    prefill_tokens_per_second: result.prefillTokensPerSecond == null ? '' : round(result.prefillTokensPerSecond),
    chars_per_second: round(result.charsPerSecond),
    streamed: result.streamed,
    stdout_chunks: result.stdoutChunks,
    second_chunk_ms: round(result.secondChunkMs),
    chunk_gap_avg_ms: round(result.chunkGapAvgMs),
    chunk_gap_max_ms: round(result.chunkGapMaxMs),
    output_hash: result.outputHash || '',
    good: result.good == null ? '' : result.good,
    error: result.error || '',
    first_chunk_tokens: result.firstChunkTokens ?? ''
  }));
}

export async function writeReport(filePath, payload, format) {
  const target = path.resolve(filePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  let content;
  if (format === 'csv') {
    content = toCsv(flattenResults(payload.results));
  } else if (format === 'html') {
    content = renderHtmlReport(payload);
  } else {
    content = `${JSON.stringify(payload, null, 2)}\n`;
  }
  await fs.writeFile(target, content, 'utf8');
  return target;
}

function csvEscape(value) {
  const text = String(value ?? '');
  const safe = guardFormula(text);
  if (/[",\n\r]/.test(safe)) {
    return `"${safe.replaceAll('"', '""')}"`;
  }
  return safe;
}

// Spreadsheet programs execute cells that start with =, +, @, or a non-numeric
// leading -. Prompt text and captured output are untrusted input, so prefix
// those cells with a single quote to keep them literal text.
function guardFormula(text) {
  if (/^[=+@\t\r]/.test(text)) return `'${text}`;
  if (text.startsWith('-') && !/^-?\d+(\.\d+)?$/.test(text)) return `'${text}`;
  return text;
}

function round(value) {
  if (!Number.isFinite(value)) return '';
  return Math.round(value * 100) / 100;
}
