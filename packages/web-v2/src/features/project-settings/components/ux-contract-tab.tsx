"use client";

// Project settings → "UX Contract" (ISS-577). The user-facing "choose, not
// write" surface for the ISS-574/578 rules + preset REST: apply a preset,
// read back the stack profile it recorded, tune rule severities, work the
// proposed-changes inbox, and preview the compiled prose the pipeline reads.
// No backend change here — pure consumption of already-live endpoints.

import { useMemo, useState } from "react";
import {
	Badge,
	Button,
	Card,
	CardContent,
	ConfirmDialog,
	EmptyState,
	ErrorState,
	Select,
	Skeleton,
	Toggle,
	Tooltip,
} from "@/design";
import { IssueRefBadge } from "@/features/issues/components/issue-ref-badge";
import type { ProjectDetail } from "@/features/projects/types";
import { formatApiError } from "@/lib/api/error";
import {
	useApplyUxPreset,
	useDeleteUxRule,
	usePatchUxRule,
	useProjectFacts,
	useUxContractRules,
	useUxFindings,
} from "../hooks";
import {
	type ProjectAgentConfig,
	type UxContractRule,
	UX_PRESET_LABELS,
	UX_PRESETS,
	UX_RULE_GROUPS,
	UX_RULE_GROUP_LABELS,
	UX_RULE_SOURCE_LABELS,
} from "../types";

function asAgentConfig(raw: unknown): ProjectAgentConfig {
	return raw && typeof raw === "object" ? (raw as ProjectAgentConfig) : {};
}

const PRESET_OPTIONS = UX_PRESETS.map((p) => ({ value: p, label: UX_PRESET_LABELS[p] }));

// cm:guard do NOT restore a Re-scan button here, or rename this back to "Detected stack", unless auto-detect is revived first — nothing detects this: the values come from `uxContractProfile.designSystem`, which apply-preset writes. Auto-detect WAS ISS-576, dropped 2026-08-30 with its four children (docs/proposals/ux-contract-direction.md) — measured on live, the `detected` rule source never held a row and the project yielding the most findings has no rows in `ux_contract_rules` at all. The button that sat here was disabled with a tooltip naming that issue, which is a control promising work nobody is doing; `ux-contract-tab.test.tsx` asserts its absence.
const STACK_PANEL_HEADING = "Stack profile";

