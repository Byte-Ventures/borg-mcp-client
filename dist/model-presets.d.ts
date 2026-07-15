/**
 * Temporary compatibility helpers for the legacy Borg-managed Claude model
 * selector. Model/provider configuration belongs to the launched agent CLI;
 * the remaining selector is retired with the assimilation model wire cleanup.
 */
export declare const MODEL_DESCRIPTOR_REGEX: RegExp;
export declare function parseModel(descriptor: string): {
    kind: 'claude';
    model: string;
};
export declare function resolveLaunchEnv(descriptor: string | null): {
    set: Record<string, string>;
    unset: string[];
};
//# sourceMappingURL=model-presets.d.ts.map