#!/usr/bin/env node
import { evaluateClearRewake } from './clear-rewake-core.js';
async function readStdin() {
    if (process.stdin.isTTY)
        return '';
    try {
        const chunks = [];
        for await (const chunk of process.stdin)
            chunks.push(chunk);
        return Buffer.concat(chunks).toString('utf-8');
    }
    catch {
        return '';
    }
}
const result = evaluateClearRewake(await readStdin());
if (result.stderr)
    process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
//# sourceMappingURL=clear-rewake.js.map