export function UxContractTab({
	project,
	canEdit,
}: {
	project: ProjectDetail;
	canEdit: boolean;
}) {
	const projectId = project.id;
	const rulesQ = useUxContractRules(projectId);
	const findingsQ = useUxFindings(projectId);
	const factsQ = useProjectFacts(projectId);
	const applyPreset = useApplyUxPreset(projectId);
	const patchRule = usePatchUxRule(projectId);
	const deleteRule = useDeleteUxRule(projectId);

	const [preset, setPreset] = useState<(typeof UX_PRESETS)[number]>("app-strict");
	const [confirmApply, setConfirmApply] = useState(false);
	const [rejectRuleId, setRejectRuleId] = useState<string | null>(null);

	const profile = asAgentConfig(project.agentConfig).uxContractProfile;
	const designSystem = profile?.designSystem;

	const activeRules = useMemo(
		() => (rulesQ.data ?? []).filter((r) => r.status === "active"),
		[rulesQ.data],
	);
	const proposedRules = useMemo(
		() => (rulesQ.data ?? []).filter((r) => r.status === "proposed"),
		[rulesQ.data],
	);
	const grouped = useMemo(() => {
		const m = new Map<string, UxContractRule[]>();
		for (const g of UX_RULE_GROUPS) m.set(g, []);
		for (const r of activeRules) m.get(r.group)?.push(r);
		return m;
	}, [activeRules]);
	const ruleById = useMemo(
		() => new Map((rulesQ.data ?? []).map((r) => [r.id, r])),
		[rulesQ.data],
	);
	const findingsByIssue = useMemo(() => {
		const m = new Map<string, number>();
		for (const f of findingsQ.data ?? []) m.set(f.issueId, (m.get(f.issueId) ?? 0) + 1);
		return m;
	}, [findingsQ.data]);

	if (rulesQ.isLoading || factsQ.isLoading) {
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

	if (rulesQ.isError) {
		return (
			<Card>
				<CardContent>
					<ErrorState message={formatApiError(rulesQ.error)} onRetry={() => rulesQ.refetch()} />
				</CardContent>
			</Card>
		);
	}

	return (
		<div className="space-y-4">
			{/* Preset selector — apply-preset REPLACES the whole rule set. */}
			<Card>
				<CardContent>
					<h2 className="fg-h3 mb-1">Preset</h2>
					<p className="fg-body-sm mb-3 text-muted">
						Pick a starting point. Applying a preset replaces every rule below with
						the compiled set for that choice.
					</p>
					<div className="flex flex-wrap items-center gap-2">
						<Select
							options={PRESET_OPTIONS}
							value={preset}
							onChange={(v) => setPreset(v as (typeof UX_PRESETS)[number])}
							disabled={!canEdit}
						/>
						<Button
							variant="primary"
							disabled={!canEdit}
							title={canEdit ? undefined : "Requires org owner/admin"}
							onClick={() => setConfirmApply(true)}
						>
							Apply preset
						</Button>
					</div>
					{!canEdit && (
						<p className="fg-caption mt-2 text-muted">
							Read-only — applying a preset requires an org owner/admin.
						</p>
					)}
				</CardContent>
			</Card>

			<Card>
				<CardContent>
					<div className="flex items-center justify-between gap-3">
						<h2 className="fg-h3">{STACK_PANEL_HEADING}</h2>
					</div>
					{designSystem ? (
						<dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
							<Field label="Library" value={designSystem.libraryName ?? "—"} />
							<Field label="Token source" value={designSystem.tokenSource ?? "—"} />
							<Field label="Toast mechanism" value={designSystem.toastMechanism ?? "—"} />
							<Field label="Breakpoints" value={designSystem.breakpoints ?? "—"} />
							<Field label="i18n" value={designSystem.i18n ? "Yes" : "No"} />
						</dl>
					) : (
						<p className="fg-body-sm mt-3 text-muted">Not detected yet.</p>
					)}
				</CardContent>
			</Card>

			{/* Rules list, grouped §1–6. */}
			<Card>
				<CardContent>
					<h2 className="fg-h3 mb-1">Rules</h2>
					<p className="fg-body-sm mb-3 text-muted">
						Toggle severity between must and should. Source shows where a rule came
						from; evidence links to the issue that taught it.
					</p>
					{activeRules.length === 0 ? (
						<EmptyState
							title="No rules yet"
							message="Pick a preset above to get started."
							mascot={false}
						/>
					) : (
						<div className="space-y-5">
							{UX_RULE_GROUPS.map((group) => {
								const rows = grouped.get(group) ?? [];
								if (rows.length === 0) return null;
								return (
									<div key={group}>
										<h3 className="fg-label mb-2 text-fg">{UX_RULE_GROUP_LABELS[group]}</h3>
										<div className="space-y-2">
											{rows.map((rule) => (
												<RuleRow
													key={rule.id}
													rule={rule}
													slug={project.slug}
													findingsByIssue={findingsByIssue}
													canEdit={canEdit}
													onToggleSeverity={(next) =>
														patchRule.mutate({ ruleId: rule.id, patch: { severity: next } })
													}
													busy={patchRule.isPending}
												/>
											))}
										</div>
									</div>
								);
							})}
						</div>
					)}
				</CardContent>
			</Card>

			{/* Proposed-changes inbox. */}
			<Card>
				<CardContent>
					<h2 className="fg-h3 mb-1">Proposed changes</h2>
					<p className="fg-body-sm mb-3 text-muted">
						Rules an improver proposed. Approve to activate, or reject to discard.
					</p>
					{proposedRules.length === 0 ? (
						<EmptyState
							title="No proposed changes yet"
							message="Nothing is waiting for review right now."
							mascot={false}
						/>
					) : (
						<div className="space-y-2">
							{proposedRules.map((rule) => (
								<ProposalRow
									key={rule.id}
									rule={rule}
									supersedes={
										rule.supersedesRuleId
											? (ruleById.get(rule.supersedesRuleId) ?? null)
											: null
									}
									slug={project.slug}
									findingsByIssue={findingsByIssue}
									canEdit={canEdit}
									busy={patchRule.isPending}
									onReject={() => setRejectRuleId(rule.id)}
									onApprove={() =>
										patchRule.mutate({ ruleId: rule.id, patch: { status: "active" } })
									}
								/>
							))}
						</div>
					)}
				</CardContent>
			</Card>

			{/* Compiled-prose preview. */}
			<Card>
				<CardContent>
					<h2 className="fg-h3 mb-1">Compiled prose</h2>
					<p className="fg-body-sm mb-3 text-muted">
						This is exactly what the pipeline sees.
					</p>
					{factsQ.isError ? (
						<ErrorState message={formatApiError(factsQ.error)} onRetry={() => factsQ.refetch()} />
					) : factsQ.data?.projectFacts["ux-contract"] ? (
						<pre className="max-h-[50vh] overflow-auto rounded-md border border-line bg-sunken p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
							{factsQ.data.projectFacts["ux-contract"]}
						</pre>
					) : (
						<EmptyState
							title="Nothing compiled yet"
							message="Apply a preset or add a rule to generate the prose."
							mascot={false}
						/>
					)}
				</CardContent>
			</Card>

			<ConfirmDialog
				open={confirmApply}
				title="Apply preset?"
				message={`This replaces the entire rule set with the compiled "${UX_PRESET_LABELS[preset]}" preset. This can't be undone automatically.`}
				confirmLabel="Apply preset"
				tone="danger"
				loading={applyPreset.isPending}
				onConfirm={() =>
					applyPreset.mutate({ preset }, { onSuccess: () => setConfirmApply(false) })
				}
				onClose={() => setConfirmApply(false)}
			/>

			<ConfirmDialog
				open={rejectRuleId !== null}
				title="Reject proposed rule?"
				message="This permanently deletes the proposal. It won't be recoverable."
				confirmLabel="Reject"
				tone="danger"
				loading={deleteRule.isPending}
				onConfirm={() => {
					if (!rejectRuleId) return;
					deleteRule.mutate(rejectRuleId, { onSuccess: () => setRejectRuleId(null) });
				}}
				onClose={() => setRejectRuleId(null)}
			/>
		</div>
	);
}

function Field({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<dt className="fg-caption text-muted">{label}</dt>
			<dd className="fg-body-sm text-fg">{value}</dd>
		</div>
	);
}

// cm:guard ISS-579 — a proposal carrying `supersedesRuleId` RETIRES that rule the moment it is approved, so the "Replaces" block must keep rendering the target's text and severity. Drop it and an admin approves a rule removal they were never shown.
function ProposalRow({
	rule,
	supersedes,
	slug,
	findingsByIssue,
	canEdit,
	busy,
	onReject,
	onApprove,
}: {
	rule: UxContractRule;
	supersedes: UxContractRule | null;
	slug: string;
	findingsByIssue: Map<string, number>;
	canEdit: boolean;
	busy: boolean;
	onReject: () => void;
	onApprove: () => void;
}) {
	return (
		<div className="rounded-md border border-line bg-surface p-3">
			<div className="mb-1 flex flex-wrap items-center gap-2">
				<Badge>{UX_RULE_GROUP_LABELS[rule.group]}</Badge>
				<Badge tone={rule.severity === "must" ? "red" : "neutral"}>{rule.severity}</Badge>
				<Badge tone="amber">{UX_RULE_SOURCE_LABELS[rule.source]}</Badge>
				{rule.evidenceIssueIds.map((issueId) => (
					<IssueRefBadge
						key={issueId}
						id={issueId}
						slug={slug}
						title={
							findingsByIssue.has(issueId)
								? `${findingsByIssue.get(issueId)} finding(s) cited this issue`
								: undefined
						}
					/>
				))}
			</div>
			<p className="fg-body-sm break-words text-fg">{rule.text}</p>
			{supersedes ? (
				<div className="mt-2 border-line border-l-2 pl-3">
					<p className="fg-caption text-muted">
						Replaces this rule ({supersedes.severity} → {rule.severity}). Approving retires it.
					</p>
					<p className="fg-body-sm break-words text-muted">{supersedes.text}</p>
				</div>
			) : null}
			{canEdit ? (
				<div className="mt-3 flex justify-end gap-2">
					<Button variant="danger" size="sm" onClick={onReject}>
						Reject
					</Button>
					<Button variant="primary" size="sm" loading={busy} onClick={onApprove}>
						Approve
					</Button>
				</div>
			) : (
				<p className="fg-caption mt-2 text-muted">
					Read-only — approving/rejecting requires an org owner/admin.
				</p>
			)}
		</div>
	);
}

function RuleRow({
	rule,
	slug,
	findingsByIssue,
	canEdit,
	onToggleSeverity,
	busy,
}: {
	rule: UxContractRule;
	slug: string;
	findingsByIssue: Map<string, number>;
	canEdit: boolean;
	onToggleSeverity: (next: "must" | "should") => void;
	busy: boolean;
}) {
	return (
		<div className="flex items-start justify-between gap-3 rounded-md border border-line bg-surface p-3">
			<div className="min-w-0 flex-1">
				<div className="mb-1 flex flex-wrap items-center gap-2">
					<Badge tone={rule.severity === "must" ? "red" : "neutral"}>{rule.severity}</Badge>
					<Badge>{UX_RULE_SOURCE_LABELS[rule.source]}</Badge>
					{rule.evidenceIssueIds.map((issueId) => (
						<IssueRefBadge
							key={issueId}
							id={issueId}
							slug={slug}
							title={
								findingsByIssue.has(issueId)
									? `${findingsByIssue.get(issueId)} finding(s) cited this issue`
									: undefined
							}
						/>
					))}
				</div>
				<p className="fg-body-sm break-words text-fg">{rule.text}</p>
			</div>
			<Tooltip label={canEdit ? "must ↔ should" : "Requires org owner/admin"}>
				<Toggle
					checked={rule.severity === "must"}
					onChange={(checked) => onToggleSeverity(checked ? "must" : "should")}
					disabled={!canEdit || busy}
					aria-label={`Severity for "${rule.text}"`}
				/>
			</Tooltip>
		</div>
	);
}
