"use client";

// A draft revision written in place: its summary and one criterion per line. Proposing an empty
// draft is refused by core by name (REQUIREMENT_REVISION_EMPTY), so this is where it gets its words.

import { useState } from "react";
import { Button, Input, Textarea } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { requirementsApi } from "../api";
import type { RequirementDetail, RequirementRevision } from "../types";

export function DraftEditor({ projectId, d, draft }: { projectId: string; d: RequirementDetail; draft: RequirementRevision }) {
  const t = useCopy();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [tldr, setTldr] = useState(draft.tldr ?? "");
  const [lines, setLines] = useState(draft.criteria.map((c) => c.body).join("\n"));
  const save = useMutation({
    mutationFn: () =>
      requirementsApi.writeDraft(projectId, d.key, draft, {
        tldr: tldr.trim(),
        criteria: lines.split("\n").map((l) => l.trim()).filter(Boolean),
      }),
    onSuccess: (detail) => {
      qc.setQueryData(["requirement", projectId, d.key], detail);
      qc.invalidateQueries({ queryKey: ["requirements", projectId] });
      setOpen(false);
    },
  });
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
        save.mutate();
      }}
    >
      <Input aria-label={t("requirements.draft.summary")} placeholder={t("requirements.draft.summary")} value={tldr} onChange={(e) => setTldr(e.target.value)} maxLength={400} />
      <Textarea aria-label={t("requirements.draft.criteria")} placeholder={t("requirements.draft.criteria")} rows={5} value={lines} onChange={(e) => setLines(e.target.value)} />
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" variant="primary" loading={save.isPending} disabled={!lines.trim()}>
          {t("requirements.draft.save")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          {t("requirements.draft.cancel")}
        </Button>
      </div>
      <RefusalLine error={save.error} />
    </form>
  );
}
