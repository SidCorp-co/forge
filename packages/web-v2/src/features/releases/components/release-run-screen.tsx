"use client";

// The release-run screen (`/projects/[slug]/releases/[runId]`).
//
// One page that assembles a whole release run from the record plus a fresh look
// at the running site, so a different person or a different machine can carry on
// from where it stopped. Everything on it comes from one call — core assembles
// the roster, the ledger, the live probe reading and the bounds itself, and this
// screen derives nothing it was not sent.

import type { ReactNode } from "react";
import {
  Badge,
  ErrorState,
  MonoTag,
  PageTitle,
  ProjectLoader,
  SectionTitle,
  Skeleton,
} from "@/design";
import { STATUS_LABELS } from "@/features/issues/derive";
import { inlineCode } from "@/features/project-settings/components/inline-code";
import { formatApiError } from "@/lib/api/error";
import { formatCountdown, formatRelativeTime } from "@/lib/utils/format";
import { useReleaseRunState } from "../hooks";
import type {
	ReleaseBoundsReading,
	ReleaseLiveState,
	ReleaseMethod,
	ReleaseRunState,
	ReleaseStart,
} from "../types";
import { ReleaseTimeline } from "./release-timeline";

/**
 * When the reading on screen was actually taken.
 *
 * `staleTime: 0` starts a refetch; it does not hide the cached answer while
 * that refetch is in flight, so a screen that says "read just now" because it
 * rendered is saying it about a reading that may be an hour old — and the
 * reader this page exists for is the one coming back to a tab they left open
 * during an outage. So the words come from `dataUpdatedAt`, and a refresh in
 * flight says so rather than being silently presented as its own result.
 */
function ReadAt({ at, refreshing }: { at: number; refreshing: boolean }) {
	const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
	return (
		<span className="text-xs text-subtle" data-testid="live-read-at">
			{refreshing
				? `reading now · showing a reading from ${seconds}s ago`
				: seconds < 5
					? "read just now"
					: `read ${seconds}s ago`}
		</span>
	);
}

/** Only a run still open has a close ahead of it, and only a completed one has had it. */
function unverifiedSentence(runStatus: string): string {
	const probe = "This project declares no verification probe, so nothing reads production.";
	if (runStatus === "running" || runStatus === "paused") {
		return `${probe} The release will close unverified, and each issue it closes will say so.`;
	}
	if (runStatus === "completed") {
		return `${probe} The release closed unverified, and each issue it closed says so.`;
	}
	return probe;
}

function LiveReading({
	live,
	verification,
	runStatus,
	readAt,
	refreshing,
}: {
	live: ReleaseLiveState | null;
	verification: ReleaseRunState["verification"];
	runStatus: string;
	readAt: number;
	refreshing: boolean;
}) {
	if (!live) {
		return (
			<p className="text-sm text-muted" data-testid="live-none">
				{verification === "unverified"
					? unverifiedSentence(runStatus)
					: "Forge has no verification probe it can read for this project, so it has nowhere to look."}
			</p>
		);
	}
	return (
		<div className="flex flex-col gap-2" data-testid="live-reading">
			<div className="flex flex-wrap items-center gap-2">
				<Badge tone={live.health === "up" ? "green" : "red"}>
					{live.health}
				</Badge>
				{live.identity ? (
					<MonoTag>{live.identity.slice(0, 12)}</MonoTag>
				) : (
					<span className="text-xs text-subtle">no agreed identity</span>
				)}
				<ReadAt at={readAt} refreshing={refreshing} />
			</div>
			<ul className="flex flex-col gap-0.5">
				{live.readings.map((reading) => (
					<li key={reading} className="font-mono text-xs text-muted">
						{reading}
					</li>
				))}
			</ul>
			{live.disagreement ? (
				<p className="text-xs text-amber">
					The probes answered different commits: {live.disagreement.join(", ")}
				</p>
			) : null}
		</div>
	);
}

const START_HEADLINE: Record<Exclude<ReleaseStart["kind"], "taken">, string> = {
	waiting: "No box has started this release",
	claimed: "No box has started this release",
	"handed-back": "Handed back to the release gate",
	aborted: "Aborted before it started",
	ended: "This release never started",
	none: "This run holds no release job",
};

/** An instant in the reader's own clock, with how long ago or until; the UTC instant on hover. */
function When({ iso }: { iso: string }) {
	const at = new Date(iso);
	const sameDay = at.toDateString() === new Date().toDateString();
	const clock = sameDay
		? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
		: at.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
	const relative = at.getTime() > Date.now() ? formatCountdown(iso) : formatRelativeTime(iso);
	return (
		<time dateTime={iso} title={iso}>
			{clock} ({relative})
		</time>
	);
}

/** Says why nothing has happened yet, so a batch no box took never reads like one at work. */
function StartLine({ start }: { start: ReleaseStart }) {
	if (start.kind === "taken") return null;
	const waiting = start.kind === "waiting" || start.kind === "claimed";
	return (
		<div className="flex flex-col gap-1 border-b border-line pb-3" data-testid="start-line" data-kind={start.kind}>
			<p className={`text-sm font-medium ${waiting ? "text-amber" : "text-fg"}`}>
				{START_HEADLINE[start.kind]}
			</p>
			{start.kind === "aborted" ? (
				<p className="text-sm text-muted">
					{start.by} aborted it before any box took it, <When iso={start.at} />: {inlineCode(start.why)}
				</p>
			) : (
				<p className="text-sm text-muted">{inlineCode(start.why)}</p>
			)}
			{start.kind === "waiting" ? (
				<p className="text-xs text-subtle">
					Waiting since <When iso={start.since} /> · handed back at <When iso={start.handedBackAt} />
				</p>
			) : null}
		</div>
	);
}

