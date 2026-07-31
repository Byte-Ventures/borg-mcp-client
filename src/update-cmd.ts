import { spawn } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import which from 'which';
import { updateHelpText } from './cli-help.js';
import { preflightBorgServerTag } from './server-handshake.js';
import { loadBorgServerTrust } from './server-trust.js';

const CLIENT_PACKAGE = 'borgmcp';
const SERVER_PACKAGE = 'borgmcp-server';
const SHARED_PACKAGE = 'borgmcp-shared';
const CANONICAL_NPM_REGISTRY = 'https://registry.npmjs.org/';
const REENTRY_ENV = 'BORG_UPDATE_REENTRY';
const MAX_CAPTURE_BYTES = 1024 * 1024;
const EXACT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export interface PublishedPackage {
  name: typeof CLIENT_PACKAGE | typeof SERVER_PACKAGE;
  version: string;
  integrity: string;
  sharedVersion: string;
}

export interface InstalledPackage {
  name: typeof CLIENT_PACKAGE | typeof SERVER_PACKAGE;
  version: string;
  sharedVersion: string;
  packageRoot: string;
  binPath: string;
}

export interface UpdateTarget {
  clientVersion: string;
  serverVersion: string;
  serverPresent?: boolean;
}

export interface UpdateOptions {
  yes: boolean;
  help?: boolean;
  target?: UpdateTarget;
}

export type ParsedUpdateArgs =
  | ({ ok: true } & UpdateOptions)
  | { ok: false; error: string };

export interface UpdateDeps {
  currentClient(): Promise<InstalledPackage>;
  currentServer(): Promise<InstalledPackage | null>;
  publishedPackage(
    name: typeof CLIENT_PACKAGE | typeof SERVER_PACKAGE,
    version: string,
  ): Promise<PublishedPackage>;
  publishedVersions(name: typeof CLIENT_PACKAGE | typeof SERVER_PACKAGE): Promise<string[]>;
  installGlobal(
    name: typeof CLIENT_PACKAGE | typeof SERVER_PACKAGE,
    version: string,
    options?: { ignoreScripts?: boolean },
  ): Promise<void>;
  reenter(binPath: string, args: readonly string[]): Promise<number>;
  serverJson(binPath: string, command: 'update' | 'status'): Promise<unknown>;
  verifyRunningProtocol(origin: string): Promise<void>;
  confirm(message: string): Promise<'yes' | 'no' | 'eof' | 'interrupted'>;
  isTTY(): boolean;
  stdout(text: string): void;
  stderr(text: string): void;
  calls?: string[];
}

interface ServerStatus {
  state: 'running' | 'stopped';
  installedController: string;
  preparedRuntime: string | null;
  preparedIntegrity: string | null;
  runningRuntime: string | null;
  runningIntegrity: string | null;
  buildIdentity: string | null;
  endpoint: string | null;
  mode: 'foreground' | 'managed' | 'legacy' | 'stopped';
  serviceAdapter: 'launchd' | 'systemd' | null;
  dataIdentity: 'available' | 'unavailable';
  nextAction: string | null;
}

interface ServerUpdateSuccess {
  status: 'prepared' | 'updated';
  installedController: string;
  artifact: string;
  artifactIntegrity: string;
  runningRuntime: string | null;
  buildIdentity: string | null;
  mode: 'stopped' | 'managed';
  nextAction: string | null;
}

interface ServerUpdateFailure {
  status: 'failed';
  errorCode: 'ARTIFACT_VERIFICATION_FAILED' | 'ACTIVATION_FAILED';
  recovery: 'verification_failed' | 'restored' | 'stopped' | 'recovery_failed';
}

type ServerUpdateResult = ServerUpdateSuccess | ServerUpdateFailure;
type ServerUpdateFailureStage =
  | 'initial server status check'
  | 'server controller identity check'
  | 'server runtime activation'
  | 'post-update server status check'
  | 'final server state verification'
  | 'final package verification'
  | 'managed service continuity check'
  | 'running server protocol verification';

interface NpmContext {
  commandPath: string;
  commandIdentity: string;
  prefix: string;
  root: string;
}

