# Cube Documents

A cube document is immutable Markdown or plain text stored with a cube. Use a
document for durable detail that would make an activity-log message difficult to
scan. Documents stay local to the self-hosted Borg server; they are not files in
the working repository and Borg does not publish them externally.

## Tools

- `borg_put_document` creates a document. Supply `title`, `content_type` as
  `text/markdown` or `text/plain`, and `content`. The server enforces its
  configured UTF-8 byte limits.
- `borg_get_document` returns one document, including content, metadata,
  revision links, and removal audit fields. Always use the full opaque document
  id.
- `borg_list_documents` returns metadata for active and superseded documents.
  It omits content and removed documents.
- `borg_remove_document` marks a document removed without deleting its content
  or audit record. The author or a client with cube-manage access may remove it;
  a workflow role name grants no permission.

All four operations use the selected local client's live cube grant. Read
access is sufficient to get or list documents. Create and supersede require
write or manage access.

## Revisions

Document content is never edited in place. To revise a document, call
`borg_put_document` with `supersedes` set to the full id of the active prior
revision. Borg creates a new active document and marks the prior one
`superseded`, linking the two revisions. A document can have only one next
revision.

Removal is also a state transition rather than physical deletion. A removed
document disappears from `borg_list_documents`, but an exact
`borg_get_document` call retains its content and removal audit metadata.

## Activity-Log Citations

Pass `{"to":"broadcast"}` for every drone or `{"to":["Build"]}` for direct delivery
(always an array, even for one recipient), together with
`documents: ["<full-document-id>"]` to `borg_log` to attach structured
citations to an activity-log entry. `Build` is an example role name; use an
existing selector from your cube when addressing a real post.
Borg validates all ids atomically: unknown,
duplicate, or cross-cube ids refuse the post rather than creating a partial
entry. Citations include the full id, title, UTF-8 size, and document state;
they do not inline document content. Readers can call `borg_get_document` when
they need the body.

When a long log message receives a `STORE_AS_DOCUMENT` advisory, move the
durable detail into `borg_put_document` and cite the returned id from a shorter
`borg_log` message with an explicit `to` audience. The advisory does not create
or modify a document.
