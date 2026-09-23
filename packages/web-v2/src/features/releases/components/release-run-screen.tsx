"use client";

// The release-run screen (`/projects/[slug]/releases/[runId]`).
//
// One page that assembles a whole release run from the record plus a fresh look
// at the running site, so a different person or a different machine can carry on
// from where it stopped. Everything on it comes from one call — core assembles
// the roster, the ledger, the live probe reading and the bounds itself, and this
// screen derives nothing it was not sent.

import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorState,
  MonoTag,
  PageTitle,
  ProjectLoader,
  Skeleton,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useReleaseRunState } from "../hooks";
import type {
	ReleaseBoundsReading,
	ReleaseLiveState,
	ReleaseMethod,
	ReleaseRunState,
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

function LiveReading({
	live,
	readAt,
	refreshing,
}: {
	live: ReleaseLiveState | null;
	readAt: number;
	refreshing: boolean;
}) {
	if (!live) {
		return (
			<p className="text-sm text-muted">
				This project declares no verification probes, so Forge has nowhere to
				look. A release batch can no longer be created without them.
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

function MethodLine({
	method,
	methodUnloaded,
}: {
	method: ReleaseMethod | null;
	methodUnloaded: boolean;
}) {
	if (!method) {
		return (
			<p className="text-sm text-amber" data-testid="method-line">
				No method announced. This run cannot be finished until it says which
				skill it loaded.
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
				<time className="text-xs text-subtle" dateTime={method.announcedAt}>
					{method.announcedAt}
				</time>
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

function Roster({ state }: { state: ReleaseRunState }) {
	const { roster } = state;
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
			<ul className="flex flex-col gap-1">
				{roster.issues.map((issue) => (
					<li key={issue.id} className="text-sm">
						<MonoTag>{issue.displayId}</MonoTag> {issue.title}
						{issue.waitingDays !== null ? (
							<span className="text-xs text-subtle">
								{" "}
								· waiting {issue.waitingDays}d
							</span>
						) : null}
					</li>
				))}
			</ul>
		</div>
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

			<div className="grid gap-4 lg:grid-cols-3">
				<Card>
					<CardHeader>
						<CardTitle>Production, right now</CardTitle>
					</CardHeader>
					<CardContent>
						<LiveReading
							live={data.live}
							readAt={dataUpdatedAt}
							refreshing={isFetching}
						/>
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle>Method</CardTitle>
					</CardHeader>
					<CardContent>
						<MethodLine
							method={data.method}
							methodUnloaded={data.methodUnloaded}
						/>
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle>Bounds</CardTitle>
					</CardHeader>
					<CardContent>
						<Bounds bounds={data.bounds} />
					</CardContent>
				</Card>
			</div>

			<Card>
				<CardHeader>
					<CardTitle>What this run did</CardTitle>
				</CardHeader>
				<CardContent>
					<ReleaseTimeline attempts={data.attempts} />
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Roster</CardTitle>
				</CardHeader>
				<CardContent>
					<Roster state={data} />
				</CardContent>
			</Card>
		</div>
	);
}
