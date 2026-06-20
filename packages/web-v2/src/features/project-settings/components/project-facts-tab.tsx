"use client";

import {
	Banner,
	Button,
	Card,
	CardContent,
	EmptyState,
	ErrorState,
	Field,
	Icon,
	Input,
	Skeleton,
	Textarea,
	Toggle,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
// Project settings → Project Facts (ISS-521). The per-project "rules" layer:
// author-maintained kebab-key → text guides that agents read. A fact flagged
// "always-inject" has its FULL body spliced verbatim into every agent system
// prompt for this project (like a mandatory rule), instead of the default
// fetch-on-demand pointer — guarded by a char budget so the prompt can't bloat.
//
// Backed by the dedicated GET/PATCH /api/projects/:id/project-facts routes
// (atomic per-key merge of agentConfig.projectFacts + projectFactsConfig). The
// editor batches all edits into one PATCH: a removed key becomes `null`
// (server merge deletes it), a renamed key is a delete + add.
import { useEffect, useMemo, useState } from "react";
import { useProjectFacts, useUpdateProjectFacts } from "../hooks";
import {
	PROJECT_FACT_KEY_PATTERN,
	PROJECT_FACT_MAX_CHARS,
	type ProjectFactsPatch,
	RESERVED_PROJECT_FACT_KEYS,
} from "../types";

type Row = { rid: number; key: string; text: string; alwaysInject: boolean };

const RESERVED = new Set<string>(RESERVED_PROJECT_FACT_KEYS);

/** Returns an inline validation message for a key, or null when valid. */
function validateKey(key: string, rows: Row[], rid: number): string | null {
	const k = key.trim();
	if (k.length === 0) return "Key is required.";
	if (k.length > 64) return "Key must be ≤64 characters.";
	if (!PROJECT_FACT_KEY_PATTERN.test(k))
		return "Key must be kebab-case (lowercase letters, digits, hyphen; can't start with a hyphen).";
	if (RESERVED.has(k))
		return `"${k}" is a reserved (derived) key and can't be used.`;
	if (rows.some((r) => r.rid !== rid && r.key.trim() === k))
		return "Another fact already uses this key.";
	return null;
}

export function ProjectFactsTab({
	projectId,
	canEdit,
}: {
	projectId: string;
	canEdit: boolean;
}) {
	const factsQ = useProjectFacts(projectId);
	const update = useUpdateProjectFacts(projectId);

	const [rows, setRows] = useState<Row[]>([]);
	const [confirmRid, setConfirmRid] = useState<number | null>(null);
	// Monotonic id source for new rows (stable across re-orders/renames).
	const [nextRid, setNextRid] = useState(1);

	// (Re)seed the editor from the server whenever the fetched facts change.
	useEffect(() => {
		if (!factsQ.data) return;
		const { projectFacts, projectFactsConfig } = factsQ.data;
		const seeded = Object.entries(projectFacts).map(([key, text], i) => ({
			rid: i + 1,
			key,
			text,
			alwaysInject: projectFactsConfig[key]?.alwaysInject === true,
		}));
		setRows(seeded);
		setNextRid(seeded.length + 1);
		setConfirmRid(null);
	}, [factsQ.data]);

	const maxChars = factsQ.data?.maxAlwaysInjectChars ?? 6000;

	// Live always-inject budget: sum of the bodies of every always-inject row.
	const injectedChars = useMemo(
		() =>
			rows
				.filter((r) => r.alwaysInject)
				.reduce((sum, r) => sum + r.text.length, 0),
		[rows],
	);
	const overBudget = injectedChars > maxChars;
	const budgetPct = Math.min(100, Math.round((injectedChars / maxChars) * 100));

	// Per-row validation + dirty check against the server snapshot.
	const errors = useMemo(() => {
		const m = new Map<number, { key?: string; text?: string }>();
		for (const r of rows) {
			const keyErr = validateKey(r.key, rows, r.rid);
			const textErr =
				r.text.length > PROJECT_FACT_MAX_CHARS
					? `Body must be ≤${PROJECT_FACT_MAX_CHARS} characters.`
					: undefined;
			if (keyErr || textErr)
				m.set(r.rid, {
					...(keyErr ? { key: keyErr } : {}),
					...(textErr ? { text: textErr } : {}),
				});
		}
		return m;
	}, [rows]);
	const hasErrors = errors.size > 0;

	const dirty = useMemo(() => {
		if (!factsQ.data) return false;
		const { projectFacts, projectFactsConfig } = factsQ.data;
		const serverKeys = Object.keys(projectFacts);
		if (serverKeys.length !== rows.length) return true;
		return rows.some((r) => {
			const k = r.key.trim();
			return (
				projectFacts[k] !== r.text ||
				(projectFactsConfig[k]?.alwaysInject === true) !== r.alwaysInject
			);
		});
	}, [rows, factsQ.data]);

	function addRow() {
		setRows((rs) => [
			...rs,
			{ rid: nextRid, key: "", text: "", alwaysInject: false },
		]);
		setNextRid((n) => n + 1);
	}
	function patchRow(rid: number, patch: Partial<Row>) {
		setRows((rs) => rs.map((r) => (r.rid === rid ? { ...r, ...patch } : r)));
	}
	function removeRow(rid: number) {
		setRows((rs) => rs.filter((r) => r.rid !== rid));
		setConfirmRid(null);
	}

	function save() {
		if (!factsQ.data || hasErrors) return;
		const serverKeys = Object.keys(factsQ.data.projectFacts);
		const liveKeys = new Set(rows.map((r) => r.key.trim()));

		const projectFacts: Record<string, string | null> = {};
		const projectFactsConfig: Record<
			string,
			{ alwaysInject?: boolean } | null
		> = {};

		// Deletions: a server key that no longer has a row (covers renames too).
		for (const k of serverKeys) {
			if (!liveKeys.has(k)) {
				projectFacts[k] = null;
				projectFactsConfig[k] = null;
			}
		}
		// Upserts: write every row's body + its always-inject flag. A `false` flag
		// is persisted as `null` to keep the config map free of noise entries.
		for (const r of rows) {
			const k = r.key.trim();
			projectFacts[k] = r.text;
			projectFactsConfig[k] = r.alwaysInject ? { alwaysInject: true } : null;
		}

		const patch: ProjectFactsPatch = { projectFacts, projectFactsConfig };
		update.mutate(patch);
	}

	if (factsQ.isLoading) {
		return (
			<Card>
				<CardContent>
					<div className="space-y-3">
						<Skeleton className="h-10 w-full rounded-md" />
						<Skeleton className="h-24 w-full rounded-md" />
						<Skeleton className="h-24 w-full rounded-md" />
					</div>
				</CardContent>
			</Card>
		);
	}

	if (factsQ.isError) {
		return (
			<Card>
				<CardContent>
					<ErrorState
						message={formatApiError(factsQ.error)}
						onRetry={() => factsQ.refetch()}
					/>
				</CardContent>
			</Card>
		);
	}

	return (
		<Card>
			<CardContent>
				<h2 className="fg-h3 mb-1">Project Facts</h2>
				<p className="fg-body-sm mb-3 text-muted">
					Author-maintained rules and guides for this project. By default a fact
					is listed to agents as a fetch-on-demand pointer. Flag a fact{" "}
					<b>always-inject</b> to splice its full body verbatim into{" "}
					<b>every</b> agent prompt — use it for hard rules the agent must
					always follow.
				</p>

				<Banner tone="attention">
					Never store secrets here. Project facts are synced to disk and
					injected into agent prompts — keep test credentials in the Testing
					tab, which renders them as a runtime pointer.
				</Banner>

				{/* Always-inject token budget meter (AC #2). */}
				<div className="mt-4 rounded-md border border-line bg-surface px-3 py-2.5">
					<div className="mb-1 flex items-center justify-between">
						<span className="fg-label text-fg">Always-inject budget</span>
						<span
							className="fg-caption font-mono"
							style={{
								color: overBudget ? "var(--red-600)" : "var(--fg-muted)",
							}}
						>
							{injectedChars.toLocaleString()} / {maxChars.toLocaleString()}{" "}
							chars
						</span>
					</div>
					<div className="h-1.5 w-full overflow-hidden rounded-pill bg-sunken">
						<div
							className="h-full rounded-pill transition-all"
							style={{
								width: `${budgetPct}%`,
								background: overBudget
									? "var(--red-600)"
									: "var(--accent-solid)",
							}}
						/>
					</div>
					{overBudget && (
						<p
							className="fg-caption mt-1.5"
							style={{ color: "var(--red-600)" }}
						>
							Over budget — all always-inject facts are still injected, but this
							bloats every prompt for the project. Trim a body or unflag a fact.
						</p>
					)}
				</div>

				{rows.length === 0 ? (
					<div className="mt-4">
						<EmptyState
							title="No project facts yet"
							message={
								canEdit
									? "Add a fact to give agents project-specific rules or guides."
									: "No project facts have been defined for this project."
							}
							mascot={false}
						/>
					</div>
				) : (
					<div className="mt-4 space-y-4">
						{rows.map((r) => {
							const err = errors.get(r.rid);
							return (
								<div
									key={r.rid}
									className="rounded-md border border-line bg-surface p-3"
								>
									<Field
										label="Key"
										hint="kebab-case identifier (e.g. contracts-boundary, build-commands)."
										{...(err?.key ? { error: err.key } : {})}
									>
										<Input
											value={r.key}
											onChange={(e) => patchRow(r.rid, { key: e.target.value })}
											disabled={!canEdit}
											placeholder="contracts-boundary"
											maxLength={64}
										/>
									</Field>

									<div className="mt-3">
										<Field
											label="Body"
											hint="The guide / rule text agents will read."
											{...(err?.text ? { error: err.text } : {})}
										>
											<Textarea
												value={r.text}
												onChange={(e) =>
													patchRow(r.rid, { text: e.target.value })
												}
												disabled={!canEdit}
												rows={4}
												placeholder="NEVER import @forge/contracts internals across the package boundary…"
											/>
										</Field>
										<div className="mt-1 flex justify-end">
											<span
												className="fg-caption font-mono text-muted"
												style={
													r.text.length > PROJECT_FACT_MAX_CHARS
														? { color: "var(--red-600)" }
														: undefined
												}
											>
												{r.text.length} / {PROJECT_FACT_MAX_CHARS}
											</span>
										</div>
									</div>

									<div className="mt-3 flex items-center justify-between gap-3 border-t border-line pt-3">
										<div className="min-w-0">
											<p className="fg-label text-fg">Always-inject</p>
											<p className="fg-caption text-muted">
												Injected verbatim into every agent prompt for this
												project.
											</p>
										</div>
										<Toggle
											checked={r.alwaysInject}
											onChange={(v) => patchRow(r.rid, { alwaysInject: v })}
											disabled={!canEdit}
											aria-label={`Always-inject ${r.key || "fact"}`}
										/>
									</div>

									{canEdit && (
										<div className="mt-3 flex justify-end">
											{confirmRid === r.rid ? (
												<div className="flex items-center gap-2">
													<span className="fg-caption text-muted">
														Remove this fact?
													</span>
													<Button
														variant="danger"
														size="sm"
														onClick={() => removeRow(r.rid)}
													>
														Confirm
													</Button>
													<Button
														variant="ghost"
														size="sm"
														onClick={() => setConfirmRid(null)}
													>
														Cancel
													</Button>
												</div>
											) : (
												<Button
													variant="ghost"
													size="sm"
													onClick={() => setConfirmRid(r.rid)}
												>
													<Icon name="trash" size={14} className="mr-1" />
													Remove
												</Button>
											)}
										</div>
									)}
								</div>
							);
						})}
					</div>
				)}

				{canEdit && (
					<div className="mt-4 space-y-3">
						<Button variant="ghost" size="sm" onClick={addRow}>
							<Icon name="plus" size={14} className="mr-1" />
							Add fact
						</Button>

						{update.isError && (
							<Banner tone="danger" onDismiss={() => update.reset()}>
								{formatApiError(update.error)}
							</Banner>
						)}

						<div>
							<Button
								variant="primary"
								loading={update.isPending}
								disabled={!dirty || hasErrors}
								onClick={save}
								className="min-h-11"
							>
								Save project facts
							</Button>
						</div>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
