"use client";

import { useState } from "react";
import { Badge, Banner, Button, PageSectionTitle, Field, Input, Table, TBody, TD, TH, THead, TR } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useSecretNames, useTestingProfiles, useWriteSecret } from "@/features/project-config/hooks";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { NAME, type SecretStanding, secretUsesIn, standingOf } from "../secret-refs";

const STANDING: Record<SecretStanding, { tone: "green" | "red" | "amber"; text: ProductCopyKey }> = {
	stored: { tone: "green", text: "settings.project.raw.secretStored" },
	missing: { tone: "red", text: "settings.project.raw.secretMissing" },
	unread: { tone: "amber", text: "settings.project.raw.secretUnread" },
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
	const t = useCopy();
	const write = useWriteSecret(projectId);
	const [value, setValue] = useState("");
	const scopeError = target.scope === "" || NAME.test(target.scope) ? undefined : t("settings.project.raw.secretScopeRule");
	const nameError = target.name === "" || NAME.test(target.name) ? undefined : t("settings.project.raw.secretNameRule");
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
					<Field label={t("settings.project.raw.secretScope")} error={scopeError}>
						<Input value={target.scope} onChange={(e) => onTarget({ ...target, scope: e.target.value })} placeholder="forge-beta" />
					</Field>
				</div>
				<div className="w-48">
					<Field label={t("settings.project.raw.secretName")} error={nameError}>
						<Input value={target.name} onChange={(e) => onTarget({ ...target, name: e.target.value })} placeholder="admin-password" />
					</Field>
				</div>
				<div className="w-64">
					<Field label={t("settings.project.raw.secretValue")} hint={t("settings.project.raw.secretValueHint")}>
						<Input type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
					</Field>
				</div>
			</div>
			{write.isError && <Banner tone="danger">{t("settings.project.raw.nothingWritten", { error: formatApiError(write.error) })}</Banner>}
			<Button variant="primary" disabled={!ready || write.isPending} loading={write.isPending} onClick={save} className="min-h-11">
				{t("settings.project.raw.secretStore")} <code translate="no">secret://{target.scope || "…"}/{target.name || "…"}</code>
			</Button>
		</div>
	);
}

export function SecretsSection({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
	const t = useCopy();
	const secrets = useSecretNames(projectId);
	const profiles = useTestingProfiles(projectId);
	const [target, setTarget] = useState({ scope: "", name: "" });
	const stored = secrets.data ? new Set(secrets.data.secrets.map((s) => s.ref)) : null;
	const uses = (profiles.data?.profiles ?? []).flatMap((p) => secretUsesIn(p.profileId, p.document));

	return (
		<section aria-label={t("settings.project.raw.secrets")} className="mt-6 border-t border-line pt-5">
			<PageSectionTitle className="fg-label text-fg">{t("settings.project.raw.secrets")}</PageSectionTitle>
			<p className="fg-body-sm mt-1 mb-3 text-muted">{t("settings.project.raw.secretsLead")}</p>
			{secrets.isError && <Banner tone="danger">{t("settings.project.raw.secretsUnread", { error: formatApiError(secrets.error) })}</Banner>}
			{profiles.isError && <Banner tone="danger">{t("settings.project.raw.profilesUnread", { error: formatApiError(profiles.error) })}</Banner>}
			{uses.length > 0 && (
				<Table>
					<THead>
						<TR>
							<TH>{t("settings.project.raw.colReferenced")}</TH>
							<TH>{t("settings.project.raw.colBy")}</TH>
							<TH>{t("settings.project.raw.secretValue")}</TH>
						</TR>
					</THead>
					<TBody>
						{uses.map((u) => {
							const standing = secrets.isLoading ? null : standingOf(u.ref, stored);
							return (
								<TR key={`${u.profileId}:${u.path}`}>
									<TD>
										<code translate="no">{u.ref}</code>
									</TD>
									<TD>
										{u.profileId} <code translate="no">{u.path}</code>
									</TD>
									<TD>
										{standing === null ? (
											t("settings.project.raw.reading")
										) : (
											<span className="inline-flex items-center gap-2">
												<Badge tone={STANDING[standing].tone}>{t(STANDING[standing].text)}</Badge>
												{canEdit && standing === "missing" && (
													<Button variant="ghost" size="sm" onClick={() => setTarget({ scope: u.scope, name: u.name })}>
														{t("settings.project.raw.secretSet")}
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
						? t("settings.project.raw.noSecrets")
						: t("settings.project.raw.storedSecrets", { refs: secrets.data.secrets.map((s) => s.ref).join(", ") })}
				</p>
			)}
			{canEdit && <SecretForm projectId={projectId} target={target} onTarget={setTarget} />}
		</section>
	);
}
