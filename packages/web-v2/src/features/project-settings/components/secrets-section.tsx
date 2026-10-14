// Writing a secret's value: write-only, as core holds it. Replacing the value of a secret an account
// already names (scope and name fixed by that account), and storing any other secret by scope and name.
// No value is ever read back; the field empties once the write settles.
import { useState } from "react";
import { Banner, Button, Field, Input } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useWriteSecret } from "@/features/project-config";
import { useCopy } from "@/lib/i18n/interface-language";
import { NAME } from "../secret-refs";

/** A new value for one secret an account names: one password field, save and cancel. */
export function ReplaceSecret({ projectId, scope, name, onDone }: { projectId: string; scope: string; name: string; onDone: () => void }) {
	const t = useCopy();
	const write = useWriteSecret(projectId);
	const [value, setValue] = useState("");
	return (
		<div className="flex flex-wrap items-end gap-2 py-1">
			<div className="w-64 max-w-full">
				<Field label={t("settings.project.testing.newValue")}>
					<Input type="password" autoComplete="new-password" value={value} onChange={(e) => setValue(e.target.value)} />
				</Field>
			</div>
			<Button
				variant="primary"
				disabled={value === "" || write.isPending}
				loading={write.isPending}
				onClick={() => write.mutate({ scope, name, value }, { onSettled: () => setValue(""), onSuccess: onDone })}
				className="min-h-11"
			>
				{t("settings.project.testing.saveValue")}
			</Button>
			<Button variant="ghost" onClick={onDone} className="min-h-11">
				{t("common.cancel")}
			</Button>
			{write.isError && <Banner tone="danger">{t("settings.project.raw.writeFailed", { error: formatApiError(write.error) })}</Banner>}
		</div>
	);
}

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
				{t("settings.project.raw.secretStore")} <code translate="no">secret://{target.scope || "…"}/{target.name || "…"}</code>
			</Button>
		</div>
	);
}
