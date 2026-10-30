// What agents proposed for a project's variables, waiting on a holder of env.manage (REQ-80 BC-6),
// and the audit of every act on them by fingerprint (BC-2). Neither ever shows a value.
import { useState } from "react";
import { Button, Disclosure, Input, Table, TBody, TD, TH, THead, TR } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { useDecideProposal, useVariableEvents, useVariableProposals } from "../variables";

export function VariableProposals({ projectId, canManage }: { projectId: string; canManage: boolean }) {
	const t = useCopy();
	const proposalsQ = useVariableProposals(projectId);
	const decide = useDecideProposal(projectId);
	const [reason, setReason] = useState("");
	const waiting = (proposalsQ.data?.proposals ?? []).filter((p) => p.status === "proposed");
	if (waiting.length === 0) return null;
	return (
		<div className="mt-6" data-testid="variable-proposals">
			<h4 className="fg-h4 mb-2">{t("settings.project.variables.proposals")}</h4>
			<Table aria-label={t("settings.project.variables.proposals")}>
				<THead>
					<TR>
						<TH>{t("settings.project.variables.key")}</TH>
						<TH>{t("settings.project.variables.environment")}</TH>
						<TH>{t("settings.project.variables.proposedAct")}</TH>
						<TH>{t("settings.project.variables.reason")}</TH>
						{canManage && <TH aria-label={t("settings.project.variables.actions")} />}
					</TR>
				</THead>
				<TBody>
					{waiting.map((p) => (
						<TR key={p.id}>
							<TD>
								<code translate="no" className="font-mono">
									{p.key}
								</code>
							</TD>
							<TD className="text-muted">{p.environment ?? t("settings.project.variables.allEnvironments")}</TD>
							<TD className="text-muted">{p.act === "set" ? t("settings.project.variables.actSet") : t("settings.project.variables.actDelete")}</TD>
							<TD>{p.reason}</TD>
							{canManage && (
								<TD className="whitespace-nowrap text-right">
									<Button
										variant="primary"
										disabled={reason.trim() === "" || decide.isPending}
										onClick={() => decide.mutate({ proposal: p.id, body: { decision: "approve", reason } })}
									>
										{t("settings.project.variables.approve")}
									</Button>{" "}
									<Button
										variant="ghost"
										disabled={reason.trim() === "" || decide.isPending}
										onClick={() => decide.mutate({ proposal: p.id, body: { decision: "reject", reason } })}
									>
										{t("settings.project.variables.reject")}
									</Button>
								</TD>
							)}
						</TR>
					))}
				</TBody>
			</Table>
			{canManage && (
				<div className="mt-2 w-96 max-w-full">
					<Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("settings.project.variables.decisionReason")} aria-label={t("settings.project.variables.decisionReason")} />
				</div>
			)}
		</div>
	);
}

export function VariableHistory({ projectId }: { projectId: string }) {
	const t = useCopy();
	const [open, setOpen] = useState(false);
	const eventsQ = useVariableEvents(projectId, open);
	return (
		<div className="mt-6">
			<Disclosure title={t("settings.project.variables.history")} open={open} onOpenChange={setOpen} testId="variable-history">
				<ul className="divide-y divide-line-subtle">
					{(eventsQ.data?.events ?? []).map((e) => (
						<li key={e.id} className="flex flex-wrap items-baseline gap-x-3 py-2 text-13">
							<span className="font-medium text-fg">{e.act}</span>
							<code translate="no" className="font-mono">
								{e.key}
							</code>
							<span className="text-muted">{e.environment ?? t("settings.project.variables.allEnvironments")}</span>
							<span className="font-mono text-subtle">
								{e.oldFingerprint ?? "–"} → {e.newFingerprint ?? "–"}
							</span>
							<span className="text-subtle">{new Date(e.at).toLocaleString()}</span>
						</li>
					))}
				</ul>
			</Disclosure>
		</div>
	);
}
