
// The act a judge takes on an issue's criteria from its Criteria tab: record a verdict on one
// criterion (pass, pass short of its wording, fail, or could not judge with a reason, judged against
// a whole commit core names by default, with a note and a screenshot or a short clip new, or a file
// already attached), taken on a closed issue too: judging shipped work is the point. Judging again
// records a newer verdict, which is the one counted. Core refuses by name. Tying the issue to its
// requirement's criteria is the agent's act, never this page's (REQ-68 BC-6, ISS-687 round 4).

import { useEffect, useState } from "react";
import { safeAttachmentName } from "@forge/contracts/attachments";
import type { JudgedBuild } from "@forge/contracts/verdict-identity";
import { Button, ConfirmDialog, Field, Input, NativeSelect, SegmentedControl, Textarea } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { formatSize } from "@/features/attachments";
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
  type VerdictEvidence,
} from "../criteria";
import { useAttachments } from "../detail-hooks";

const VERDICTS: readonly PersonVerdict[] = ["pass", "short", "fail", "skipped"];

function refusalText(t: Copy, r: EvidenceFileRefusal): string {
  if (r.kind === "clipTooLarge") return t("issues.verdictAct.clipTooLargeRefused", { name: r.name, cap: r.cap });
  if (r.kind === "empty") return t("issues.verdictAct.fileEmptyRefused", { name: r.name });
  return t("issues.verdictAct.fileTypeRefused", { name: r.name });
}

/** What the commit field says about the build core named, before anything is typed over it. */
function namedBuildHint(t: Copy, build: JudgedBuild): string {
  const named = { basis: build.basis, build: build.version ?? build.sha?.slice(0, 7) ?? "" };
  if (build.source === "live") return t("issues.verdictAct.commitLive", named);
  if (build.source === "shipped") return t("issues.verdictAct.commitShipped", named);
  if (build.source === "merged") return t("issues.verdictAct.commitMerged", named);
  if (build.source === "landed") return t("issues.verdictAct.commitLanded", named);
  if (build.source === "judged-on") return t("issues.verdictAct.commitJudgedOn", named);
  return t("issues.verdictAct.commitNone");
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
  const shaHint = shaHintOf(t, { typed, sha, named, skipped, build });
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
        onConfirm={() =>
          record.mutate(
            // the build core named on the testing environment, untyped over, is judged there as it runs
            { criterion: row.n, verdict, sha, note, evidence, onTesting: typed === null && build.data?.source === "judged-on" },
            { onSuccess: close },
          )
        }
        message={
          <div className="grid gap-4" data-testid="verdict-form">
            <p className="whitespace-pre-wrap text-13 text-muted">{row.statement}</p>
            <Field label={t("issues.verdictAct.verdict")}>
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
            <ScreenshotField
              screenshot={screenshot}
              uploadAs={uploadAs}
              picker={picker}
              refused={refused}
              onPick={(file, why) => {
                setRefused(why);
                if (why) setPicker((k) => k + 1);
                setScreenshot(why ? null : file);
                setCited("");
              }}
            />
            <RefusalLine error={record.error} testid="verdict-refusal" />
          </div>
        }
      />
    </>
  );
}

/** What the commit field says under it: the typed sha, the build core named, or why there is none. */
function shaHintOf(
  t: Copy,
  { typed, sha, named, skipped, build }: { typed: string | null; sha: string; named: string; skipped: boolean; build: ReturnType<typeof useJudgedBuild> },
): string {
  if (typed !== null && sha.trim() !== named) {
    if (sha.trim()) return t("issues.verdictAct.commitTyped");
    return skipped ? t("issues.verdictAct.commitSkipped") : t("issues.verdictAct.commitNone");
  }
  if (build.isPending) return t("issues.verdictAct.commitLoading");
  if (build.isError) return t("issues.verdictAct.commitUnread", { error: formatApiError(build.error) });
  return build.data ? namedBuildHint(t, build.data) : "";
}

/** The file chosen as evidence: a screenshot or a clip, refused by name when it cannot be sent. */
function ScreenshotField({
  screenshot,
  uploadAs,
  picker,
  refused,
  onPick,
}: {
  screenshot: File | null;
  uploadAs: string | null;
  picker: number;
  refused: EvidenceFileRefusal | null;
  onPick: (file: File | null, why: EvidenceFileRefusal | null) => void;
}) {
  const t = useCopy();
  return (
    <Field
      label={t("issues.verdictAct.screenshot")}
      hint={
        screenshot && uploadAs && uploadAs !== safeAttachmentName(screenshot.name)
          ? t("issues.verdictAct.renamed", { name: safeAttachmentName(screenshot.name), as: uploadAs })
          : undefined
      }
    >
      <input
        key={picker}
        type="file"
        accept={EVIDENCE_FILE_ACCEPT}
        className="text-12"
        onChange={(e) => {
          const file = e.target.files?.[0] ?? null;
          onPick(file, file ? evidenceFileRefusal(file) : null);
        }}
        data-testid="verdict-screenshot"
      />
      {refused ? (
        <p role="alert" className="mt-1 text-13 text-danger" data-testid="verdict-evidence-refusal">
          {refusalText(t, refused)}
        </p>
      ) : null}
      {screenshot?.type.startsWith("video/") ? (
        <div className="mt-2 grid gap-1" data-testid="verdict-clip-chosen">
          <span className="text-13 text-muted">{t("issues.verdictAct.clipChosen", { name: screenshot.name, size: formatSize(screenshot.size) })}</span>
          {typeof URL.createObjectURL === "function" ? <ClipPreview key={picker} file={screenshot} /> : null}
        </div>
      ) : null}
    </Field>
  );
}

/** A chosen clip played back from a local object URL, released when the clip is replaced or the form closes. */
function ClipPreview({ file }: { file: File }) {
  const [url] = useState(() => URL.createObjectURL(file));
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <video src={url} controls muted preload="metadata" className="max-h-48 w-full border-y border-line-subtle" />;
}
