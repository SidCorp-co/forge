// Settings → Secrets (ISS-1348, owner 2026-11-19): the one place a person gives a secret. What agents
// asked for comes first, each request with who asked, when, why and the value's shape, filled in one
// step; below it every secret the project holds, grouped by what uses it. A room agent's link names a
// request (`?ask=<id>`): the page lands on it, scrolled into view, focused and highlighted, and a
// request whose slot already holds a value says so, with nothing to do. A link written for the old
// Testing rows (`?tab=testing&profile=&actor|service=`, ISS-1328) lands on that account's row here.
import type { SecretSlotsRead } from "@forge/contracts/secret-slots";
import { useEffect, useMemo, useRef, useState } from "react";
import { CONTENTS_LABEL, Disclosure, ErrorState, Skeleton } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { useSecretSlots } from "../../secret-slots";
import { SecretForm } from "../secrets-section";
import { RequestBlock } from "./request-block";
import { SlotGroups } from "./slot-groups";

/** What a link names: a request, or an account of a testing profile (an old Testing link). */
export interface Landing {
	ask: string | null;
	testing: { profile: string; actor?: string; service?: string } | null;
}

export function landingOf(search: string): Landing {
	const q = new URLSearchParams(search);
	const profile = q.get("profile");
	const actor = q.get("actor");
	const service = q.get("service");
	return {
		ask: q.get("ask"),
		testing: profile && (actor === null) !== (service === null) ? { profile, ...(actor !== null ? { actor } : { service: service ?? "" }) } : null,
	};
}

/** The element a link lands on: its request's, else its slot's row; null where it names neither. */
export function landedOn(read: SecretSlotsRead, landing: Landing): { request: string | null; slot: string | null } {
	const slots = read.groups.flatMap((g) => g.slots);
	const t = landing.testing;
	const slot = t
		? slots.find((s) => s.ref?.kind === "testing" && s.ref.profile === t.profile && s.ref.actor === t.actor && s.ref.service === t.service)
		: undefined;
	const request = read.requests.find((r) => (landing.ask ? r.askIds.includes(landing.ask) : slot ? r.slot.anchor === slot.anchor : false));
	if (request) return { request: request.id, slot: null };
	return { request: null, slot: slot?.anchor ?? null };
}

export function SecretsSettings({ projectId, canWrite, canEdit }: { projectId: string; canWrite: boolean; canEdit: boolean }) {
	const t = useCopy();
	const q = useSecretSlots(projectId);
	const [landing] = useState(() => landingOf(window.location.search));
	const read = q.data;
	const landed = useMemo(() => (read ? landedOn(read, landing) : null), [read, landing]);
	useLanding(landed);
	if (q.isLoading) return <Skeleton className="h-64 w-full rounded-md" />;
	if (!read) return <ErrorState message={formatApiError(q.error)} onRetry={() => void q.refetch()} />;
	const waiting = read.requests.filter((r) => r.filled === null && r.slot.held === null);
	const requested = new Set(waiting.map((r) => r.slot.anchor));
	return (
		<div>
			<section id="requests" aria-label={t("settings.project.secrets.requests")} className="scroll-mt-24 pb-8" {...{ [CONTENTS_LABEL]: t("settings.project.secrets.requests") }}>
				<h3 className="fg-h3 mb-2 flex items-baseline gap-2.5">
					{t("settings.project.secrets.requests")}
					<span className="fg-body-sm font-medium text-subtle">
						{waiting.length > 0 ? t("settings.project.secrets.waiting", { count: waiting.length }) : t("settings.project.secrets.none")}
					</span>
				</h3>
				{read.requests.map((r) => (
					<RequestBlock key={r.id} projectId={projectId} request={r} linked={landed?.request === r.id} canWrite={canWrite} />
				))}
			</section>
			<section aria-label={t("settings.project.secrets.all")} className="border-t border-line pt-6">
				<h3 className="fg-h3 mb-4">{t("settings.project.secrets.all")}</h3>
				<SlotGroups projectId={projectId} groups={read.groups} requested={requested} linked={landed?.slot ?? null} canWrite={canWrite} />
				{canEdit ? (
					<div className="mt-6">
						<Disclosure title={t("settings.project.testing.storeAnother")}>
							<SecretForm projectId={projectId} />
						</Disclosure>
					</div>
				) : null}
			</section>
		</div>
	);
}

/** Once the page has drawn, the place a link names is brought into the middle of the window and focused. */
function useLanding(landed: { request: string | null; slot: string | null } | null) {
	const doneRef = useRef(false);
	useEffect(() => {
		if (doneRef.current || !landed) return;
		const id = landed.request ? `request-${landed.request}` : landed.slot;
		if (!id) return;
		// marked in the frame, so an effect run twice (and its frame cancelled once) still lands
		const frame = requestAnimationFrame(() => {
			doneRef.current = true;
			const el = document.getElementById(id);
			el?.scrollIntoView?.({ block: "center" });
			// a form's first box already holds the focus where the request waits; otherwise the place itself
			if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
		});
		return () => cancelAnimationFrame(frame);
	}, [landed]);
}
