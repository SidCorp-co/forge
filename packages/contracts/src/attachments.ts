// One copy of each list a browser stages against: a second drifts, and staging
// what the PUT then refuses costs the person the file (ISS-1146).

export const CONVERSATION_MIMES = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
] as const;

export const SESSION_MIMES = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/svg+xml",
	"text/html",
	"application/pdf",
	"text/plain",
	"text/markdown",
] as const;

// The stored name a file gets and the budget it fits in: the browser refuses
// the name the server would, when the file is picked rather than after the PUT.
export function safeAttachmentName(name: string): string {
  const cleaned = name
    .normalize("NFC")
    .replace(/[\\/]+/g, "_")
    .replace(/[\p{C}\p{Z}]/gu, "_")
    .replace(/[^\p{L}\p{M}\p{N}._-]/gu, "_");
  return cleaned || "file";
}

export const ATTACHMENT_NAME_MAX_BYTES = 180;

export function attachmentNameExceedsBudget(name: string): boolean {
  return new TextEncoder().encode(name).length > ATTACHMENT_NAME_MAX_BYTES;
}
