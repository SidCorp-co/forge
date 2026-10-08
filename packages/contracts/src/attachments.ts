// One copy of each list a browser stages against: a second drifts, and staging
// what the PUT then refuses costs the person the file (ISS-1146).

const MIB = 1024 * 1024;

/**
 * Each type a conversation takes, with the extensions that name it and the most bytes it may carry.
 * A document is read by the assistant as text (`core/src/lib/document-text.ts`), so a text format's
 * cap is far below a picture's: past it, the turn could not show the model more than a cut of it.
 */
export const CONVERSATION_ATTACHMENT_TYPES = [
	{
		mime: "image/png",
		extensions: [".png"],
		maxBytes: 10 * MIB,
		kind: "image",
	},
	{
		mime: "image/jpeg",
		extensions: [".jpg", ".jpeg"],
		maxBytes: 10 * MIB,
		kind: "image",
	},
	{
		mime: "image/gif",
		extensions: [".gif"],
		maxBytes: 10 * MIB,
		kind: "image",
	},
	{
		mime: "image/webp",
		extensions: [".webp"],
		maxBytes: 10 * MIB,
		kind: "image",
	},
	{
		mime: "application/pdf",
		extensions: [".pdf"],
		maxBytes: 10 * MIB,
		kind: "document",
	},
	{
		mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		extensions: [".docx"],
		maxBytes: 10 * MIB,
		kind: "document",
	},
	{
		mime: "text/markdown",
		extensions: [".md", ".markdown"],
		maxBytes: 2 * MIB,
		kind: "document",
	},
	{
		mime: "text/plain",
		extensions: [".txt"],
		maxBytes: 2 * MIB,
		kind: "document",
	},
	{
		mime: "text/csv",
		extensions: [".csv"],
		maxBytes: 2 * MIB,
		kind: "document",
	},
	{
		mime: "application/json",
		extensions: [".json"],
		maxBytes: 2 * MIB,
		kind: "document",
	},
] as const satisfies readonly {
	mime: string;
	extensions: readonly string[];
	maxBytes: number;
	kind: "image" | "document";
}[];

export type ConversationAttachmentType =
	(typeof CONVERSATION_ATTACHMENT_TYPES)[number];

export const CONVERSATION_MIMES: readonly string[] =
	CONVERSATION_ATTACHMENT_TYPES.map((t) => t.mime);

/** The types a conversation reads as text rather than shows the model as a picture. */
export const CONVERSATION_DOCUMENT_MIMES: readonly string[] =
	CONVERSATION_ATTACHMENT_TYPES.filter((t) => t.kind === "document").map(
		(t) => t.mime,
	);

export function conversationAttachmentType(
	mime: string,
): ConversationAttachmentType | undefined {
	return CONVERSATION_ATTACHMENT_TYPES.find((t) => t.mime === mime);
}

/** A cap as a person reads it: whole mebibytes as "10 MB", anything else in KB. */
export function formatAttachmentCap(bytes: number): string {
	return bytes % MIB === 0
		? `${bytes / MIB} MB`
		: `${Math.round(bytes / 1024)} KB`;
}

/**
 * Every type a conversation takes with its cap, as one sentence a refusal ends with:
 * ".png, .jpg, .jpeg, .gif, .webp, .pdf or .docx up to 10 MB; .md, .markdown, .txt, .csv or .json up to 2 MB".
 * `ceiling` is the deployment's own upload limit, which lowers every cap above it.
 */
export function conversationAcceptedList(
	ceiling = Number.POSITIVE_INFINITY,
): string {
	const groups = new Map<number, string[]>();
	for (const t of CONVERSATION_ATTACHMENT_TYPES) {
		const cap = Math.min(t.maxBytes, ceiling);
		groups.set(cap, [...(groups.get(cap) ?? []), ...t.extensions]);
	}
	return [...groups]
		.map(([cap, exts]) => {
			const head = exts.slice(0, -1).join(", ");
			const listed = head
				? `${head} or ${exts[exts.length - 1]}`
				: (exts[0] ?? "");
			return `${listed} up to ${formatAttachmentCap(cap)}`;
		})
		.join("; ");
}

/**
 * The type a picked file is staged and uploaded under: the browser's own where a conversation takes
 * it, else the type its extension names. A browser names no type for `.md` on some systems, and
 * Windows names `.csv` `application/vnd.ms-excel`; the server still judges the bytes it is sent.
 */
export function conversationTypeOfFile(
	name: string,
	browserType: string,
): string {
	if (CONVERSATION_MIMES.includes(browserType)) return browserType;
	const dot = name.lastIndexOf(".");
	const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
	const byExtension = CONVERSATION_ATTACHMENT_TYPES.find((t) =>
		(t.extensions as readonly string[]).includes(ext),
	);
	return byExtension?.mime ?? browserType;
}

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

/** What every attachment write (issue, comment, session, conversation, upload ticket) refuses. */
export const ATTACHMENT_REFUSAL_CODES = [
	"ATTACHMENT_REFUSED",
	"MIME_NOT_ALLOWED",
	"FILE_TOO_LARGE",
	"EMPTY_FILE",
	"INVALID_NAME",
	"ATTACHMENT_NAME_TAKEN",
	"UPLOAD_OPERATION_REUSED",
	"UPLOAD_IN_PROGRESS",
	"UPLOAD_OUTCOME_UNKNOWN",
] as const;

export type AttachmentRefusalCode = (typeof ATTACHMENT_REFUSAL_CODES)[number];

/** A ticket minted twice under one operation id for different files, and a replay whose first PUT has not finished or never recorded its answer. */
export const ATTACHMENT_REFUSAL_STATUSES = {
	UPLOAD_OPERATION_REUSED: 409,
	UPLOAD_IN_PROGRESS: 409,
	UPLOAD_OUTCOME_UNKNOWN: 409,
} as const;

/** The files an issue's create carries inline; a comment takes any number, one upload each. */
export const ISSUE_CREATE_ATTACHMENTS_MAX = 10;
