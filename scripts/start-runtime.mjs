import { spawn } from 'node:child_process';

const services = [
  {
    name: 'api',
    command: process.execPath,
    args: ['apps/api/dist/index.js'],
  },
];

if (process.env.RUN_WORKER !== 'false') {
  services.push({
    name: 'worker',
    command: process.execPath,
    args: ['apps/worker/dist/index.js'],
  });
}

const children = new Map();
let shuttingDown = false;

function writePrefixed(prefix, text, target) {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    target.write(`[${prefix}] ${line}\n`);
  }
}

function bindOutput(child, name) {
  let stdoutBuffer = '';
  let stderrBuffer = '';

  child.stdout?.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    const parts = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = parts.pop() ?? '';
    writePrefixed(name, parts.join('\n'), process.stdout);
  });

  child.stderr?.on('data', (chunk) => {
    stderrBuffer += chunk.toString();
    const parts = stderrBuffer.split(/\r?\n/);
    stderrBuffer = parts.pop() ?? '';
    writePrefixed(name, parts.join('\n'), process.stderr);
  });

  child.stdout?.on('end', () => {
    if (stdoutBuffer) {
      writePrefixed(name, stdoutBuffer, process.stdout);
    }
  });

  child.stderr?.on('end', () => {
    if (stderrBuffer) {
      writePrefixed(name, stderrBuffer, process.stderr);
    }
  });
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children.values()) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }

  setTimeout(() => process.exit(exitCode), 2000);
}

for (const service of services) {
  const child = spawn(service.command, service.args, {
    env: process.env,
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  children.set(service.name, child);
  bindOutput(child, service.name);

  child.on('exit', (code, signal) => {
    children.delete(service.name);
    if (shuttingDown) {
      return;
    }

    const detail = signal ? `signal ${signal}` : `code ${code ?? 0}`;
    process.stderr.write(`[launcher] ${service.name} exited with ${detail}\n`);
    shutdown(code ?? 1);
  });

  child.on('error', (error) => {
    if (shuttingDown) {
      return;
    }

    process.stderr.write(`[launcher] failed to start ${service.name}: ${error.message}\n`);
    shutdown(1);
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
