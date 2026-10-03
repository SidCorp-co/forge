"use client";


import {
  CardTitle,
  MonoTag,
  StatusBadge,
} from "@/design";
import type { ReleaseAttempt } from "../types";

/** Shown in place of a reading the record does not hold. */
const UNRECORDED = "not recorded";

function shortCommit(commit: string) {
	return commit.length > 12 ? commit.slice(0, 12) : commit;
}

function Backing({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-0.5">
			<span className="text-10 font-semibold uppercase tracking-wide text-subtle">
				{label}
			</span>
			<span className="text-xs text-fg">{children}</span>
		</div>
	);
}

function Unrecorded() {
	return <span className="text-subtle">{UNRECORDED}</span>;
}

/**
 * A null identity is two different answers and they are not interchangeable.
 *
 * With no readings beside it, core never took one. With readings beside it,
 * core DID look and the fleet did not agree on a commit — `readLiveState`
 * returns `identity: null` for exactly that case. Calling the second one "not
 * recorded" tells a reader nothing was checked on the one attempt where the
 * check is the whole story, so the readings are shown as the evidence for it.
 */
function AttemptIdentity({ attempt }: { attempt: ReleaseAttempt }) {
	if (attempt.identity) return <MonoTag>{shortCommit(attempt.identity)}</MonoTag>;
	if (attempt.readings && attempt.readings.length > 0) {
		return (
			<span className="text-amber" data-testid="identity-unagreed">
				no agreed identity
			</span>
		);
	}
	return <Unrecorded />;
}

export function AttemptBacking({ attempt }: { attempt: ReleaseAttempt }) {
	return (
		<div
			className="mt-2 flex flex-col gap-2 rounded-md border border-line-subtle bg-sunken p-2.5"
			data-testid="attempt-backing"
		>
			<section data-testid="backing-reported">
				<CardTitle className="text-10 font-semibold uppercase tracking-wide text-muted">
					Reported by the agent
				</CardTitle>
				<div className="mt-1 grid gap-3 sm:grid-cols-2">
					<Backing label="Commit">
						{attempt.commit ? (
							<MonoTag>{shortCommit(attempt.commit)}</MonoTag>
						) : (
							<Unrecorded />
						)}
					</Backing>
					<Backing label="Provider reference">
						{attempt.providerRef ? (
							<MonoTag>{attempt.providerRef}</MonoTag>
						) : (
							<Unrecorded />
						)}
					</Backing>
				</div>
			</section>

			<section data-testid="backing-read">
				<CardTitle className="text-10 font-semibold uppercase tracking-wide text-muted">
					Read by Forge
				</CardTitle>
				<div className="mt-1 grid gap-3 sm:grid-cols-3">
					<Backing label="Health">
						{attempt.health ? (
							<StatusBadge family="health" value={attempt.health} />
						) : (
							<Unrecorded />
						)}
					</Backing>
					<Backing label="Identity">
						<AttemptIdentity attempt={attempt} />
					</Backing>
					<Backing label="Verdict">
						{attempt.verdict ? (
							<StatusBadge family="attemptVerdict" value={attempt.verdict} />
						) : (
							<Unrecorded />
						)}
					</Backing>
				</div>
				{attempt.readings && attempt.readings.length > 0 ? (
					<ul className="mt-1.5 flex flex-col gap-0.5" data-testid="attempt-readings">
						{attempt.readings.map((reading) => (
							<li key={reading} className="font-mono text-11 text-muted">
								{reading}
							</li>
						))}
					</ul>
				) : null}
			</section>
		</div>
	);
}
