// Every secret the project holds, grouped by what uses it (ISS-1348): the app per environment, each
// testing profile's accounts, the connections it binds, and any other stored secret. A row is the
// secret in plain words with its key as secondary text, whether it holds a value (when, by whom), and
// Set or Replace, which opens the same one-step form a request has. A row a link names is highlighted.
import type { SecretSlotGroup, SecretSlotView } from "@forge/contracts/secret-slots";
import { useState } from "react";
import { Button, CONTENTS_LABEL, sentenceCase } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { useFillSlot } from "../../secret-slots";
import { HeldLine } from "./request-block";
import { ValueForm } from "./value-form";

type Copy = ReturnType<typeof useCopy>;

/** A group's heading in plain words: no profile id where an environment names it. */
export function groupTitle(t: Copy, g: SecretSlotGroup): string {
	if (g.kind === "app") return t("settings.project.secrets.groupApp", { environment: g.name ? sentenceCase(g.name) : t("settings.project.variables.allEnvironments") });
	if (g.kind === "testing")
		return g.usedIn.length > 0
			? t("settings.project.secrets.groupTesting", { environment: g.usedIn.map(sentenceCase).join(", ") })
			: t("settings.project.testing.title");
	if (g.kind === "connections") return t("settings.project.secrets.groupConnections");
	return t("settings.project.testing.otherSecrets");
}

function SecretSlot({
	projectId,
	slot,
	requested,
	linked,
	canWrite,
}: {
	projectId: string;
	slot: SecretSlotView;
	requested: boolean;
	linked: boolean;
	canWrite: boolean;
}) {
	const t = useCopy();
	const fill = useFillSlot(projectId);
	const [open, setOpen] = useState(linked && slot.held === null && canWrite);
	return (
		<li
			id={slot.anchor}
			data-testid="secret-slot"
			data-linked={linked ? "true" : undefined}
			tabIndex={linked ? -1 : undefined}
			className={`scroll-mt-24 border-b border-line-subtle py-2.5 outline-none ${linked ? "-mx-4 bg-accent-tint px-4" : ""}`}
		>
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
				<div className="min-w-0 flex-1 basis-48">
					<div className="fg-body text-fg">{slot.label}</div>
					<div translate="no" className="truncate font-mono text-12 text-subtle">
						{slot.detail}
					</div>
				</div>
				{slot.held ? (
					<HeldLine held={slot.held} />
				) : (
					<span className="inline-flex items-center gap-1.5 font-semibold text-warn-11">
						<span aria-hidden className="size-2 rounded-full border-2 border-warn-11" />
						{t("settings.project.secrets.missing")}
						{requested ? <span className="fg-body-sm font-normal text-muted">· {t("settings.project.secrets.requested")}</span> : null}
					</span>
				)}
				{canWrite && !open ? (
					<Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
						{slot.held ? t("settings.project.secrets.replace") : t("settings.project.secrets.set")}
					</Button>
				) : null}
			</div>
			{open ? (
				<ValueForm
					form={slot.form}
					focus
					saving={fill.isPending}
					error={fill.error}
					onCancel={() => setOpen(false)}
					onSave={(value) => fill.mutate({ door: slot.door, value, form: slot.form, tier: slot.tier }, { onSuccess: () => setOpen(false) })}
				/>
			) : null}
		</li>
	);
}

export function SlotGroups({
	projectId,
	groups,
	requested,
	linked,
	canWrite,
}: {
	projectId: string;
	groups: SecretSlotGroup[];
	/** The anchors of slots a request waits on. */
	requested: ReadonlySet<string>;
	/** The anchor of the slot an old Testing link names, if any. */
	linked: string | null;
	canWrite: boolean;
}) {
	const t = useCopy();
	return (
		<div className="space-y-6">
			{groups.map((g) => (
				<section key={g.anchor} id={g.anchor} aria-label={groupTitle(t, g)} className="scroll-mt-24" {...{ [CONTENTS_LABEL]: groupTitle(t, g) }}>
					<h4 className="fg-label mb-1 text-muted">{groupTitle(t, g)}</h4>
					<ul className="border-t border-line">
						{g.slots.map((s) => (
							<SecretSlot key={s.anchor} projectId={projectId} slot={s} requested={requested.has(s.anchor)} linked={linked === s.anchor} canWrite={canWrite} />
						))}
					</ul>
				</section>
			))}
		</div>
	);
}
