import fs from 'node:fs';
import path from 'node:path';
import which from 'which';
import { inspectManagedAgentHookConfigs, refreshManagedAgentHookConfigs, refreshManagedAgentMcpConfigs, } from './config-utils.js';
import { borgHomeRoot } from './private-root.js';
import { getPackageVersion } from './version.js';
export const AGENT_HOOK_BINS = [
    'borg-regen',
    'borg-clear-rewake',
    'borg-log-audit',
    'borg-foreign-path-reminder',
    'borg-inbox-monitor',
];
function findOwningPackage(startPath) {
    let directory = path.dirname(startPath);
    const root = path.parse(directory).root;
    while (true) {
        const packagePath = path.join(directory, 'package.json');
        try {
            const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
            if (typeof parsed.name === 'string' && typeof parsed.version === 'string') {
                return { name: parsed.name, version: parsed.version };
            }
        }
        catch {
            // Keep walking. npm bin links resolve into a package's dist directory.
        }
        if (directory === root)
            return null;
        directory = path.dirname(directory);
    }
}
function defaultResolveBin(name, searchPath) {
    try {
        return which.sync(name, searchPath === undefined ? undefined : { path: searchPath });
    }
    catch {
        return null;
    }
}
export function inspectAgentIntegrationHealth(options = {}) {
    const expectedVersion = options.expectedVersion ?? getPackageVersion();
    const homeDir = options.homeDir ?? borgHomeRoot();
    const resolveBin = options.resolveBin ?? defaultResolveBin;
    const bins = AGENT_HOOK_BINS.map((name) => {
        const found = resolveBin(name, options.path);
        if (!found)
            return { name, status: 'missing' };
        let resolvedPath;
        try {
            resolvedPath = fs.realpathSync(found);
        }
        catch (error) {
            return {
                name,
                status: 'unreadable',
                resolvedPath: found,
                detail: error instanceof Error ? error.message : String(error),
            };
        }
        const owner = findOwningPackage(resolvedPath);
        if (!owner || owner.name !== 'borgmcp') {
            return {
                name,
                status: 'wrong-owner',
                resolvedPath,
                owner: owner?.name ?? 'unknown',
                version: owner?.version,
            };
        }
        if (owner.version !== expectedVersion) {
            return { name, status: 'version-skew', resolvedPath, owner: owner.name, version: owner.version };
        }
        return { name, status: 'ok', resolvedPath, owner: owner.name, version: owner.version };
    });
    const pluginPath = path.join(homeDir, '.config', 'opencode', 'plugins', 'borg-orient.js');
    const hookConfigs = inspectManagedAgentHookConfigs(homeDir);
    return {
        expectedVersion,
        bins,
        issues: [
            ...bins.filter((bin) => bin.status !== 'ok'),
            ...hookConfigs.filter((config) => config.status === 'stale' || config.status === 'invalid'),
        ],
        hookConfigs,
        openCodePlugin: { path: pluginPath, present: fs.existsSync(pluginPath) },
    };
}
function renderBin(bin, expectedVersion) {
    switch (bin.status) {
        case 'ok': return `${bin.name}: ok (${bin.version})`;
        case 'missing': return `${bin.name}: missing`;
        case 'wrong-owner': return `${bin.name}: wrong owner ${bin.owner}${bin.version ? `@${bin.version}` : ''}${bin.resolvedPath ? ` at ${bin.resolvedPath}` : ''}`;
        case 'version-skew': return `${bin.name}: version ${bin.version}, expected ${expectedVersion}${bin.resolvedPath ? ` at ${bin.resolvedPath}` : ''}`;
        case 'unreadable': return `${bin.name}: unreadable${bin.resolvedPath ? ` at ${bin.resolvedPath}` : ''}${bin.detail ? ` (${bin.detail})` : ''}`;
    }
}
export function renderAgentIntegrationHealth(report) {
    const lines = [
        `Borg agent integration (borgmcp ${report.expectedVersion})`,
        ...report.bins.map((bin) => `  ${renderBin(bin, report.expectedVersion)}`),
        'Hook configuration:',
        ...report.hookConfigs.map((item) => (`  ${item.status}: ${item.path}${item.detail ? ` (${item.detail})` : ''}`)),
        `OpenCode borg-orient.js plugin: ${report.openCodePlugin.present ? 'present' : 'absent'} (${report.openCodePlugin.path})`,
    ];
    for (const bin of report.bins) {
        switch (bin.status) {
            case 'missing':
                lines.push(`Repair missing ${bin.name}: npm install --global borgmcp@${report.expectedVersion} --ignore-scripts`);
                break;
            case 'wrong-owner':
            case 'version-skew':
                lines.push(`Fix PATH so ${bin.name} resolves to borgmcp@${report.expectedVersion}, then run: borg doctor`);
                break;
            case 'unreadable':
                lines.push(`Fix or replace unreadable ${bin.name}, then run: borg doctor`);
                break;
            case 'ok':
                break;
        }
    }
    for (const config of report.hookConfigs) {
        if (config.status === 'stale') {
            lines.push('Repair stale managed hooks: borg update --yes');
        }
        else if (config.status === 'invalid') {
            lines.push(config.detail?.startsWith('inventory failed:')
                ? `Restore readable, non-symlinked hook inventory path ${config.path}, then run: borg doctor`
                : `Repair invalid managed hook config ${config.path}, then run: borg update --yes`);
        }
    }
    return `${lines.join('\n')}\n`;
}
export function assertAgentIntegrationHealthy(report) {
    if (report.issues.length === 0)
        return;
    throw new Error(renderAgentIntegrationHealth(report).trim());
}
export function runDoctor(options = {}) {
    const report = inspectAgentIntegrationHealth(options);
    (options.stdout ?? ((text) => process.stdout.write(text)))(renderAgentIntegrationHealth(report));
    return report.issues.length === 0 ? 0 : 1;
}
export function warnIfAgentIntegrationUnhealthy(options = {}) {
    const stderr = options.stderr ?? ((text) => process.stderr.write(text));
    try {
        const report = inspectAgentIntegrationHealth(options);
        if (report.issues.length === 0)
            return true;
        stderr(`Warning: Borg agent integration is incomplete or version-skewed.\n${renderAgentIntegrationHealth(report)}`);
        return false;
    }
    catch (error) {
        stderr(`Warning: Borg agent integration health check failed; launch continues: ${error instanceof Error ? error.message : String(error)}\n`);
        return false;
    }
}
/** Update-time whole-integration refresh. Attempt each independent surface so
 * one malformed config does not hide later repairs, then aggregate failures. */
export function refreshAndVerifyManagedAgentIntegrations() {
    const failures = [];
    try {
        refreshManagedAgentMcpConfigs();
    }
    catch (error) {
        failures.push(`${error instanceof Error ? error.message : String(error)}. ` +
            'Repair the named agent MCP config, then rerun borg update --yes');
    }
    try {
        refreshManagedAgentHookConfigs();
    }
    catch (error) {
        failures.push(`${error instanceof Error ? error.message : String(error)}. ` +
            'Repair the named managed hook config, then rerun borg update --yes');
    }
    try {
        assertAgentIntegrationHealthy(inspectAgentIntegrationHealth());
    }
    catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
    }
    if (failures.length > 0)
        throw new Error(failures.join('; '));
}
//# sourceMappingURL=agent-integration-health.js.map