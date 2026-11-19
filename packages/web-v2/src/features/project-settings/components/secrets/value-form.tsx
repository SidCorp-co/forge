// A secret's value given in one step, in a form fit for its shape (ISS-1348): one masked box for a
// single value, labelled boxes for a structured one (written as one JSON object, so nobody types
// JSON), and a file picker for a file, read as text in the browser. The value leaves only on Save,
// to the slot's own door, and the boxes empty once it is kept.
import type { SecretForm, SecretShapeField } from "@forge/contracts/secret-slots";
import { useState } from "react";
import { Banner, Button, Field, focusOnMount, Input } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";

/** The fields' values as the one JSON object the slot holds, in the fields' order. */
export function fieldsValue(fields: readonly SecretShapeField[], values: Record<string, string>): string {
	return JSON.stringify(Object.fromEntries(fields.map((f) => [f.key, values[f.key]?.trim() ?? ""])));
}

const PORT = /port$/i;

export function ValueForm({
	form,
	focus = false,
	saving,
	error,
	onSave,
	onCancel,
	testId,
}: {
	form: SecretForm;
	/** A link landed here: the first box takes the focus. */
	focus?: boolean;
	saving: boolean;
	error: unknown;
	onSave: (value: string) => void;
	onCancel?: () => void;
	testId?: string;
}) {
	const t = useCopy();
	const [value, setValue] = useState("");
	const [fields, setFields] = useState<Record<string, string>>({});
	const [file, setFile] = useState<{ name: string; text: string } | null>(null);
	const first = focus ? focusOnMount : undefined;
	const ready =
		form.kind === "value"
			? value !== ""
			: form.kind === "file"
				? file !== null && file.text !== ""
				: form.fields.every((f) => (fields[f.key] ?? "").trim() !== "");
	const save = () => {
		const given = form.kind === "value" ? value : form.kind === "file" ? (file?.text ?? "") : fieldsValue(form.fields, fields);
		onSave(given);
	};
	return (
		<div className="mt-3 space-y-3" data-testid={testId}>
			{form.kind === "value" ? (
				<div className="max-w-md">
					<Field label={t("settings.project.secrets.value")}>
						<Input ref={first} type="password" autoComplete="new-password" value={value} onChange={(e) => setValue(e.target.value)} />
					</Field>
				</div>
			) : form.kind === "file" ? (
				<div className="flex max-w-md flex-col gap-1.5">
					<span className="fg-label">{t("settings.project.secrets.file")}</span>
					<input
						ref={first}
						type="file"
						aria-label={t("settings.project.secrets.file")}
						className="fg-body-sm block w-full rounded-md border border-dashed border-line px-3 py-2 file:mr-3 file:rounded-md file:border file:border-line file:bg-surface file:px-3 file:py-1 file:text-13"
						onChange={(e) => {
							const picked = e.target.files?.[0];
							if (!picked) return setFile(null);
							void picked.text().then((text) => setFile({ name: picked.name, text }));
						}}
					/>
				</div>
			) : (
				<div className="grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
					{form.fields.map((f, i) => (
						<Field key={f.key} label={f.label}>
							<Input
								ref={i === 0 ? first : undefined}
								type={f.secret ? "password" : "text"}
								inputMode={PORT.test(f.key) ? "numeric" : undefined}
								autoComplete={f.secret ? "new-password" : "off"}
								placeholder={f.example}
								value={fields[f.key] ?? ""}
								onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })}
							/>
						</Field>
					))}
				</div>
			)}
			{error ? <Banner tone="danger">{formatApiError(error)}</Banner> : null}
			<div className="flex flex-wrap gap-2">
				<Button variant="primary" disabled={!ready || saving} loading={saving} onClick={save} className="min-h-11 max-sm:flex-1">
					{t("settings.project.secrets.save")}
				</Button>
				{onCancel ? (
					<Button variant="ghost" onClick={onCancel} className="min-h-11">
						{t("common.cancel")}
					</Button>
				) : null}
			</div>
		</div>
	);
}
