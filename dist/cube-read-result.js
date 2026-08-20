export function rawCubeSettingsResult(cube) {
    if (typeof cube.cube_directive !== 'string') {
        throw new Error('Local Borg server returned an invalid cube directive');
    }
    const messageTaxonomy = cube.message_taxonomy ?? null;
    if (messageTaxonomy !== null && !Array.isArray(messageTaxonomy)) {
        throw new Error('Local Borg server returned an invalid message taxonomy');
    }
    return {
        content: [{ type: 'text', text: cube.cube_directive }],
        structuredContent: {
            cube_id: cube.id,
            cube_name: cube.name,
            cube_directive: cube.cube_directive,
            message_taxonomy: messageTaxonomy,
        },
    };
}
//# sourceMappingURL=cube-read-result.js.map