// Performs GUARD_FIXTURE_ACTION on GUARD_FIXTURE_TARGET (a fake protected
// config set through BORG_TEST_GUARD_PROTECTED_CONFIG), as a missed isolation
// path would; 'none' writes nothing. Content is deliberately marker-free.
import { it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

it('acts on the protected directory', () => {
  const target = process.env.GUARD_FIXTURE_TARGET!;
  const action = process.env.GUARD_FIXTURE_ACTION;
  if (action === 'create') writeFileSync(join(target, 'representative.json'), '{"version":1,"bindings":{}}');
  if (action === 'modify') writeFileSync(join(target, 'existing.json'), '{"changed":true}');
  if (action === 'delete') rmSync(join(target, 'existing.json'));
  if (action === 'child') {
    spawnSync(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(join(target, 'from-child'))}, 'x')`]);
  }
});
