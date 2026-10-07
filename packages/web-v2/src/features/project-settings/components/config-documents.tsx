"use client";

import { useState, type ReactNode } from "react";
import { Banner, Button, PageSectionTitle, ErrorState, Field, Input, Skeleton, enumLabel } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { documentRefusals, readRefusal } from "@/lib/api/refusals";
import {
	useBindingDocuments,
	useDeleteTestingProfile,
	usePolicyDocument,
	useProjectDocument,
	useTestingProfiles,
	useWriteBinding,
	useWritePolicy,
	useWriteProjectDocument,
	useWriteTestingProfile,
} from "@/features/project-config/hooks";
import { bindingTemplate, policyTemplate, projectTemplate, testingProfileTemplate } from "../config-templates";
import type { V1Read } from "@/features/project-config/types";
import { NAME } from "../secret-refs";
import { useCopy } from "@/lib/i18n/interface-language";
import { DocumentEditor } from "./document-editor";
import { IDENTITY_POINTERS, PROJECT_IDENTITY } from "./document-fields";

const KEYED_IDENTITY = [...IDENTITY_POINTERS, "/id"];

const UNDECLARED: V1Read = { declared: false, revision: null, document: null };

function Loading({ query }: { query: { isLoading: boolean; isError: boolean; error: unknown; refetch: () => unknown } }) {
	if (query.isLoading) return <Skeleton className="mt-6 h-40 w-full rounded-md" />;
	return <ErrorState message={formatApiError(query.error)} onRetry={() => query.refetch()} />;
}

export function ProjectDocumentSection({
	project,
	canEdit,
}: {
	project: { id: string; slug: string; name: string };
	canEdit: boolean;
}) {
	const t = useCopy();
	const q = useProjectDocument(project.id);
	const write = useWriteProjectDocument(project.id);
	if (!q.data) return <Loading query={q} />;
	return (
		<DocumentEditor
			title={t("settings.project.raw.projectDocument")}
			description={t("settings.project.raw.projectDocumentLead")}
			fixed={PROJECT_IDENTITY}
			read={q.data}
			template={projectTemplate(project)}
			canEdit={canEdit}
			write={write}
			onReload={() => q.refetch()}
		/>
	);
}

