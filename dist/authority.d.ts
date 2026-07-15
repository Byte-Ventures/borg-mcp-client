/**
 * The one authority allowed to receive Borg Cloud OAuth credentials.
 *
 * BORG_API_URL is a routing/configuration override used by development and
 * test environments. It is mutable process input, so equality with that value
 * can never prove that an explicit drone-session endpoint is Borg Cloud.
 */
export declare const CANONICAL_HOSTED_API_URL = "https://api.borgmcp.ai";
export declare function isCanonicalHostedApiUrl(apiUrl: string): boolean;
//# sourceMappingURL=authority.d.ts.map