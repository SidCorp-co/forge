
// A draft revision written in place: its summary and one criterion per line. Proposing an empty
// draft is refused by core by name (REQUIREMENT_REVISION_EMPTY), so this is where it gets its words.
// A refused save shows core's words on the field its path names (REQ-34 BC-18).

import { useState } from "react";
import { Button, Field, Input, Textarea } from "@/design";
import { placeRefusals } from "@/lib/api/field-refusals";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { useWrite } from "@/lib/api/query-kit";
import { requirementsApi } from "../api";
import { requirementKeys } from "../hooks";
import type { RequirementDetail, RequirementRevision } from "../types";

const DRAFT_FIELDS = { summary: ["/tldr"], criteria: ["/criteria"] } as const;

export function DraftEditor({ projectId, d, draft }: { projectId: string; d: RequirementDetail; draft: RequirementRevision }) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  const [tldr, setTldr] = useState(draft.tldr ?? "");
  const [lines, setLines] = useState(draft.criteria.map((c) => c.body).join("\n"));
  const save = useWrite(
    () => requirementsApi.writeDraft(projectId, d.key, draft, { tldr: tldr.trim(), criteria: lines.split("\n").map((l) => l.trim()).filter(Boolean) }),
    { shows: requirementKeys.detail(projectId, d.key), touches: [requirementKeys.list(projectId)] },
  );
  const refused = placeRefusals(save.error, DRAFT_FIELDS);
  if (!open) {
    return (
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        {t("requirements.draft.write", { r: draft.revision })}
      </Button>
    );
  }
  return (
    <form
      className="grid basis-full gap-2 border-t border-line-subtle pt-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(undefined, { onSuccess: () => setOpen(false) });
      }}
    >
      <Field label={t("requirements.draft.summary")} error={refused.at("summary")}>
        <Input value={tldr} onChange={(e) => setTldr(e.target.value)} maxLength={400} />
      </Field>
      <Field label={t("requirements.draft.criteria")} error={refused.at("criteria")}>
        <Textarea rows={5} value={lines} onChange={(e) => setLines(e.target.value)} />
      </Field>
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" variant="primary" loading={save.isPending} disabled={!lines.trim()}>
          {t("requirements.draft.save")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          {t("requirements.draft.cancel")}
        </Button>
      </div>
      <RefusalLine error={save.error} onField={refused.onField} />
    </form>
  );
}
