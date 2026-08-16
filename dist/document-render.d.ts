import type { CubeDocument, CubeDocumentMetadata, DocumentCitation } from 'borgmcp-shared/protocol';
export declare function formatDocumentMetadata(document: CubeDocumentMetadata): string;
export declare function formatDocument(document: CubeDocument): string;
export declare function formatDocumentCitation(citation: DocumentCitation): string;
export declare function formatDocumentCitations(citations: readonly DocumentCitation[] | undefined): string[];
//# sourceMappingURL=document-render.d.ts.map