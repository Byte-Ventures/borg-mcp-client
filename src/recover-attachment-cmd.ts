import { createInterface } from 'node:readline/promises';
import { normalizeServerEndpoint } from './server-endpoint.js';
import { getServerCredentialRecord } from './config.js';
import { loadBorgServerTrust } from './server-trust.js';
import { resolveGitRepositoryContext } from './repository-identity.js';
import { readAttachmentAttempt, recoverAttachmentAttempt, reserveAttachmentTarget,
  observeSeat, isAttachmentAttempt, AttachmentAttemptUnavailableError, type AttachmentAttempt, type SeatRecord } from './seats.js';
import { reconcileBorgServerAttachment, sendBorgServerAttach, AttachmentReconciliationError } from './server-handshake.js';
import { ErrorCode, type ReconcileAttachmentAction, type ReconcileAttachmentResponse } from 'borgmcp-shared';
import { shellEscape } from './shell-escape.js';
import { advanceLocalServerCursor } from './local-server-cursor.js';
import { BorgServerError, BorgServerTrustError } from './server-errors.js';

export interface RecoverAttachmentFlags { host: string; attempt: string; retire?: boolean; yes?: boolean }

export function parseRecoverAttachmentArgs(args: string[]):
  { ok: true; flags: RecoverAttachmentFlags } | { ok: false; error: string } {
  const values = new Map<string, string | boolean>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--host', '--attempt', '--retire', '--yes'].includes(key) || values.has(key)) {
      return { ok: false, error: 'Expected --host <endpoint> --attempt <uuid> [--retire [--yes]]' };
    }
    if (key === '--host' || key === '--attempt') {
      const value = args[++i];
      if (!value || value.startsWith('-')) return { ok: false, error: 'Host and attempt require values' };
      values.set(key, value);
    } else values.set(key, true);
  }
  const host = values.get('--host');
  const attempt = values.get('--attempt');
  if (typeof host !== 'string' || !isAttachmentAttempt(attempt) ||
      (values.has('--yes') && !values.has('--retire'))) {
    return { ok: false, error: 'Expected --host <endpoint> --attempt <UUIDv4> [--retire [--yes]]' };
  }
  return { ok: true, flags: { host, attempt, retire: values.has('--retire'), yes: values.has('--yes') } };
}

export interface RecoveryContext {
  origin: string; trustIdentity: string; clientId: string; worktree: string;
  targetAbsent?: (target: string) => Promise<boolean>;
  reconcile: (entry: AttachmentAttempt, action: ReconcileAttachmentAction) => Promise<ReconcileAttachmentResponse>;
  resume: (entry: AttachmentAttempt, record: SeatRecord) => Promise<boolean>;
}
export interface RecoverAttachmentDeps {
  context: (host: string) => Promise<RecoveryContext>;
  prompt: (message: string) => Promise<string>;
  isTTY: () => boolean;
  stdout: (message: string) => void;
  stderr: (message: string) => void;
}

export async function runRecoverAttachment(flags: RecoverAttachmentFlags, deps: RecoverAttachmentDeps): Promise<number> {
  let command = 'borg recover-attachment';
  try {
    const origin = normalizeServerEndpoint(flags.host);
    command += ` --host ${shellEscape(origin)} --attempt ${flags.attempt}`;
    const context = await deps.context(origin);
    // Select before prompting. A handle never grants authority or selects another worktree.
    const entry = await readAttachmentAttempt({ ...context, attempt: flags.attempt });
    const observation = await observeSeat(entry.credentialRef, { origin: entry.origin, trustIdentity: entry.trustIdentity, cubeId: entry.cubeId });
    if (flags.retire && !flags.yes) {
      if (!deps.isTTY()) {
        deps.stderr('Retirement needs explicit consent. Re-run with --retire --yes, or use an interactive terminal.\n');
        return 1;
      }
      const answer = (await deps.prompt(`Retire this failed attachment on ${context.origin}? [y/N]: `)).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') { deps.stdout('No changes made.\n'); return 0; }
    }
    const result = await recoverAttachmentAttempt({ ...context, attempt: flags.attempt, retire: flags.retire === true,
      expected: { observation, targetWorktree: entry.targetWorktree } });
    if (result.kind === 'pending') {
      if (!await context.resume(result.entry, result.record)) {
        deps.stderr(`The local connection and worktree were preserved, but finalization could not be confirmed. Run: ${command}\n`);
        return 1;
      }
      deps.stdout('Attachment recovery completed; the original drone and session were reused. No agent was launched.\n');
    } else if (result.kind === 'active') {
      deps.stdout('Attachment is already active; no connection was replaced. No agent was launched.\n');
    } else if (result.kind === 'retired') {
      deps.stdout('The failed attachment is retired; it cannot be reused. Local replacement connections and worktrees were left unchanged. No agent was launched.\n');
    } else if (result.kind === 'target-missing') {
      deps.stderr(`The reserved attachment target is absent. The original pending connection was preserved; no worktree was recreated. To retire only this failed attachment, run: ${command} --retire\n`);
      return 1;
    } else {
      deps.stderr(`The original local connection is missing or replaced. Nothing was restored or newly attached. To retire only the failed attachment, run: ${command} --retire\n`);
      return 1;
    }
    return 0;
  } catch (error) {
    if (error instanceof AttachmentAttemptUnavailableError) {
      deps.stderr('The requested attachment recovery attempt is not available from this worktree and authority. Nothing was restored or newly attached. Use the original source or preserved worktree; if its journal was lost, ask an operator with cube management access to inspect and clean up the orphaned attachment.\n');
    } else if (error instanceof BorgServerError && error.code === 'NOT_ENROLLED') {
      deps.stderr('The existing server enrollment could not be loaded. Nothing was restored or newly attached. Ask the server operator for a new enrollment invitation and re-enroll explicitly; an attachment handle cannot recover lost credentials.\n');
    } else if (error instanceof BorgServerTrustError) {
      deps.stderr('The saved server authority could not be verified. No attachment recovery request was sent. Ask the server operator to verify the authority and provide a current enrollment invitation; recovery never replaces a trust anchor automatically.\n');
    } else if (error instanceof AttachmentReconciliationError) {
      deps.stderr(error.code === ErrorCode.ATTACHMENT_FINALIZED
        ? 'This attachment was finalized before its local connection was reset or replaced. Nothing was restored or newly attached. Ask an operator with cube management access to inspect and clean up that attachment.\n'
        : `Attachment recovery was refused (${error.code}); no connection was restored or newly minted.\n`);
    } else {
      const message = error instanceof Error ? error.message : '';
      // Preserve the existing stale-lock remediation, but never echo transport bodies or secrets.
      deps.stderr(message.startsWith('Borg private store lock file ') || message === 'Borg private store is busy'
        ? `${message}\n` : `Attachment recovery could not be confirmed. No agent was launched. Retry: ${command}\n`);
    }
    return 1;
  }
}

