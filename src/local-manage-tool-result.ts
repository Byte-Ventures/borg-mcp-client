import { LocalManageRequiredError } from './server-errors.js';

export interface RoleSectionConflictOperation {
  roleId: string;
  action: 'replace' | 'insert' | 'delete';
  heading: string;
  after?: string | null;
}

export class RoleSectionConflictError extends Error {
  constructor(public readonly operation: RoleSectionConflictOperation) {
    super('The role section patch conflicted with the current role text.');
    this.name = 'RoleSectionConflictError';
  }
}

const UNSAFE_DISPLAY_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;

function safeOperationValue(value: string): string {
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replace(/([`*_[\]()<>#!|~])/gu, '\\$1')
    .replace(UNSAFE_DISPLAY_CHARACTER, (character) =>
      `\\u{${character.codePointAt(0)!.toString(16)}}`);
  return `"${escaped}"`;
}

export function formatLocalManageToolResult(error: unknown) {
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
        type: 'text' as const,
        text:
          `[ROLE-SECTION-CONFLICT] The requested role section operation conflicts with the current role text.\n\n` +
          `Requested operation: ${context}\n\n` +
          'No role text was changed by this request. ' +
          `Read the current role with \`borg_role\` using role id ${safeOperationValue(roleId)}, ` +
          'then retry `borg_patch-role-section` against that current text.',
      }],
      isError: true as const,
    };
  }
  if (!(error instanceof LocalManageRequiredError)) return null;

  return {
    content: [{ type: 'text' as const, text: error.message }],
    isError: true as const,
  };
}
