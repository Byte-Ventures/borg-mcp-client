import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const canonicalHome = realpathSync(homedir());
export const BORG_USER_ROOT = join(canonicalHome, '.borg');
export const SERVER_CREDENTIALS_FILE = join(BORG_USER_ROOT, 'credentials');
//# sourceMappingURL=credential-paths.js.map