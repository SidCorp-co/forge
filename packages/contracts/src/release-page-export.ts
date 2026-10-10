// A release page as a person takes it out of Forge (REQ-40 BC-11): Markdown to paste, and an email
// file (.eml) to send from their own mail, since Forge sends no mail. Both are built from the page's
// user sections only, whatever view the page was read in: the technical notes are an engineer's, and
// a page that carries them is exported without them. A clip or picture is a link, never an embedded
// file; an in-app link needs the reader's session, so what is exported says so rather than hiding it.

import type {
	ReleaseHighlights,
	ReleaseMediaRef,
	ReleasePage,
	ReleasePageChange,
	ReleasePageCriteria,
	ReleasePageProven,
	ReleasePageRequirement,
} from "./release-page.js";

export interface ReleasePageExportOptions {
	/** The origin links are made absolute against, for example `https://forge.example`. */
	origin?: string | undefined;
}

export interface ReleasePageEmail {
	subject: string;
	/** The plain-text body: the same words as the Markdown, with nothing to render. */
	text: string;
	html: string;
}

/** A known issue's state in the words a person outside the team reads; the verdict's reason is the developer view's and never leaves with an export. */
export const KNOWN_ISSUE_WORDS: Record<string, string> = {
	fail: "Failing",
	short: "Falls short",
	skipped: "Skipped",
	not_judged: "Not yet judged",
};

const APPROVAL_WORDS: Record<
	ReleasePage["header"]["approval"]["state"],
	string
> = {
	not_asked: "No approval asked",
	pending: "Approval pending",
	approved: "Approved",
	returned: "Returned for changes",
};

const day = (iso: string) => iso.slice(0, 10);

