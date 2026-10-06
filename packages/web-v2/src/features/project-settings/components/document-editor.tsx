"use client";

import { useState, type ReactNode } from "react";
import type { UseMutationResult } from "@tanstack/react-query";
import { Banner, Button, PageSectionTitle, MonoTag, Tabs, Textarea } from "@/design";
import { canonicalJson } from "@forge/contracts/document-patch";
import { formatApiError } from "@/lib/api/error";
import { documentRefusals, type Refusal, readRefusal } from "@/lib/api/refusals";
import type { V1Document, V1Read, V1Write, V1Written } from "../config-types";
import {
	isStaleBase,
	movedSince,
	placeRefusals,
	reapply,
	sameDocument,
	setAt,
	STALE_BASE,
} from "../document-edit";
import { DocumentFields } from "./document-fields";

interface Held {
	revision: number | null;
	read: V1Document | null;
	draft: V1Document;
}

const seed = (read: V1Read, template: V1Document): Held =>
	read.declared
		? { revision: read.revision, read: read.document, draft: read.document }
		: { revision: null, read: null, draft: template };

const pretty = (doc: unknown) => JSON.stringify(doc, null, 2);

const MODES = [
	{ value: "fields", label: "Fields" },
	{ value: "json", label: "JSON" },
];

function MovedNotice({
	held,
	fresh,
	onReapply,
	onReload,
}: {
	held: Held;
	fresh: V1Read;
	onReapply: () => void;
	onReload: () => void;
}) {
	const moved = movedSince(held.read ?? {}, fresh.document ?? {}, held.draft);
	const stored = fresh.declared ? `revision ${fresh.revision}` : "no document";
	return (
		<Banner tone="attention">
			<div className="space-y-2">
				<p>
					This document moved since you read it: you read{" "}
					{held.revision === null ? "no document" : `revision ${held.revision}`}, and it now holds {stored}.
					Nothing of yours was written.
				</p>
				{moved.length > 0 && (
					<ul aria-label="What moved" className="list-disc pl-5">
						{moved.map((m) => (
							<li key={m.path}>
								<code>{m.path}</code>: you read <code>{canonicalJson(m.read)}</code>, it now holds{" "}
								<code>{canonicalJson(m.stored)}</code>
								{m.contested ? " — you edited this too; re-applying keeps your value" : ""}
							</li>
						))}
					</ul>
				)}
				<div className="flex flex-wrap gap-2">
					{fresh.declared && (
						<Button variant="primary" size="sm" onClick={onReapply}>
							Re-apply my edits on revision {fresh.revision}
						</Button>
					)}
					<Button variant="secondary" size="sm" onClick={onReload}>
						Reload, discarding my edits
					</Button>
				</div>
			</div>
		</Banner>
	);
}

function RefusalList({ refusals }: { refusals: readonly Refusal[] }) {
	return (
		<ul className="list-disc pl-5">
			{refusals.map((r) => (
				<li key={`${r.code}:${r.path}`}>
					<code>{r.code}</code> at <code>{readRefusal(r).where ?? "/"}</code>: {readRefusal(r).sentence}
				</li>
			))}
		</ul>
	);
}

type Write = UseMutationResult<V1Written, Error, V1Write>;

/** The draft held against the revision it was read at, and the edits, save and reseeds over it. */
function useHeldDocument(read: V1Read, template: V1Document, write: Write, onReload: () => unknown) {
	const [held, setHeld] = useState<Held>(() => seed(read, template));
	const [text, setText] = useState<string | null>(null);
	const [invalid, setInvalid] = useState<string | null>(null);

	const dirty = !sameDocument(held.draft, held.read ?? template);
	const behind = (read.revision ?? 0) > (held.revision ?? 0);
	if (behind && !dirty) setHeld(seed(read, template));

	function edit(draft: V1Document) {
		if (write.isError) write.reset();
		setHeld((h) => ({ ...h, draft }));
	}

	function editText(next: string) {
		setText(next);
		try {
			const value: unknown = JSON.parse(next);
			if (value === null || typeof value !== "object" || Array.isArray(value)) {
				setInvalid("The document is a JSON object. The fields keep the last object that parsed.");
				return;
			}
			setInvalid(null);
			edit(value as V1Document);
		} catch (err) {
			setInvalid(`Not valid JSON (${err instanceof Error ? err.message : String(err)}). The fields keep the last object that parsed.`);
		}
	}

	function save() {
		write.mutate(
			{ baseRevision: held.revision, document: held.draft },
			{
				onSuccess: (saved) => {
					setHeld({ revision: saved.revision, read: saved.document, draft: saved.document });
					setText(null);
				},
				onError: (err) => {
					if (isStaleBase(err)) onReload();
				},
			},
		);
	}

	const reseed = (next: Held) => {
		write.reset();
		setText(null);
		setInvalid(null);
		setHeld(next);
	};

	return { held, text, invalid, dirty, moved: behind && dirty, edit, editText, save, reseed };
}