function signalExitCode(error: unknown): number | null {
  return error instanceof CommandSignalError ? error.exitCode : null;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function renderReentryPreflightFailure(error: unknown, target: UpdateTarget): string {
  return (
    `Update preflight failed: ${errorMessage(error, 'unknown failure')}\n` +
    `Observed update state:\n` +
    `  client: ${CLIENT_PACKAGE}@${target.clientVersion} installed and verified before re-entry\n` +
    `  server controller: not changed by this continuation\n` +
    `  prepared runtime: not inspected\n` +
    `  running runtime: not inspected\n` +
    `Server mutation was not attempted.\n` +
    `Retry with: borg update --yes\n`
  );
}

function renderServerState(
  client: InstalledPackage,
  server: InstalledPackage,
  status: ServerStatus | null,
  update: ServerUpdateResult | null,
): string {
  const updateLine = update === null
    ? 'unavailable'
    : update.status === 'failed'
      ? `failed ${update.errorCode} (${update.recovery})`
      : `${update.status} ${update.artifact} (${update.artifactIntegrity})`;
  return (
    `Observed update state:\n` +
    `  client (last verified): ${client.name}@${client.version} (${SHARED_PACKAGE}@${client.sharedVersion})\n` +
    `  server controller (last verified): ${server.name}@${server.version} (${SHARED_PACKAGE}@${server.sharedVersion})\n` +
    `  prepared runtime: ${status?.preparedRuntime ?? 'unavailable'}\n` +
    `  prepared integrity: ${status?.preparedIntegrity ?? 'unavailable'}\n` +
    `  running runtime: ${status?.runningRuntime ?? 'unavailable'}\n` +
    `  running integrity: ${status?.runningIntegrity ?? 'unavailable'}\n` +
    `  server update: ${updateLine}\n`
  );
}

export function isExactSemver(value: unknown): value is string {
  return typeof value === 'string' && EXACT_SEMVER.test(value);
}

function isCanonicalSha512Integrity(value: unknown): boolean {
  if (typeof value !== 'string' || !value.startsWith('sha512-') || value.includes(' ')) return false;
  const encoded = value.slice('sha512-'.length);
  try {
    const bytes = Buffer.from(encoded, 'base64');
    return bytes.length === 64 && bytes.toString('base64') === encoded;
  } catch {
    return false;
  }
}

function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.origin === value &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

export function parseUpdateArgs(
  args: readonly string[],
  reentryAuthorized = false,
): ParsedUpdateArgs {
  let yes = false;
  let help = false;
  let clientVersion: string | undefined;
  let serverVersion: string | undefined;
  let serverPresent: boolean | undefined;
  let hasInternalOption = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--yes' || arg === '-y') {
      yes = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--target-client' || arg === '--target-server' || arg === '--server-present') {
      hasInternalOption = true;
      const value = args[index + 1];
      if (!value) return { ok: false, error: `${arg} requires a value` };
      index += 1;
      if (arg === '--target-client') clientVersion = value;
      if (arg === '--target-server') serverVersion = value;
      if (arg === '--server-present') {
        if (value !== 'yes' && value !== 'no') {
          return { ok: false, error: '--server-present requires yes or no' };
        }
        serverPresent = value === 'yes';
      }
    } else {
      return { ok: false, error: `unknown option: ${arg}` };
    }
  }

  if (hasInternalOption && !reentryAuthorized) {
    return { ok: false, error: 'internal update continuation is unavailable' };
  }
  if (hasInternalOption) {
    if (!clientVersion || !serverVersion || serverPresent === undefined) {
      return { ok: false, error: 'internal update continuation requires both target versions and server presence' };
    }
    if (!isExactSemver(clientVersion) || !isExactSemver(serverVersion)) {
      return { ok: false, error: 'internal update continuation requires exact versions' };
    }
    return {
      ok: true,
      yes,
      ...(help ? { help: true } : {}),
      target: { clientVersion, serverVersion, serverPresent },
    };
  }
  return { ok: true, yes, ...(help ? { help: true } : {}) };
}

function validatePublishedPackage(
  value: PublishedPackage,
  expectedName: typeof CLIENT_PACKAGE | typeof SERVER_PACKAGE,
): void {
  if (value.name !== expectedName || !isExactSemver(value.version)) {
    throw new Error(`registry returned an invalid ${expectedName} manifest identity (missing or invalid name/version field)`);
  }
  if (!isCanonicalSha512Integrity(value.integrity)) {
    throw new Error(`registry returned invalid ${expectedName} SHA-512 integrity`);
  }
  if (!isExactSemver(value.sharedVersion)) {
    throw new Error(`registry returned a non-exact ${expectedName} ${SHARED_PACKAGE} dependency`);
  }
}

async function publishedPair(
  target: UpdateTarget | undefined,
  deps: UpdateDeps,
): Promise<{ client: PublishedPackage; server: PublishedPackage }> {
  const [client, server] = await Promise.all([
    deps.publishedPackage(CLIENT_PACKAGE, target?.clientVersion ?? 'latest'),
    deps.publishedPackage(SERVER_PACKAGE, target?.serverVersion ?? 'latest'),
  ]);
  validatePublishedPackage(client, CLIENT_PACKAGE);
  validatePublishedPackage(server, SERVER_PACKAGE);
  if (target && (client.version !== target.clientVersion || server.version !== target.serverVersion)) {
    throw new Error('published update targets changed during client re-entry');
  }
  if (client.sharedVersion !== server.sharedVersion) {
    throw new Error(
      `published pair is incompatible: ${CLIENT_PACKAGE}@${client.version} pins ${SHARED_PACKAGE}@${client.sharedVersion}; ` +
      `${SERVER_PACKAGE}@${server.version} pins ${SHARED_PACKAGE}@${server.sharedVersion}. ` +
      `Wait for a compatible published pair and rerun borg update.`,
    );
  }
  return { client, server };
}

/**
 * Resolve the exact published server that can run with an already-installed
 * client. First-run onboarding uses this instead of inventing a second
 * registry path or installing an unpinned `latest` spec.
 */
export async function resolveCompatibleServerTarget(
  clientSharedVersion: string,
  deps: Pick<UpdateDeps, 'publishedPackage' | 'publishedVersions'>,
): Promise<PublishedPackage> {
  if (!isExactSemver(clientSharedVersion)) {
    throw new Error(`installed client has an invalid ${SHARED_PACKAGE} pin`);
  }
  const stableVersions = (await deps.publishedVersions(SERVER_PACKAGE))
    .filter((version) => isExactSemver(version) && !version.includes('-'))
    .sort(compareStableSemverDescending);
  for (const version of stableVersions) {
    const server = await deps.publishedPackage(SERVER_PACKAGE, version);
    validatePublishedPackage(server, SERVER_PACKAGE);
    if (server.version !== version) {
      throw new Error(`registry returned the wrong ${SERVER_PACKAGE} manifest version`);
    }
    if (server.sharedVersion === clientSharedVersion) return server;
  }
  throw new Error(
    `no published ${SERVER_PACKAGE} release uses ${SHARED_PACKAGE}@${clientSharedVersion}`,
  );
}

