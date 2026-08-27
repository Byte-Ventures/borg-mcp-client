import type { MessageTaxonomy } from 'borgmcp-shared/templates';
export declare const DIGEST_THRESHOLD = 50;
export declare const DIGEST_TAIL = 25;
export declare const DIGEST_FETCH_CAP = 2000;
interface ReadLogDigestInput {
    entries: any[];
    selfDroneId: string;
    taxonomy: MessageTaxonomy | null | undefined;
    droneById: Map<string, any>;
    roleById: Map<string, any>;
    tail: number;
    capped: number;
}
export interface ReadLogDigest {
    text: string;
    tailEntries: any[];
    omitted: number;
}
export declare function buildReadLogDigest(input: ReadLogDigestInput): ReadLogDigest;
export {};
//# sourceMappingURL=read-log-digest.d.ts.map