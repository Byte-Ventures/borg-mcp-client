import { recordClaudeSessionStart, resolveAgentSessionIdentity } from '../../src/agent-session-identity.js';
import { recordLifecycleLog, shouldSuppressLifecycleLog } from '../../src/lifecycle-log-guard.js';
import { CodexAppServerClient } from '../../src/codex-app-server.js';
import { connectOpenCodeDrone } from '../../src/opencode-drone.js';

const worktree = process.env.TEST_WORKTREE!;
if (process.env.TEST_HOOK_PAYLOAD !== undefined) await recordClaudeSessionStart(process.env.TEST_HOOK_PAYLOAD, process.env, worktree);
if (process.env.TEST_CODEX_THREADS) {
  const threads = JSON.parse(process.env.TEST_CODEX_THREADS);
  CodexAppServerClient.prototype.connect = async () => {};
  (CodexAppServerClient.prototype as any).request = async (method: string, params: any) => {
    if (method === 'thread/loaded/list') return { data: threads.map((thread: any) => thread.id) };
    const thread = threads.find((thread: any) => thread.id === params.threadId);
    if (thread?.unreadable) throw new Error('injected thread read failure');
    return { thread };
  };
}
if (process.env.TEST_OPENCODE) await connectOpenCodeDrone(JSON.parse(process.env.TEST_OPENCODE));

const descriptors = ['pid', 'ppid'].map((key) => [key, Object.getOwnPropertyDescriptor(process, key)!] as const);
let processIdReads = 0;
for (const [key, descriptor] of descriptors) {
  Object.defineProperty(process, key, { configurable: true, get() { processIdReads++; return descriptor.value; } });
}
const identity = await resolveAgentSessionIdentity(process.env, worktree);
for (const [key, descriptor] of descriptors) Object.defineProperty(process, key, descriptor);
const subject = { cubeId: 'cube', droneId: process.env.TEST_DRONE ?? 'drone' };
const decision = await shouldSuppressLifecycleLog(subject, 'ARRIVAL: fixture online', identity);
if (!decision.suppress) await recordLifecycleLog(subject, 'ARRIVAL: fixture online', identity);
process.stdout.write(JSON.stringify({ identity, suppress: decision.suppress, processIdReads }));
