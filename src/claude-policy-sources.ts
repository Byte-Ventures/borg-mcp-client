import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { borgHomeRoot } from './private-root.js';
import { findProjectRoot } from './cubes.js';
import { splitClaudeToolSelectors } from './claude-effective-settings.js';
import { assertClaudeHookPoliciesMigrated, assertToolNamePoliciesMigrated, ToolNameMigrationError } from './tool-name-migration.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const fail = () => new ToolNameMigrationError('claude', 'an agent, skill, command or plugin policy source could not be inspected; check its JSON/YAML definition and installed plugin metadata.');

/** Read definitions as data, never load a plugin or run a host hook. Native
 * get_settings omits frontmatter and CLI agents, so inspect these separately. */
export function inspectClaudePolicySources(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, settings: unknown): void {
  const home = env.HOME || env.USERPROFILE || borgHomeRoot();
  const expand = (value: string, base = cwd) => resolve(base, value === '~' ? home : value.startsWith('~/') ? join(home, value.slice(2)) : value);
  const configRoot = env.CLAUDE_CONFIG_DIR ? expand(env.CLAUDE_CONFIG_DIR) : join(home, '.claude');
  const additional: string[] = [];
  const plugins: string[] = [];
  const inlineAgents: unknown[] = [];
  const seen = new Set<string>();
  let totalBytes = 0, files = 0;
  const read = (path: string): string | undefined => {
    let info;
    try { info = statSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw fail(); }
    if (!info.isFile() || info.size > 4 * 1024 * 1024 || (totalBytes += info.size) > 64 * 1024 * 1024 || ++files > 4096) throw fail();
    try { return readFileSync(path, 'utf8'); } catch { throw fail(); }
  };
  const json = (path: string): unknown => {
    const source = read(path);
    if (source === undefined) return undefined;
    try { return JSON.parse(source); } catch { throw fail(); }
  };
  const inspect = (value: unknown) => {
    if (!record(value)) throw fail();
    const policies: RecordValue = {};
    for (const [from, to] of [['tools', 'tools'], ['disallowedTools', 'disallowedTools'], ['allowedTools', 'allowedTools'], ['allowed-tools', 'allowedTools']] as const) {
      const selectors = value[from];
      if (selectors == null) continue;
      if (typeof selectors === 'string') policies[to] = splitClaudeToolSelectors(selectors);
      else if (Array.isArray(selectors) && selectors.every(entry => typeof entry === 'string')) policies[to] = selectors.flatMap(splitClaudeToolSelectors);
      else throw fail();
    }
    if (value.permissions !== undefined) policies.permissions = value.permissions;
    assertToolNamePoliciesMigrated('claude', policies);
    assertClaudeHookPoliciesMigrated({ hooks: value.hooks });
  };
  const frontmatter = (path: string) => {
    const source = read(path)?.replace(/^\uFEFF/, '');
    if (!source || !/^---[ \t]*\r?\n/.test(source)) return;
    const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
    if (!match) throw fail();
    const document = parseDocument(match[1], { uniqueKeys: true, prettyErrors: false, merge: true });
    if (document.errors.length || document.warnings.length) throw fail();
    let value: unknown;
    try { value = document.toJS({ maxAliasCount: 100 }); JSON.stringify(value); } catch { throw fail(); }
    if (value !== null) inspect(value);
  };
  const walk = (path: string, kind: string) => {
    let physical: string;
    try { physical = realpathSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw fail(); }
    const identity = `${kind}:${physical}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    let info;
    try { info = statSync(physical); } catch { throw fail(); }
    if (info.isFile()) {
      if (kind === 'skills' ? basename(path) === 'SKILL.md' : /\.md$/i.test(path) && basename(path) !== 'README.md') frontmatter(physical);
      return;
    }
    if (!info.isDirectory()) throw fail();
    let entries: string[];
    try { entries = readdirSync(physical); } catch { throw fail(); }
    if (seen.size + entries.length > 8192) throw fail();
    for (const name of entries) walk(join(physical, name), kind);
  };
  const flagValues = (index: number, inline: string | undefined, variadic: boolean): { values: string[]; index: number } => {
    if (inline !== undefined) return { values: [inline], index };
    const values: string[] = [];
    while (index + 1 < args.length && !args[index + 1].startsWith('-')) {
      values.push(args[++index]);
      if (!variadic) break;
    }
    if (!values.length) throw fail();
    return { values, index };
  };
  for (let index = 0; index < args.length && args[index] !== '--'; index++) {
    const [flag, inline] = args[index].split(/=(.*)/s);
    if (flag === '--plugin-url') throw new ToolNameMigrationError('claude', 'a remote plugin cannot be inspected before launch; install it locally before using it through Borg.');
    if (!['--agents', '--add-dir', '--plugin-dir'].includes(flag)) continue;
    const parsed = flagValues(index, inline, flag !== '--agents');
    index = parsed.index;
    for (const value of parsed.values) {
      if (flag === '--add-dir') additional.push(expand(value));
      else if (flag === '--plugin-dir') plugins.push(expand(value));
      else {
        let definitions: unknown;
        if (value.trimStart().startsWith('{')) {
          try { definitions = JSON.parse(value); } catch { throw fail(); }
        } else definitions = json(expand(value));
        if (!record(definitions)) throw fail();
        inlineAgents.push(...Object.values(definitions));
      }
    }
  }
  inlineAgents.forEach(inspect);
  const roots = new Set([configRoot]);
  const projectRoot = findProjectRoot(cwd);
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    roots.add(join(directory, '.claude'));
    if (directory === projectRoot || directory === dirname(directory)) break;
  }
  if (record(settings) && record(settings.effective) && record(settings.effective.permissions)) {
    const paths = settings.effective.permissions.additionalDirectories;
    if (Array.isArray(paths)) for (const path of paths) { if (typeof path !== 'string') throw fail(); additional.push(expand(path)); }
  }
  for (const path of additional) roots.add(join(path, '.claude'));
  for (const root of roots) for (const kind of ['agents', 'skills', 'commands']) walk(join(root, kind), kind);

  // Only enabled installed plugins can contribute auto-discovered definitions.
  const effective = record(settings) && record(settings.effective) ? settings.effective : {};
  const enabled = record(effective.enabledPlugins) ? Object.entries(effective.enabledPlugins).filter(([, value]) => value === true).map(([name]) => name) : [];
  if (enabled.length) {
    const installed = json(join(configRoot, 'plugins', 'installed_plugins.json'));
    if (!record(installed) || !record(installed.plugins)) throw fail();
    for (const name of enabled) {
      const entries = installed.plugins[name];
      if (!Array.isArray(entries)) throw fail();
      const applicable = entries.filter(entry => record(entry) && (entry.scope === 'user' || typeof entry.projectPath === 'string' &&
        (() => { const path = relative(expand(entry.projectPath), cwd); return path === '' || (!path.startsWith('..') && !isAbsolute(path)); })()));
      if (!applicable.length) throw fail();
      for (const entry of applicable) { if (typeof entry.installPath !== 'string') throw fail(); plugins.push(expand(entry.installPath)); }
    }
  }
  for (const root of new Set(plugins)) {
    const manifest = json(join(root, '.claude-plugin', 'plugin.json'));
    if (manifest !== undefined && !record(manifest)) throw fail();
    for (const kind of ['agents', 'skills', 'commands']) {
      walk(join(root, kind), kind);
      const extra = record(manifest) ? manifest[kind] : undefined;
      if (extra === undefined) continue;
      const paths = Array.isArray(extra) ? extra : [extra];
      for (const path of paths) { if (typeof path !== 'string') throw fail(); walk(expand(path, root), kind); }
    }
    const hooks = json(join(root, 'hooks', 'hooks.json'));
    if (hooks !== undefined) assertClaudeHookPoliciesMigrated({ hooks });
    const extraHooks = record(manifest) ? manifest.hooks : undefined;
    if (extraHooks !== undefined) for (const entry of Array.isArray(extraHooks) ? extraHooks : [extraHooks]) {
      const value = typeof entry === 'string' ? json(expand(entry, root)) : entry;
      if (!record(value)) throw fail();
      assertClaudeHookPoliciesMigrated({ hooks: value });
    }
  }
  assertClaudeHookPoliciesMigrated(settings);
}
