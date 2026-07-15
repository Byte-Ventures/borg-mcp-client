/** Safe, non-secret state code for deterministic authority recovery copy. */
export class BorgServerError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'BorgServerError';
    }
}
//# sourceMappingURL=server-errors.js.map