function RefusedNotice({ write, mode }: { write: Write; mode: string }) {
	const refusals = documentRefusals(write.error);
	const stale = refusals.filter((r) => r.code === STALE_BASE);
	return (
		<Banner tone="danger" onDismiss={() => write.reset()}>
			<div className="space-y-1">
				<p>Refused, nothing written.</p>
				{stale.length > 0 && <RefusalList refusals={stale} />}
				{refusals.length === 0 && <p>{formatApiError(write.error)}</p>}
				{mode === "json" && refusals.length > stale.length && (
					<RefusalList refusals={refusals.filter((r) => r.code !== STALE_BASE)} />
				)}
				{mode === "fields" && refusals.length > stale.length && <p>Each other refusal is shown at the field it names.</p>}
			</div>
		</Banner>
	);
}

export function DocumentEditor({
	title,
	description,
	read,
	template,
	canEdit,
	write,
	onReload,
	actions,
}: {
	title: string;
	description?: ReactNode;
	read: V1Read;
	template: V1Document;
	canEdit: boolean;
	write: Write;
	onReload: () => unknown;
	actions?: ReactNode;
}) {
	const [mode, setMode] = useState("fields");
	const { held, text, invalid, dirty, moved, edit, editText, save, reseed } = useHeldDocument(read, template, write, onReload);
	const placed = placeRefusals(held.draft, write.isError ? documentRefusals(write.error) : []);

	return (
		<section aria-label={title} className="mt-6 border-t border-line pt-5">
			<div className="flex flex-wrap items-center gap-2">
				<PageSectionTitle className="fg-label text-fg">{title}</PageSectionTitle>
				<MonoTag>{read.declared ? `revision ${read.revision}` : "not declared"}</MonoTag>
				{actions}
			</div>
			{description && <div className="fg-body-sm mt-1 mb-3 text-muted">{description}</div>}
			{!read.declared && (
				<Banner tone="attention">Not declared yet. The fields below start from a template; saving writes revision 1.</Banner>
			)}
			{moved && (
				<MovedNotice
					held={held}
					fresh={read}
					onReapply={() =>
						reseed({
							revision: read.revision,
							read: read.document,
							draft: reapply(held.read, held.draft, read.document ?? {}),
						})
					}
					onReload={() => reseed(seed(read, template))}
				/>
			)}
			{write.isError && <RefusedNotice write={write} mode={mode} />}
			<div className="mt-3">
				<Tabs tabs={MODES} value={mode} onChange={setMode} />
			</div>
			<div className="mt-3">
				{mode === "fields" ? (
					<DocumentFields
						document={held.draft}
						placed={placed}
						canEdit={canEdit}
						onSet={(segments, value) => edit(setAt(held.draft, segments, value) as V1Document)}
					/>
				) : (
					<>
						<Textarea
							aria-label={`${title} (JSON)`}
							value={text ?? pretty(held.draft)}
							rows={18}
							readOnly={!canEdit}
							className="font-mono"
							onChange={(e) => editText(e.target.value)}
						/>
						{invalid && <Banner tone="danger">{invalid}</Banner>}
					</>
				)}
			</div>
			{canEdit && (
				<div className="mt-3 flex flex-wrap gap-2">
					<Button
						variant="primary"
						loading={write.isPending}
						disabled={(!dirty && read.declared) || moved || invalid !== null || write.isPending}
						onClick={save}
						className="min-h-11"
					>
						Save {title.toLowerCase()}
					</Button>
					{dirty && (
						<Button variant="ghost" onClick={() => reseed(seed(read, template))} className="min-h-11">
							Discard edits
						</Button>
					)}
				</div>
			)}
		</section>
	);
}
