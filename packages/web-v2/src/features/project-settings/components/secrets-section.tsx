// Storing a secret by scope and name, beside the ones the Secrets section lists (ISS-1348): write-only,
// as core holds it. No value is ever read back; the field empties once the write settles.
import { useState } from "react";
import { Banner, Button, Field, Input } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useWriteSecret } from "@/features/project-config";
import { useCopy } from "@/lib/i18n/interface-language";
import { NAME } from "../secret-refs";

/** Any secret by scope and name, for an account or service not written yet. */
export function SecretForm({ projectId }: { projectId: string }) {
	const t = useCopy();
	const write = useWriteSecret(projectId);
	const [target, setTarget] = useState({ scope: "", name: "" });
	const [value, setValue] = useState("");
	const scopeError = target.scope === "" || NAME.test(target.scope) ? undefined : t("settings.project.raw.secretScopeRule");
	const nameError = target.name === "" || NAME.test(target.name) ? undefined : t("settings.project.raw.secretNameRule");
	const ready = target.scope !== "" && target.name !== "" && value !== "" && !scopeError && !nameError;
	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-start gap-3">
				<div className="w-48 max-w-full">
					<Field label={t("settings.project.raw.secretScope")} error={scopeError}>
						<Input value={target.scope} onChange={(e) => setTarget({ ...target, scope: e.target.value })} placeholder="forge-beta" />
					</Field>
				</div>
				<div className="w-48 max-w-full">
					<Field label={t("settings.project.raw.secretName")} error={nameError}>
						<Input value={target.name} onChange={(e) => setTarget({ ...target, name: e.target.value })} placeholder="admin-password" />
					</Field>
				</div>
				<div className="w-64 max-w-full">
					<Field label={t("settings.project.raw.secretValue")}>
						<Input type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
					</Field>
				</div>
			</div>
			{write.isError && <Banner tone="danger">{t("settings.project.raw.writeFailed", { error: formatApiError(write.error) })}</Banner>}
			<Button
				variant="primary"
				disabled={!ready || write.isPending}
				loading={write.isPending}
				onClick={() => write.mutate({ scope: target.scope, name: target.name, value }, { onSettled: () => setValue("") })}
				className="min-h-11"
			>
				{t("settings.project.raw.secretStore")}
			</Button>
		</div>
	);
}
