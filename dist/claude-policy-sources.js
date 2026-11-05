import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import { borgHomeRoot } from './private-root.js';
import { findProjectRoot } from './cubes.js';
import { splitClaudeToolSelectors } from './claude-effective-settings.js';
import { claudeManagedAgentDirectory } from './claude-managed-policy.js';
import { assertClaudeHookPoliciesMigrated, assertToolNamePoliciesMigrated, ToolNameMigrationError } from './tool-name-migration.js';
const record = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const fail = () => new ToolNameMigrationError('claude', 'an agent, skill, command or plugin policy source could not be inspected; check its JSON/YAML definition and installed plugin metadata.');
/** Read definitions as data, never load a plugin or run a host hook. Native
 * get_settings omits frontmatter and CLI agents, so inspect these separately. */
export function inspectClaudePolicySources(args, cwd, env, settings) {
    const home = env.HOME || env.USERPROFILE || borgHomeRoot();
    const expand = (value, base = cwd) => resolve(base, value === '~' ? home : value.startsWith('~/') ? join(home, value.slice(2)) : value);
    const configRoot = env.CLAUDE_CONFIG_DIR ? expand(env.CLAUDE_CONFIG_DIR) : join(home, '.claude');
    const additional = [];
    const plugins = [];
    const inlineAgents = [];
    const seen = new Set();
    let totalBytes = 0, files = 0, discoveredEntries = 0;
    const read = (path) => {
        let info;
        try {
            info = statSync(path);
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return undefined;
            throw fail();
        }
        if (!info.isFile() || info.size > 4 * 1024 * 1024 || (totalBytes += info.size) > 64 * 1024 * 1024 || ++files > 4096)
            throw fail();
        try {
            return readFileSync(path, 'utf8');
        }
        catch {
            throw fail();
        }
    };
    const json = (path) => {
        const source = read(path);
        if (source === undefined)
            return undefined;
        try {
            return JSON.parse(source);
        }
        catch {
            throw fail();
        }
    };
    const inspect = (value) => {
        if (!record(value))
            throw fail();
        const policies = {};
        for (const [from, to] of [['tools', 'tools'], ['disallowedTools', 'disallowedTools'], ['allowedTools', 'allowedTools'], ['allowed-tools', 'allowedTools']]) {
            const selectors = value[from];
            if (selectors == null)
                continue;
            if (typeof selectors === 'string')
                policies[to] = splitClaudeToolSelectors(selectors);
            else if (Array.isArray(selectors) && selectors.every(entry => typeof entry === 'string'))
                policies[to] = selectors.flatMap(splitClaudeToolSelectors);
            else
                throw fail();
        }
        if (value.permissions !== undefined)
            policies.permissions = value.permissions;
        assertToolNamePoliciesMigrated('claude', policies);
        assertClaudeHookPoliciesMigrated({ hooks: value.hooks });
    };
    const inspectMarkdown = (text) => {
        const source = text?.replace(/^\uFEFF/, '');
        if (!source || !/^---[ \t]*\r?\n/.test(source))
            return;
        const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
        if (!match)
            throw fail();
        const document = parseDocument(match[1], { uniqueKeys: true, prettyErrors: false, merge: true });
        if (document.errors.length || document.warnings.length)
            throw fail();
        let value;
        try {
            value = document.toJS({ maxAliasCount: 100 });
            JSON.stringify(value);
        }
        catch {
            throw fail();
        }
        if (value !== null)
            inspect(value);
    };
    const frontmatter = (path) => inspectMarkdown(read(path));
    const commandPath = (root, value) => {
        if (typeof value !== 'string' || !value.startsWith('./'))
            throw fail();
        try {
            const physical = realpathSync(expand(value, root));
            const local = relative(realpathSync(root), physical);
            if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local))
                throw fail();
            return physical;
        }
        catch {
            throw fail();
        }
    };
    const walk = (path, kind) => {
        let physical;
        try {
            physical = realpathSync(path);
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return;
            throw fail();
        }
        const identity = `${kind}:${physical}`;
        let info;
        try {
            info = statSync(physical);
        }
        catch {
            throw fail();
        }
        if (info.isFile()) {
            const eligible = kind === 'skills' ? basename(path) === 'SKILL.md'
                : /\.md$/i.test(path) && (kind === 'agents' || basename(path) !== 'README.md');
            // An ancillary symlink must not mark its SKILL.md target inspected.
            if (eligible && !seen.has(identity)) {
                seen.add(identity);
                frontmatter(physical);
            }
            return;
        }
        if (!info.isDirectory())
            throw fail();
        if (seen.has(identity))
            return;
        seen.add(identity);
        let entries;
        try {
            entries = readdirSync(physical);
        }
        catch {
            throw fail();
        }
        if ((discoveredEntries += entries.length) > 8192)
            throw fail();
        for (const name of entries)
            walk(join(physical, name), kind);
    };
    const flagValues = (index, inline, variadic) => {
        if (inline !== undefined)
            return { values: [inline], index };
        const values = [];
        while (index + 1 < args.length && !args[index + 1].startsWith('-')) {
            values.push(args[++index]);
            if (!variadic)
                break;
        }
        if (!values.length)
            throw fail();
        return { values, index };
    };
    for (let index = 0; index < args.length && args[index] !== '--'; index++) {
        const [flag, inline] = args[index].split(/=(.*)/s);
        if (flag === '--plugin-url')
            throw new ToolNameMigrationError('claude', 'a remote plugin cannot be inspected before launch; install it locally before using it through Borg.');
        if (!['--agents', '--add-dir', '--plugin-dir'].includes(flag))
            continue;
        const parsed = flagValues(index, inline, flag !== '--agents');
        index = parsed.index;
        for (const value of parsed.values) {
            if (flag === '--add-dir')
                additional.push(expand(value));
            else if (flag === '--plugin-dir')
                plugins.push(expand(value));
            else {
                let definitions;
                if (value.trimStart().startsWith('{')) {
                    try {
                        definitions = JSON.parse(value);
                    }
                    catch {
                        throw fail();
                    }
                }
                else
                    definitions = json(expand(value));
                if (!record(definitions))
                    throw fail();
                inlineAgents.push(...Object.values(definitions));
            }
        }
    }
    inlineAgents.forEach(inspect);
    const roots = new Set([configRoot]);
    const projectRoot = findProjectRoot(cwd);
    for (let directory = resolve(cwd);; directory = dirname(directory)) {
        roots.add(join(directory, '.claude'));
        if (directory === projectRoot || directory === dirname(directory))
            break;
    }
    if (record(settings) && record(settings.effective) && record(settings.effective.permissions)) {
        const paths = settings.effective.permissions.additionalDirectories;
        if (Array.isArray(paths))
            for (const path of paths) {
                if (typeof path !== 'string')
                    throw fail();
                additional.push(expand(path));
            }
    }
    for (const path of additional)
        roots.add(join(path, '.claude'));
    for (const root of roots)
        for (const kind of ['agents', 'skills', 'commands'])
            walk(join(root, kind), kind);
    // Bare get_settings omits file-based agents, including the highest-priority
    // managed definitions outside the user's configurable Claude directory.
    walk(claudeManagedAgentDirectory(), 'agents');
    // Only enabled installed plugins can contribute auto-discovered definitions.
    const effective = record(settings) && record(settings.effective) ? settings.effective : {};
    const enabled = record(effective.enabledPlugins) ? Object.entries(effective.enabledPlugins).filter(([, value]) => value === true).map(([name]) => name) : [];
    if (enabled.length) {
        const installed = json(join(configRoot, 'plugins', 'installed_plugins.json'));
        if (!record(installed) || !record(installed.plugins))
            throw fail();
        for (const name of enabled) {
            const entries = installed.plugins[name];
            if (!Array.isArray(entries))
                throw fail();
            const applicable = entries.filter(entry => record(entry) && (entry.scope === 'user' || typeof entry.projectPath === 'string' &&
                (() => { const path = relative(expand(entry.projectPath), cwd); return path === '' || (!path.startsWith('..') && !isAbsolute(path)); })()));
            if (!applicable.length)
                throw fail();
            for (const entry of applicable) {
                if (typeof entry.installPath !== 'string')
                    throw fail();
                plugins.push(expand(entry.installPath));
            }
        }
    }
    for (const root of new Set(plugins)) {
        const manifest = json(join(root, '.claude-plugin', 'plugin.json'));
        if (manifest !== undefined && !record(manifest))
            throw fail();
        for (const kind of ['agents', 'skills', 'commands']) {
            const extra = record(manifest) ? manifest[kind] : undefined;
            // Explicit command/agent declarations replace the default scan; skills
            // are additive. Do not inspect ignored defaults as active policies.
            if (extra === undefined || kind === 'skills')
                walk(join(root, kind), kind);
            if (extra === undefined)
                continue;
            if (kind === 'commands' && record(extra)) {
                for (const command of Object.values(extra)) {
                    if (!record(command) || Object.hasOwn(command, 'source') === Object.hasOwn(command, 'content'))
                        throw fail();
                    if (command.allowedTools !== undefined && (!Array.isArray(command.allowedTools) ||
                        !command.allowedTools.every(tool => typeof tool === 'string')))
                        throw fail();
                    inspect({ allowedTools: command.allowedTools });
                    if (Object.hasOwn(command, 'source')) {
                        const source = read(commandPath(root, command.source));
                        if (source === undefined)
                            throw fail();
                        inspectMarkdown(source);
                    }
                    else {
                        if (typeof command.content !== 'string')
                            throw fail();
                        inspectMarkdown(command.content);
                    }
                }
                continue;
            }
            const paths = Array.isArray(extra) ? extra : [extra];
            for (const path of paths) {
                if (typeof path !== 'string')
                    throw fail();
                if (kind !== 'commands') {
                    walk(expand(path, root), kind);
                    continue;
                }
                const source = commandPath(root, path);
                let info;
                try {
                    info = statSync(source);
                }
                catch {
                    throw fail();
                }
                if (info.isFile())
                    frontmatter(source);
                else
                    walk(source, kind);
            }
        }
        const hooks = json(join(root, 'hooks', 'hooks.json'));
        if (hooks !== undefined)
            assertClaudeHookPoliciesMigrated({ hooks });
        const extraHooks = record(manifest) ? manifest.hooks : undefined;
        if (extraHooks !== undefined)
            for (const entry of Array.isArray(extraHooks) ? extraHooks : [extraHooks]) {
                const value = typeof entry === 'string' ? json(expand(entry, root)) : entry;
                if (!record(value))
                    throw fail();
                assertClaudeHookPoliciesMigrated({ hooks: value });
            }
    }
    assertClaudeHookPoliciesMigrated(settings);
}
//# sourceMappingURL=claude-policy-sources.js.map