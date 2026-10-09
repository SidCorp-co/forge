"use client";

// The acts a person takes on an issue's criteria from its Criteria tab: record a verdict on one
// criterion (pass, pass short of its wording, fail, or could not judge with a reason, judged against
// a whole commit core names by default, with a note and a screenshot or a short clip new, or a file already attached), and
// tie the issue to business criteria of the requirement it delivers. Both are taken on a closed issue
// too: judging shipped work is the point. Judging again records a newer verdict, which is the one
// counted. Core refuses by name.

import { useEffect, useState } from "react";
import { safeAttachmentName } from "@forge/contracts/attachments";
import type { JudgedBuild } from "@forge/contracts/verdict-identity";
import { Button, Checkbox, ConfirmDialog, Field, Input, NativeSelect, SegmentedControl, Textarea } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { formatSize } from "@/features/attachments/components/staged-files";
import {
  type CriterionRow,
  EVIDENCE_FILE_ACCEPT,
  type EvidenceFileRefusal,
  evidenceFileRefusal,
  freeAttachmentName,
  isWholeSha,
  type PersonVerdict,
  useJudgedBuild,
  useRecordVerdict,
  useTraceCriteria,
  type VerdictEvidence,
} from "../criteria";
import { useAttachments } from "../detail-hooks";
import { useRequirementCriteria } from "../requirement-link";

const VERDICTS: readonly PersonVerdict[] = ["pass", "short", "fail", "skipped"];

function refusalText(t: Copy, r: EvidenceFileRefusal): string {
  if (r.kind === "clipTooLarge") return t("issues.verdictAct.clipTooLarge", { name: r.name, cap: r.cap });
  if (r.kind === "empty") return t("issues.verdictAct.fileEmpty", { name: r.name });
  return t("issues.verdictAct.fileType", { name: r.name });
}

/** What the commit field says about the build core named, before anything is typed over it. */
function namedBuildHint(t: Copy, build: JudgedBuild): string {
  const named = { basis: build.basis, build: build.version ?? build.sha?.slice(0, 7) ?? "" };
  if (build.source === "live") return t("issues.verdictAct.commitLive", named);
  if (build.source === "shipped") return t("issues.verdictAct.commitShipped", named);
  if (build.source === "merged") return t("issues.verdictAct.commitMerged", named);
  return t("issues.verdictAct.commitNone", named);
}

