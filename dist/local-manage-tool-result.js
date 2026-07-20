import { LocalManageRequiredError } from './server-errors.js';
export function formatLocalManageToolResult(error) {
    if (!(error instanceof LocalManageRequiredError))
        return null;
    return {
        content: [{ type: 'text', text: error.message }],
        isError: true,
    };
}
//# sourceMappingURL=local-manage-tool-result.js.map