function MethodLine({
	method,
	methodUnloaded,
	start,
	ended,
}: {
	method: ReleaseMethod | null;
	methodUnloaded: boolean;
	start: ReleaseStart;
	ended: boolean;
}) {
	if (!method && start.kind !== "taken") {
		// The start line already says why; this only must not promise a run that never began.
		return (
			<p className="text-sm text-muted" data-testid="method-line">
				{ended
					? "No method was announced: this release never started."
					: "No method yet: no box has started this release."}
			</p>
		);
	}
	if (!method) {
		return (
			<p className="text-sm text-muted" data-testid="method-line">
				No method announced. The run can still be finished; what an
				announcement is needed for is a deploy through Forge, which is refused
				until this run has recorded something.
			</p>
		);
	}
	return (
		<div className="flex flex-col gap-1" data-testid="method-line">
			<div className="flex flex-wrap items-center gap-2">
				<MonoTag hue="cobalt">{method.skill}</MonoTag>
				{methodUnloaded ? (
					<Badge tone="amber">could not load</Badge>
				) : (
					<Badge tone="green">loaded</Badge>
				)}
				<When iso={method.announcedAt} />
			</div>
			{method.detail ? (
				<p className="text-xs text-muted">{method.detail}</p>
			) : null}
		</div>
	);
}

function Bounds({ bounds }: { bounds: ReleaseBoundsReading }) {
	return (
		<div className="flex flex-col gap-2" data-testid="bounds">
			{bounds.holding ? (
				<p className="text-sm font-medium text-amber">
					Holding: this run is past its {bounds.crossedNames.join(" and ")}{" "}
					bound and records no further attempts until a person looks.
				</p>
			) : null}
			<ul className="flex flex-col gap-1">
				{bounds.bounds.map((bound) => (
					<li key={bound.name} className="text-xs text-muted">
						<span className="font-semibold capitalize">{bound.name}</span>
						{": "}
						{bound.why}
					</li>
				))}
			</ul>
		</div>
	);
}

/** The issues this run was opened with, and where the release gate it came from stands. */
function Roster({ state }: { state: ReleaseRunState }) {
	const { roster, runIssues } = state;
	return (
		<div className="flex flex-col gap-2" data-testid="roster">
			<div className="flex flex-wrap items-center gap-2 text-xs text-muted">
				{roster.baseBranch ? <MonoTag>{roster.baseBranch}</MonoTag> : null}
				{roster.channels.length > 0 ? (
					<span>channel {roster.channels.join(", ")}</span>
				) : null}
				{roster.releaseRunnerLabel ? (
					<span>prefers {roster.releaseRunnerLabel}</span>
				) : null}
			</div>
			{runIssues.length === 0 ? (
				<p className="text-sm text-muted">This run names no issue.</p>
			) : (
				<ul className="flex flex-col divide-y divide-line">
					{runIssues.map((issue) => (
						<li key={issue.id} className="flex min-w-0 items-baseline gap-2 py-1.5 text-sm">
							<MonoTag>{issue.displayId}</MonoTag>
							<span className="min-w-0 truncate">{issue.title}</span>
							<span className="ml-auto shrink-0 text-xs text-subtle">
								{(STATUS_LABELS as Record<string, string>)[issue.status] ?? issue.status}
							</span>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/** A flat section: a heading over its content, a hairline above it, no surface of its own. */
function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="flex min-w-0 flex-col gap-2 py-4">
			<SectionTitle className="fg-h3">{title}</SectionTitle>
			{children}
		</section>
	);
}

export interface ReleaseRunScreenProps {
	projectId: string;
	runId: string;
}

export function ReleaseRunScreen({ projectId, runId }: ReleaseRunScreenProps) {
	const { data, isLoading, isError, error, refetch, isFetching, dataUpdatedAt } =
		useReleaseRunState(projectId, runId);

	if (isLoading) {
		return (
			<div className="flex flex-col gap-4 p-6">
				<ProjectLoader label="loading release run…" />
				<Skeleton />
				<Skeleton />
			</div>
		);
	}

	if (isError || !data) {
		return (
			<div className="grid min-h-[60vh] place-items-center">
				<ErrorState
					title="Couldn't load this release run"
					message={isError ? formatApiError(error) : "No run came back."}
					onRetry={() => refetch()}
				/>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4 p-6">
			<header className="flex flex-wrap items-center gap-2">
				<PageTitle className="fg-h2">Release run</PageTitle>
				<MonoTag>{data.runId}</MonoTag>
				<Badge tone={data.runStatus === "running" ? "cobalt" : "neutral"}>
					{data.runStatus}
				</Badge>
			</header>

			<StartLine start={data.start} />

			<div className="grid divide-y divide-line border-y border-line lg:grid-cols-3 lg:divide-x lg:divide-y-0 [&>*]:lg:px-4 [&>*:first-child]:lg:pl-0">
				<Section title="Production, right now">
					<LiveReading
						live={data.live}
						verification={data.verification}
						runStatus={data.runStatus}
						readAt={dataUpdatedAt}
						refreshing={isFetching}
					/>
				</Section>
				<Section title="Method">
					<MethodLine
						method={data.method}
						methodUnloaded={data.methodUnloaded}
						start={data.start}
						ended={data.runStatus !== "running" && data.runStatus !== "paused"}
					/>
				</Section>
				<Section title="Bounds">
					<Bounds bounds={data.bounds} />
				</Section>
			</div>

			<div className="divide-y divide-line border-b border-line">
				<Section title="What this run did">
					<ReleaseTimeline
						attempts={data.attempts}
						ended={data.runStatus !== "running" && data.runStatus !== "paused"}
					/>
				</Section>
				<Section title="Roster">
					<Roster state={data} />
				</Section>
			</div>
		</div>
	);
}
