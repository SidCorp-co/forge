"use client";

import { useState } from "react";
import { Button, Field, IconButton, Input, MonoTag, Toggle } from "@/design";
import { isPlainObject } from "@forge/contracts/document-patch";
import type { ConfigRefusal } from "../config-types";
import { pointerOf, REMOVE } from "../document-edit";

interface Ctx {
	placed: Map<string, ConfigRefusal[]>;
	canEdit: boolean;
	set: (segments: string[], value: unknown) => void;
}

function said(refusals: readonly ConfigRefusal[], at: string): string | undefined {
	if (refusals.length === 0) return undefined;
	return refusals
		.map((r) => `${r.code}${r.path === at ? "" : ` at ${r.path}`}: ${r.detail}`)
		.join(" · ");
}

function RefusalLines({ refusals, at }: { refusals: readonly ConfigRefusal[]; at: string }) {
	if (refusals.length === 0) return null;
	return (
		<ul role="alert" className="fg-caption mt-1 space-y-0.5 text-red">
			{refusals.map((r) => (
				<li key={`${r.code}:${r.path}`}>
					<code>{r.code}</code>
					{r.path === at ? "" : <> at <code>{r.path || "/"}</code></>}: {r.detail}
				</li>
			))}
		</ul>
	);
}

function Leaf({ name, value, path, ctx }: { name: string; value: unknown; path: string[]; ctx: Ctx }) {
	const at = pointerOf(path);
	const error = said(ctx.placed.get(at) ?? [], at);
	const remove = ctx.canEdit ? (
		<IconButton icon="x" size="sm" aria-label={`Remove ${at}`} onClick={() => ctx.set(path, REMOVE)} />
	) : null;
	if (typeof value === "boolean") {
		return (
			<div className="flex items-center gap-3">
				<Toggle checked={value} disabled={!ctx.canEdit} aria-label={at} onChange={(v) => ctx.set(path, v)} />
				<span className="fg-label">{name}</span>
				{remove}
				{error && <p role="alert" className="fg-caption text-red">{error}</p>}
			</div>
		);
	}
	return (
		<div className="flex items-start gap-2">
			<div className="min-w-0 flex-1">
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

function AddEntry({ keyed, at, onAdd }: { keyed: boolean; at: string; onAdd: (key: string, value: unknown) => void }) {
	const [open, setOpen] = useState(false);
	const [key, setKey] = useState("");
	const [text, setText] = useState('""');
	const [invalid, setInvalid] = useState<string | null>(null);
	if (!open) {
		return (
			<Button variant="ghost" size="sm" onClick={() => setOpen(true)} aria-label={`Add to ${at || "/"}`}>
				+ {keyed ? "key" : "item"}
			</Button>
		);
	}
	function add() {
		if (keyed && key.trim() === "") {
			setInvalid("Name the key.");
			return;
		}
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			setInvalid('The value is JSON: "text" in quotes, 3, true, {} or []. Nothing was added.');
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
				<Input aria-label={`New key in ${at || "/"}`} placeholder="key" value={key} onChange={(e) => setKey(e.target.value)} className="w-40" />
			)}
			<Input aria-label={`New value in ${at || "/"}`} placeholder='"value"' value={text} onChange={(e) => setText(e.target.value)} className="w-64 font-mono" />
			<Button variant="secondary" size="sm" onClick={add}>Add</Button>
			<Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
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
					<span className="fg-label">{name}</span>
					<MonoTag>{Array.isArray(value) ? `${entries.length} items` : `${entries.length} keys`}</MonoTag>
					{ctx.canEdit && (
						<IconButton icon="x" size="sm" aria-label={`Remove ${at}`} onClick={() => ctx.set(path, REMOVE)} />
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
					onAdd={(key, v) => ctx.set([...path, Array.isArray(value) ? String(entries.length) : key], v)}
				/>
			)}
		</div>
	);
}

function DocumentNode(props: { name: string; value: unknown; path: string[]; ctx: Ctx }) {
	return Array.isArray(props.value) || isPlainObject(props.value) ? <Branch {...props} /> : <Leaf {...props} />;
}

export function DocumentFields({
	document,
	placed,
	canEdit,
	onSet,
}: {
	document: Record<string, unknown>;
	placed: Map<string, ConfigRefusal[]>;
	canEdit: boolean;
	onSet: (segments: string[], value: unknown) => void;
}) {
	return <DocumentNode name="" value={document} path={[]} ctx={{ placed, canEdit, set: onSet }} />;
}