async function defaultContext(origin: string): Promise<RecoveryContext> {
  const trust = await loadBorgServerTrust(origin);
  const parent = await getServerCredentialRecord(origin, trust.identity);
  if (!parent?.clientId) throw new BorgServerError('NOT_ENROLLED', 'An existing authority-bound enrollment is required');
  const current = await resolveGitRepositoryContext(process.cwd());
  if (!current) throw new Error('A repository worktree is required');
  return {
    origin, trustIdentity: trust.identity, clientId: parent.clientId, worktree: current.root,
    reconcile: (entry, action) => reconcileBorgServerAttachment(origin, parent.credential, {
      receipt: entry.receipt, cube_id: entry.cubeId, role_id: entry.roleId, action,
      ...(entry.priorDroneId === undefined ? {} : { prior_drone_id: entry.priorDroneId }),
    }, trust.fetchImpl),
    resume: async (entry, record) => {
      const prepared = await sendBorgServerAttach(origin, trust.identity, parent.credential, {
        cubeId: entry.cubeId, roleId: entry.roleId, operation: entry.operation,
        ...(entry.priorDroneId === undefined ? {} : { priorDroneId: entry.priorDroneId }),
      }, record.credential, { fetchImpl: trust.fetchImpl });
      if ((entry.droneId !== undefined && prepared.drone.id !== entry.droneId) ||
          (entry.sessionId !== undefined && prepared.session.sessionId !== entry.sessionId)) {
        throw new Error('Attachment retry returned a different identity');
      }
      if (prepared.initialLogCursor) {
        const cursorBinding = { origin, trustIdentity: trust.identity, cubeId: entry.cubeId, droneId: prepared.drone.id };
        await advanceLocalServerCursor(cursorBinding, prepared.initialLogCursor);
        await advanceLocalServerCursor({ ...cursorBinding, purpose: 'stream' }, prepared.initialLogCursor);
      }
      let target = entry.targetWorktree;
      if (target === undefined) {
        if (entry.operation.kind === 'seat') target = entry.operation.projectRoot;
        else {
          const source = await resolveGitRepositoryContext(entry.operation.projectRoot);
          if (!source || source.commonDir !== current.commonDir) throw new Error('The source worktree changed');
          const { buildDefaultAssimilateDeps } = await import('./assimilate-deps.js');
          const { prepareAssimilationWorktree } = await import('./assimilate-cmd.js');
          const deps = buildDefaultAssimilateDeps();
          const verifiedHead = deps.runSync('git', ['rev-parse', 'HEAD'], source.root).stdout.trim();
          const outcome = await prepareAssimilationWorktree({
            flags: entry.operation.operationKey.startsWith('named-sibling:')
              ? { worktree: entry.operation.operationKey.slice('named-sibling:'.length) } : {},
            repositoryContext: source, projectRoot: source.root, wantSibling: true, verifiedHead,
            assignedRole: { ...prepared.role, is_human_seat: false, is_default: false }, existing: null,
            reserveTarget: path => reserveAttachmentTarget(entry.attempt, path),
          }, deps);
          if (outcome.kind === 'stop' || !outcome.value.spawnedWorktreePath) return false;
          target = outcome.value.spawnedWorktreePath;
        }
      }
      const repository = await resolveGitRepositoryContext(target);
      if (!repository || repository.root !== target || repository.commonDir !== current.commonDir) {
        throw new Error('The attachment target worktree changed');
      }
      return await prepared.activate({ worktree: target, commonDir: repository.commonDir,
        ...(repository.publicRepository ? { repositoryOrigin: repository.publicRepository.value } : {}),
        name: prepared.cube.name, droneLabel: prepared.drone.label, roleName: prepared.role.name,
        ...(prepared.role.role_class === undefined ? {} : { roleClass: prepared.role.role_class }),
      }) === 'activated';
    },
  };
}

export function buildDefaultRecoverAttachmentDeps(): RecoverAttachmentDeps {
  return { context: defaultContext, isTTY: () => process.stdin.isTTY === true,
    prompt: async message => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try { return await rl.question(message); } finally { rl.close(); }
    }, stdout: message => process.stdout.write(message), stderr: message => process.stderr.write(message) };
}
