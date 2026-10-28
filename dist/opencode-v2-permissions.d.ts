import type { OpenCodeClient } from '@opencode/client';
export interface OpenCodeV2Permission {
    action: string;
    resource: string;
    effect: 'allow' | 'deny' | 'ask';
}
export declare const OPENCODE_V2_COORDINATION_TOOLS: string[];
export declare function effectiveOpenCodeV2Permission(rules: readonly OpenCodeV2Permission[], action: string, resource?: string): OpenCodeV2Permission['effect'];
/** Query only the owned server; `opencode debug config` starts a shared V2 service. */
export declare function applyOpenCodeV2LaunchPermissions(client: OpenCodeClient, sessionID: string, directory: string, skipOverride: boolean, accessDirectories?: readonly string[]): Promise<string[]>;
//# sourceMappingURL=opencode-v2-permissions.d.ts.map