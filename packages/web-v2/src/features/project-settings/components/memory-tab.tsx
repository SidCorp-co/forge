"use client";

// Project settings → Memory (ISS-908). Draws the project's memory model and the
// reindex the flip runs, in exactly one of the five states the server reports.
// Every number on this screen is a field of GET .../memory-model/reindex or
// GET .../memory-model/estimate; the tab never derives a state of its own.
// The endpoints and the job are ISS-906 (core memory-model-routes.ts).

import {
	Badge,
	Banner,
	Button,
	Card,
	CardContent,
	ErrorState,
	Field,
	Input,
	ProgressBar,
	Skeleton,
} from "@/design";
import type { ProjectDetail } from "@/features/projects/types";
import { formatApiError } from "@/lib/api/error";
import { useState } from "react";
import {
	isReindexLiveError,
	useCancelMemoryReindex,
	useMemoryEstimate,
	useMemoryModel,
	useSetMemoryModel,
} from "../hooks";
import type { MemoryModelStatus, MemoryReindex, MemoryReindexEstimate } from "../types";

const n = (v: number) => v.toLocaleString("en-US");
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : "—");

export function MemoryTab({ project, canEdit }: { project: ProjectDetail; canEdit: boolean }) {
	const statusQ = useMemoryModel(project.id);
	const status = statusQ.data;
	const flat = status?.model === "flat";
	const estimateQ = useMemoryEstimate(project.id, flat);
	const setModel = useSetMemoryModel(project.id);
	const cancel = useCancelMemoryReindex(project.id);
	const [liveConflict, setLiveConflict] = useState(false);

	// cm:guard a 409 is drawn as this sentence and nothing else happens: the mutation's onSettled already refetches the state, so the live reindex appears on its own and no code path here re-sends the POST
	const flip = (model: "flat" | "chunked") =>
		setModel.mutate(model, {
			onError: (err) => {
				if (isReindexLiveError(err)) setLiveConflict(true);
			},
			onSuccess: () => setLiveConflict(false),
		});

	if (statusQ.isLoading) {
		return (
			<Card>
				<CardContent>
					<Skeleton className="h-6 w-1/3 rounded-md" />
					<Skeleton className="mt-3 h-20 w-full rounded-md" />
				</CardContent>
			</Card>
		);
	}
	if (statusQ.isError || !status) {
		return (
			<ErrorState
				message={statusQ.error ? formatApiError(statusQ.error) : "No memory-model state came back."}
				onRetry={() => statusQ.refetch()}
			/>
		);
	}

	return (
		<div className="space-y-6">
			<Card>
				<CardContent>
					<h2 className="fg-h3 mb-1">Memory model</h2>
					<p className="fg-caption mb-4 text-muted">
						How this project's memory is stored for search. <b>Flat</b> embeds each memory as
						one document. <b>Chunked</b> also stores ~1,200-character passages, so a fact
						buried in a long issue or note is found by the passage that holds it.
					</p>
					{liveConflict && (
						<div className="mb-4">
							<Banner tone="attention" onDismiss={() => setLiveConflict(false)}>
								A reindex is already running.
							</Banner>
						</div>
					)}
					{flat ? (
						<FlatState
							estimate={estimateQ.data}
							estimateLoading={estimateQ.isLoading}
							canEdit={canEdit}
							pending={setModel.isPending}
							onConfirm={() => flip("chunked")}
						/>
					) : (
						<ChunkedState
							status={status}
							projectName={project.name}
							canEdit={canEdit}
							pending={setModel.isPending}
							cancelPending={cancel.isPending}
							onRepost={() => flip("chunked")}
							onCancel={() => cancel.mutate()}
							onRevert={() => flip("flat")}
						/>
					)}
				</CardContent>
			</Card>
		</div>
	);
}

function FlatState({
	estimate,
	estimateLoading,
	canEdit,
	pending,
	onConfirm,
}: {
	estimate: MemoryReindexEstimate | undefined;
	estimateLoading: boolean;
	canEdit: boolean;
	pending: boolean;
	onConfirm: () => void;
}) {
	return (
		<>
			<div className="mb-3 flex items-center gap-2">
				<span className="fg-caption text-subtle">Current model</span>
				<Badge tone="neutral">flat</Badge>
			</div>
			<p className="fg-caption mb-3 text-muted">
				Switching re-embeds every issue, note, knowledge, decision and policy memory as
				passages, in the background. Search keeps working throughout; rows the job has not
				reached yet are searched the old way.
			</p>
			{estimateLoading || !estimate ? (
				<Skeleton className="h-16 w-full rounded-md" />
			) : (
				<dl className="grid gap-x-6 gap-y-2 sm:grid-cols-3" data-testid="memory-estimate">
					<Row label="Memories">{n(estimate.memories)}</Row>
					<Row label="Characters">{n(estimate.totalChars)}</Row>
					<Row label="Estimated passages">{n(estimate.estimatedChunks)}</Row>
					<Row label="Embedding calls">{n(estimate.estimatedEmbedCalls)}</Row>
					<Row label="Estimated minutes">{n(estimate.estimatedMinutes)}</Row>
				</dl>
			)}
			{canEdit && (
				<Button
					variant="primary"
					className="mt-4 min-h-11"
					loading={pending}
					disabled={!estimate}
					onClick={onConfirm}
				>
					Switch to chunked
				</Button>
			)}
		</>
	);
}

