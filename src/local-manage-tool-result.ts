import { LocalManageRequiredError } from './server-errors.js';

export function formatLocalManageToolResult(error: unknown) {
  if (!(error instanceof LocalManageRequiredError)) return null;

  return {
    content: [{ type: 'text' as const, text: error.message }],
    isError: true as const,
  };
}
