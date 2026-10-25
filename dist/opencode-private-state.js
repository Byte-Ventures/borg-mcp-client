import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fs } from './guarded-fs.js';
import { borgConfigRoot, ensurePrivateBorgConfigRootSync, isCanonicalPath } from './private-root.js';
export function openCodePrivateRoot() {
    // Windows needs a dedicated DACL, rather than POSIX mode bits. Do not
    // replace an operator's ACL on the shared Borg credentials directory.
    return process.platform === 'win32' ? path.join(borgConfigRoot(), 'opencode-launches') : borgConfigRoot();
}
const sealedWindowsRoots = new Map();
function windowsAcl(filename, initialize) {
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
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: { ...process.env, BORG_OPENCODE_PRIVATE_PATH: filename }, stdio: 'ignore', timeout: 10_000, windowsHide: true });
    }
    catch {
        throw new Error('OpenCode private launch state must be owned by and accessible only to the current Windows user.');
    }
}
export function ensureOpenCodePrivateRoot(root = openCodePrivateRoot()) {
    if (!isCanonicalPath(root))
        throw new Error('OpenCode private state path contains a symlink.');
    if (process.platform !== 'win32') {
        ensurePrivateBorgConfigRootSync(root);
        return;
    }
    fs.mkdirSync(root, { recursive: true });
    const metadata = fs.lstatSync(root);
    if (!metadata.isDirectory())
        throw new Error('OpenCode private state root is not a directory.');
    const identity = `${metadata.dev}:${metadata.ino}`;
    if (sealedWindowsRoots.get(root) === identity)
        return;
    windowsAcl(root, true);
    sealedWindowsRoots.set(root, identity);
}
export function verifyOpenCodePrivateWindowsPath(filename) {
    if (process.platform === 'win32')
        windowsAcl(filename, false);
}
//# sourceMappingURL=opencode-private-state.js.map