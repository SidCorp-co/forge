// Project settings → Variables (REQ-80 BC-1, BC-2, BC-6): every variable as key, scope, type and
// protected flag in one flush table, like GitLab's CI/CD variables. A holder of env.manage reads a
// plain value inline, reveals a secret one at a time, adds, edits and deletes, and decides what
// agents proposed; anyone else reads names. Values are never kept past the row that revealed them.
import type { VariableView } from "@forge/contracts/variables";
import { useState } from "react";
import {
	Badge,
	Button,
	ConfirmDialog,
	EmptyState,
	ErrorState,
	IconButton,
	PageSection,
	PageSectionBody,
	SectionTitle,
	Skeleton,
	Table,
	TBody,
	TD,
	TH,
	THead,
	TR,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { useDeleteVariable, useVariables, variablesApi } from "../variables";
import { VariableForm } from "./variable-form";
import { TYPE_LABEL } from "./variable-labels";
import { VariableHistory, VariableProposals } from "./variable-proposals";

export function VariablesSettings({ projectId }: { projectId: string }) {
	const t = useCopy();
	const listQ = useVariables(projectId);
	const [editing, setEditing] = useState<VariableView | "new" | null>(null);
	const [deleting, setDeleting] = useState<VariableView | null>(null);
	const remove = useDeleteVariable(projectId);
	const read = listQ.data;
	return (
		<PageSection>
			<PageSectionBody>
				<div className="mb-3 flex items-center justify-between gap-3">
					<SectionTitle className="fg-h3 text-accent-text!">{t("settings.project.variables.title")}</SectionTitle>
					{read?.canManage && editing === null && (
						<Button variant="primary" onClick={() => setEditing("new")} className="min-h-11">
							{t("settings.project.variables.add")}
						</Button>
					)}
				</div>
				{listQ.isLoading ? (
					<Skeleton className="h-9 w-full rounded-md" />
				) : listQ.isError ? (
					<ErrorState message={formatApiError(listQ.error)} onRetry={() => void listQ.refetch()} />
				) : read ? (
					<>
						{editing !== null && (
							<VariableForm projectId={projectId} environments={read.environments} editing={editing === "new" ? null : editing} onDone={() => setEditing(null)} />
						)}
						{read.variables.length === 0 ? (
							<EmptyState message={t("settings.project.variables.none")} mascot={false} />
						) : (
							<VariableTable projectId={projectId} rows={read.variables} canManage={read.canManage} onEdit={setEditing} onDelete={setDeleting} />
						)}
						<VariableProposals projectId={projectId} canManage={read.canManage} />
						<VariableHistory projectId={projectId} />
					</>
				) : null}
				<ConfirmDialog
					open={deleting !== null}
					title={t("settings.project.variables.deleteTitle", { key: deleting?.key ?? "" })}
					message={t("settings.project.variables.deleteBody")}
					confirmLabel={t("settings.project.variables.delete")}
					tone="danger"
					loading={remove.isPending}
					onConfirm={() =>
						deleting && remove.mutate({ variable: deleting.id, baseVersion: deleting.version }, { onSettled: () => setDeleting(null) })
					}
					onClose={() => setDeleting(null)}
				/>
			</PageSectionBody>
		</PageSection>
	);
}

function VariableTable({
	projectId,
	rows,
	canManage,
	onEdit,
	onDelete,
}: {
	projectId: string;
	rows: VariableView[];
	canManage: boolean;
	onEdit: (v: VariableView) => void;
	onDelete: (v: VariableView) => void;
}) {
	const t = useCopy();
	return (
		<Table aria-label={t("settings.project.variables.title")}>
			<THead>
				<TR>
					<TH>{t("settings.project.variables.key")}</TH>
					<TH>{t("settings.project.variables.environment")}</TH>
					<TH>{t("settings.project.variables.type")}</TH>
					<TH>{t("settings.project.variables.value")}</TH>
					{canManage && <TH aria-label={t("settings.project.variables.actions")} />}
				</TR>
			</THead>
			<TBody>
				{rows.map((v) => (
					<TR key={v.id} data-testid="variable-row">
						<TD>
							<code translate="no" className="font-mono text-fg">
								{v.key}
							</code>
							{v.protected && (
								<span className="ml-2">
									<Badge tone="amber">{t("settings.project.variables.protected")}</Badge>
								</span>
							)}
						</TD>
						<TD className="text-muted">{v.environment ?? t("settings.project.variables.allEnvironments")}</TD>
						<TD className="text-muted">{t(TYPE_LABEL[v.type])}</TD>
						<TD>
							<ValueCell projectId={projectId} variable={v} canManage={canManage} />
						</TD>
						{canManage && (
							<TD className="whitespace-nowrap text-right">
								<IconButton icon="rename" aria-label={t("settings.project.variables.editNamed", { key: v.key })} onClick={() => onEdit(v)} />
								<IconButton icon="trash" aria-label={t("settings.project.variables.deleteNamed", { key: v.key })} onClick={() => onDelete(v)} />
							</TD>
						)}
					</TR>
				))}
			</TBody>
		</Table>
	);
}

/** A plain value inline for a holder; a secret or file value masked until revealed, then hidden again. */
function ValueCell({ projectId, variable, canManage }: { projectId: string; variable: VariableView; canManage: boolean }) {
	const t = useCopy();
	const [shown, setShown] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	if (variable.value !== null) {
		return (
			<code translate="no" className="break-all font-mono text-fg">
				{variable.value}
			</code>
		);
	}
	if (shown !== null) {
		return (
			<span className="flex items-start gap-2">
				<code translate="no" className="break-all font-mono text-fg" data-testid="revealed-value">
					{shown}
				</code>
				<IconButton icon="lock" aria-label={t("settings.project.variables.hide")} onClick={() => setShown(null)} />
			</span>
		);
	}
	return (
		<span className="flex items-center gap-2">
			<span className="font-mono text-subtle" title={variable.fingerprint}>
				••••••••
			</span>
			{canManage && (
				<Button
					variant="ghost"
					loading={busy}
					onClick={() => {
						setBusy(true);
						setError(null);
						variablesApi
							.reveal(projectId, variable.id)
							.then((r) => setShown(r.value))
							.catch((err: unknown) => setError(formatApiError(err)))
							.finally(() => setBusy(false));
					}}
				>
					{t("settings.project.variables.reveal")}
				</Button>
			)}
			{error && <span className="text-12 text-danger">{error}</span>}
		</span>
	);
}
