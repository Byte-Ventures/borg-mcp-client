#!/usr/bin/env node

/**
 * Non-blocking pre-tool reminder for a Borg-launched seat.
 *
 * Claude Code and Codex pass a JSON hook payload on stdin. The hook only
 * emits a reminder when the payload names a working directory or target path
 * outside the two paths Borg granted to this seat. It never returns a deny
 * decision and exits successfully for malformed, missing, or unconfigured
 * input so the harness permission layer remains the enforcement point.
 */

import { isAbsolute, relative, resolve } from 'node:path';
import {
  BORG_LAUNCH_SCRATCH_ENV,
  BORG_LAUNCH_WORKTREE_ENV,
} from './launch-access.js';

const PATH_KEYS = new Set([
  'cwd',
  'workdir',
  'working_directory',
  'directory',
  'dir',
  'path',
  'file_path',
  'target_path',
  'source_path',
  'destination_path',
  'old_path',
  'new_path',
]);

const COMMAND_KEYS = new Set(['command', 'cmd', 'shell_command']);

interface HookPayload {
  cwd?: unknown;
  tool_input?: unknown;
  input?: unknown;
  [key: string]: unknown;
}

function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolveInput) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    process.stdin.on('end', () => resolveInput(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolveInput(''));
  });
}

function configuredRoots(): string[] {
  return [process.env[BORG_LAUNCH_WORKTREE_ENV], process.env[BORG_LAUNCH_SCRATCH_ENV]]
    .filter((root): root is string => typeof root === 'string' && isAbsolute(root))
    .map((root) => resolve(root));
}

function isInsideAnyRoot(candidate: string, roots: string[]): boolean {
  const absolute = resolve(candidate);
  return roots.some((root) => {
    const suffix = relative(root, absolute);
    return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix));
  });
}

function pathFromValue(value: string, baseCwd: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(baseCwd, value);
}

function absolutePathsInCommand(command: string): string[] {
  const paths: string[] = [];
  const pattern = /(?:^|[\s"'=])((?:\/|[A-Za-z]:[\\/])[^\s"'`;&|<>]*)/g;
  for (const match of command.matchAll(pattern)) {
    const value = match[1]?.replace(/[),.]+$/, '');
    if (value) paths.push(value);
  }
  return paths;
}

function containsForeignTarget(value: unknown, key: string, baseCwd: string, roots: string[]): boolean {
  if (typeof value === 'string') {
    if (PATH_KEYS.has(key)) return !isInsideAnyRoot(pathFromValue(value, baseCwd), roots);
    if (COMMAND_KEYS.has(key)) {
      return absolutePathsInCommand(value).some((path) => !isInsideAnyRoot(path, roots));
    }
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsForeignTarget(item, key, baseCwd, roots));
  }
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).some(([childKey, childValue]) =>
    containsForeignTarget(childValue, childKey, baseCwd, roots)
  );
}

function shouldRemind(payload: HookPayload, roots: string[]): boolean {
  const baseCwd = typeof payload.cwd === 'string' && payload.cwd.length > 0
    ? resolve(payload.cwd)
    : roots[0];
  if (!isInsideAnyRoot(baseCwd, roots)) return true;
  return containsForeignTarget(payload.tool_input ?? payload.input ?? payload, 'input', baseCwd, roots);
}

async function main(): Promise<void> {
  const roots = configuredRoots();
  if (roots.length === 0) return;

  const raw = await readStdin();
  if (!raw.trim()) return;
  let payload: HookPayload;
  try {
    payload = JSON.parse(raw) as HookPayload;
  } catch {
    return;
  }
  if (!shouldRemind(payload, roots)) return;

  process.stdout.write(
    'Reminder: this seat is scoped to its own worktree and scratch root; coordinate before working on a foreign path.\n'
  );
}

main().catch(() => {
  // A reminder hook is advisory only and must never block a tool call.
});
