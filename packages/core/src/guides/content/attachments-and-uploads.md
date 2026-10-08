## Attachments & uploads

### Writing an attachment — presigned URL, not base64
For anything beyond a tiny snippet, use the `forge_uploads` presigned-URL pattern instead of inlining base64 bytes into a tool call: request an upload URL, then upload the file straight to storage. Base64 in a request body is slow to transmit and burns context tokens carrying bytes that don't need to pass through the model at all.

### Reading an attachment's content
`forge_uploads` with `action=fetch` reads an **existing** attachment by `{ target: "issue" | "comment", attachmentId }`:
- Images (png/jpeg/gif/webp) come back as a viewable image block — use this whenever an issue or comment references a screenshot you need to actually look at, not just acknowledge.
- Text/markdown comes back inline.
- PDFs, video, and oversized files come back as metadata + a download URL only — fetch does not try to inline everything.

### The typical flow
1. Create the comment or issue update that will carry the attachment.
2. Request a presigned upload URL from `forge_uploads`.
3. Upload the file directly to the returned URL.
4. Later, any reader (including a different agent) calls `action=fetch` on that attachment to see its actual content — never assume a filename or mime type tells you enough; fetch it when the content matters to the task.