import { LocalManageRequiredError } from './server-errors.js';
export class RoleSectionConflictError extends Error {
    operation;
    constructor(operation) {
        super('The role section patch conflicted with the current role text.');
        this.operation = operation;
        this.name = 'RoleSectionConflictError';
    }
}
const UNSAFE_OPERATION_CHARACTER = /["\\`*_[\]()<>#!|~\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
function safeOperationValue(value) {
    const escaped = Array.from(value, (character) => UNSAFE_OPERATION_CHARACTER.test(character)
        ? `\\u{${character.codePointAt(0).toString(16)}}`
        : character).join('');
    return `"${escaped}"`;
}
export function formatLocalManageToolResult(error) {
    if (error instanceof RoleSectionConflictError) {
        const { roleId, action, heading, after } = error.operation;
        const context = [
            `action=${action}`,
            `heading=${safeOperationValue(heading)}`,
            ...(action === 'insert'
                ? [`after=${after == null ? '<end>' : safeOperationValue(after)}`]
                : []),
        ].join(', ');
        return {
            content: [{
                    type: 'text',
                    text: `[ROLE-SECTION-CONFLICT] The requested role section operation conflicts with the current role text.\n\n` +
                        `Requested operation: ${context}\n\n` +
                        'No role text was changed by this request. ' +
                        `Read the current role with \`borg_role\` using role id ${safeOperationValue(roleId)}, ` +
                        'then retry `borg_patch-role-section` against that current text.',
                }],
            isError: true,
        };
    }
    if (!(error instanceof LocalManageRequiredError))
        return null;
    return {
        content: [{ type: 'text', text: error.message }],
        isError: true,
    };
}
//# sourceMappingURL=local-manage-tool-result.js.map