"use client";

// The acts a person takes on an issue's criteria from its Criteria tab: record a verdict on one
// criterion (pass, fail or short, judged against a whole commit, with a note and an optional
// screenshot), and tie the issue to business criteria of the requirement it delivers. Both are
// taken on a closed issue too: judging shipped work is the point. Core refuses by name.

import { useState } from "react";
import { Button, Checkbox, ConfirmDialog, Field, Input, SegmentedControl, Textarea } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import {
  type CriterionRow,
  isWholeSha,
  type PersonVerdict,
  useRecordVerdict,
  useTraceCriteria,
  type VerdictCommit,
} from "../criteria";
import { useRequirementCriteria } from "../requirement-link";

const VERDICTS: readonly PersonVerdict[] = ["pass", "fail", "short"];

export function RecordVerdict({ issueId, row, commit }: { issueId: string; row: CriterionRow; commit: VerdictCommit | null }) {
  const t = useCopy();
  const record = useRecordVerdict(issueId);
  const [open, setOpen] = useState(false);
  const [verdict, setVerdict] = useState<PersonVerdict>("pass");
  const [sha, setSha] = useState(commit?.sha ?? "");
  const [note, setNote] = useState("");
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const close = () => {
    setOpen(false);
    record.reset();
  };
  const shaHint = !sha.trim()
    ? t("issues.verdictAct.commitNone")
    : commit && sha.trim() === commit.sha
      ? t(commit.source === "live" ? "issues.verdictAct.commitLive" : "issues.verdictAct.commitMerged")
      : t("issues.verdictAct.commitTyped");
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)} data-testid={`criterion-${row.n}-judge`}>
        {t("issues.verdictAct.open")}
      </Button>
      <ConfirmDialog
        open={open}
        title={t("issues.verdictAct.title", { n: row.n })}
        confirmLabel={t("issues.verdictAct.submit")}
        loading={record.isPending}
        confirmDisabled={!isWholeSha(sha)}
        onClose={close}
        onConfirm={() =>
          record.mutate({ criterion: row.n, verdict, sha, note, screenshot }, { onSuccess: close })
        }
        message={
          <div className="grid gap-4" data-testid="verdict-form">
            <p className="whitespace-pre-wrap text-13 text-muted">{row.statement}</p>
            <Field label={t("issues.verdictAct.verdict")} hint={t("issues.verdictAct.shortHint")}>
              <SegmentedControl
                value={verdict}
                onChange={setVerdict}
                options={VERDICTS.map((v) => ({ value: v, label: t(`issues.verdictAct.${v}`) }))}
              />
            </Field>
            <Field label={t("issues.verdictAct.commit")} hint={shaHint} error={sha.trim() && !isWholeSha(sha) ? t("issues.verdictAct.commitShape") : undefined}>
              <Input value={sha} onChange={(e) => setSha(e.target.value)} className="font-mono text-12" spellCheck={false} />
            </Field>
            <Field label={t("issues.verdictAct.note")} hint={t("issues.verdictAct.noteHint")}>
              <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={4000} />
            </Field>
            <Field label={t("issues.verdictAct.screenshot")} hint={t("issues.verdictAct.screenshotHint")}>
              <input
                type="file"
                accept="image/*"
                className="text-12"
                onChange={(e) => setScreenshot(e.target.files?.[0] ?? null)}
                data-testid="verdict-screenshot"
              />
            </Field>
            <RefusalLine error={record.error} testid="verdict-refusal" />
          </div>
        }
      />
    </>
  );
}

/**
 * Tie the issue to business criteria of its requirement: the requirement's BCs, those this issue
 * already traces shown ticked and fixed, the rest to pick. Each picked BC becomes a criterion of the
 * issue worded as the BC, so it can be judged.
 */
export function TieCriteria({
  issueId,
  projectId,
  requirementKey,
}: {
  issueId: string;
  projectId: string;
  requirementKey: string;
}) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const bcs = useRequirementCriteria(projectId, open ? requirementKey : null);
  const tie = useTraceCriteria(issueId, projectId, requirementKey);
  const held = new Set((bcs.data ?? []).filter((bc) => bc.issues.some((i) => i.issueId === issueId)).map((bc) => bc.code));
  const close = () => {
    setOpen(false);
    setPicked([]);
    tie.reset();
  };
  const toggle = (code: string, on: boolean) => setPicked((p) => (on ? [...p, code] : p.filter((c) => c !== code)));
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)} data-testid="criteria-tie">
        {t("issues.tieAct.open", { req: requirementKey })}
      </Button>
      <ConfirmDialog
        open={open}
        title={t("issues.tieAct.title", { req: requirementKey })}
        confirmLabel={t("issues.tieAct.submit", { n: picked.length })}
        loading={tie.isPending}
        confirmDisabled={picked.length === 0}
        onClose={close}
        onConfirm={() => tie.mutate(picked, { onSuccess: close })}
        message={
          <div className="grid gap-3" data-testid="tie-form">
            <p className="text-13 text-muted">{t("issues.tieAct.lead")}</p>
            {bcs.isLoading ? <p className="text-13 text-subtle">{t("issues.steps.loading")}</p> : null}
            <RefusalLine error={bcs.error} testid="tie-read-refusal" />
            <ul className="max-h-[50vh] divide-y divide-line-subtle overflow-y-auto border-y border-line-subtle">
              {(bcs.data ?? []).map((bc) => (
                <li key={bc.code} className="py-2" data-testid={`tie-${bc.code}`}>
                  <Checkbox
                    checked={held.has(bc.code) || picked.includes(bc.code)}
                    disabled={held.has(bc.code)}
                    onChange={(on) => toggle(bc.code, on)}
                    label={`${bc.code} ${bc.body}${held.has(bc.code) ? ` · ${t("issues.tieAct.held")}` : ""}`}
                  />
                </li>
              ))}
            </ul>
            <RefusalLine error={tie.error} testid="tie-refusal" />
          </div>
        }
      />
    </>
  );
}
