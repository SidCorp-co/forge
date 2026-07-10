"use client";

// Workspace Resources → Private Keys (ISS-628). An org-scoped pool of SSH
// deploy keys — create once, reuse across any project in the org. Mirrors the
// UX-completeness contract: loading skeleton, first-run empty state, error +
// retry, toasts on every mutation, destructive confirm surfacing the 409
// in-use list, copy feedback, keyboard + focus, 375px responsive.
import {
	Button,
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	EmptyState,
	ErrorState,
	MonoTag,
	PageContainer,
	Skeleton,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { formatRelativeTime } from "@/lib/utils/format";
import { useState } from "react";
import { keyInUseDetails, useDeleteSshKey, useOrgSshKeys } from "../hooks";
import type { WorkspaceSshKeyView } from "../types";
import { ConfirmDialog } from "@/features/orgs/components/confirm-dialog";
import { PrivateKeyCreateSlideOver } from "./private-key-create-slideover";

function CopyButton({ value }: { value: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<Button
			variant="ghost"
			size="sm"
			icon={copied ? "check" : "link"}
			onClick={() => {
				void navigator.clipboard?.writeText(value).then(() => {
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				});
			}}
		>
			{copied ? "Copied" : "Copy public key"}
		</Button>
	);
}

function PrivateKeyCard({
	sshKey,
	onDelete,
}: {
	sshKey: WorkspaceSshKeyView;
	onDelete: (key: WorkspaceSshKeyView) => void;
}) {
	return (
		<div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex min-w-0 items-center gap-2">
					<span className="truncate font-semibold text-fg">{sshKey.name}</span>
					{sshKey.fingerprint && <MonoTag>{sshKey.fingerprint}</MonoTag>}
				</div>
				<Button variant="ghost" size="sm" icon="trash" onClick={() => onDelete(sshKey)}>
					Delete
				</Button>
			</div>
			{sshKey.note && <p className="fg-body-sm text-subtle">{sshKey.note}</p>}
			<div className="flex items-center justify-between gap-2">
				<code className="min-w-0 flex-1 truncate font-mono text-[12px] text-subtle">
					{sshKey.publicKey}
				</code>
				<CopyButton value={sshKey.publicKey} />
			</div>
			<div className="flex flex-wrap items-center justify-between gap-2 text-subtle">
				<span className="fg-caption">
					{sshKey.source === "forge_generated" ? "Forge-generated" : "User-provided"}
					{" · "}
					{formatRelativeTime(sshKey.createdAt)}
				</span>
				<span className="fg-caption">
					{sshKey.usedByProjects.length === 0
						? "Not used by any project"
						: `Used by ${sshKey.usedByProjects.map((p) => p.name).join(", ")}`}
				</span>
			</div>
		</div>
	);
}

export function PrivateKeysScreen({ orgId }: { orgId: string | null }) {
	const keys = useOrgSshKeys(orgId);
	const del = useDeleteSshKey(orgId ?? "");
	const [createOpen, setCreateOpen] = useState(false);
	const [deleteTarget, setDeleteTarget] = useState<WorkspaceSshKeyView | null>(null);
	const [inUseError, setInUseError] = useState<ReturnType<typeof keyInUseDetails>>(null);

	function closeDelete() {
		setDeleteTarget(null);
		setInUseError(null);
	}

	function confirmDelete() {
		if (!deleteTarget) return;
		setInUseError(null);
		del.mutate(deleteTarget.id, {
			onSuccess: closeDelete,
			onError: (err) => {
				const details = keyInUseDetails(err);
				if (details) setInUseError(details);
				else closeDelete();
			},
		});
	}

	const rows = keys.data ?? [];

	const body = (
		<>
			<div className="flex items-center justify-between gap-3">
				<div>
					<h1 className="fg-h2">Private keys</h1>
					<p className="fg-body-sm text-muted">
						SSH deploy keys shared across every project in this organization — create one and
						reuse it, instead of a key per project.
					</p>
				</div>
				<Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)} disabled={!orgId}>
					Create key
				</Button>
			</div>

			<Card>
				<CardHeader>
					<CardTitle>Pool</CardTitle>
				</CardHeader>
				<CardContent>
					{keys.isLoading ? (
						<div className="flex flex-col gap-2">
							<Skeleton className="h-20 w-full" />
							<Skeleton className="h-20 w-full" />
						</div>
					) : keys.isError ? (
						<ErrorState message={formatApiError(keys.error)} onRetry={() => keys.refetch()} />
					) : rows.length === 0 ? (
						<EmptyState
							title="No private keys yet"
							message="Create one to connect your projects to Git."
							action={{ label: "Create key", onClick: () => setCreateOpen(true) }}
						/>
					) : (
						<div className="flex flex-col gap-3">
							{rows.map((k) => (
								<PrivateKeyCard key={k.id} sshKey={k} onDelete={setDeleteTarget} />
							))}
						</div>
					)}
				</CardContent>
			</Card>
		</>
	);

	return (
		<PageContainer className="flex flex-col gap-5">
			{body}

			{orgId && (
				<PrivateKeyCreateSlideOver
					open={createOpen}
					onClose={() => setCreateOpen(false)}
					orgId={orgId}
				/>
			)}

			<ConfirmDialog
				open={deleteTarget !== null}
				title={`Delete "${deleteTarget?.name ?? ""}"?`}
				message={
					inUseError ? (
						<span className="flex flex-col gap-2">
							<span>
								This key is in use by {inUseError.referencedBy.length} project
								{inUseError.referencedBy.length === 1 ? "" : "s"} and can&apos;t be deleted:
							</span>
							<span className="flex flex-col gap-1">
								{inUseError.referencedBy.map((p) => (
									<span key={p.id} className="fg-body-sm font-semibold text-fg">
										{p.name}
									</span>
								))}
							</span>
							<span className="fg-body-sm text-subtle">
								Detach it from those projects first (Project Settings → Runners → Git access).
							</span>
						</span>
					) : (
						"This permanently deletes the key from the pool. Any project still using it must detach first."
					)
				}
				confirmLabel={inUseError ? "OK" : "Delete key"}
				tone={inUseError ? "default" : "danger"}
				loading={del.isPending}
				onConfirm={inUseError ? closeDelete : confirmDelete}
				onClose={closeDelete}
			/>
		</PageContainer>
	);
}
