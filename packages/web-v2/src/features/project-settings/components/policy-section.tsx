"use client";

import { useState } from "react";
import { Banner, Button, CardTitle, ErrorState, Skeleton, Textarea } from "@/design";
import { ApiError } from "@/lib/api/client";
import { formatApiError } from "@/lib/api/error";
import { usePolicy, useUpdatePolicy } from "../hooks";
import type { PolicyDocument, PolicyRefusal } from "../types";

/** The refusals core named for a policy write, or none where the error carries none. */
export function policyRefusals(err: unknown): PolicyRefusal[] {
	if (!(err instanceof ApiError)) return [];
	const error = (err.body as { error?: { refusals?: unknown } } | undefined)?.error;
	const rows = error?.refusals;
	if (!Array.isArray(rows)) return [];
	return rows.filter(
		(row): row is PolicyRefusal =>
			typeof row === "object" &&
			row !== null &&
			typeof (row as PolicyRefusal).code === "string" &&
			typeof (row as PolicyRefusal).path === "string",
	);
}

/** The draft as a document, or the sentence saying why it is not one. */
function parseDraft(text: string): { document: PolicyDocument } | { invalid: string } {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (err) {
		return { invalid: `Not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return { invalid: "The policy is a JSON object: { \"version\": 1, \"qa\": …, \"states\": … }." };
	}
	return { document: value as PolicyDocument };
}

const pretty = (doc: PolicyDocument | null) => (doc ? JSON.stringify(doc, null, 2) : "");

export function PolicySection({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
	const policyQ = usePolicy(projectId);
	const update = useUpdatePolicy(projectId);
	const read = policyQ.data;
	const readRevision = read?.declared ? read.revision : null;
	const [draft, setDraft] = useState<{ revision: number | null; text: string } | null>(null);
	const [invalid, setInvalid] = useState<string | null>(null);

	if (policyQ.isLoading) return <Skeleton className="mt-6 h-40 w-full rounded-md" />;
	if (policyQ.isError || !read) {
		return (
			<ErrorState message={formatApiError(policyQ.error)} onRetry={() => policyQ.refetch()} />
		);
	}

	const held = draft && draft.revision === readRevision ? draft.text : pretty(read.document);
	const dirty = held !== pretty(read.document);
	const refusals = update.isError ? policyRefusals(update.error) : [];

	function save() {
		const parsed = parseDraft(held);
		if ("invalid" in parsed) {
			setInvalid(parsed.invalid);
			return;
		}
		setInvalid(null);
		update.mutate(
			{ baseRevision: readRevision, document: parsed.document },
			{ onSuccess: (saved) => setDraft({ revision: saved.revision, text: pretty(saved.document) }) },
		);
	}

	return (
		<div className="mt-6 border-t border-line pt-5">
			<CardTitle className="fg-label text-fg">Policy</CardTitle>
			<p className="fg-body-sm mb-3 text-muted">
				Who judges a change (<code>qa</code>), whether queued issues start on their own
				(<code>intake</code>), and for each status the model and the tools it runs without (
				<code>states</code>, <code>permissions</code>). Dispatch reads this document and nothing
				else.
			</p>
			{read.declared ? (
				<p className="fg-caption mb-2 text-muted">Revision {read.revision}</p>
			) : (
				<Banner tone="attention">No policy — nothing dispatches for this project.</Banner>
			)}
			<Textarea
				aria-label="Policy document (JSON)"
				value={held}
				rows={16}
				readOnly={!canEdit}
				className="mt-2 font-mono"
				onChange={(e) => {
					setInvalid(null);
					setDraft({ revision: readRevision, text: e.target.value });
				}}
			/>
			{invalid && (
				<Banner tone="danger" onDismiss={() => setInvalid(null)}>
					{invalid} Nothing was sent.
				</Banner>
			)}
			{update.isError && (
				<Banner tone="danger" onDismiss={() => update.reset()}>
					<div className="space-y-1">
						<p>Refused, nothing written.</p>
						{refusals.length > 0 ? (
							<ul className="list-disc pl-5">
								{refusals.map((r) => (
									<li key={`${r.code}:${r.path}`}>
										<code>{r.code}</code> at <code>{r.path || "/"}</code> — {r.detail}
									</li>
								))}
							</ul>
						) : (
							<p>{formatApiError(update.error)}</p>
						)}
					</div>
				</Banner>
			)}
			{canEdit && (
				<Button
					variant="primary"
					loading={update.isPending}
					disabled={!dirty || update.isPending}
					onClick={save}
					className="mt-3 min-h-11"
				>
					Save policy
				</Button>
			)}
		</div>
	);
}