function compareStableSemverDescending(left: string, right: string): number {
  const leftParts = left.split('+', 1)[0].split('.').map((part) => BigInt(part));
  const rightParts = right.split('+', 1)[0].split('.').map((part) => BigInt(part));
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) return -1;
    if (leftParts[index] < rightParts[index]) return 1;
  }
  return right.localeCompare(left);
}

function assertInstalled(
  installed: InstalledPackage,
  published: PublishedPackage,
): void {
  if (
    installed.name !== published.name ||
    installed.version !== published.version ||
    installed.sharedVersion !== published.sharedVersion
  ) {
    throw new Error(
      `${published.name} installation verification failed: expected ${published.version} with ` +
      `${SHARED_PACKAGE}@${published.sharedVersion}`,
    );
  }
}

function exactServerIdentity(version: string): string {
  return `${SERVER_PACKAGE}@${version}`;
}

function isNextAction(value: unknown): value is string | null {
  return value === null || value === 'borg-mcp-server update' || (
    typeof value === 'string' &&
    value.startsWith('npm install --global borgmcp-server@') &&
    isExactSemver(value.slice('npm install --global borgmcp-server@'.length))
  );
}

function decodeServerStatus(value: unknown): ServerStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('server returned invalid JSON status');
  }
  const record = value as Record<string, unknown>;
  if (
    (record.status !== 'running' && record.status !== 'stopped') ||
    typeof record.installed_controller !== 'string' ||
    (record.prepared_runtime !== null && typeof record.prepared_runtime !== 'string') ||
    (record.prepared_integrity !== null && typeof record.prepared_integrity !== 'string') ||
    (record.running_runtime !== null && typeof record.running_runtime !== 'string') ||
    (record.running_integrity !== null && typeof record.running_integrity !== 'string') ||
    (record.build_identity !== null && typeof record.build_identity !== 'string') ||
    (record.endpoint !== null && typeof record.endpoint !== 'string') ||
    !['foreground', 'managed', 'legacy', 'stopped'].includes(record.mode as string) ||
    (record.service_adapter !== null && record.service_adapter !== 'launchd' && record.service_adapter !== 'systemd') ||
    (record.data_identity !== 'available' && record.data_identity !== 'unavailable') ||
    !isNextAction(record.next_action)
  ) {
    throw new Error('server returned invalid JSON status');
  }
  if (
    (record.prepared_integrity !== null && !isCanonicalSha512Integrity(record.prepared_integrity)) ||
    (record.running_integrity !== null && !isCanonicalSha512Integrity(record.running_integrity))
  ) {
    throw new Error('server returned invalid JSON status integrity');
  }
  if (
    (record.status === 'stopped' && (
      record.running_runtime !== null ||
      record.running_integrity !== null ||
      record.build_identity !== null ||
      record.endpoint !== null ||
      record.mode !== 'stopped'
    )) ||
    (record.status === 'running' && record.mode === 'stopped')
  ) {
    throw new Error('server returned inconsistent JSON status');
  }
  return {
    state: record.status,
    installedController: record.installed_controller,
    preparedRuntime: record.prepared_runtime,
    preparedIntegrity: record.prepared_integrity,
    runningRuntime: record.running_runtime,
    runningIntegrity: record.running_integrity,
    buildIdentity: record.build_identity,
    endpoint: record.endpoint,
    mode: record.mode as ServerStatus['mode'],
    serviceAdapter: record.service_adapter,
    dataIdentity: record.data_identity,
    nextAction: record.next_action,
  };
}

function decodeServerUpdate(value: unknown): ServerUpdateResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('server returned invalid JSON update result');
  }
  const record = value as Record<string, unknown>;
  if (record.status === 'failed') {
    if (
      (record.error_code !== 'ARTIFACT_VERIFICATION_FAILED' && record.error_code !== 'ACTIVATION_FAILED') ||
      !['verification_failed', 'restored', 'stopped', 'recovery_failed'].includes(record.recovery as string) ||
      record.data_identity !== 'preserved' ||
      (record.error_code === 'ARTIFACT_VERIFICATION_FAILED' && record.recovery !== 'verification_failed') ||
      (record.error_code === 'ACTIVATION_FAILED' && record.recovery === 'verification_failed')
    ) {
      throw new Error('server returned invalid JSON update failure');
    }
    return {
      status: 'failed',
      errorCode: record.error_code,
      recovery: record.recovery as ServerUpdateFailure['recovery'],
    };
  }
  if (
    (record.status !== 'prepared' && record.status !== 'updated') ||
    typeof record.installed_controller !== 'string' ||
    typeof record.artifact !== 'string' ||
    typeof record.artifact_integrity !== 'string' ||
    (record.running_runtime !== null && typeof record.running_runtime !== 'string') ||
    (record.build_identity !== null && typeof record.build_identity !== 'string') ||
    (record.mode !== 'stopped' && record.mode !== 'managed') ||
    record.data_identity !== 'preserved' ||
    !isNextAction(record.next_action) ||
    !isCanonicalSha512Integrity(record.artifact_integrity)
  ) {
    throw new Error('server returned invalid JSON update result');
  }
  if (
    (record.status === 'prepared' && (record.running_runtime !== null || record.mode !== 'stopped')) ||
    (record.status === 'updated' && (typeof record.running_runtime !== 'string' || record.mode !== 'managed'))
  ) {
    throw new Error('server returned inconsistent JSON update result');
  }
  return {
    status: record.status,
    installedController: record.installed_controller,
    artifact: record.artifact,
    artifactIntegrity: record.artifact_integrity,
    runningRuntime: record.running_runtime,
    buildIdentity: record.build_identity,
    mode: record.mode,
    nextAction: record.next_action,
  };
}

