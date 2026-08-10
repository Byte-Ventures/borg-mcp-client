import { describe, expect, it } from 'vitest';
import { buildLaunchCommand } from '../src/launch-all-command';

const candidate = {
  worktreeDir: "/work trees/builder's tree",
  droneId: "00000001-0000-0000-0000-00000000000'",
};

describe('buildLaunchCommand', () => {
  it('shell-escapes the worktree, borg path, and full drone id', () => {
    expect(buildLaunchCommand(candidate, "/opt/borg tools/borg's")).toBe(
      "cd '/work trees/builder'\\''s tree' && '/opt/borg tools/borg'\\''s' launch '00000001-0000-0000-0000-00000000000'\\'''"
    );
  });

  it('includes the complete UUID instead of a label or prefix', () => {
    const droneId = '12345678-1234-4234-8234-123456789abc';
    expect(buildLaunchCommand({ worktreeDir: '/worktree', droneId }, '/usr/local/bin/borg')).toContain(
      `launch '${droneId}'`
    );
  });

  it('uses the exact keep-open failure copy', () => {
    expect(buildLaunchCommand(candidate, '/usr/local/bin/borg', { keepOpenOnFail: true })).toBe(
      "cd '/work trees/builder'\\''s tree' && '/usr/local/bin/borg' launch '00000001-0000-0000-0000-00000000000'\\''' || { echo \"borg launch failed — press Enter to close\"; read _; }"
    );
  });

  it('always emits a single-line command', () => {
    expect(buildLaunchCommand(candidate, '/usr/local/bin/borg')).not.toMatch(/[\r\n]/);
  });
});