function absolute(url: string, origin: string | undefined): string {
	if (/^https?:\/\//i.test(url) || !origin) return url;
	return `${origin.replace(/\/+$/, "")}${url.startsWith("/") ? url : `/${url}`}`;
}

/** The facts a header line reads, in the order a reader looks for them. */
function headerFacts(page: ReleasePage): string[] {
	const h = page.header;
	const facts: string[] = [];
	if (h.releasedAt) facts.push(`Released ${day(h.releasedAt)}`);
	const where = h.environment?.url ?? h.environment?.name ?? null;
	if (where) facts.push(`Runs at ${where}`);
	if (h.build) facts.push(`Build ${h.build.slice(0, 7)}`);
	if (h.verified.total > 0)
		facts.push(`${h.verified.proven} of ${h.verified.total} criteria proven`);
	const a = h.approval;
	facts.push(
		a.state === "approved" && a.by
			? `Approved by ${a.by.name}${a.at ? ` on ${day(a.at)}` : ""}`
			: APPROVAL_WORDS[a.state],
	);
	return facts;
}

/** One plain paragraph per section, as both exports share them. */
interface Section {
	title: string;
	items: { text: string; link?: { label: string; url: string } }[];
	/** Said in place of a list when the section is meant to be read empty. */
	none?: string;
}

function highlightItems(
	highlights: ReleaseHighlights,
	origin: string | undefined,
): Section["items"] {
	if (highlights.state !== "drafted") return [];
	return highlights.highlights.map((h) => ({
		text: `${h.title}: ${h.body}`,
		...(h.media ? { link: mediaLink(h.media, origin) } : {}),
	}));
}

function mediaLink(m: ReleaseMediaRef, origin: string | undefined) {
	return {
		label: m.kind === "clip" ? "Watch the clip" : "See the picture",
		url: m.url ? absolute(m.url, origin) : "",
	};
}

const lineOf = (c: ReleasePageChange) => ({ text: c.line });

const rowText = (p: ReleasePageProven) =>
	p.short ? `${p.statement} (short of its wording)` : p.statement;

/** One group's proven criteria, a short marked, then how many are not proven on the build. */
function criteriaText(g: ReleasePageCriteria): string {
	const proven =
		g.proven.length > 0 ? `: ${g.proven.map(rowText).join("; ")}` : "";
	return `${proven}${g.unproven > 0 ? ` (${g.unproven} not yet proven on this build)` : ""}`;
}

const bare = (text: string) => text.trim().replace(/\.+$/, "");

/**
 * A requirement counted in its own criteria, each one the build proves said once with the rows that
 * prove it; a share frozen before it was counted reads as its group did.
 */
function requirementText(r: ReleasePageRequirement): string {
	if (!r.business) return criteriaText(r);
	const b = r.business;
	const count = `: ${b.proven.length} of its ${b.total} criteria proven on this build`;
	const codes = b.proven.map((c) => {
		const rows = r.proven
			.filter((p) => p.code === c.code)
			.map((p) => `${bare(p.statement)}${p.short ? ", short of its wording" : ""}`);
		return `${bare(c.statement)} (${rows.join("; ")})`;
	});
	return codes.length > 0 ? `${count}: ${codes.join("; ")}` : count;
}

function sectionsOf(page: ReleasePage, origin: string | undefined): Section[] {
	const out: Section[] = [];
	const highlights = highlightItems(page.highlights, origin);
	if (highlights.length > 0)
		out.push({ title: "Highlights", items: highlights });
	const proves = [
		...page.requirements.map((r) => ({
			text: `${r.title}${r.completes ? " (complete)" : " (in progress)"}${requirementText(r)}`,
		})),
		...(page.untraced
			? [{ text: `Not traced to a requirement${criteriaText(page.untraced)}` }]
			: []),
	];
	if (proves.length > 0)
		out.push({ title: "What this release proves", items: proves });
	if (page.improvements.length > 0)
		out.push({ title: "Improvements", items: page.improvements.map(lineOf) });
	if (page.fixes.length > 0)
		out.push({ title: "Fixes", items: page.fixes.map(lineOf) });
	out.push({
		title: "Action required",
		items: page.actionRequired.map((a) => ({
			text: `${a.sentence} (${a.ref})`,
		})),
		none:
			page.shipped.state === "unread"
				? `What this release requires of you could not be read: ${page.shipped.why}.`
				: "Nothing is required of you.",
	});
	out.push({
		title: "Known issues",
		items: page.knownIssues.map((k) => ({
			text: `${k.statement} (${KNOWN_ISSUE_WORDS[k.standing] ?? k.standing})`,
		})),
		none: "No known issues on this build.",
	});
	return out;
}

/** The release page as Markdown: its title, the facts of its header, then each user section. */
export function releasePageMarkdown(
	page: ReleasePage,
	opts: ReleasePageExportOptions = {},
): string {
	const parts = [
		`# Release ${page.header.version}`,
		"",
		headerFacts(page).join(" · "),
		"",
	];
	for (const s of sectionsOf(page, opts.origin)) {
		parts.push(`## ${s.title}`);
		if (s.items.length === 0) parts.push(s.none ?? "");
		for (const i of s.items)
			parts.push(
				`- ${i.text}${i.link?.url ? ` ([${i.link.label}](${i.link.url}))` : ""}`,
			);
		parts.push("");
	}
	return `${parts.join("\n").trimEnd()}\n`;
}

const escapeHtml = (s: string) =>
	s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

/** The release page as a message a person sends: a subject, a plain-text body and an HTML body. */
export function releasePageEmail(
	page: ReleasePage,
	opts: ReleasePageExportOptions = {},
): ReleasePageEmail {
	const subject = `Release ${page.header.version}`;
	const sections = sectionsOf(page, opts.origin);
	const facts = headerFacts(page).join(" · ");
	const text = [
		`${subject}`,
		facts,
		"",
		...sections.flatMap((s) => [
			s.title.toUpperCase(),
			...(s.items.length === 0
				? [s.none ?? ""]
				: s.items.map(
						(i) =>
							`- ${i.text}${i.link?.url ? ` (${i.link.label}: ${i.link.url})` : ""}`,
					)),
			"",
		]),
	]
		.join("\n")
		.trimEnd();
	const html = [
		"<!doctype html>",
		`<html><body style="font-family:sans-serif;max-width:640px">`,
		`<h1>${escapeHtml(subject)}</h1>`,
		`<p>${escapeHtml(facts)}</p>`,
		...sections.flatMap((s) => [
			`<h2>${escapeHtml(s.title)}</h2>`,
			...(s.items.length === 0
				? [`<p>${escapeHtml(s.none ?? "")}</p>`]
				: [
						"<ul>",
						...s.items.map(
							(i) =>
								`<li>${escapeHtml(i.text)}${
									i.link?.url
										? ` (<a href="${escapeHtml(i.link.url)}">${escapeHtml(i.link.label)}</a>)`
										: ""
								}</li>`,
						),
						"</ul>",
					]),
		]),
		"</body></html>",
	].join("\n");
	return { subject, text: `${text}\n`, html };
}

const base64 = (s: string): string => {
	const bytes = new TextEncoder().encode(s);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
};
const wrap76 = (s: string) => s.replace(/.{1,76}/g, "$&\r\n").trimEnd();

/**
 * The message as an .eml file a mail program opens as an unsent draft: UTF-8 throughout, the subject
 * an RFC 2047 word, the text and HTML bodies as the two alternatives of one multipart message.
 * `now` is the Date header; the caller names the instant so the file is the same given the same input.
 */
export function releasePageEml(email: ReleasePageEmail, now: Date): string {
	const boundary = `forge-release-${now.getTime().toString(36)}`;
	const body = (type: string, content: string) =>
		[
			`--${boundary}`,
			`Content-Type: ${type}; charset=utf-8`,
			"Content-Transfer-Encoding: base64",
			"",
			wrap76(base64(content)),
		].join("\r\n");
	return [
		`Date: ${now.toUTCString()}`,
		`Subject: =?UTF-8?B?${base64(email.subject)}?=`,
		"MIME-Version: 1.0",
		"X-Unsent: 1",
		`Content-Type: multipart/alternative; boundary="${boundary}"`,
		"",
		body("text/plain", email.text),
		body("text/html", email.html),
		`--${boundary}--`,
		"",
	].join("\r\n");
}