function verifyServerStatus(status: ServerStatus, target: PublishedPackage): 'running' | 'stopped' {
  const identity = exactServerIdentity(target.version);
  if (
    status.installedController !== identity ||
    status.preparedRuntime !== identity ||
    status.preparedIntegrity !== target.integrity ||
    status.nextAction !== null
  ) {
    throw new Error('final server verification failed: controller, prepared runtime, integrity, or next action mismatched');
  }
  if (status.state === 'stopped') {
    if (
      status.runningRuntime !== null ||
      status.runningIntegrity !== null ||
      status.buildIdentity !== null ||
      status.endpoint !== null ||
      status.mode !== 'stopped' ||
      status.dataIdentity !== 'available'
    ) {
      throw new Error('final server verification failed: stopped server reported a running runtime');
    }
    return 'stopped';
  }
  if (
    status.runningRuntime !== identity ||
    status.runningIntegrity !== target.integrity ||
    status.mode === 'stopped' ||
    status.dataIdentity !== 'available' ||
    status.endpoint === null ||
    !isHttpsOrigin(status.endpoint)
  ) {
    throw new Error('final server verification failed: running runtime mismatched');
  }
  return 'running';
}

function renderServerFailureRecovery(
  status: ServerStatus | null,
  updateAttempted: boolean,
  retryCommand: 'borg update --yes' | 'borg server status' | 'borg server update' | 'borg server start',
): string {
  let text = '';
  if (status?.state === 'stopped') {
    text += `Local server service is stopped.\nStart it with: borg server start\n`;
  } else if (updateAttempted && status === null) {
    text += (
      `Local server service state could not be verified; it may be stopped.\n` +
      `Check it with: borg server status\n` +
      `If it is stopped, start it with: borg server start\n`
    );
  }
  if (retryCommand !== 'borg server start') {
    text += status?.state === 'stopped'
      ? `Then retry the failed stage with: ${retryCommand}\n`
      : `Next: ${retryCommand}\n`;
  }
  return text;
}

