// gh#556 Part 2 — `borg launch-all [cube]` dependency seam.
//
// LaunchAllDeps is the full injectable seam list (per spec §10) so every
// pure module (discovery / parser / orchestrator / backends) is unit-testable
// with vi.fn() stubs. buildDefaultLaunchAllDeps() (added in launch-all-cmd
// wiring / Phase 4) wires the real-IO production modules.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync, readdirSync, } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { readAllProjectIdentities as cubesReadAllProjectIdentities, getProjectCliPreferenceForPath, findProjectRoot, getActiveCube, } from './cubes.js';
import { getRoster, getCube, getValidToken, API_URL } from './remote-client.js';
import { defaultProbeSeat } from './seat-probe.js';
/** Real-IO factory wiring production modules (spec §10). Test code stubs LaunchAllDeps directly. */
export function buildDefaultLaunchAllDeps() {
    return {
        runSync: (cmd, args, opts) => {
            const r = spawnSync(cmd, args, { encoding: 'utf-8', cwd: opts?.cwd });
            if (r.error)
                throw r.error;
            if (r.status !== 0) {
                throw new Error(`${cmd} exited ${r.status}: ${(r.stderr ?? '').toString().trim()}`);
            }
            return (r.stdout ?? '').toString();
        },
        runSyncExitCode: (cmd, args) => spawnSync(cmd, args, { encoding: 'utf-8' }).status ?? 1,
        attachInteractive: (cmd, args) => {
            spawnSync(cmd, args, { stdio: 'inherit' });
        },
        cwd: () => process.cwd(),
        pathExists: (p) => existsSync(p),
        homedir: () => osHomedir(),
        mkdirp: (dir) => {
            mkdirSync(dir, { recursive: true });
        },
        readFileOpt: (p) => {
            try {
                return readFileSync(p, 'utf-8');
            }
            catch {
                return null;
            }
        },
        writeFile: (p, content, mode) => {
            writeFileSync(p, content, { mode: mode ?? 0o600 });
        },
        unlinkOpt: (p) => {
            try {
                unlinkSync(p);
            }
            catch {
                /* ENOENT ignored */
            }
        },
        statMtime: (p) => {
            try {
                return statSync(p).mtimeMs;
            }
            catch {
                return null;
            }
        },
        listDir: (p) => {
            try {
                return readdirSync(p);
            }
            catch {
                return [];
            }
        },
        getCachedAuth: async () => {
            try {
                return { token: await getValidToken(), apiUrl: API_URL };
            }
            catch {
                return null;
            }
        },
        getRoster: (token, apiUrl, since) => getRoster(token, apiUrl, since),
        // getCube uses the user OAuth token via authedFetch (cubeId-only); apiUrl/token unused.
        getCube: (_apiUrl, _token, cubeId) => getCube(cubeId),
        probeSeat: (sessionToken, apiUrl) => defaultProbeSeat(sessionToken, apiUrl),
        getCliPreferenceForPath: (projectPath) => getProjectCliPreferenceForPath(projectPath),
        readAllProjectIdentities: () => cubesReadAllProjectIdentities(),
        findProjectRoot: (dir) => findProjectRoot(dir),
        getActiveCube: () => getActiveCube(),
        prompt: async (message) => {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            try {
                return (await rl.question(message)).trim();
            }
            finally {
                rl.close();
            }
        },
        isTTY: () => process.stdin.isTTY === true,
        getEnv: (name) => process.env[name],
        platform: () => process.platform,
        stderr: (line) => {
            process.stderr.write(line);
        },
        stdout: (line) => {
            process.stdout.write(line);
        },
    };
}
//# sourceMappingURL=launch-all-deps.js.map