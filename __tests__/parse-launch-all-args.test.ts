import { describe, it, expect } from 'vitest';
import { parseLaunchAllArgs } from '../src/parse-launch-all-args';

describe('parseLaunchAllArgs (gh#556 Part 2 §11.1)', () => {
  it('[] → no cube, no flags', () => {
    expect(parseLaunchAllArgs([])).toEqual({ ok: true, args: { cubeName: undefined, flags: {} } });
  });
  it('[mycube] → cubeName set', () => {
    expect(parseLaunchAllArgs(['mycube'])).toEqual({ ok: true, args: { cubeName: 'mycube', flags: {} } });
  });
  it('--mode tmux → mode set', () => {
    const r = parseLaunchAllArgs(['--mode', 'tmux']);
    expect(r).toMatchObject({ ok: true, args: { flags: { mode: 'tmux' } } });
  });
  it('--mode invalid → error', () => {
    const r = parseLaunchAllArgs(['--mode', 'invalid']);
    expect(r.ok).toBe(false);
  });
  it('--only builder → only set', () => {
    expect(parseLaunchAllArgs(['--only', 'builder'])).toMatchObject({ ok: true, args: { flags: { only: 'builder' } } });
  });
  it('--only with no value → error', () => {
    expect(parseLaunchAllArgs(['--only']).ok).toBe(false);
    expect(parseLaunchAllArgs(['--only', '--force']).ok).toBe(false);
  });
  it('--dry-run → dryRun true', () => {
    expect(parseLaunchAllArgs(['--dry-run'])).toMatchObject({ ok: true, args: { flags: { dryRun: true } } });
  });
  it('--cli codex → cli set; --cli vim → error', () => {
    expect(parseLaunchAllArgs(['--cli', 'codex'])).toMatchObject({ ok: true, args: { flags: { cli: 'codex' } } });
    expect(parseLaunchAllArgs(['--cli', 'vim']).ok).toBe(false);
  });
  it('--no-attach → noAttach true', () => {
    expect(parseLaunchAllArgs(['--no-attach'])).toMatchObject({ ok: true, args: { flags: { noAttach: true } } });
  });
  it('--yes / -y → yes true', () => {
    expect(parseLaunchAllArgs(['--yes'])).toMatchObject({ ok: true, args: { flags: { yes: true } } });
    expect(parseLaunchAllArgs(['-y'])).toMatchObject({ ok: true, args: { flags: { yes: true } } });
  });
  it('--force → force true', () => {
    expect(parseLaunchAllArgs(['--force'])).toMatchObject({ ok: true, args: { flags: { force: true } } });
  });
  it('--launch-delay 3000 → launchDelayMs 3000; 0 is valid (disables stagger)', () => {
    expect(parseLaunchAllArgs(['--launch-delay', '3000'])).toMatchObject({ ok: true, args: { flags: { launchDelayMs: 3000 } } });
    expect(parseLaunchAllArgs(['--launch-delay', '0'])).toMatchObject({ ok: true, args: { flags: { launchDelayMs: 0 } } });
  });
  it('--launch-delay rejects missing/negative/non-integer values', () => {
    expect(parseLaunchAllArgs(['--launch-delay']).ok).toBe(false);
    expect(parseLaunchAllArgs(['--launch-delay', '-5']).ok).toBe(false);
    expect(parseLaunchAllArgs(['--launch-delay', '1.5']).ok).toBe(false);
    expect(parseLaunchAllArgs(['--launch-delay', 'abc']).ok).toBe(false);
  });
  it('two positionals → error', () => {
    expect(parseLaunchAllArgs(['cube1', 'cube2']).ok).toBe(false);
  });
  it('--unknown → error listing supported flags', () => {
    const r = parseLaunchAllArgs(['--unknown']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('--mode');
  });
  it('combines positional + multiple flags', () => {
    const r = parseLaunchAllArgs(['mycube', '--mode', 'tmux', '--only', 'drone-3', '--yes', '--dry-run']);
    expect(r).toEqual({
      ok: true,
      args: { cubeName: 'mycube', flags: { mode: 'tmux', only: 'drone-3', yes: true, dryRun: true } },
    });
  });
});
