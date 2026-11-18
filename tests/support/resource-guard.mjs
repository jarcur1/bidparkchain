// Owns one test resource on behalf of a parent process. Runs the optional command, and when the
// parent exits for any reason (including SIGKILL, which closes this process's stdin), stops the
// command and deletes the listed paths. Usage: node resource-guard.mjs '<json spec>'
//   spec = { command?: string[], cwd?: string, env?: object, removePaths?: string[] }
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const spec = JSON.parse(process.argv[2]);
let child = null;
let finishing = false;

function finish(code) {
  if (finishing) return;
  finishing = true;
  const removeAndExit = () => {
    for (const target of spec.removePaths ?? []) fs.rmSync(target, { recursive: true, force: true });
    process.exit(code);
  };
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    removeAndExit();
    return;
  }
  const forceKill = setTimeout(() => child.kill('SIGKILL'), 3000);
  child.once('exit', () => {
    clearTimeout(forceKill);
    removeAndExit();
  });
  child.kill('SIGTERM');
}

if (spec.command) {
  const [file, ...args] = spec.command;
  child = spawn(file, args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.on('error', (error) => {
    console.error(`[resource-guard] ${error.message}`);
    finish(1);
  });
  // An owned service exiting by itself is reported to the parent through this process's exit code.
  child.on('exit', (code) => finish(code ?? 1));
}

process.stdin.on('end', () => finish(0));
process.stdin.on('close', () => finish(0));
process.stdin.resume();
process.on('SIGTERM', () => finish(0));
process.on('SIGINT', () => finish(0));
