/**
 * Fresh-vs-configured rule. "Configured" = the user has completed `borg setup`,
 * signalled by the PRESENCE of a stored credential. Inputs are existence
 * booleans only — the caller null-checks the token accessors and never decodes,
 * logs, or prints the token value (SR gh#817 constraint).
 *
 * Refresh-token presence is the durable signal: it survives id_token expiry, so
 * a configured user whose id_token has lapsed is NOT mistaken for fresh (which
 * would wrongly suppress their normal launch). The id_token presence is the
 * fallback for the rare case where Google returned no refresh_token and the
 * id_token is still valid.
 */
export declare function shouldShowGetStarted(hasRefreshToken: boolean, hasIdToken: boolean): boolean;
/**
 * The user-visible get-started text. Carries ZERO auth material (no tokens, no
 * PII) — it is pure onboarding guidance. When no agent CLI is detected, lead
 * with the install-an-agent-CLI step (mirrors the B1 banner intent).
 */
export declare function composeGetStarted(hasAgentCli: boolean): string;
//# sourceMappingURL=get-started.d.ts.map