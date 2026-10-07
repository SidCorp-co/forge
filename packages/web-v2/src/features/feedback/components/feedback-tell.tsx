"use client";

// "Tell the reporter now": one act for a shipped item nobody told, above all one that shipped before
// the project's releases sent notices. Core sends the release and what changed in each reporter's
// language and refuses it once they were told; this only offers the button and shows a refusal.

import { Button } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { useTellShipped } from "../hooks";
import type { FeedbackView } from "../types";

export function TellShippedBar({ projectId, f }: { projectId: string; f: FeedbackView }) {
  const t = useCopy();
  const tell = useTellShipped(projectId, f.key);
  return (
    <div className="grid gap-1.5" data-testid="feedback-tell-shipped">
      <p className="text-13">
        {t("feedback.tell.head")} <span className="text-muted">{t("feedback.tell.hint")}</span>
      </p>
      <RefusalLine error={tell.error} />
      <div>
        <Button type="button" size="sm" loading={tell.isPending} onClick={() => tell.mutate()}>
          {t("feedback.tell.act")}
        </Button>
      </div>
    </div>
  );
}
