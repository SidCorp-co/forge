// Adding a variable, or changing one (REQ-80 BC-2): key and scope are fixed once it exists; a value
// left blank on an edit keeps the stored one. Core refuses what the scope cannot hold (a protected
// variable on a non-production environment, a short secret) and the refusal is shown as it says it.
import { VARIABLE_KEY, type VariableType, type VariableView } from "@forge/contracts/variables";
import { useState } from "react";
import { Banner, Button, Checkbox, Field, focusOnMount, Input, NativeSelect, Textarea } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { useCreateVariable, useUpdateVariable } from "../variables";
import { TYPE_LABEL } from "./variable-labels";

const ALL = "";

/** The one variable a room agent's secret link names (ISS-1348): `?key=<KEY>&environment=<name | *>`. */
export interface AskedVariable {
	key: string;
	environment: string | null;
}

export function askedVariableOf(search: string): AskedVariable | null {
	const q = new URLSearchParams(search);
	const key = q.get("key");
	const environment = q.get("environment");
	if (!key || !VARIABLE_KEY.test(key) || environment === null || environment === "") return null;
	return { key, environment: environment === "*" ? null : environment };
}

export function VariableForm({
	projectId,
	environments,
	editing,
	asked = null,
	onDone,
}: {
	projectId: string;
	environments: { name: string; tier: string }[];
	editing: VariableView | null;
	/** A new variable a secret link opened: its key and scope filled, its value box focused. */
	asked?: AskedVariable | null;
	onDone: () => void;
}) {
	const t = useCopy();
	const create = useCreateVariable(projectId);
	const update = useUpdateVariable(projectId);
	const askedTier = environments.find((e) => e.name === asked?.environment)?.tier;
	const [key, setKey] = useState(editing?.key ?? asked?.key ?? "");
	const [environment, setEnvironment] = useState(editing?.environment ?? asked?.environment ?? ALL);
	const [type, setType] = useState<VariableType>(editing?.type ?? "secret");
	// a production value an agent asked for reaches production alone (REQ-80 BC-2)
	const [isProtected, setIsProtected] = useState(editing?.protected ?? askedTier === "production");
	const focus = asked !== null ? focusOnMount : undefined;
	const [value, setValue] = useState("");
	const write = editing ? update : create;
	const keyError = key === "" || VARIABLE_KEY.test(key) ? undefined : t("settings.project.variables.keyRule");
	const ready = key !== "" && !keyError && (editing !== null || value !== "");
	const submit = () => {
		if (editing) {
			update.mutate(
				{
					variable: editing.id,
					body: { baseVersion: editing.version, type, protected: isProtected, ...(value === "" ? {} : { value }) },
				},
				{ onSuccess: onDone },
			);
		} else {
			create.mutate({ key, value, environment: environment === ALL ? null : environment, type, protected: isProtected }, { onSuccess: onDone });
		}
	};
	return (
		<div className="mb-4 space-y-3 border-b border-line-subtle pb-4" data-testid="variable-form">
			<div className="flex flex-wrap items-start gap-3">
				<div className="w-64 max-w-full">
					<Field label={t("settings.project.variables.key")} error={keyError}>
						<Input value={key} disabled={editing !== null} onChange={(e) => setKey(e.target.value)} placeholder="DATABASE_URL" />
					</Field>
				</div>
				<div className="w-48 max-w-full">
					<Field label={t("settings.project.variables.environment")}>
						<NativeSelect
							value={environment}
							disabled={editing !== null}
							onChange={(e) => setEnvironment(e.target.value)}
							options={[
								{ value: ALL, label: t("settings.project.variables.allEnvironments") },
								...environments.map((e) => ({ value: e.name, label: `${e.name} (${e.tier})` })),
							]}
						/>
					</Field>
				</div>
				<div className="w-40 max-w-full">
					<Field label={t("settings.project.variables.type")}>
						<NativeSelect
							value={type}
							onChange={(e) => setType(e.target.value as VariableType)}
							options={(Object.keys(TYPE_LABEL) as VariableType[]).map((v) => ({ value: v, label: t(TYPE_LABEL[v]) }))}
						/>
					</Field>
				</div>
			</div>
			<Field label={editing ? t("settings.project.variables.newValue") : t("settings.project.variables.value")}>
				{type === "file" ? (
					<Textarea ref={focus} value={value} onChange={(e) => setValue(e.target.value)} rows={4} />
				) : (
					<Input ref={focus} type={type === "secret" ? "password" : "text"} autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
				)}
			</Field>
			<Checkbox checked={isProtected} onChange={setIsProtected} label={t("settings.project.variables.protectedLabel")} />
			{write.isError && <Banner tone="danger">{formatApiError(write.error)}</Banner>}
			<div className="flex gap-2">
				<Button variant="primary" disabled={!ready || write.isPending} loading={write.isPending} onClick={submit} className="min-h-11">
					{editing ? t("settings.project.variables.save") : t("settings.project.variables.add")}
				</Button>
				<Button variant="ghost" onClick={onDone} className="min-h-11">
					{t("common.cancel")}
				</Button>
			</div>
		</div>
	);
}
