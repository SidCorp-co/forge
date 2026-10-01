"use client";

import { useState, type ReactNode } from "react";
import { Banner, Button, CardTitle, ErrorState, Field, Input, Skeleton } from "@/design";
import { formatApiError } from "@/lib/api/error";
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
} from "../config-hooks";
import { bindingTemplate, policyTemplate, projectTemplate, testingProfileTemplate } from "../config-templates";
import type { V1Read } from "../config-types";
import { refusalsOf } from "../document-edit";
import { DocumentEditor } from "./document-editor";

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
	const q = useProjectDocument(project.id);
	const write = useWriteProjectDocument(project.id);
	if (!q.data) return <Loading query={q} />;
	return (
		<DocumentEditor
			title="Project document"
			description="Where work is made, how a workspace builds, what proves a change, the environments it goes live in, the promotions between branches, rollback and the pinned executor."
			read={q.data}
			template={projectTemplate(project)}
			canEdit={canEdit}
			write={write}
			onReload={() => q.refetch()}
		/>
	);
}

export function PolicyDocumentSection({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
	const q = usePolicyDocument(projectId);
	const write = useWritePolicy(projectId);
	if (!q.data) return <Loading query={q} />;
	return (
		<DocumentEditor
			title="Policy"
			description={
				<>
					Who judges a change (<code>qa</code>), whether queued issues start on their own (<code>intake</code>), and
					for each status the model and the tools it runs without (<code>states</code>, <code>permissions</code>).
					Dispatch reads this document and nothing else.
					{!q.data.declared && " With none declared, nothing dispatches for this project."}
				</>
			}
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
	const write = useWriteTestingProfile(props.projectId, props.profileId);
	return (
		<DocumentEditor
			title={`Testing profile ${props.profileId}`}
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
	const refusals = refusalsOf(err);
	return (
		<Banner tone="danger">
			{refusals.length === 0
				? formatApiError(err)
				: refusals.map((r) => (
						<p key={`${r.code}:${r.path}`}>
							<code>{r.code}</code> at <code>{r.path || "/"}</code>: {r.detail}
						</p>
					))}
		</Banner>
	);
}

const NAME = /^[a-z][a-z0-9-]{0,62}$/;

export function TestingProfilesSection({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
	const q = useTestingProfiles(projectId);
	const remove = useDeleteTestingProfile(projectId);
	const [name, setName] = useState("");
	const [adding, setAdding] = useState<string[]>([]);
	if (!q.data) return <Loading query={q} />;
	const held = new Set(q.data.profiles.map((p) => p.profileId));
	const pending = adding.filter((id) => !held.has(id));
	const nameError =
		name === "" || NAME.test(name) ? (held.has(name) ? `${name} is already declared.` : undefined) : "A profile id matches ^[a-z][a-z0-9-]{0,62}$.";
	return (
		<div className="mt-6 border-t border-line pt-5">
			<CardTitle className="fg-label text-fg">Testing profiles</CardTitle>
			<p className="fg-body-sm mt-1 text-muted">
				How a tester gets into an environment: actors and services, each naming a <code>secret://</code> reference, never
				a value. An environment names its profile in <code>environments.&lt;name&gt;.testing</code>.
			</p>
			{q.data.profiles.length === 0 && pending.length === 0 && (
				<p className="fg-caption mt-2 text-subtle">No testing profile is declared.</p>
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
								Delete
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
						<Field label="New profile id" error={nameError}>
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
						Add a testing profile
					</Button>
				</div>
			)}
		</div>
	);
}

function BindingEditor(props: { projectId: string; bindingId: string; read: V1Read; canEdit: boolean; onReload: () => unknown }) {
	const write = useWriteBinding(props.projectId, props.bindingId);
	return (
		<DocumentEditor
			title={`Binding ${props.bindingId}`}
			read={props.read}
			template={bindingTemplate(props.bindingId)}
			canEdit={props.canEdit}
			write={write}
			onReload={props.onReload}
		/>
	);
}

export function BindingsSection({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
	const q = useBindingDocuments(projectId);
	const [adding, setAdding] = useState<string[]>([]);
	if (!q.data) return <Loading query={q} />;
	const held = new Set(q.data.bindings.map((b) => String(b.document.id)));
	const pending = adding.filter((id) => !held.has(id));
	return (
		<div className="mt-6 border-t border-line pt-5">
			<CardTitle className="fg-label text-fg">Bindings</CardTitle>
			<p className="fg-body-sm mt-1 text-muted">
				What a connection is bound to in this project: a deploy target, a storefront source or a service. Each keeps one
				role; the project document names a binding by its id.
			</p>
			{q.data.unrepresentable.map((u) => (
				<Banner key={u.id} tone="attention">
					Binding <code>{u.id}</code> ({u.provider}, {u.role}) has no binding-document form: {u.reason}
				</Banner>
			))}
			{q.data.bindings.length === 0 && pending.length === 0 && (
				<p className="fg-caption mt-2 text-subtle">No binding is declared.</p>
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
					Add a binding
				</Button>
			)}
		</div>
	);
}
