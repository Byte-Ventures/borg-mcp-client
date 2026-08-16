import type {
  CubeDocument,
  CubeDocumentMetadata,
  DocumentCitation,
} from 'borgmcp-shared/protocol';

function actorLabel(actor: CubeDocumentMetadata['author']): string {
  const identity = actor.label ?? actor.drone_id ?? 'operator';
  return actor.role ? `${identity} (${actor.role})` : identity;
}

export function formatDocumentMetadata(document: CubeDocumentMetadata): string {
  const lines = [
    `**${document.title}**`,
    `- id: ${document.id}`,
    `- state: ${document.state}`,
    `- content type: ${document.content_type}`,
    `- size: ${document.size_bytes} UTF-8 bytes`,
    `- author: ${actorLabel(document.author)}`,
    `- created: ${document.created_at}`,
  ];
  if (document.supersedes) lines.push(`- supersedes: ${document.supersedes}`);
  if (document.superseded_by) lines.push(`- superseded by: ${document.superseded_by}`);
  if (document.removed_by && document.removed_at) {
    lines.push(`- removed by: ${actorLabel(document.removed_by)}`);
    lines.push(`- removed: ${document.removed_at}`);
  }
  return lines.join('\n');
}

export function formatDocument(document: CubeDocument): string {
  return `${formatDocumentMetadata(document)}\n\n## Content\n\n${document.content}`;
}

export function formatDocumentCitation(citation: DocumentCitation): string {
  return `${citation.id} (${citation.state}, ${citation.size_bytes} UTF-8 bytes): ${citation.title}`;
}

export function formatDocumentCitations(citations: readonly DocumentCitation[] | undefined): string[] {
  return citations?.map(formatDocumentCitation) ?? [];
}
