// One request an agent made for a secret (ISS-1348): what it is in plain words, where it is used,
// who asked and when, why, and the value's shape with an example; then the form fit for that shape
// and, for a value that sits in a file, a one-time command to copy. Once its slot holds a value it
// reads "Has a value", when and by whom, and that nothing is to do, with Replace beside it. The
// request a link names is drawn highlighted, and the page brings it into view and focuses it.
import type { SecretForm, SecretHeld, SecretRequestView, SecretSlotView } from "@forge/contracts/secret-slots";
import { useState } from "react";
import { Badge, Button, sentenceCase } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { useFillSlot, useMintWriteUrl } from "../../secret-slots";
import { ValueForm } from "./value-form";

/** Where a slot is used, as a badge: its environment (amber where it is production), a test account or a connection. */
export function UseBadge({ slot }: { slot: SecretSlotView }) {
	const t = useCopy();
	if (slot.environment) return <Badge tone={slot.tier === "production" ? "amber" : "neutral"}>{sentenceCase(slot.environment)}</Badge>;
	if (slot.ref?.kind === "variable") return <Badge>{t("settings.project.variables.allEnvironments")}</Badge>;
	if (slot.door.kind === "connection") return <Badge>{t("settings.project.secrets.connection")}</Badge>;
	return <Badge>{t("settings.project.secrets.testAccount")}</Badge>;
}

/** "Has a value", when, and by whom or through the command. */
export function HeldLine({ held }: { held: SecretHeld }) {
	const t = useCopy();
	const time = useTimeFormat();
	const who = held.by ? t("settings.project.secrets.byWhom", { name: held.by }) : held.via === "presigned" ? t("settings.project.secrets.byCommand") : null;
	return (
		<span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
			<span className="inline-flex items-center gap-1.5 font-semibold text-ok-11">
				<span aria-hidden className="size-2 rounded-full bg-ok-9" />
				{t("settings.project.secrets.hasValue")}
			</span>
			<span className="fg-body-sm text-muted" title={time.dateTime(held.at)}>
				{[time.relative(held.at), who].filter(Boolean).join(" · ")}
			</span>
		</span>
	);
}

function shapeSaid(t: ReturnType<typeof useCopy>, form: SecretForm): string {
	if (form.kind === "file") return t("settings.project.secrets.shapeFile");
	if (form.kind === "fields") return t("settings.project.secrets.shapeFields", { count: form.fields.length });
	return t("settings.project.secrets.shapeValue");
}

function TerminalCommand({ projectId, ask }: { projectId: string; ask: string }) {
	const t = useCopy();
	const mint = useMintWriteUrl(projectId);
	const [copied, setCopied] = useState(false);
	const minted = mint.data;
	return (
		<div className="mt-3">
			{minted ? (
				<div data-testid="secret-command">
					<div className="flex items-center gap-2 rounded-md bg-sunken px-3 py-2">
						<code translate="no" className="min-w-0 flex-1 break-all font-mono text-12">
							{minted.command.replace("<file holding the value>", "secret.txt")}
						</code>
						<Button
							variant="secondary"
							size="sm"
							onClick={() =>
								void navigator.clipboard?.writeText(minted.command.replace("<file holding the value>", "secret.txt")).then(() => setCopied(true))
							}
						>
							{copied ? t("settings.project.secrets.copied") : t("settings.project.secrets.copy")}
						</Button>
					</div>
					<p className="fg-caption mt-1 text-subtle">{t("settings.project.secrets.commandTerms", { minutes: minted.minutes })}</p>
				</div>
			) : (
				<Button variant="ghost" size="sm" loading={mint.isPending} onClick={() => mint.mutate(ask)} className="-ml-2 text-accent-text">
					{t("settings.project.secrets.terminal")}
				</Button>
			)}
			{mint.isError ? <p className="fg-caption mt-1 text-danger-11">{formatApiError(mint.error)}</p> : null}
		</div>
	);
}

export function RequestBlock({
	projectId,
	request,
	linked,
	canWrite,
}: {
	projectId: string;
	request: SecretRequestView;
	/** The request the page's link names: highlighted, scrolled to and focused. */
	linked: boolean;
	canWrite: boolean;
}) {
	const t = useCopy();
	const time = useTimeFormat();
	const fill = useFillSlot(projectId);
	const { slot } = request;
	const held = slot.held ?? request.filled;
	const [replacing, setReplacing] = useState(false);
	const open = canWrite && (held === null || replacing);
	return (
		<article
			id={`request-${request.id}`}
			aria-label={slot.label}
			aria-current={linked ? "true" : undefined}
			tabIndex={linked ? -1 : undefined}
			data-testid="secret-request"
			data-linked={linked ? "true" : undefined}
			className={`-mx-4 scroll-mt-24 border-t border-l-4 border-t-line px-4 py-4 outline-none ${linked ? "border-l-accent bg-accent-tint" : "border-l-transparent"}`}
		>
			<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
				<h4 className="fg-label text-15">{slot.label}</h4>
				<UseBadge slot={slot} />
				{linked ? <Badge tone="accent">{t("settings.project.secrets.fromLink")}</Badge> : null}
			</div>
			<p className="fg-body-sm mt-1 text-muted">
				{[
					t("settings.project.secrets.roomAgent"),
					request.askedFor ? t("settings.project.secrets.askedFor", { name: request.askedFor }) : null,
					time.relative(request.askedAt),
				]
					.filter(Boolean)
					.join(" · ")}{" "}
				· <span translate="no" className="font-mono text-12 text-subtle">{slot.detail}</span>
			</p>
			<p className="fg-body mt-2 border-l-2 border-line pl-2.5">{request.why}</p>
			{held && !replacing ? (
				<div className="mt-3 flex flex-wrap items-center gap-3" data-testid="secret-request-held">
					<HeldLine held={held} />
					<span className="rounded-md bg-ok-3 px-2.5 py-1 text-13 font-medium text-ok-11">{t("settings.project.secrets.nothingToDo")}</span>
					{canWrite ? (
						<Button variant="ghost" size="sm" onClick={() => setReplacing(true)}>
							{t("settings.project.secrets.replace")}
						</Button>
					) : null}
				</div>
			) : (
				<p className="fg-body-sm mt-2 text-muted">
					<span className="font-medium text-fg">{shapeSaid(t, slot.form)}</span>
					{request.example ? ` · ${t("settings.project.secrets.example", { example: request.example })}` : null}
				</p>
			)}
			{open ? (
				<ValueForm
					form={slot.form}
					focus={linked}
					saving={fill.isPending}
					error={fill.error}
					onCancel={replacing ? () => setReplacing(false) : undefined}
					onSave={(value) =>
						fill.mutate({ door: slot.door, value, form: slot.form, tier: slot.tier }, { onSuccess: () => setReplacing(false) })
					}
					testId="secret-request-form"
				/>
			) : null}
			{open && held === null ? <TerminalCommand projectId={projectId} ask={request.id} /> : null}
		</article>
	);
}
