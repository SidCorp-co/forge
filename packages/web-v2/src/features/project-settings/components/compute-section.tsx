"use client";

// Advanced → Computation: the project document's `compute` key, which decides whether the assistant
// may run a short script over this project's data in an isolated sandbox, and which sandboxes may
// take the data (`packages/core/src/reports/compute.ts`). Core reads anything but `enabled: true` as
// off, so turning it off removes the key where nothing else is set, and writes `enabled: false` where
// a sandbox choice is held, so turning it back on finds that choice again. A sandbox choice is set
// only while computation is on, since `compute` without `enabled` is not a document core accepts.

import { Skeleton, Toggle } from "@/design";
import { sectionOf } from "@/features/project-config/use-document-draft";
import { useCopy } from "@/lib/i18n/interface-language";
import { UndeclaredNotice, useProjectDraft } from "./general-section";
import { SaveBar, SettingGroup, SettingRow } from "./setting-controls";

type Compute = { enabled?: unknown; zdrOnly?: unknown; thirdParty?: unknown };

export function ComputeSection({ projectId, slug, canEdit }: { projectId: string; slug: string; canEdit: boolean }) {
  const t = useCopy();
  const draft = useProjectDraft(projectId);
  const section = sectionOf([draft]);
  if (draft.loading || !draft.ready) return <Skeleton className="h-40 w-full rounded-md" />;
  const off = !canEdit || !draft.declared;
  const raw = draft.get(["compute"]);
  const compute: Compute = raw !== null && typeof raw === "object" ? (raw as Compute) : {};
  const enabled = compute.enabled === true;
  const setEnabled = (on: boolean) => {
    const { enabled: _was, ...choices } = compute;
    const held = Object.values(choices).some((v) => v !== undefined);
    draft.set(["compute"], on ? { ...choices, enabled: true } : held ? { ...choices, enabled: false } : undefined);
  };
  const choice = (key: "thirdParty" | "zdrOnly", label: string, effect: string) => (
    <SettingRow
      inline
      label={label}
      effect={effect}
      refusals={draft.refusedAt(["compute", key])}
      control={<Toggle checked={compute[key] === true} disabled={off || !enabled} aria-label={label} onChange={(v) => draft.set(["compute", key], v ? true : undefined)} />}
    />
  );
  return (
    <div data-testid="compute-section">
      {!draft.declared && <UndeclaredNotice slug={slug} />}
      <SettingGroup id="compute" title={t("settings.project.compute.title")} lead={t("settings.project.compute.lead")}>
        <SettingRow
          inline
          label={t("settings.project.compute.enabled")}
          effect={t("settings.project.compute.enabledEffect")}
          refusals={draft.refusedAt(["compute"]).filter((r) => r.path === "/compute" || r.path === "/compute/enabled")}
          control={<Toggle checked={enabled} disabled={off} aria-label={t("settings.project.compute.enabled")} onChange={setEnabled} />}
        />
        {choice("thirdParty", t("settings.project.compute.thirdParty"), t("settings.project.compute.thirdPartyEffect"))}
        {choice("zdrOnly", t("settings.project.compute.zdrOnly"), t("settings.project.compute.zdrOnlyEffect"))}
      </SettingGroup>
      {draft.declared && <SaveBar section={section} canEdit={canEdit} />}
    </div>
  );
}
