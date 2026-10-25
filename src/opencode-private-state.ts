import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { fs } from './guarded-fs.js';
import { borgConfigRoot, ensurePrivateBorgConfigRootSync, isCanonicalPath } from './private-root.js';

export function openCodePrivateRoot(): string {
  // Windows needs a dedicated DACL, rather than POSIX mode bits. Do not
  // replace an operator's ACL on the shared Borg credentials directory.
  return process.platform === 'win32' ? path.join(borgConfigRoot(), 'opencode-launches') : borgConfigRoot();
}
const sealedWindowsRoots = new Map<string, string>();

/** The native host and Node can spell a Windows path differently. Compare
 * directory identities there, including case-sensitive NTFS directories. */
export function sameOpenCodeDirectory(left: string, right: string): boolean {
  const a = realpathSync(left); const b = realpathSync(right);
  if (process.platform !== 'win32') return a === b;
  const first = statSync(a, { bigint: true }); const second = statSync(b, { bigint: true });
  if (!first.isDirectory() || !second.isDirectory()) return false;
  if (first.ino !== 0n && second.ino !== 0n) return first.dev === second.dev && first.ino === second.ino;
  const normalized = (value: string) => value.replace(/^\\\\\?\\/, '').replace(/^[A-Z]:/, drive => drive.toLowerCase());
  return normalized(a) === normalized(b);
}
function windowsAcl(filename: string, initialize: boolean): void {
  const script = `
$ErrorActionPreference = 'Stop'
$p = $env:BORG_OPENCODE_PRIVATE_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $p
${initialize ? `$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
$acl.SetOwner($sid)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $p -AclObject $acl
$acl = Get-Acl -LiteralPath $p` : ''}
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { exit 1 }
foreach ($rule in $acl.Access) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { exit 1 }
}
`;
  try {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const options = { env: { ...process.env, BORG_OPENCODE_PRIVATE_PATH: filename }, stdio: 'ignore' as const, timeout: 10_000, windowsHide: true };
    // Compiled Bun hosts can hang when spawning native Windows programs:
    // https://github.com/oven-sh/bun/issues/32011. Only the fixed command and
    // base64 script enter the shell; the operator's path remains env data.
    if (process.versions.bun) execFileSync(`powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`, { ...options, shell: true });
    else execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], options);
  } catch { throw new Error('OpenCode private launch state must be owned by and accessible only to the current Windows user.'); }
}
export function ensureOpenCodePrivateRoot(root = openCodePrivateRoot()): void {
  if (!isCanonicalPath(root)) throw new Error('OpenCode private state path contains a symlink.');
  if (process.platform !== 'win32') { ensurePrivateBorgConfigRootSync(root); return; }
  fs.mkdirSync(root, { recursive: true });
  const metadata = fs.lstatSync(root);
  if (!metadata.isDirectory()) throw new Error('OpenCode private state root is not a directory.');
  const identity = `${metadata.dev}:${metadata.ino}`;
  if (sealedWindowsRoots.get(root) === identity) return;
  windowsAcl(root, true);
  sealedWindowsRoots.set(root, identity);
}
export function verifyOpenCodePrivateWindowsPath(filename: string): void {
  if (process.platform === 'win32') windowsAcl(filename, false);
}
