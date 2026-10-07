"use client";

import type { UseMutationResult } from "@tanstack/react-query";
import { useState } from "react";
import { documentRefusals, type Refusal } from "@/lib/api/refusals";
import { isStaleBase, pointerOf, REMOVE, reapply, sameDocument, setAt, STALE_BASE } from "./document-edit";
import type { V1Document, V1Read, V1Write, V1Written } from "./types";

type Write = UseMutationResult<V1Written, Error, V1Write>;

/** A document as a section of settings holds it: the revision it was read at, the edits on top, and
 *  the one write that saves them — the same `{ baseRevision, document }` the raw editor sends. */
export interface DocumentDraft {
	/** False until the document has been read; a section draws nothing editable before that. */
	ready: boolean;
	declared: boolean;
	revision: number | null;
	document: V1Document;
	dirty: boolean;
	/** Someone saved a newer revision while this one held edits. */
	moved: boolean;
	saving: boolean;
	refusals: Refusal[];
	/** A failure that named no refusal (a network error, a 403). */
	failure: Error | null;
	savedRevision: number | null;
	get: (path: readonly string[]) => unknown;
	set: (path: readonly string[], value: unknown) => void;
	/** `path`'s refusals: those naming it or anything under it. */
	refusedAt: (path: readonly string[]) => Refusal[];
	save: () => Promise<boolean>;
	discard: () => void;
	reapplyOnFresh: () => void;
}

interface Held {
	revision: number | null;
	read: V1Document | null;
	draft: V1Document;
}

const heldOf = (read: V1Read | undefined, template?: V1Document): Held =>
	read?.declared
		? { revision: read.revision, read: read.document, draft: read.document }
		: { revision: null, read: read && template ? template : null, draft: read && template ? template : {} };

/** `null` and `undefined` set a key absent, as an emptied optional field is. */
const valueFor = (value: unknown) => (value === undefined ? REMOVE : value);

function getAt(document: unknown, path: readonly string[]): unknown {
	let cursor = document;
	for (const segment of path) {
		if (Array.isArray(cursor)) cursor = cursor[Number(segment)];
		else if (cursor !== null && typeof cursor === "object") cursor = (cursor as Record<string, unknown>)[segment];
		else return undefined;
	}
	return cursor;
}

/** `refetch` reads the stored revision again after a write refused as stale, so the section can offer to
 *  re-apply. With a `template`, an undeclared document is edited from it and its first save writes revision 1. */
export function useDocumentDraft(
	read: V1Read | undefined,
	write: Write,
	refetch?: () => unknown,
	template?: V1Document,
): DocumentDraft {
	const [held, setHeld] = useState<Held>(() => heldOf(read, template));
	const [savedRevision, setSavedRevision] = useState<number | null>(null);
	const dirty = held.read !== null && !sameDocument(held.draft, held.read);
	const behind = read?.declared === true && read.revision > (held.revision ?? 0);
	if (read && (behind || (held.read === null && (read.declared || template))) && !dirty) setHeld(heldOf(read, template));

	const refusals = write.isError ? documentRefusals(write.error) : [];
	const failure = write.isError && refusals.length === 0 ? write.error : null;

	return {
		ready: read !== undefined,
		declared: read?.declared === true,
		revision: held.revision,
		document: held.draft,
		dirty,
		moved: behind && dirty,
		saving: write.isPending,
		refusals,
		failure,
		savedRevision,
		get: (path) => getAt(held.draft, path),
		set: (path, value) => {
			if (write.isError) write.reset();
			setSavedRevision(null);
			setHeld((h) => ({ ...h, draft: setAt(h.draft, path, valueFor(value)) as V1Document }));
		},
		refusedAt: (path) => {
			const at = pointerOf(path);
			return refusals.filter((r) => r.code !== STALE_BASE && (r.path === at || r.path.startsWith(`${at}/`)));
		},
		save: () =>
			new Promise<boolean>((resolve) => {
				if (!dirty || (held.revision === null && held.read === null)) return resolve(true);
				write.mutate(
					{ baseRevision: held.revision, document: held.draft },
					{
						onSuccess: (saved) => {
							setHeld({ revision: saved.revision, read: saved.document, draft: saved.document });
							setSavedRevision(saved.revision);
							resolve(true);
						},
						onError: (err) => {
							if (isStaleBase(err)) refetch?.();
							resolve(false);
						},
					},
				);
			}),
		discard: () => {
			write.reset();
			setHeld(heldOf(read, template));
		},
		reapplyOnFresh: () => {
			if (!read?.declared) return;
			write.reset();
			setHeld({ revision: read.revision, read: read.document, draft: reapply(held.read, held.draft, read.document) });
		},
	};
}

/** Every draft a section saves, as one: dirty when any is, saved in turn, first refusal stops. */
export function sectionOf(drafts: readonly DocumentDraft[]) {
	return {
		dirty: drafts.some((d) => d.dirty),
		moved: drafts.some((d) => d.moved),
		saving: drafts.some((d) => d.saving),
		refusals: drafts.flatMap((d) => d.refusals),
		failures: drafts.flatMap((d) => (d.failure ? [d.failure] : [])),
		saved: drafts.some((d) => d.savedRevision !== null) && !drafts.some((d) => d.dirty),
		save: async () => {
			for (const d of drafts) if (d.dirty && !(await d.save())) return false;
			return true;
		},
		discard: () => {
			for (const d of drafts) d.discard();
		},
		reapply: () => {
			for (const d of drafts) if (d.moved) d.reapplyOnFresh();
		},
	};
}
