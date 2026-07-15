import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const input = readFileSync(0);
if (input.length > 512) throw new Error('SHA-256 fingerprint input exceeds 512 bytes.');
process.stdout.write(createHash('sha256').update(input).digest('hex'));
