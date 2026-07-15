// POSIX-safe shell-escaping for paste-intended emission.
//
// Sprint 18 (gh-tracked via dispatch 10:41:47Z): when the CLI emits a
// `cd <path>` line for the user to copy-paste into their shell, the path is
// a filesystem-controlled string with no character constraints (unlike
// DB-CHECK-constrained role/cube names). Paths can legally contain spaces,
// `$VAR`, backticks, `$(cmd)`, embedded single-quotes, and other shell
// metacharacters that would execute on paste under naive emission.
//
// drone-11 SR-LANE (cube entry 2026-05-19T10:44:35Z) escalation: double-
// quoting handles spaces but `$VAR` / backtick / `$(cmd)` still expand
// inside double-quotes. Single-quotes with internal-quote escape (`'\''`
// = close-quote / escaped-quote / re-open-quote) defang every shell
// metachar including embedded `'`. POSIX-defined, copy-paste-runnable
// across bash / zsh / dash / sh.
//
// Behavior: returns the input wrapped in single-quotes with any internal
// `'` rewritten as `'\''`. Empty string returns `''`.
export function shellEscape(s) {
    return `'${s.replace(/'/g, `'\\''`)}'`;
}
//# sourceMappingURL=shell-escape.js.map