import { type StreamOwnerDeps, type StreamOwnershipSnapshot } from './stream-owner.js';
import type { RepresentativeBinding } from './representative-store.js';
export declare function representativeOwnerDeps(binding: RepresentativeBinding): StreamOwnerDeps;
export declare function representativeOwnership(binding: RepresentativeBinding): Promise<StreamOwnershipSnapshot>;
export declare function createRepresentativeOwner(): {
    snapshot: (binding: RepresentativeBinding) => Promise<StreamOwnershipSnapshot>;
    ensure: (binding: RepresentativeBinding) => Promise<undefined>;
    close: () => Promise<void>;
};
//# sourceMappingURL=representative-owner.d.ts.map