export function RecordVerdict({ issueId, row }: { issueId: string; row: CriterionRow }) {
  const t = useCopy();
  const record = useRecordVerdict(issueId);
  const [open, setOpen] = useState(false);
  const build = useJudgedBuild(issueId, open);
  const attachments = useAttachments(open ? issueId : undefined);
  const [verdict, setVerdict] = useState<PersonVerdict>("pass");
  const [typed, setTyped] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [cited, setCited] = useState("");
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [picker, setPicker] = useState(0);
  const [refused, setRefused] = useState<EvidenceFileRefusal | null>(null);
  const isClip = !!screenshot && screenshot.type.startsWith("video/");
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!isClip || !screenshot || typeof URL.createObjectURL !== "function") return setClipUrl(null);
    const url = URL.createObjectURL(screenshot);
    setClipUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [isClip, screenshot]);
  const named = build.data?.sha ?? "";
  const sha = typed ?? named;
  const skipped = verdict === "skipped";
  const taken = (attachments.data ?? []).map((a) => a.name);
  const uploadAs = screenshot ? freeAttachmentName(screenshot.name, taken) : null;
  const evidence: VerdictEvidence =
    screenshot && uploadAs ? { kind: "upload", file: screenshot, as: uploadAs } : cited ? { kind: "attached", name: cited } : { kind: "none" };
  const close = () => {
    setOpen(false);
    setTyped(null);
    setNote("");
    setCited("");
    setScreenshot(null);
    setRefused(null);
    record.reset();
  };
  const shaHint = typed !== null && sha.trim() !== named
    ? sha.trim()
      ? t("issues.verdictAct.commitTyped")
      : skipped
        ? t("issues.verdictAct.commitSkipped")
        : t("issues.verdictAct.commitNone", { basis: build.data?.basis ?? "" })
    : build.isPending
      ? t("issues.verdictAct.commitLoading")
      : build.isError
        ? t("issues.verdictAct.commitUnread", { error: formatApiError(build.error) })
        : build.data
          ? namedBuildHint(t, build.data)
          : "";
  const shaReady = skipped ? !sha.trim() || isWholeSha(sha) : isWholeSha(sha);
  const ready = shaReady && (!skipped || note.trim() !== "");
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
        confirmDisabled={!ready}
        onClose={close}
        onConfirm={() => record.mutate({ criterion: row.n, verdict, sha, note, evidence }, { onSuccess: close })}
        message={
          <div className="grid gap-4" data-testid="verdict-form">
            <p className="whitespace-pre-wrap text-13 text-muted">{row.statement}</p>
            <Field label={t("issues.verdictAct.verdict")} hint={t("issues.verdictAct.verdictHint")}>
              <SegmentedControl
                value={verdict}
                onChange={setVerdict}
                options={VERDICTS.map((v) => ({ value: v, label: t(`issues.verdictAct.${v}`) }))}
              />
            </Field>
            <Field label={t("issues.verdictAct.commit")} hint={shaHint} error={sha.trim() && !isWholeSha(sha) ? t("issues.verdictAct.commitShape") : undefined}>
              <Input value={sha} onChange={(e) => setTyped(e.target.value)} className="font-mono text-12" spellCheck={false} />
            </Field>
            <Field
              label={t(skipped ? "issues.verdictAct.skipNote" : "issues.verdictAct.note")}
              hint={t(skipped ? "issues.verdictAct.skipNoteHint" : "issues.verdictAct.noteHint")}
              required={skipped}
            >
              <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={4000} />
            </Field>
            {taken.length > 0 ? (
              <Field label={t("issues.verdictAct.attached")}>
                <NativeSelect
                  value={cited}
                  onChange={(e) => {
                    setCited(e.target.value);
                    setScreenshot(null);
                    setPicker((k) => k + 1);
                  }}
                  options={[{ value: "", label: t("issues.verdictAct.attachedNone") }, ...taken.map((name) => ({ value: name, label: name }))]}
                />
              </Field>
            ) : null}
            <Field
              label={t("issues.verdictAct.screenshot")}
              hint={
                screenshot && uploadAs && uploadAs !== safeAttachmentName(screenshot.name)
                  ? t("issues.verdictAct.renamed", { name: safeAttachmentName(screenshot.name), as: uploadAs })
                  : t("issues.verdictAct.screenshotHint")
              }
            >
              <input
                key={picker}
                type="file"
                accept={EVIDENCE_FILE_ACCEPT}
                className="text-12"
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null;
                  const why = file ? evidenceFileRefusal(file) : null;
                  setRefused(why);
                  if (why) setPicker((k) => k + 1);
                  setScreenshot(why ? null : file);
                  setCited("");
                }}
                data-testid="verdict-screenshot"
              />
              {refused ? (
                <p role="alert" className="mt-1 text-12-5 text-danger" data-testid="verdict-evidence-refusal">
                  {refusalText(t, refused)}
                </p>
              ) : null}
              {isClip && screenshot ? (
                <div className="mt-2 grid gap-1" data-testid="verdict-clip-chosen">
                  <span className="text-12-5 text-muted">{t("issues.verdictAct.clipChosen", { name: screenshot.name, size: formatSize(screenshot.size) })}</span>
                  {clipUrl ? <video src={clipUrl} controls muted preload="metadata" className="max-h-48 w-full border-y border-line-subtle" /> : null}
                </div>
              ) : null}
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
 * already traces at their current wording shown ticked and fixed, the rest to pick. Each picked BC
 * becomes a criterion of the issue worded as the BC is now, so it can be judged. A BC this issue
 * traces only at an earlier wording is matched as coverage matches it, by wording: it is pickable,
 * and tying it refreshes that criterion to the current wording, to be judged again.
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
  const mine = (bc: { issues: { issueId: string; stale: boolean }[] }) => bc.issues.filter((i) => i.issueId === issueId);
  const held = new Set((bcs.data ?? []).filter((bc) => mine(bc).some((i) => !i.stale)).map((bc) => bc.code));
  const earlier = new Set((bcs.data ?? []).filter((bc) => !held.has(bc.code) && mine(bc).some((i) => i.stale)).map((bc) => bc.code));
  const note = (code: string) => (held.has(code) ? ` · ${t("issues.tieAct.held")}` : earlier.has(code) ? ` · ${t("issues.tieAct.earlier")}` : "");
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
                    label={`${bc.code} ${bc.body}${note(bc.code)}`}
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
