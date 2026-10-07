"use client";

import { useState, type ReactNode } from "react";
import type { UseMutationResult } from "@tanstack/react-query";
import { Banner, Button, PageSectionTitle, MonoTag, Tabs, Textarea } from "@/design";
import { canonicalJson } from "@forge/contracts/document-patch";
import { formatApiError } from "@/lib/api/error";
import { documentRefusals, type Refusal, readRefusal } from "@/lib/api/refusals";
import type { V1Document, V1Read, V1Write, V1Written } from "@/features/project-config/types";
import {
	isStaleBase,
	movedSince,
	placeRefusals,
	reapply,
	sameDocument,
	setAt,
	STALE_BASE,
} from "@/features/project-config/document-edit";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { DocumentFields, PROJECT_IDENTITY } from "./document-fields";

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

/** The value at a JSON pointer, or `undefined` where nothing stands there. */
function at(document: unknown, pointer: string): unknown {
	let cursor = document;
	for (const segment of pointer.slice(1).split("/")) {
		if (cursor === null || typeof cursor !== "object") return undefined;
		cursor = (cursor as Record<string, unknown>)[segment.replaceAll("~1", "/").replaceAll("~0", "~")];
	}
	return cursor;
}

/** The first fixed key `next` changes or removes from `held`, dotted as a reader names it. */
export function fixedChanged(held: unknown, next: unknown, fixed: readonly string[]): string | null {
	const moved = fixed.find((p) => at(held, p) !== undefined && JSON.stringify(at(held, p)) !== JSON.stringify(at(next, p)));
	return moved ? moved.slice(1).replaceAll("/", ".") : null;
}

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
	const t = useCopy();
	const moved = movedSince(held.read ?? {}, fresh.document ?? {}, held.draft);
	const revision = (r: number | null) => (r === null ? t("settings.project.raw.noDocument") : t("settings.project.raw.revision", { revision: r }));
	return (
		<Banner tone="attention">
			<div className="space-y-2">
				<p>{t("settings.project.raw.moved", { read: revision(held.revision), stored: revision(fresh.declared ? fresh.revision : null) })}</p>
				{moved.length > 0 && (
					<ul aria-label={t("settings.project.raw.whatMoved")} className="list-disc pl-5">
						{moved.map((m) => (
							<li key={m.path}>
								{t("settings.project.raw.movedValue", { path: m.path, read: canonicalJson(m.read), stored: canonicalJson(m.stored) })}
								{m.contested ? ` ${t("settings.project.raw.contested")}` : ""}
							</li>
						))}
					</ul>
				)}
				<div className="flex flex-wrap gap-2">
					{fresh.declared && (
						<Button variant="primary" size="sm" onClick={onReapply}>
							{t("settings.project.raw.reapply", { revision: fresh.revision })}
						</Button>
					)}
					<Button variant="secondary" size="sm" onClick={onReload}>
						{t("settings.project.raw.reload")}
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
					<code translate="no">{r.code}</code> <code translate="no">{readRefusal(r).where ?? "/"}</code>: {readRefusal(r).sentence}
				</li>
			))}
		</ul>
	);
}

type Write = UseMutationResult<V1Written, Error, V1Write>;

/** The draft held against the revision it was read at, and the edits, save and reseeds over it. */
function useHeldDocument(read: V1Read, template: V1Document, write: Write, onReload: () => unknown, fixed: readonly string[], t: Copy) {
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
				setInvalid(t("settings.project.raw.notObject"));
				return;
			}
			const changed = fixedChanged(held.read ?? template, value, fixed);
			if (changed) {
				setInvalid(t("settings.project.raw.fixedChanged", { key: changed }));
				return;
			}
			setInvalid(null);
			edit(value as V1Document);
		} catch (err) {
			setInvalid(t("settings.project.raw.notJson", { error: err instanceof Error ? err.message : String(err) }));
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
	const t = useCopy();
	const refusals = documentRefusals(write.error);
	const stale = refusals.filter((r) => r.code === STALE_BASE);
	return (
		<Banner tone="danger" onDismiss={() => write.reset()}>
			<div className="space-y-1">
				<p>{t("settings.project.raw.refused")}</p>
				{stale.length > 0 && <RefusalList refusals={stale} />}
				{refusals.length === 0 && <p>{formatApiError(write.error)}</p>}
				{mode === "json" && refusals.length > stale.length && (
					<RefusalList refusals={refusals.filter((r) => r.code !== STALE_BASE)} />
				)}
				{mode === "fields" && refusals.length > stale.length && <p>{t("settings.project.raw.refusedAtFields")}</p>}
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
	fixed = PROJECT_IDENTITY,
}: {
	/** Pointers no edit here changes or removes: who the document is. */
	fixed?: readonly string[];
	title: string;
	description?: ReactNode;
	read: V1Read;
	template: V1Document;
	canEdit: boolean;
	write: Write;
	onReload: () => unknown;
	actions?: ReactNode;
}) {
	const t = useCopy();
	const [mode, setMode] = useState("fields");
	const { held, text, invalid, dirty, moved, edit, editText, save, reseed } = useHeldDocument(read, template, write, onReload, fixed, t);
	const modes = [
		{ value: "fields", label: t("settings.project.raw.fields") },
		{ value: "json", label: "JSON" },
	];
	const placed = placeRefusals(held.draft, write.isError ? documentRefusals(write.error) : []);

	return (
		<section aria-label={title} className="mt-6 border-t border-line pt-5">
			<div className="flex flex-wrap items-center gap-2">
				<PageSectionTitle className="fg-label text-fg">{title}</PageSectionTitle>
				<MonoTag>{read.declared ? t("settings.project.raw.revision", { revision: read.revision }) : t("settings.project.raw.notDeclared")}</MonoTag>
				{actions}
			</div>
			{description && <div className="fg-body-sm mt-1 mb-3 text-muted">{description}</div>}
			{!read.declared && (
				<Banner tone="attention">{t("settings.project.raw.fromTemplate")}</Banner>
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
				<Tabs tabs={modes} value={mode} onChange={setMode} />
			</div>
			<div className="mt-3">
				{mode === "fields" ? (
					<DocumentFields
						document={held.draft}
						placed={placed}
						canEdit={canEdit}
						fixed={fixed}
						onSet={(segments, value) => edit(setAt(held.draft, segments, value) as V1Document)}
					/>
				) : (
					<>
						<Textarea
							aria-label={`${title} (JSON)`}
							translate="no"
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
						{t("settings.project.raw.save", { title: title.toLowerCase() })}
					</Button>
					{dirty && (
						<Button variant="ghost" onClick={() => reseed(seed(read, template))} className="min-h-11">
							{t("settings.project.raw.discard")}
						</Button>
					)}
				</div>
			)}
		</section>
	);
}