export async function runUpdate(options: UpdateOptions, deps: UpdateDeps): Promise<number> {
  if (options.help) {
    deps.stdout(updateHelpText(''));
    return 0;
  }

  let pair: { client: PublishedPackage; server: PublishedPackage };
  let client: InstalledPackage;
  let discoveredServer: InstalledPackage | null;
  try {
    [pair, client, discoveredServer] = await Promise.all([
      publishedPair(options.target, deps),
      deps.currentClient(),
      deps.currentServer(),
    ]);
  } catch (error) {
    const interrupted = signalExitCode(error);
    deps.stderr(options.target
      ? renderReentryPreflightFailure(error, options.target)
      : (
        `Update preflight failed: ${errorMessage(error, 'unknown failure')}\n` +
        `Observed update state:\n` +
        `  client: not inspected (registry preflight incomplete)\n` +
        `  server controller: not inspected (registry preflight incomplete)\n` +
        `  prepared runtime: not inspected\n` +
        `  running runtime: not inspected\n` +
        `No mutation was attempted.\n` +
        `Manual fallback: npm install -g ${CLIENT_PACKAGE} && npm install -g ${SERVER_PACKAGE}\n`
      ));
    return interrupted ?? 1;
  }

  const serverWasPresent = options.target?.serverPresent ?? discoveredServer !== null;
  if (options.target?.serverPresent === true && discoveredServer === null) {
    deps.stderr(
      `The previously installed server is no longer available.\n` +
      `Observed update state:\n` +
      `  client: ${client.name}@${client.version} (${SHARED_PACKAGE}@${client.sharedVersion})\n` +
      `  server controller: unavailable\n` +
      `  prepared runtime: not inspected\n` +
      `  running runtime: not inspected\n` +
      `Server mutation was not attempted.\n` +
      `Retry with: borg update --yes\n`,
    );
    return 1;
  }

  deps.stdout(
    `Published update plan (${CANONICAL_NPM_REGISTRY}):\n` +
    `  client: ${CLIENT_PACKAGE}@${client.version} -> ${CLIENT_PACKAGE}@${pair.client.version}\n` +
    `    target integrity: ${pair.client.integrity}\n` +
    `  server: ${discoveredServer ? `${SERVER_PACKAGE}@${discoveredServer.version}` : 'not installed'} -> ${SERVER_PACKAGE}@${pair.server.version}\n` +
    `    target integrity: ${pair.server.integrity}\n` +
    `  shared pin: ${SHARED_PACKAGE}@${pair.client.sharedVersion}\n` +
    `  local server: ${serverWasPresent ? 'update' : 'skip (not installed)'}\n`,
  );

  if (!options.yes) {
    if (!deps.isTTY()) {
      deps.stderr('borg update requires --yes when input is not an interactive terminal. No update was performed.\n');
      return 1;
    }
    const answer = await deps.confirm(
      `Update ${CLIENT_PACKAGE} ${client.version} -> ${pair.client.version}` +
      `${serverWasPresent ? ` and ${SERVER_PACKAGE} ${discoveredServer?.version ?? 'unknown'} -> ${pair.server.version}` : ''}` +
      ` with ${SHARED_PACKAGE}@${pair.client.sharedVersion}? [y/N] `,
    );
    if (answer === 'no') {
      deps.stdout('Update cancelled. No changes were made.\n');
      return 0;
    }
    if (answer === 'eof') {
      deps.stderr('Update cancelled because confirmation input ended. No changes were made.\n');
      return 1;
    }
    if (answer === 'interrupted') {
      deps.stderr('Update cancelled by SIGINT. No changes were made.\n');
      return 130;
    }
  }

  if (client.version !== pair.client.version || client.sharedVersion !== pair.client.sharedVersion) {
    let installedClient: InstalledPackage | null = null;
    try {
      await deps.installGlobal(
        CLIENT_PACKAGE,
        pair.client.version,
        { ignoreScripts: true },
      );
      installedClient = await deps.currentClient();
      assertInstalled(installedClient, pair.client);
      const args = [
        'update',
        '--yes',
        '--target-client', pair.client.version,
        '--target-server', pair.server.version,
        '--server-present', serverWasPresent ? 'yes' : 'no',
      ];
      return await deps.reenter(installedClient.binPath, args);
    } catch (error) {
      const interrupted = signalExitCode(error);
      deps.stderr(
        `Client update or re-entry failed: ${errorMessage(error, 'unknown failure')}.\n` +
        `Observed update state:\n` +
        `  client: ${installedClient
          ? `${installedClient.name}@${installedClient.version} installed and verified`
          : 'unavailable after client update failure'}\n` +
        `  server controller before client update: ${discoveredServer
          ? `${discoveredServer.name}@${discoveredServer.version}`
          : 'not installed'}\n` +
        `  prepared runtime: not inspected\n` +
        `  running runtime: not inspected\n` +
        `Server mutation was not attempted.\n` +
        `Retry with: borg update --yes\n`,
      );
      return interrupted ?? 1;
    }
  }

  try {
    assertInstalled(client, pair.client);
  } catch (error) {
    const interrupted = signalExitCode(error);
    deps.stderr(
      `${errorMessage(error, 'Client verification failed')}\n` +
      `Observed update state:\n` +
      `  client: verification failed\n` +
      `  server controller: ${discoveredServer
        ? `${discoveredServer.name}@${discoveredServer.version}`
        : 'not installed'}\n` +
      `  prepared runtime: not inspected\n` +
      `  running runtime: not inspected\n` +
      `Server mutation was not attempted.\n` +
      `Next: reinstall ${CLIENT_PACKAGE}@${pair.client.version} from ${CANONICAL_NPM_REGISTRY}, then rerun borg update --yes.\n`,
    );
    return interrupted ?? 1;
  }

  if (!serverWasPresent) {
    deps.stdout(
      `Updated ${CLIENT_PACKAGE}@${pair.client.version}. Local server: skipped (not installed).\n` +
      `Restart active agent sessions to load the updated client.\n`,
    );
    return 0;
  }

  let server: InstalledPackage;
  try {
    if (!discoveredServer) throw new Error('previously installed server is unavailable');
    if (
      discoveredServer.version !== pair.server.version ||
      discoveredServer.sharedVersion !== pair.server.sharedVersion
    ) {
      await deps.installGlobal(
        SERVER_PACKAGE,
        pair.server.version,
        { ignoreScripts: true },
      );
    }
    const verified = await deps.currentServer();
    if (!verified) throw new Error('server controller disappeared after installation');
    assertInstalled(verified, pair.server);
    server = verified;
  } catch (error) {
    const interrupted = signalExitCode(error);
    deps.stderr(
      `Client updated, but server controller update failed: ${errorMessage(error, 'unknown failure')}.\n` +
      `Observed update state:\n` +
      `  client: ${client.name}@${client.version} (${SHARED_PACKAGE}@${client.sharedVersion})\n` +
      `  server controller: unavailable after controller failure\n` +
      `  prepared runtime: not inspected\n` +
      `  running runtime: not inspected\n` +
      `Server runtime mutation was not attempted.\n` +
      `Retry with: borg update --yes\n`,
    );
    return interrupted ?? 1;
  }

  let observedStatus: ServerStatus | null = null;
  let observedUpdate: ServerUpdateResult | null = null;
  let initialServerState: ServerStatus['state'] | null = null;
  let updateAttempted = false;
  let recoveryStatusAttempted = false;
  let failureStage: ServerUpdateFailureStage = 'initial server status check';
  let retryCommand: Parameters<typeof renderServerFailureRecovery>[2] = 'borg server status';
  const observeStatusAfterFailure = async (): Promise<void> => {
    recoveryStatusAttempted = true;
    try {
      observedStatus = decodeServerStatus(await deps.serverJson(server.binPath, 'status'));
    } catch {
      observedStatus = null;
    }
  };
  try {
    let status = decodeServerStatus(await deps.serverJson(server.binPath, 'status'));
    observedStatus = status;
    initialServerState = status.state;
    if (status.installedController !== exactServerIdentity(pair.server.version)) {
      failureStage = 'server controller identity check';
      retryCommand = 'borg update --yes';
      throw new Error('server status contradicted the verified controller identity');
    }
    try {
      verifyServerStatus(status, pair.server);
    } catch {
      observedStatus = null;
      updateAttempted = true;
      failureStage = 'server runtime activation';
      retryCommand = 'borg server update';
      const update = decodeServerUpdate(await deps.serverJson(server.binPath, 'update'));
      observedUpdate = update;
      if (update.status === 'failed') {
        await observeStatusAfterFailure();
        throw new Error(`server update failed: ${update.errorCode} (${update.recovery})`);
      }
      const serverIdentity = exactServerIdentity(pair.server.version);
      if (
        update.installedController !== serverIdentity ||
        update.artifact !== serverIdentity ||
        update.artifactIntegrity !== pair.server.integrity ||
        update.nextAction !== null ||
        (update.status === 'updated' && update.runningRuntime !== serverIdentity)
      ) {
        throw new Error('server update result did not reach the target artifact');
      }
      failureStage = 'post-update server status check';
      retryCommand = 'borg server status';
      recoveryStatusAttempted = true;
      status = decodeServerStatus(await deps.serverJson(server.binPath, 'status'));
      observedStatus = status;
    }
    failureStage = 'final server state verification';
    retryCommand = 'borg server update';
    const state = verifyServerStatus(status, pair.server);
    failureStage = 'final package verification';
    retryCommand = 'borg update --yes';
    const [finalClient, finalServer] = await Promise.all([
      deps.currentClient(),
      deps.currentServer(),
    ]);
    assertInstalled(finalClient, pair.client);
    if (!finalServer) throw new Error('server controller disappeared during final verification');
    assertInstalled(finalServer, pair.server);
    if (initialServerState === 'running' && state === 'stopped') {
      failureStage = 'managed service continuity check';
      retryCommand = 'borg server start';
      throw new Error('a previously running local server is now stopped');
    }
    if (state === 'running') {
      failureStage = 'running server protocol verification';
      retryCommand = 'borg server status';
      await deps.verifyRunningProtocol(status.endpoint!);
    }
    deps.stdout(
      state === 'stopped'
        ? (
          `Updated ${CLIENT_PACKAGE}@${pair.client.version} and ${SERVER_PACKAGE}@${pair.server.version}: prepared.\n` +
          `Local server service is stopped.\n` +
          `Start it with: borg server start\n`
        )
        : `Updated ${CLIENT_PACKAGE}@${pair.client.version} and ${SERVER_PACKAGE}@${pair.server.version}; running identities and protocol verified.\n`,
    );
    deps.stdout('Restart active agent sessions to load the updated client.\n');
    return 0;
  } catch (error) {
    const interrupted = signalExitCode(error);
    if (updateAttempted && !recoveryStatusAttempted && observedStatus === null) {
      await observeStatusAfterFailure();
    }
    deps.stderr(
      `Server update failed during ${failureStage}: ${errorMessage(error, 'unknown failure')}.\n` +
      renderServerState(client, server, observedStatus, observedUpdate) +
      renderServerFailureRecovery(observedStatus, updateAttempted, retryCommand),
    );
    return interrupted ?? 1;
  }
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

class CommandSignalError extends Error {
  readonly exitCode: number;

  constructor(signal: NodeJS.Signals, stderr = '') {
    super(`command stopped by ${signal}${serverCommandStderr(stderr)}`);
    this.name = 'CommandSignalError';
    this.exitCode = 128 + (constants.signals[signal] ?? 1);
  }
}

function runCommand(
  command: string,
  args: readonly string[],
  options: { inherit?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      shell: false,
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      env: options.env ?? process.env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString('utf8');
      if (Buffer.byteLength(next) > MAX_CAPTURE_BYTES) {
        child.kill('SIGTERM');
        fail(new Error('command output exceeded the update limit'));
      }
      return next;
    };
    child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once('error', fail);
    child.once('exit', (code, signal) => {
      if (settled) return;
      if (signal) {
        fail(new CommandSignalError(signal, stderr));
        return;
      }
      settled = true;
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`invalid package manifest at ${path}`);
  }
  return parsed as Record<string, unknown>;
}

function singleLine(text: string, label: string): string {
  const value = text.trim();
  if (value === '' || value.includes('\n') || value.includes('\r')) {
    throw new Error(`npm returned an invalid ${label}`);
  }
  return value;
}

function serverCommandStderr(stderr: string): string {
  const detail = stderr.trim();
  if (detail === '') return '';
  const bounded = Array.from(detail).slice(-4096).join('')
    .replace(/\p{Cc}/gu, (character) => character === '\n' || character === '\t' ? character : '?');
  return `\nServer command stderr:\n${bounded}`;
}

async function npmText(commandPath: string, args: readonly string[], label: string): Promise<string> {
  const result = await runCommand(commandPath, args);
  if (result.code !== 0) throw new Error(`npm ${label} lookup failed`);
  return singleLine(result.stdout, label);
}

function requireCanonicalRegistry(value: string): void {
  let normalized: string;
  try {
    normalized = new URL(value).href;
  } catch {
    throw new Error('npm registry configuration is invalid');
  }
  if (normalized !== CANONICAL_NPM_REGISTRY) {
    throw new Error(
      `borg update requires the canonical npm registry ${CANONICAL_NPM_REGISTRY}; ` +
      `the configured registry is unsupported. Use your package manager manually for this installation.`,
    );
  }
}

async function resolveNpmContext(): Promise<NpmContext> {
  const commandPath = which.sync('npm');
  const commandIdentity = await realpath(commandPath);
  const registry = await npmText(commandPath, ['config', 'get', 'registry'], 'registry');
  requireCanonicalRegistry(registry);
  const prefixText = await npmText(commandPath, ['prefix', '--global'], 'global prefix');
  const rootText = await npmText(commandPath, ['root', '--global'], 'global root');
  if (!isAbsolute(prefixText) || !isAbsolute(rootText)) {
    throw new Error('npm returned a non-absolute global context');
  }
  const prefix = await realpath(prefixText);
  const root = await realpath(rootText);
  const relativeRoot = relative(prefix, root);
  if (relativeRoot === '' || relativeRoot.startsWith('..') || isAbsolute(relativeRoot)) {
    throw new Error('npm global root is outside its global prefix');
  }
  return { commandPath, commandIdentity, prefix, root };
}

async function assertNpmContext(context: NpmContext): Promise<NpmContext> {
  const activeCommand = which.sync('npm');
  if (await realpath(activeCommand) !== context.commandIdentity) {
    throw new Error('active npm executable changed during update');
  }
  const registry = await npmText(context.commandPath, ['config', 'get', 'registry'], 'registry');
  requireCanonicalRegistry(registry);
  const prefix = await realpath(await npmText(context.commandPath, ['prefix', '--global'], 'global prefix'));
  if (prefix !== context.prefix) throw new Error('npm global prefix changed during update');
  const root = await realpath(await npmText(context.commandPath, ['root', '--global'], 'global root'));
  if (root !== context.root) throw new Error('npm global root changed during update');
  return context;
}

function packageBin(manifest: Record<string, unknown>, binName: string): string {
  const bin = manifest.bin;
  if (typeof bin === 'string') return bin;
  if (bin && typeof bin === 'object' && !Array.isArray(bin)) {
    const value = (bin as Record<string, unknown>)[binName];
    if (typeof value === 'string') return value;
  }
  throw new Error(`package manifest does not declare ${binName}`);
}

export async function inspectNpmPackageAt(input: {
  name: typeof CLIENT_PACKAGE | typeof SERVER_PACKAGE,
  binName: 'borg' | 'borg-mcp-server',
  npmRoot: string;
  commandPath: string;
  invokedPath?: string;
}): Promise<InstalledPackage> {
  const npmRoot = await realpath(input.npmRoot);
  const packageRoot = await realpath(join(npmRoot, input.name));
  const packageRelative = relative(npmRoot, packageRoot);
  if (packageRelative !== input.name) {
    throw new Error(`${input.name} is not owned by the active npm global root`);
  }
  const manifest = await readJson(join(packageRoot, 'package.json'));
  if (manifest.name !== input.name || typeof manifest.version !== 'string' || !isExactSemver(manifest.version)) {
    throw new Error(`installed ${input.name} manifest identity is invalid`);
  }
  const binRelative = packageBin(manifest, input.binName);
  const expectedBin = await realpath(resolve(packageRoot, binRelative));
  const relativeBin = relative(packageRoot, expectedBin);
  if (relativeBin.startsWith('..') || isAbsolute(relativeBin)) {
    throw new Error(`${input.binName} resolves outside the npm-owned package`);
  }
  if (!(await stat(expectedBin)).isFile()) {
    throw new Error(`${input.binName} is not a regular npm package file`);
  }
  if (await realpath(input.commandPath) !== expectedBin) {
    throw new Error(`${input.binName} on PATH is not the npm-owned package binary`);
  }
  if (input.invokedPath !== undefined) {
    const invoked = await realpath(input.invokedPath);
    if (invoked !== expectedBin) {
      throw new Error('running borg entrypoint is not the npm-owned package binary');
    }
  }
  const shared = await readJson(join(packageRoot, 'node_modules', SHARED_PACKAGE, 'package.json'));
  if (shared.name !== SHARED_PACKAGE || typeof shared.version !== 'string' || !isExactSemver(shared.version)) {
    throw new Error(`installed ${input.name} ${SHARED_PACKAGE} identity is invalid`);
  }
  return {
    name: input.name,
    version: manifest.version,
    sharedVersion: shared.version,
    packageRoot,
    binPath: expectedBin,
  };
}

async function inspectNpmPackage(
  name: typeof CLIENT_PACKAGE | typeof SERVER_PACKAGE,
  binName: 'borg' | 'borg-mcp-server',
  required: boolean,
  context: NpmContext,
): Promise<InstalledPackage | null> {
  let commandPath: string;
  try {
    commandPath = which.sync(binName);
  } catch {
    if (!required) return null;
    throw new Error(`${binName} is not available on PATH`);
  }
  try {
    await realpath(join(context.root, name));
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      throw new Error(
        `${binName} is on PATH from a different npm global prefix. ` +
        `borg update only manages packages under the active npm prefix. ` +
        `Run npm prefix --global to inspect it, then update the other installation with its package manager.`,
      );
    }
    throw error;
  }
  return inspectNpmPackageAt({
    name,
    binName,
    npmRoot: context.root,
    commandPath,
    ...(name === CLIENT_PACKAGE ? { invokedPath: process.argv[1] } : {}),
  });
}

