export interface LocalAttachBinding {
    origin: string;
    trustIdentity: string;
    cubeId: string;
    roleId: string;
}
/**
 * Load or create the non-authoritative attach correlator before any request is
 * sent. A lost response therefore reuses the exact same server binding.
 */
export declare function getOrCreateLocalAttachRetryKey(binding: LocalAttachBinding, projectRoot?: string): Promise<string>;
//# sourceMappingURL=server-attach-state.d.ts.map