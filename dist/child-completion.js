/** Capture termination before launch-time async work can hide an early exit.
 * Resolve errors as data so callers may safely attach after admission settles. */
export function captureChildCompletion(child) {
    return new Promise(resolve => {
        const onError = (error) => { child.off('exit', onExit); resolve({ kind: 'error', error }); };
        const onExit = (code, signal) => {
            child.off('error', onError);
            resolve({ kind: 'exit', code, signal });
        };
        child.once('error', onError);
        child.once('exit', onExit);
    });
}
//# sourceMappingURL=child-completion.js.map