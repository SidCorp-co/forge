"use client";

import { useState } from "react";
import { Button, Field, IconButton, Input, MonoTag, Toggle } from "@/design";
import { isPlainObject } from "@forge/contracts/document-patch";
import { type Refusal, readRefusal } from "@/lib/api/refusals";
import { pointerOf, REMOVE } from "@/features/project-config/document-edit";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";

interface Ctx {
	placed: Map<string, Refusal[]>;
	canEdit: boolean;
	set: (segments: string[], value: unknown) => void;
	/** Pointers no edit here may change or remove: who the document is. */
	fixed: ReadonlySet<string>;
	t: Copy;
}

/** A branch whose removal would take a fixed key with it. */
const holdsFixed = (ctx: Ctx, at: string) => [...ctx.fixed].some((f) => f === at || f.startsWith(`${at}/`));

function said(refusals: readonly Refusal[], at: string): string | undefined {
	if (refusals.length === 0) return undefined;
	return refusals
		.map((r) => {
			const read = readRefusal(r);
			return `${read.code}${r.path === at || !read.where ? "" : ` at ${read.where}`}: ${read.sentence}`;
		})
		.join(" · ");
}

function RefusalLines({ refusals, at }: { refusals: readonly Refusal[]; at: string }) {
	if (refusals.length === 0) return null;
	return (
		<ul role="alert" className="fg-caption mt-1 space-y-0.5 text-red">
			{refusals.map((r) => {
				const read = readRefusal(r);
				return (
					<li key={`${r.code}:${r.path}`}>
						<code>{read.code}</code>
						{r.path === at ? "" : <> at <code>{read.where ?? "/"}</code></>}: {read.sentence}
					</li>
				);
			})}
		</ul>
	);
}

function Leaf({ name, value, path, ctx }: { name: string; value: unknown; path: string[]; ctx: Ctx }) {
	const at = pointerOf(path);
	const error = said(ctx.placed.get(at) ?? [], at);
	if (ctx.fixed.has(at)) {
		return (
			<div className="flex flex-col gap-1" data-fixed={at}>
				<span className="fg-label" translate="no">
					{name}
				</span>
				<span className="fg-body-sm font-mono text-fg" translate="no">
					{String(value)}
				</span>
				<span className="fg-caption text-subtle">{ctx.t("settings.project.raw.fixed")}</span>
			</div>
		);
	}
	const remove = ctx.canEdit ? (
		<IconButton icon="x" size="sm" aria-label={ctx.t("settings.project.raw.remove", { at })} onClick={() => ctx.set(path, REMOVE)} />
	) : null;
	if (typeof value === "boolean") {
		return (
			<div className="flex items-center gap-3">
				<Toggle checked={value} disabled={!ctx.canEdit} aria-label={at} onChange={(v) => ctx.set(path, v)} />
				<span className="fg-label" translate="no">
					{name}
				</span>
				{remove}
				{error && <p role="alert" className="fg-caption text-red">{error}</p>}
			</div>
		);
	}
	return (
		<div className="flex items-start gap-2">
			<div className="min-w-0 flex-1" translate="no">
				<Field label={name} error={error}>
					{value === null ? (
						<MonoTag>null</MonoTag>
					) : (
						<Input
							aria-label={at}
							type={typeof value === "number" ? "number" : "text"}
							value={String(value)}
							disabled={!ctx.canEdit}
							onChange={(e) => {
								const raw = e.target.value;
								const n = Number(raw);
								ctx.set(path, typeof value === "number" && raw.trim() !== "" && !Number.isNaN(n) ? n : raw);
							}}
						/>
					)}
				</Field>
			</div>
			<div className="pt-6">{remove}</div>
		</div>
	);
}

