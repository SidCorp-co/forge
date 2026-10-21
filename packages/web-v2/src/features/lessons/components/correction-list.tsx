// The corrections no lesson holds yet (REQ-50 BC-1): what a person said, where and when. The steward
// groups them into proposals; one that was never a correction is dismissed here and grouped no more.

import type { CorrectionView } from "@forge/contracts/lessons";
import { Button, RowItem, RowList } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { formatRelativeTime } from "@/lib/utils/format";
import { useDismissCorrection } from "../hooks";
import { personWords, sourceWords } from "../words";

export function CorrectionList({ projectId, corrections }: { projectId: string; corrections: CorrectionView[] }) {
  const t = useCopy();
  const dismiss = useDismissCorrection(projectId);
  if (corrections.length === 0) return <p className="py-2 text-13 text-muted">{t("lessons.correctionsNone")}</p>;
  return (
    <>
      <RowList label={t("lessons.corrections")} testId="lesson-corrections">
        {corrections.map((c) => (
          <RowItem
            key={c.id}
            testId="lesson-correction-row"
            rowKey={c.id}
            lead={c.item.key}
            title={c.reason}
            wrap
            facts={[
              sourceWords(c.source),
              personWords(t, c.by, c.agency),
              formatRelativeTime(c.at),
              ...(c.score !== null ? [t("lessons.correction.score", { score: Math.round(c.score * 100) })] : []),
            ]}
            trailing={
              <Button
                type="button"
                size="sm"
                variant="ghost"
                loading={dismiss.isPending && dismiss.variables === c.id}
                onClick={() => dismiss.mutate(c.id)}
                data-testid="correction-dismiss"
              >
                {t("lessons.act.dismiss")}
              </Button>
            }
          />
        ))}
      </RowList>
      {dismiss.isError ? (
        <p className="mt-2 text-12 text-danger" role="alert">
          {formatApiError(dismiss.error)}
        </p>
      ) : null}
    </>
  );
}
