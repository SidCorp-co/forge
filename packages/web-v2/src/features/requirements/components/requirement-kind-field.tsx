"use client";

// What a requirement is, set or corrected on its page by a project.write holder (REQ-35 BC-2;
// Requirement lifecycle r14 edge `kind.corrected`). Core keeps a drawn picture only while it fits the
// kind (`picture.ts:writeKind`) and nothing brings a dropped one back, so a change that would drop
// one asks first, naming the picture and who drew it, and sends nothing until the person agrees. The
// field is held while the picture editor is open, so what was typed there is never lost to it, and a
// refusal of the kind, from this write or from a picture write, shows on it in plain words.

import { PICTURE_KIND_OF, type RequirementKind, type RequirementPictureView } from "@forge/contracts/requirement-pictures";
import { useState } from "react";
import { ConfirmDialog, Field, NativeSelect } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { namedRefusals } from "@/lib/api/refusals";
import { useCopy } from "@/lib/i18n/interface-language";
import { useWriteRequirementKind } from "../hooks";

export const KINDS = ["process", "rule", "screen", "report"] as const satisfies readonly RequirementKind[];

/** A failed write in plain words: the first refusal core named, without its code; else what the failure says. */
export function plainRefusal(err: unknown): string | undefined {
  if (!err) return undefined;
  return namedRefusals(err)[0]?.detail ?? formatApiError(err);
}

/** Whether core drops `picture` when the kind becomes `next`, as `picture.ts:writeKind` decides it. */
export const dropsPicture = (picture: RequirementPictureView | null, next: RequirementKind | null): boolean =>
  picture !== null && (next === null || PICTURE_KIND_OF[next] !== picture.kind);

export function KindField({
  projectId,
  reqKey,
  revision,
  kind,
  picture,
  held,
  refused,
}: {
  projectId: string;
  reqKey: string;
  revision: number;
  kind: RequirementKind | null;
  picture: RequirementPictureView | null;
  /** The picture editor is open: the kind waits until it is saved or cancelled. */
  held: boolean;
  /** A picture write refused for not fitting the kind, in core's words. */
  refused: string | undefined;
}) {
  const t = useCopy();
  const write = useWriteRequirementKind(projectId, reqKey);
  // undefined: nothing asked; null: clearing the kind
  const [asked, setAsked] = useState<RequirementKind | null | undefined>(undefined);
  const send = (next: RequirementKind | null) => write.mutate({ revision, kind: next }, { onSettled: () => setAsked(undefined) });
  const kindName = (k: RequirementKind) => t(`requirements.picture.kind.${k}`).toLowerCase();

  return (
    <div className="w-[220px]">
      <Field label={t("requirements.picture.edit.kind")} hint={held ? t("requirements.picture.edit.kindHeld") : undefined} error={plainRefusal(write.error) ?? refused}>
        <NativeSelect
          value={kind ?? ""}
          disabled={write.isPending || held}
          onChange={(e) => {
            const next = KINDS.find((k) => k === e.target.value) ?? null;
            if (next === kind) return;
            if (dropsPicture(picture, next)) setAsked(next);
            else send(next);
          }}
          options={[{ value: "", label: t("requirements.picture.edit.kindNone") }, ...KINDS.map((k) => ({ value: k, label: t(`requirements.picture.kind.${k}`) }))]}
        />
      </Field>
      {picture ? (
        <ConfirmDialog
          open={asked !== undefined}
          title={asked ? t("requirements.picture.kindChange.title", { kind: kindName(asked) }) : t("requirements.picture.kindChange.titleNone")}
          message={t("requirements.picture.kindChange.message", {
            picture: t(`requirements.picture.of.${picture.kind}`),
            who: picture.writtenByName ?? t("standing.who.itsAuthor"),
          })}
          confirmLabel={t("requirements.picture.kindChange.confirm")}
          tone="danger"
          loading={write.isPending}
          onConfirm={() => send(asked ?? null)}
          onClose={() => setAsked(undefined)}
        />
      ) : null}
    </div>
  );
}
