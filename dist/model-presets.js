/**
 * Temporary compatibility helpers for the legacy Borg-managed Claude model
 * selector. Model/provider configuration belongs to the launched agent CLI;
 * the remaining selector is retired with the assimilation model wire cleanup.
 */
export const MODEL_DESCRIPTOR_REGEX = /^claude:[A-Za-z0-9._:\/-]+$/;
export function parseModel(descriptor) {
    if (!MODEL_DESCRIPTOR_REGEX.test(descriptor)) {
        throw new Error(`invalid model descriptor: ${descriptor} (expected claude:<model>)`);
    }
    return { kind: 'claude', model: descriptor.slice('claude:'.length) };
}
export function resolveLaunchEnv(descriptor) {
    if (!descriptor)
        return { set: {}, unset: [] };
    const { model } = parseModel(descriptor);
    return { set: { ANTHROPIC_MODEL: model }, unset: [] };
}
//# sourceMappingURL=model-presets.js.map