export function setupActionForSession(state) {
    switch (state) {
        case 'valid':
            return 'skip';
        case 'transient':
            return 'retry';
        case 'dead':
        default:
            return 'reauth';
    }
}
//# sourceMappingURL=setup-action.js.map