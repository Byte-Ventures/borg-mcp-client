/**
 * gh#docs-site phase B — the single source for the in-product docs index.
 *
 * `borg_docs` (index.ts) returns these sections so an agent can route a "how
 * does borgmcp work / pricing / setup" question to the right page, then WebFetch
 * the URL for the content. Pure data + a lazy keyword match — NO server-side
 * fetch, NO RAG/embeddings.
 *
 * `page` is the public documentation slug each section maps to.
 */
export declare const DOCS_BASE_URL = "https://borgmcp.ai/docs";
export interface DocsSection {
    /** logical topic key */
    slug: string;
    title: string;
    /** public page URL the agent should WebFetch */
    url: string;
    /** the docs/<page>.astro file this section maps to (anti-drift anchor) */
    page: string;
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