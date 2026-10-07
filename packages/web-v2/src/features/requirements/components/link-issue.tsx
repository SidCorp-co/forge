"use client";

// A person links an issue that already exists to the requirement it delivers: picked by key or
// title, optionally adopting its written plan for the current revision. Core decides; a refusal
// (not agreed, linked elsewhere, no plan to adopt) is shown by its name.

import { useState } from "react";
import { Button, Checkbox } from "@/design";
import { type IssuePick, IssuePicker } from "@/features/issue-picker/issue-picker";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { useLinkRequirementIssue } from "../hooks";

export function LinkIssueControl({ projectId, reqKey }: { projectId: string; reqKey: string }) {
  const t = useCopy();
  const link = useLinkRequirementIssue(projectId, reqKey);
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<IssuePick[]>([]);
  const [adoptPlan, setAdoptPlan] = useState(false);
  const chosen = pick[0];
  if (!open) {
    return (
      <Button variant="ghost" size="sm" icon="plus" onClick={() => setOpen(true)} data-testid="link-issue-open">
        {t("requirements.link.open")}
      </Button>
    );
  }
  return (
    <form
      className="grid gap-2 pt-1.5"
      data-testid="link-issue"
      onSubmit={(e) => {
        e.preventDefault();
        if (!chosen) return;
        link.mutate(
          { issue: chosen.key, adoptPlan },
          {
            onSuccess: () => {
              setPick([]);
              setAdoptPlan(false);
              setOpen(false);
            },
          },
        );
      }}
    >
      <IssuePicker projectId={projectId} value={pick} onChange={setPick} ariaLabel={t("requirements.link.pick")} single />
      <Checkbox checked={adoptPlan} onChange={setAdoptPlan} label={t("requirements.link.adoptPlan")} />
      <span className="flex items-center gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={!chosen || link.isPending}>
          {t("requirements.link.submit")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          {t("requirements.link.cancel")}
        </Button>
      </span>
      <RefusalLine error={link.error} testid="link-issue-refusal" />
    </form>
  );
}
