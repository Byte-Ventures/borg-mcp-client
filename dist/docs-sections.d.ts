/**
 * The single source for the in-product docs index.
 *
 * `borg_docs` (index.ts) returns these sections so an agent can route a "how
 * does borgmcp work / setup / concept / tool" question to the right
 * public documentation page, then WebFetch the URL for the content. Pure data +
 * a lazy keyword match — NO server-side fetch, NO RAG/embeddings.
 *
 * Most topics route to borgmcp.ai; repository-resident operator detail routes
 * to the public source repository.
 */
export interface DocsSection {
    /** logical topic key */
    slug: string;
    title: string;
    /** public documentation URL the agent should WebFetch */
    url: string;
    summary: string;
    /** extra match terms for the topic lookup */
    keywords: string[];
}
export declare const DOCS_SECTIONS: DocsSection[];
/**
 * Lazy topic match: a section matches when the topic shares a whitespace token
 * with the section's slug / title / summary / keywords (case-insensitive,
 * substring both ways so "price"↔"pricing"). Returns matches ranked by hit
 * count; empty when nothing matches (the caller then shows the full index).
 */
export declare function matchDocsSections(topic: string): DocsSection[];
/** Render sections as a plain-text index (title — summary — URL per line). */
export declare function formatDocsIndex(sections: DocsSection[]): string;
//# sourceMappingURL=docs-sections.d.ts.map