function AddEntry({
	keyed,
	at,
	held,
	onAdd,
	t,
}: {
	keyed: boolean;
	at: string;
	held: readonly string[];
	onAdd: (key: string, value: unknown) => void;
	t: Copy;
}) {
	const [open, setOpen] = useState(false);
	const [key, setKey] = useState("");
	const [text, setText] = useState('""');
	const [invalid, setInvalid] = useState<string | null>(null);
	if (!open) {
		return (
			<Button variant="ghost" size="sm" onClick={() => setOpen(true)} aria-label={t("settings.project.raw.addTo", { at: at || "/" })}>
				{keyed ? t("settings.project.raw.addKey") : t("settings.project.raw.addItem")}
			</Button>
		);
	}
	function add() {
		if (keyed && key.trim() === "") {
			setInvalid(t("settings.project.raw.nameKey"));
			return;
		}
		if (keyed && held.includes(key.trim())) {
			setInvalid(t("settings.project.raw.keyExists", { key: key.trim() }));
			return;
		}
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			setInvalid(t("settings.project.raw.valueIsJson"));
			return;
		}
		onAdd(key.trim(), value);
		setOpen(false);
		setKey("");
		setText('""');
		setInvalid(null);
	}
	return (
		<div className="flex flex-wrap items-end gap-2">
			{keyed && (
				<Input aria-label={t("settings.project.raw.newKey", { at: at || "/" })} value={key} onChange={(e) => setKey(e.target.value)} className="w-40 font-mono" />
			)}
			<Input aria-label={t("settings.project.raw.newValue", { at: at || "/" })} value={text} onChange={(e) => setText(e.target.value)} className="w-64 font-mono" />
			<Button variant="secondary" size="sm" onClick={add}>
				{t("settings.project.raw.add")}
			</Button>
			<Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
				{t("common.cancel")}
			</Button>
			{invalid && <p role="alert" className="fg-caption w-full text-red">{invalid}</p>}
		</div>
	);
}

function Branch({ name, value, path, ctx }: { name: string; value: unknown; path: string[]; ctx: Ctx }) {
	const at = pointerOf(path);
	const entries: [string, unknown][] = Array.isArray(value)
		? value.map((v, i) => [String(i), v])
		: Object.entries(value as Record<string, unknown>);
	return (
		<div className={path.length === 0 ? "space-y-3" : "space-y-3 border-l border-line pl-3"}>
			{path.length > 0 && (
				<div className="flex items-center gap-2">
					<span className="fg-label" translate="no">
						{name}
					</span>
					<MonoTag>
						{Array.isArray(value) ? ctx.t("settings.project.raw.items", { n: entries.length }) : ctx.t("settings.project.raw.keys", { n: entries.length })}
					</MonoTag>
					{ctx.canEdit && !holdsFixed(ctx, at) && (
						<IconButton icon="x" size="sm" aria-label={ctx.t("settings.project.raw.remove", { at })} onClick={() => ctx.set(path, REMOVE)} />
					)}
				</div>
			)}
			<RefusalLines refusals={ctx.placed.get(at) ?? []} at={at} />
			{entries.map(([key, child]) => (
				<DocumentNode key={key} name={key} value={child} path={[...path, key]} ctx={ctx} />
			))}
			{ctx.canEdit && (
				<AddEntry
					keyed={!Array.isArray(value)}
					at={at}
					held={entries.map(([k]) => k)}
					t={ctx.t}
					onAdd={(key, v) => ctx.set([...path, Array.isArray(value) ? String(entries.length) : key], v)}
				/>
			)}
		</div>
	);
}

function DocumentNode(props: { name: string; value: unknown; path: string[]; ctx: Ctx }) {
	return Array.isArray(props.value) || isPlainObject(props.value) ? <Branch {...props} /> : <Leaf {...props} />;
}

/** Who every document is: its schema and version. A document names more of its own (`fixed`). */
export const IDENTITY_POINTERS = ["/$schema", "/version"] as const;

export function DocumentFields({
	document,
	placed,
	canEdit,
	onSet,
	fixed = PROJECT_IDENTITY,
}: {
	document: Record<string, unknown>;
	placed: Map<string, Refusal[]>;
	canEdit: boolean;
	onSet: (segments: string[], value: unknown) => void;
	fixed?: readonly string[];
}) {
	const t = useCopy();
	return <DocumentNode name="" value={document} path={[]} ctx={{ placed, canEdit, set: onSet, fixed: new Set(fixed), t }} />;
}

/** The project document's identity: a slug is moved by its own act, an id never. */
export const PROJECT_IDENTITY: readonly string[] = [...IDENTITY_POINTERS, "/project/id", "/project/slug"];
