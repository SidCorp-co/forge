"use client";

import { useState } from "react";
import { Badge, Banner, Button, PageSectionTitle, Field, Input, Table, TBody, TD, TH, THead, TR } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useSecretNames, useTestingProfiles, useWriteSecret } from "../../project-config/hooks";
import { NAME, type SecretStanding, secretUsesIn, standingOf } from "../secret-refs";


const STANDING: Record<SecretStanding, { tone: "green" | "red" | "amber"; text: string }> = {
	stored: { tone: "green", text: "value stored" },
	missing: { tone: "red", text: "missing — no value stored" },
	unread: { tone: "amber", text: "could not be read" },
};

function SecretForm({
	projectId,
	target,
	onTarget,
}: {
	projectId: string;
	target: { scope: string; name: string };
	onTarget: (t: { scope: string; name: string }) => void;
}) {
	const write = useWriteSecret(projectId);
	const [value, setValue] = useState("");
	const scopeError = target.scope === "" || NAME.test(target.scope) ? undefined : "A scope matches ^[a-z][a-z0-9-]{0,62}$.";
	const nameError = target.name === "" || NAME.test(target.name) ? undefined : "A name matches ^[a-z][a-z0-9-]{0,62}$.";
	const ready = target.scope !== "" && target.name !== "" && value !== "" && !scopeError && !nameError;
	function save() {
		write.mutate(
			{ scope: target.scope, name: target.name, value },
			{ onSettled: () => setValue("") },
		);
	}
	return (
		<div className="mt-4 space-y-3">
			<div className="flex flex-wrap items-start gap-3">
				<div className="w-48">
					<Field label="Scope" error={scopeError}>
						<Input value={target.scope} onChange={(e) => onTarget({ ...target, scope: e.target.value })} placeholder="forge-beta" />
					</Field>
				</div>
				<div className="w-48">
					<Field label="Name" error={nameError}>
						<Input value={target.name} onChange={(e) => onTarget({ ...target, name: e.target.value })} placeholder="admin-password" />
					</Field>
				</div>
				<div className="w-64">
					<Field label="Value" hint="Written once and never shown again, here or anywhere.">
						<Input type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
					</Field>
				</div>
			</div>
			{write.isError && <Banner tone="danger">Nothing was written: {formatApiError(write.error)}</Banner>}
			<Button variant="primary" disabled={!ready || write.isPending} loading={write.isPending} onClick={save} className="min-h-11">
				Store value for secret://{target.scope || "<scope>"}/{target.name || "<name>"}
			</Button>
		</div>
	);
}

export function SecretsSection({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
	const secrets = useSecretNames(projectId);
	const profiles = useTestingProfiles(projectId);
	const [target, setTarget] = useState({ scope: "", name: "" });
	const stored = secrets.data ? new Set(secrets.data.secrets.map((s) => s.ref)) : null;
	const uses = (profiles.data?.profiles ?? []).flatMap((p) => secretUsesIn(p.profileId, p.document));

	return (
		<section aria-label="Secrets" className="mt-6 border-t border-line pt-5">
			<PageSectionTitle className="fg-label text-fg">Secrets</PageSectionTitle>
			<p className="fg-body-sm mt-1 mb-3 text-muted">
				Values a testing profile names as <code>secret://scope/name</code>. Only the names are listed; a value is
				written here and never read back.
			</p>
			{secrets.isError && (
				<Banner tone="danger">The stored secret names could not be read: {formatApiError(secrets.error)}</Banner>
			)}
			{profiles.isError && (
				<Banner tone="danger">The testing profiles could not be read, so their references are not checked: {formatApiError(profiles.error)}</Banner>
			)}
			{uses.length > 0 && (
				<Table>
					<THead>
						<TR>
							<TH>Referenced</TH>
							<TH>By</TH>
							<TH>Value</TH>
						</TR>
					</THead>
					<TBody>
						{uses.map((u) => {
							const standing = secrets.isLoading ? null : standingOf(u.ref, stored);
							return (
								<TR key={`${u.profileId}:${u.path}`}>
									<TD><code>{u.ref}</code></TD>
									<TD>
										{u.profileId} <code>{u.path}</code>
									</TD>
									<TD>
										{standing === null ? (
											"reading…"
										) : (
											<span className="inline-flex items-center gap-2">
												<Badge tone={STANDING[standing].tone}>{STANDING[standing].text}</Badge>
												{canEdit && standing === "missing" && (
													<Button variant="ghost" size="sm" onClick={() => setTarget({ scope: u.scope, name: u.name })}>
														Set value
													</Button>
												)}
											</span>
										)}
									</TD>
								</TR>
							);
						})}
					</TBody>
				</Table>
			)}
			{secrets.data && (
				<p className="fg-caption mt-3 text-subtle">
					{secrets.data.secrets.length === 0
						? "No secret value is stored for this project."
						: `Stored: ${secrets.data.secrets.map((s) => s.ref).join(", ")}.`}
				</p>
			)}
			{canEdit && <SecretForm projectId={projectId} target={target} onTarget={setTarget} />}
		</section>
	);
}
