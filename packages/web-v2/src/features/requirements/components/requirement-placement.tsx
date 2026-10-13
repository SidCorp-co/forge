
// Where requirements are placed (REQ-29): the project's list of areas, edited where the list is read,
// and the assistant's proposed area and short name, taken by a person. Nothing here fills a field alone.

import type { RequirementAreaRef, RequirementSummary } from "@forge/contracts/requirements";
import { useState } from "react";
import { Button, Fact, Select, Textarea } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { useAcceptAllPlacements, usePlacement, useProposePlacements, useRequirementAreas, useSetAreas } from "../hooks";

/** One row: how many requirements wait on a proposed placement, take them all, or ask for proposals. */
export function PlacementBanner({ projectId, rows, hasAreas }: { projectId: string; rows: RequirementSummary[]; hasAreas: boolean }) {
  const t = useCopy();
  const accept = useAcceptAllPlacements(projectId);
  const ask = useProposePlacements(projectId);
  const waiting = rows.filter((r) => r.placementProposal);
  const unplaced = rows.filter((r) => (!r.area || !r.shortName) && !r.placementProposal).length;
  if (waiting.length === 0 && unplaced === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2.5 border-b border-line-subtle px-5 py-2.5 text-13 text-muted max-md:px-3" data-testid="placement-banner">
      {waiting.length > 0 ? (
        <>
          <span>{t("requirements.placement.waiting", { n: waiting.length })}</span>
          <Button type="button" size="sm" variant="primary" loading={accept.isPending} onClick={() => accept.mutate(waiting.map((r) => r.key))}>
            {t("requirements.placement.acceptAll")}
          </Button>
        </>
      ) : null}
      {unplaced > 0 && hasAreas ? (
        <>
          <span>{t("requirements.placement.unplaced", { n: unplaced })}</span>
          <Button type="button" size="sm" loading={ask.isPending} disabled={ask.isSuccess} onClick={() => ask.mutate()}>
            {ask.isSuccess ? t("requirements.placement.asked") : t("requirements.placement.ask")}
          </Button>
        </>
      ) : null}
      <RefusalLine error={accept.error ?? ask.error} />
    </div>
  );
}

/** The project's areas as one per line, saved whole. */
export function AreasEditor({ projectId, areas }: { projectId: string; areas: RequirementAreaRef[] }) {
  const t = useCopy();
  const set = useSetAreas(projectId);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  if (!open) {
    return (
      <Button type="button" size="sm" variant="ghost" onClick={() => { setText(areas.map((a) => a.name).join("\n")); setOpen(true); }}>
        {t("requirements.areas.edit")}
      </Button>
    );
  }
  return (
    <form
      className="grid basis-full gap-2 pt-1"
      onSubmit={(e) => {
        e.preventDefault();
        set.mutate(text.split("\n").map((l) => l.trim()).filter(Boolean), { onSuccess: () => setOpen(false) });
      }}
    >
      <Textarea aria-label={t("requirements.areas.label")} placeholder={t("requirements.areas.label")} rows={7} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" variant="primary" loading={set.isPending}>
          {t("requirements.areas.save")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          {t("requirements.draft.cancel")}
        </Button>
      </div>
      <RefusalLine error={set.error} />
    </form>
  );
}

/** One requirement's area and short name: change them, or take the assistant's proposal beside them. */
export function Placement({ projectId, d }: { projectId: string; d: RequirementSummary }) {
  const t = useCopy();
  const areas = useRequirementAreas(projectId).data ?? [];
  const { set, accept } = usePlacement(projectId, d.key);
  const [name, setName] = useState<string | null>(null);
  const p = d.placementProposal;
  return (
    <>
      <Fact label={t("requirements.placement.area")}>
        <Select
          quiet
          aria-label={t("requirements.placement.area")}
          value={d.area?.id ?? ""}
          onChange={(v) => set.mutate({ areaId: v || null })}
          options={[{ value: "", label: t("requirements.noArea") }, ...areas.map((a) => ({ value: a.id, label: a.name }))]}
        />
      </Fact>
      <Fact label={t("requirements.placement.shortName")}>
        <input
          aria-label={t("requirements.placement.shortName")}
          value={name ?? d.shortName ?? ""}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if (name !== null && name.trim() !== (d.shortName ?? "")) set.mutate({ shortName: name.trim() || null }, { onSettled: () => setName(null) });
            else setName(null);
          }}
          placeholder={d.title}
          className="h-7 w-full min-w-0 bg-transparent text-13 outline-none"
        />
      </Fact>
      {p ? (
        <Fact label={t("requirements.placement.proposed")}>
          <span className="flex flex-wrap items-center justify-end gap-2 text-13">
            <span>{[p.area?.name, p.shortName].filter(Boolean).join(" · ")}</span>
            <Button type="button" size="sm" variant="primary" loading={accept.isPending} onClick={() => accept.mutate()}>
              {t("requirements.placement.accept")}
            </Button>
          </span>
        </Fact>
      ) : null}
      <RefusalLine error={set.error ?? accept.error} />
    </>
  );
}