async function defaultPublishedPackage(
  name: typeof CLIENT_PACKAGE | typeof SERVER_PACKAGE,
  version: string,
  context: NpmContext,
): Promise<PublishedPackage> {
  if (version !== 'latest' && !isExactSemver(version)) throw new Error('invalid registry target version');
  // Keep npm context validation above, but read the registry's typed manifest
  // contract directly rather than parsing npm CLI presentation output.
  void context;
  const endpoint = new URL(`${encodeURIComponent(name)}/${encodeURIComponent(version)}`, CANONICAL_NPM_REGISTRY);
  let published: PublishedPackage;
  try {
    const response = await fetch(endpoint, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('response was not a manifest object');
    }
    const manifest = parsed as Record<string, unknown>;
    const dist = manifest.dist as Record<string, unknown> | undefined;
    const dependencies = manifest.dependencies as Record<string, unknown> | undefined;
    published = {
      name: manifest.name as PublishedPackage['name'],
      version: manifest.version as string,
      integrity: dist?.integrity as string,
      sharedVersion: dependencies?.[SHARED_PACKAGE] as string,
    };
  } catch {
    throw new Error(`registry manifest lookup failed for ${name}@${version}`);
  }
  validatePublishedPackage(published, name);
  return published;
}

async function defaultPublishedVersions(
  name: typeof CLIENT_PACKAGE | typeof SERVER_PACKAGE,
  context: NpmContext,
): Promise<string[]> {
  void context;
  const endpoint = new URL(encodeURIComponent(name), CANONICAL_NPM_REGISTRY);
  try {
    const response = await fetch(endpoint, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('response was not a package object');
    }
    const versions = (parsed as Record<string, unknown>).versions;
    if (!versions || typeof versions !== 'object' || Array.isArray(versions)) {
      throw new Error('package versions were not an object');
    }
    const values = Object.keys(versions);
    if (values.length === 0 || values.some((version) => !isExactSemver(version))) {
      throw new Error('package versions were missing or invalid');
    }
    return values;
  } catch {
    throw new Error(`registry version lookup failed for ${name}`);
  }
}