function ChunkedState(props: {
	status: MemoryModelStatus;
	projectName: string;
	canEdit: boolean;
	pending: boolean;
	cancelPending: boolean;
	onRepost: () => void;
	onCancel: () => void;
	onRevert: () => void;
}) {
	const r = props.status.reindex;
	const state = r?.state ?? "completed";
	return (
		<>
			<div className="mb-3 flex items-center gap-2">
				<span className="fg-caption text-subtle">Current model</span>
				<Badge tone="accent">chunked</Badge>
				<span className="fg-caption text-subtle">Reindex</span>
				<Badge tone={state === "failed" ? "red" : state === "completed" ? "green" : "neutral"}>
					{state}
				</Badge>
			</div>
			{r && (state === "queued" || state === "running") && (
				<Progress reindex={r} canEdit={props.canEdit} pending={props.cancelPending} onCancel={props.onCancel} />
			)}
			{r && state === "failed" && (
				<>
					<Banner tone="danger">{r.lastError ?? "The reindex failed."}</Banner>
					<Counts reindex={r} />
					{props.canEdit && (
						<Button variant="primary" className="mt-3 min-h-11" loading={props.pending} onClick={props.onRepost}>
							Retry
						</Button>
					)}
				</>
			)}
			{r && state === "cancelled" && (
				<>
					<Counts reindex={r} />
					<p className="fg-caption mt-2 text-muted">
						Rows already chunked stay searchable by passage; the rest are searched the old way
						until the reindex resumes.
					</p>
					{props.canEdit && (
						<Button variant="primary" className="mt-3 min-h-11" loading={props.pending} onClick={props.onRepost}>
							Resume
						</Button>
					)}
				</>
			)}
			{state === "completed" && (
				<>
					{r && <Counts reindex={r} />}
					<p className="fg-caption mt-2 text-muted">
						Every eligible memory is searched by passage. New writes are chunked as they land.
					</p>
					{props.canEdit && (
						<RevertToFlat projectName={props.projectName} pending={props.pending} onConfirm={props.onRevert} />
					)}
				</>
			)}
		</>
	);
}

function Progress({
	reindex: r,
	canEdit,
	pending,
	onCancel,
}: {
	reindex: MemoryReindex;
	canEdit: boolean;
	pending: boolean;
	onCancel: () => void;
}) {
	const pct = r.total > 0 ? Math.round((r.done / r.total) * 100) : 0;
	return (
		<>
			<ProgressBar value={pct} indeterminate={r.state === "queued"} />
			<Counts reindex={r} />
			{canEdit && (
				<Button variant="secondary" className="mt-3 min-h-11" loading={pending} onClick={onCancel}>
					Cancel
				</Button>
			)}
		</>
	);
}

function Counts({ reindex: r }: { reindex: MemoryReindex }) {
	return (
		<dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-3" data-testid="memory-reindex-counts">
			<Row label="Done">
				{n(r.done)} / {n(r.total)}
			</Row>
			<Row label="Remaining">{n(r.remaining)}</Row>
			<Row label="Last batch">{when(r.lastBatchAt)}</Row>
		</dl>
	);
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div>
			<dt className="fg-caption text-subtle">{label}</dt>
			<dd className="fg-body-sm font-mono text-fg">{children}</dd>
		</div>
	);
}

// cm:guard the confirm names the seven-day purge in its own copy — a revert is cheap for a week and destructive after, and a button that only says "flat" hides the half that costs
function RevertToFlat({
	projectName,
	pending,
	onConfirm,
}: {
	projectName: string;
	pending: boolean;
	onConfirm: () => void;
}) {
	const [confirming, setConfirming] = useState(false);
	const [typed, setTyped] = useState("");
	const matches = typed.trim() === projectName && projectName.length > 0;
	if (!confirming) {
		return (
			<Button variant="secondary" className="mt-4 min-h-11" onClick={() => setConfirming(true)}>
				Switch back to flat
			</Button>
		);
	}
	return (
		<div className="mt-4 space-y-4">
			<p className="fg-caption text-muted">
				Search goes back to whole-document rows immediately. The passages are kept for seven
				days so you can switch again at no cost, then purged.
			</p>
			<Field label="Confirm switch to flat" hint={`Type the project name "${projectName}" to confirm.`}>
				<Input
					value={typed}
					onChange={(e) => setTyped(e.target.value)}
					placeholder={projectName}
					autoComplete="off"
					aria-label="Type the project name to confirm the switch to flat"
				/>
			</Field>
			<div className="flex gap-2">
				<Button variant="danger" className="min-h-11" loading={pending} disabled={!matches} onClick={onConfirm}>
					Confirm switch to flat
				</Button>
				<Button
					variant="secondary"
					className="min-h-11"
					onClick={() => {
						setConfirming(false);
						setTyped("");
					}}
				>
					Cancel
				</Button>
			</div>
		</div>
	);
}
