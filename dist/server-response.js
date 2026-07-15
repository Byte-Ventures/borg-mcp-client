function abortError(signal) {
    return signal.reason instanceof Error
        ? signal.reason
        : new Error('Borg server request was aborted');
}
async function readWithAbort(reader, signal) {
    if (!signal)
        return reader.read();
    if (signal.aborted)
        throw abortError(signal);
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(abortError(signal));
        signal.addEventListener('abort', onAbort, { once: true });
        reader.read().then(resolve, reject).finally(() => {
            signal.removeEventListener('abort', onAbort);
        });
    });
}
/** Read one server response without trusting Content-Length or stream EOF. */
export async function readBoundedResponseBody(response, maxBytes, limitMessage, signal) {
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null) {
        const parsed = Number(declaredLength);
        if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maxBytes) {
            await response.body?.cancel().catch(() => { });
            throw new Error(limitMessage);
        }
    }
    if (!response.body)
        return '';
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await readWithAbort(reader, signal);
            if (done)
                break;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel().catch(() => { });
                throw new Error(limitMessage);
            }
            chunks.push(value);
        }
    }
    catch (error) {
        await reader.cancel(error).catch(() => { });
        throw error;
    }
    finally {
        try {
            reader.releaseLock();
        }
        catch {
            // The stream may already be canceled.
        }
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
}
//# sourceMappingURL=server-response.js.map