async function defaultConfirm(message: string): Promise<'yes' | 'no' | 'eof' | 'interrupted'> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let interrupted = false;
  rl.once('SIGINT', () => {
    interrupted = true;
    rl.close();
  });
  try {
    const answer = (await rl.question(message)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes' ? 'yes' : 'no';
  } catch (error) {
    if (interrupted) return 'interrupted';
    if ((error as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') return 'eof';
    throw error;
  } finally {
    rl.close();
  }
}

export function buildDefaultUpdateDeps(): UpdateDeps {
  let contextPromise: Promise<NpmContext> | undefined;
  const context = async (): Promise<NpmContext> => {
    contextPromise ??= resolveNpmContext();
    return assertNpmContext(await contextPromise);
  };
  return {
    currentClient: async () => {
      const value = await inspectNpmPackage(CLIENT_PACKAGE, 'borg', true, await context());
      if (!value) throw new Error('borgmcp is not installed');
      return value;
    },
    currentServer: async () => inspectNpmPackage(
      SERVER_PACKAGE,
      'borg-mcp-server',
      false,
      await context(),
    ),
    publishedPackage: async (name, version) => defaultPublishedPackage(name, version, await context()),
    publishedVersions: async (name) => defaultPublishedVersions(name, await context()),
    installGlobal: async (name, version, options) => {
      const npm = await context();
      const result = await runCommand(npm.commandPath, [
        'install',
        '--global',
        ...(options?.ignoreScripts ? ['--ignore-scripts'] : []),
        `--prefix=${npm.prefix}`,
        `--registry=${CANONICAL_NPM_REGISTRY}`,
        `${name}@${version}`,
      ], { inherit: true });
      if (result.code !== 0) throw new Error(`${name} installation exited ${result.code}`);
    },
    reenter: async (binPath, args) => {
      const result = await runCommand(process.execPath, [binPath, ...args], {
        inherit: true,
        env: { ...process.env, [REENTRY_ENV]: '1' },
      });
      return result.code;
    },
    serverJson: async (binPath, command) => {
      const result = await runCommand(process.execPath, [binPath, command, '--json']);
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        throw new Error(`server ${command} returned invalid JSON${serverCommandStderr(result.stderr)}`);
      }
      if (result.code !== 0 && command !== 'update') {
        throw new Error(
          `server ${command} exited ${result.code}${serverCommandStderr(result.stderr)}`,
        );
      }
      return parsed;
    },
    verifyRunningProtocol: async (origin) => {
      const trust = await loadBorgServerTrust(origin);
      await preflightBorgServerTag(origin, trust.fetchImpl);
    },
    confirm: defaultConfirm,
    isTTY: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

export async function runEarlyUpdate(
  argv: readonly string[],
  deps: UpdateDeps = buildDefaultUpdateDeps(),
): Promise<number | null> {
  if (argv[2] !== 'update') return null;
  const parsed = parseUpdateArgs(argv.slice(3), process.env[REENTRY_ENV] === '1');
  if (!parsed.ok) {
    deps.stderr(`${parsed.error}\nRun \`borg update --help\` for usage.\n`);
    return 1;
  }
  if (parsed.help) {
    deps.stdout(updateHelpText(''));
    return 0;
  }
  return runUpdate(parsed, deps);
}
