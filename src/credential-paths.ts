import { join } from 'node:path';
import { borgHomeRoot } from './private-root.js';

const canonicalHome = borgHomeRoot();

export const BORG_USER_ROOT = join(canonicalHome, '.borg');
export const SERVER_CREDENTIALS_FILE = join(BORG_USER_ROOT, 'credentials');
