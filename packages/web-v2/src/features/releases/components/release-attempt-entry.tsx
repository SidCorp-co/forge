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
 * The machine's half, always all five fields.
 *
 * Every field is rendered whether or not it holds a value: a backing block that
 * hides its empty rows reads as a complete record with fewer questions asked,
 * and "Forge never read an identity here" is exactly the thing a person
 * debugging a release needs to see.
 */
function AttemptBacking({ attempt }: { attempt: ReleaseAttempt }) {
	return (
		<div
			className="mt-2 grid gap-3 rounded-md border border-line-subtle bg-sunken p-2.5 sm:grid-cols-5"
			data-testid="attempt-backing"
		>
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
				{attempt.identity ? (
					<MonoTag>{shortCommit(attempt.identity)}</MonoTag>
				) : (
					<Unrecorded />
				)}
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