export function PolicyDocumentSection({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
	const t = useCopy();
	const q = usePolicyDocument(projectId);
	const write = useWritePolicy(projectId);
	if (!q.data) return <Loading query={q} />;
	return (
		<DocumentEditor
			title={t("settings.project.raw.policy")}
			description={`${t("settings.project.raw.policyLead")}${q.data.declared ? "" : ` ${t("settings.project.raw.policyUndeclared")}`}`}
			fixed={IDENTITY_POINTERS}
			read={q.data}
			template={policyTemplate()}
			canEdit={canEdit}
			write={write}
			onReload={() => q.refetch()}
		/>
	);
}

function ProfileEditor(props: {
	projectId: string;
	profileId: string;
	read: V1Read;
	canEdit: boolean;
	onReload: () => unknown;
	actions?: ReactNode;
}) {
	const t = useCopy();
	const write = useWriteTestingProfile(props.projectId, props.profileId);
	return (
		<DocumentEditor
			title={t("settings.project.raw.profileNamed", { id: props.profileId })}
			fixed={KEYED_IDENTITY}
			read={props.read}
			template={testingProfileTemplate(props.profileId)}
			canEdit={props.canEdit}
			write={write}
			onReload={props.onReload}
			actions={props.actions}
		/>
	);
}

function RefusedBanner({ err }: { err: unknown }) {
	const refusals = documentRefusals(err);
	return (
		<Banner tone="danger">
			{refusals.length === 0
				? formatApiError(err)
				: refusals.map((r) => (
						<p key={`${r.code}:${r.path}`}>
							<code translate="no">{r.code}</code> <code translate="no">{readRefusal(r).where ?? "/"}</code>: {readRefusal(r).sentence}
						</p>
					))}
		</Banner>
	);
}

export function TestingProfilesSection({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
	const t = useCopy();
	const q = useTestingProfiles(projectId);
	const remove = useDeleteTestingProfile(projectId);
	const [name, setName] = useState("");
	const [adding, setAdding] = useState<string[]>([]);
	if (!q.data) return <Loading query={q} />;
	const held = new Set(q.data.profiles.map((p) => p.profileId));
	const pending = adding.filter((id) => !held.has(id));
	const nameError =
		name === "" || NAME.test(name) ? (held.has(name) ? t("settings.project.raw.profileExists", { id: name }) : undefined) : t("settings.project.raw.profileIdRule");
	return (
		<div className="mt-6 border-t border-line pt-5">
			<PageSectionTitle className="fg-label text-fg">{t("settings.project.raw.profiles")}</PageSectionTitle>
			<p className="fg-body-sm mt-1 text-muted">{t("settings.project.raw.profilesLead")}</p>
			{q.data.profiles.length === 0 && pending.length === 0 && (
				<p className="fg-caption mt-2 text-subtle">{t("settings.project.raw.noProfiles")}</p>
			)}
			{remove.isError && <RefusedBanner err={remove.error} />}
			{q.data.profiles.map((p) => (
				<ProfileEditor
					key={p.profileId}
					projectId={projectId}
					profileId={p.profileId}
					read={p}
					canEdit={canEdit}
					onReload={() => q.refetch()}
					actions={
						canEdit && (
							<Button variant="ghost" size="sm" loading={remove.isPending} onClick={() => remove.mutate(p.profileId)}>
								{t("settings.project.raw.delete")}
							</Button>
						)
					}
				/>
			))}
			{pending.map((id) => (
				<ProfileEditor key={id} projectId={projectId} profileId={id} read={UNDECLARED} canEdit={canEdit} onReload={() => q.refetch()} />
			))}
			{canEdit && (
				<div className="mt-4 flex flex-wrap items-end gap-2">
					<div className="w-64">
						<Field label={t("settings.project.raw.newProfile")} error={nameError}>
							<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="forge-beta" />
						</Field>
					</div>
					<Button
						variant="secondary"
						disabled={name === "" || nameError !== undefined}
						onClick={() => {
							setAdding((a) => [...a, name]);
							setName("");
						}}
					>
						{t("settings.project.raw.addProfile")}
					</Button>
				</div>
			)}
		</div>
	);
}

function BindingEditor(props: { projectId: string; bindingId: string; read: V1Read; canEdit: boolean; onReload: () => unknown }) {
	const t = useCopy();
	const write = useWriteBinding(props.projectId, props.bindingId);
	return (
		<DocumentEditor
			title={t("settings.project.raw.bindingNamed", { id: props.bindingId })}
			fixed={KEYED_IDENTITY}
			read={props.read}
			template={bindingTemplate(props.bindingId)}
			canEdit={props.canEdit}
			write={write}
			onReload={props.onReload}
		/>
	);
}

export function BindingsSection({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
	const t = useCopy();
	const q = useBindingDocuments(projectId);
	const [adding, setAdding] = useState<string[]>([]);
	if (!q.data) return <Loading query={q} />;
	const held = new Set(q.data.bindings.map((b) => String(b.document.id)));
	const pending = adding.filter((id) => !held.has(id));
	return (
		<div className="mt-6 border-t border-line pt-5">
			<PageSectionTitle className="fg-label text-fg">{t("settings.project.raw.bindings")}</PageSectionTitle>
			<p className="fg-body-sm mt-1 text-muted">{t("settings.project.raw.bindingsLead")}</p>
			{q.data.unrepresentable.map((u) => (
				<Banner key={u.id} tone="attention">
					{t("settings.project.raw.unrepresentable", { id: u.id, provider: u.provider, role: enumLabel("bindingRole", u.role) })} {u.reason}
				</Banner>
			))}
			{q.data.bindings.length === 0 && pending.length === 0 && (
				<p className="fg-caption mt-2 text-subtle">{t("settings.project.raw.noBindings")}</p>
			)}
			{q.data.bindings.map((b) => (
				<BindingEditor
					key={String(b.document.id)}
					projectId={projectId}
					bindingId={String(b.document.id)}
					read={b}
					canEdit={canEdit}
					onReload={() => q.refetch()}
				/>
			))}
			{pending.map((id) => (
				<BindingEditor key={id} projectId={projectId} bindingId={id} read={UNDECLARED} canEdit={canEdit} onReload={() => q.refetch()} />
			))}
			{canEdit && (
				<Button variant="secondary" className="mt-4" onClick={() => setAdding((a) => [...a, crypto.randomUUID()])}>
					{t("settings.project.raw.addBinding")}
				</Button>
			)}
		</div>
	);
}
