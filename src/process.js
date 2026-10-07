import { spawn } from 'node:child_process';

// Children currently alive. The CLI registers signal handlers that terminate
// these so Ctrl+C cannot leave `fm` processes behind.
const activeChildren = new Set();

export function activeChildCount() {
  return activeChildren.size;
}

/**
 * Terminate every running child process. Returns how many were signalled.
 * @param {NodeJS.Signals} signal
 */
export function killActiveChildren(signal = 'SIGTERM') {
  let killed = 0;
  for (const child of activeChildren) {
    if (child.exitCode != null || child.signalCode != null) continue;
    try {
      child.kill(signal);
      killed += 1;
    } catch {
      // Process already gone.
    }
  }
  return killed;
}

export function runProcess(command, args = [], options = {}) {
  const {
    input,
    timeoutMs = 30_000,
    env = process.env,
    cwd = process.cwd()
  } = options;

  return new Promise((resolve) => {
    const startedAt = process.hrtime.bigint();
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    activeChildren.add(child);

    let stdout = '';
    let stderr = '';
    let stdoutChunks = 0;
    let stderrChunks = 0;
    const stdoutChunkTimesMs = [];
    const stdoutChunkLengths = [];
    let firstStdoutMs = null;
    let firstStderrMs = null;
    let timedOut = false;
    let settled = false;

    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => {
            if (!settled) child.kill('SIGKILL');
          }, 1_000).unref();
        }, timeoutMs)
      : null;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const chunkAtMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      stdoutChunks += 1;
      if (firstStdoutMs == null && chunk.length > 0) {
        firstStdoutMs = chunkAtMs;
      }
      if (chunk.length > 0) {
        stdoutChunkTimesMs.push(chunkAtMs);
        stdoutChunkLengths.push(chunk.length);
      }
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderrChunks += 1;
      if (firstStderrMs == null && chunk.length > 0) {
        firstStderrMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      }
      stderr += chunk;
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(child);
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    child.on('error', (error) => {
      finish({
        command,
        args,
        code: null,
        signal: null,
        stdout,
        stderr: stderr || error.message,
        stdoutChunks,
        stderrChunks,
        stdoutChunkTimesMs,
        stdoutChunkLengths,
        firstStdoutMs,
        firstStderrMs,
        error,
        timedOut,
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6
      });
    });

    child.on('close', (code, signal) => {
      finish({
        command,
        args,
        code,
        signal,
        stdout,
        stderr,
        stdoutChunks,
        stderrChunks,
        stdoutChunkTimesMs,
        stdoutChunkLengths,
        firstStdoutMs,
        firstStderrMs,
        error: null,
        timedOut,
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6
      });
    });

    if (input != null) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}
