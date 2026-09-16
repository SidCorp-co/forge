"use client";

// One entry of the release timeline: what the agent says it did, and what the
// machine read while it did it.
//
// The two are laid out as body and backing rather than side by side, because
// they are not peers. `account` is a claim; `commit`, `providerRef`, `health`,
// `identity` and `verdict` are readings core took itself, and the defect this
// whole issue answers is that the claim used to be the only thing anybody had.
// So the account is quoted as the agent's words and the readings sit under it
// labelled as Forge's, and a reader can always tell which is which.

import { Badge, MonoTag } from "@/design";
import type { ReleaseAttempt } from "../types";

/** Shown in place of a reading the record does not hold. */
const UNRECORDED = "not recorded";

function shortCommit(commit: string) {
	return commit.length > 12 ? commit.slice(0, 12) : commit;
}

function Backing({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-0.5">
			<span className="text-[10px] font-semibold uppercase tracking-wide text-subtle">
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

/**
 * The five fields that back the account, split by who authored them.
 *
 * `commit` and `providerRef` reach the row through the agent's own routes —
 * `ledger.ts` says so in as many words: a deployment uuid "is a fact only the
 * caller holds, so it travels with the account, where it is read as something
 * reported rather than as something measured". `health`, `identity` and
 * `verdict` are what core read itself and no route lets an agent write them.
 * Presenting all five under one heading would put the agent's word back inside
 * Forge's reading, which is the collapse this whole table exists to undo.
 *
 * Every field renders whether or not it holds a value: a backing block that
 * hides its empty rows reads as a complete record with fewer questions asked,
 * and "Forge never read an identity here" is exactly the thing a person
 * debugging a release needs to see.
 */
function AttemptBacking({ attempt }: { attempt: ReleaseAttempt }) {
	return (
		<div
			className="mt-2 flex flex-col gap-2 rounded-md border border-line-subtle bg-sunken p-2.5"
			data-testid="attempt-backing"
		>
			<section data-testid="backing-reported">
				<h4 className="text-[10px] font-semibold uppercase tracking-wide text-muted">
					Reported by the agent
				</h4>
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
				<h4 className="text-[10px] font-semibold uppercase tracking-wide text-muted">
					Read by Forge
				</h4>
				<div className="mt-1 grid gap-3 sm:grid-cols-3">
					<Backing label="Health">
						{attempt.health ? (
							<Badge tone={attempt.health === "up" ? "green" : "red"}>
								{attempt.health}
							</Badge>
						) : (
							<Unrecorded />
						)}
					</Backing>
					<Backing label="Identity">
						<AttemptIdentity attempt={attempt} />
					</Backing>
					<Backing label="Verdict">
						{attempt.verdict ? (
							<Badge tone={attempt.verdict === "ok" ? "green" : "red"}>
								{attempt.verdict}
							</Badge>
						) : (
							<Unrecorded />
						)}
					</Backing>
				</div>
				{attempt.readings && attempt.readings.length > 0 ? (
					<ul className="mt-1.5 flex flex-col gap-0.5" data-testid="attempt-readings">
						{attempt.readings.map((reading) => (
							<li key={reading} className="font-mono text-[11px] text-muted">
								{reading}
							</li>
						))}
					</ul>
				) : null}
			</section>
		</div>
	);
}

/**
 * An act that was declared and never reported back.
 *
 * `settledAt` null is a state, not a missing row — it is what a killed release
 * looks like from outside — so the entry renders in full and says what is
 * missing, rather than being filtered out of a list that would then read as a
 * complete account of the run.
 */
function NeverReported() {
	return (
		<p
			className="mt-1.5 text-xs font-medium text-amber"
			data-testid="attempt-incomplete"
		>
			Never reported — this act was recorded before it ran and nothing has
			reported back on it since. It is incomplete, not finished.
		</p>
	);
}

/**
 * A log tail the machine cut short that nobody has read past.
 *
 * The pair is what separates short output from output the machine cut: a
 * truncation nobody is told about reads as the whole of it, and an operator
 * debugging a failed deploy then believes they have seen the error.
 */
function LogCutUnread() {
	return (
		<p
			className="mt-1.5 text-xs text-amber"
			data-testid="attempt-log-cut-unread"
		>
			Log cut short by the machine — read by nobody. What is stored here stops
			before the end of what the act printed.
		</p>
	);
}

export interface ReleaseAttemptEntryProps {
	attempt: ReleaseAttempt;
}

export function ReleaseAttemptEntry({ attempt }: ReleaseAttemptEntryProps) {
	const incomplete = attempt.settledAt === null;
	const logCutUnread = attempt.logTailTruncated && attempt.logTailReadAt === null;

	return (
		<li
			className="relative pl-6"
			data-testid="attempt-entry"
			data-stage={attempt.stage}
			data-incomplete={incomplete ? "true" : "false"}
		>
			<span
				className="absolute left-0 top-2 h-2.5 w-2.5 rounded-full border-2"
				style={{
					borderColor: incomplete ? "var(--amber-500)" : "var(--border-strong)",
					background: incomplete ? "transparent" : "var(--border-strong)",
				}}
				aria-hidden
			/>
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-sm font-semibold capitalize">{attempt.stage}</span>
				<MonoTag hue="cobalt">{attempt.idempotencyKey}</MonoTag>
				<time className="text-xs text-subtle" dateTime={attempt.startedAt}>
					{attempt.startedAt}
				</time>
				{incomplete ? <Badge tone="amber">incomplete</Badge> : null}
			</div>

			{attempt.account ? (
				<blockquote
					className="mt-1.5 whitespace-pre-wrap text-sm text-fg"
					data-testid="attempt-account"
				>
					{attempt.account}
				</blockquote>
			) : (
				<p className="mt-1.5 text-sm text-subtle" data-testid="attempt-account">
					The agent recorded no account of this act.
				</p>
			)}

			{incomplete ? <NeverReported /> : null}
			{logCutUnread ? <LogCutUnread /> : null}
			{attempt.verdictReason ? (
				<p className="mt-1.5 text-xs text-muted">
					Forge&rsquo;s reason: {attempt.verdictReason}
				</p>
			) : null}

			<AttemptBacking attempt={attempt} />
		</li>
	);
}
