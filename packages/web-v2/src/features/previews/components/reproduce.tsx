"use client";

// A feedback item reproduced and its fix confirmed, on the item's own page (REQ-41 BC-17, BC-20):
// Reproduce opens a preview of the build its reporter used (core picks it, or refuses naming what
// to give) and records what a member does there; once a routed issue's run serves the fix in its
// live preview, the reporter, or a member for them, says Fixed or Not fixed against that preview.
// Core decides every move and binds the word to the patch it served; this draws the records and
// says by name what core refused. The reproduce's id rides the URL, so a reload keeps it.

import { previewKeys } from "../queries";
import { PREVIEW_FAILURE_REASONS, type PreviewFailureReason, type PreviewRecord } from "@forge/contracts/preview";
import type { FixConfirmation } from "@forge/contracts/reproduce";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Banner, Button, Textarea, useUrlParams, ViewHeading } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { usePreview } from "../hooks";
import { PreviewFrame } from "./preview-frame";
import { reproduceApi } from "../reproduce-api";

type Copy = ReturnType<typeof useCopy>;

/** The URL param that holds the open reproduce's id. */
export const REPRODUCE_PARAM = "reproduce";

/** A reproduce still starting is read again on a short clock, as the issue's preview is. */
const STARTING_POLL_MS = 3000;

export const reproduceKey = (id: string | null) => ["preview", "reproduce", id] as const;
export const recordingsKey = previewKeys.recordings;

const REASONS = Object.fromEntries(
  PREVIEW_FAILURE_REASONS.map((r) => [r, { name: `previews.failed.reason.${r}`, fix: `previews.failed.fix.${r}` }]),
) as Record<PreviewFailureReason, { name: Parameters<Copy>[0]; fix: Parameters<Copy>[0] }>;

function Refusal({ error, lead }: { error: unknown; lead: string }) {
  if (!error) return null;
  return (
    <p role="alert" className="fg-body-sm text-danger-11">
      {lead}: {formatApiError(error)}
    </p>
  );
}

const shortSha = (sha: string) => sha.slice(0, 12);
const isServing = (p: PreviewRecord | null) => p?.state === "starting" || p?.state === "live";
const buildOf = (p: PreviewRecord) =>
  p.subject.kind === "reproduce" ? (p.subject.build.release ? `${p.subject.build.release} (${shortSha(p.subject.build.sha)})` : shortSha(p.subject.build.sha)) : null;

export interface ReproductionProps {
  projectId: string;
  fbKey: string;
  /** The issue keys that carry the item's issue route: whose live preview serves the fix. */
  carriers: readonly string[];
  /** A reproduce reads the reporter's report: once their data is deleted there is nothing to reproduce. */
  redacted: boolean;
}

export function Reproduction({ projectId, fbKey, carriers, redacted }: ReproductionProps) {
  const t = useCopy();
  const qc = useQueryClient();
  const [params, setParams] = useUrlParams();
  const openId = params.get(REPRODUCE_PARAM);
  const previewQ = useQuery({
    queryKey: reproduceKey(openId),
    queryFn: () => reproduceApi.get(openId as string),
    enabled: !!openId,
    refetchInterval: (q) => (q.state.data?.state === "starting" ? STARTING_POLL_MS : false),
  });
  const open = useMutation({
    mutationFn: () => reproduceApi.open(projectId, fbKey),
    onSuccess: (p) => {
      qc.setQueryData(reproduceKey(p.id), p);
      setParams({ [REPRODUCE_PARAM]: p.id });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: recordingsKey(projectId, fbKey) }),
  });
  const preview = previewQ.data ?? null;
  const serving = isServing(preview);

  return (
    <section aria-label={t("previews.reproduce.title")} data-testid="reproduce-section" data-highlight="reproduce" className="grid gap-3">
      <ViewHeading>{t("previews.reproduce.title")}</ViewHeading>
      {redacted ? (
        <p className="fg-body-sm text-muted">{t("previews.reproduce.redacted")}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            {serving ? null : (
              <Button size="sm" loading={open.isPending} onClick={() => open.mutate()} data-testid="reproduce-open">
                {t("previews.reproduce.open", { fb: fbKey })}
              </Button>
            )}
          </div>
          <Refusal error={open.error} lead={t("previews.reproduce.openFailed")} />
          <Refusal error={previewQ.error} lead={t("previews.reproduce.loadFailed")} />
          {preview ? <ReproduceBody preview={preview} fbKey={fbKey} t={t} /> : null}
        </>
      )}
      {carriers.map((key) => (
        <FixConfirm key={key} projectId={projectId} issueKey={key} fbKey={fbKey} />
      ))}
    </section>
  );
}

function ReproduceBody({ preview, fbKey, t }: { preview: PreviewRecord; fbKey: string; t: Copy }) {
  const build = buildOf(preview);
  const recording = preview.subject.kind === "reproduce" && preview.subject.record;
  return (
    <div className="grid gap-2" data-testid="reproduce-preview" data-state={preview.state}>
      <p className="fg-body-sm text-fg">
        <span data-testid="reproduce-state" className="fg-label">
          {t(`previews.state.${preview.state}`)}
        </span>
        {build ? <span className="text-muted"> · {t("previews.reproduce.build", { build })}</span> : null}
        {isServing(preview) ? <span className="text-muted"> · {recording ? t("previews.reproduce.recording") : t("previews.reproduce.notRecording")}</span> : null}
      </p>
      {preview.state === "starting" ? (
        <p role="status" className="fg-body-sm text-muted">
          {t("previews.reproduce.starting")}
        </p>
      ) : null}
      {preview.state === "live" ? <PreviewFrame preview={preview} issueLabel={fbKey} /> : null}
      {preview.state === "failed" && preview.reason ? (
        <div data-testid="reproduce-failure" data-reason={preview.reason} className="grid gap-1.5">
          <Banner tone="danger">
            <span className="font-medium">{t(REASONS[preview.reason].name)}.</span> {t(REASONS[preview.reason].fix)}
          </Banner>
          {preview.detail ? <pre className="fg-caption max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-sunken p-3 font-mono text-fg">{preview.detail}</pre> : null}
        </div>
      ) : null}
      {preview.state === "failed" && !preview.reason ? <Banner tone="danger">{t("previews.failed.lead")}</Banner> : null}
      {!isServing(preview) && preview.state !== "failed" ? <p className="fg-body-sm text-muted">{t("previews.reproduce.closed")}</p> : null}
    </div>
  );
}

/** The routed issue's live preview, and the reporter's Fixed or Not fixed on it (BC-20). */
function FixConfirm({ projectId, issueKey, fbKey }: { projectId: string; issueKey: string; fbKey: string }) {
  const t = useCopy();
  const previewQ = usePreview(issueKey, projectId);
  const [note, setNote] = useState("");
  const [asking, setAsking] = useState(false);
  const confirm = useMutation({
    mutationFn: ({ previewId, verdict }: { previewId: string; verdict: "fixed" | "not_fixed" }) =>
      reproduceApi.confirm(previewId, verdict, verdict === "not_fixed" ? note.trim() : undefined),
  });
  // a word is said only on a fix that serves now: core binds it to the patch served at that moment
  const preview = previewQ.data?.state === "live" ? previewQ.data : null;
  if (previewQ.isLoading || previewQ.isError) return null;
  if (!preview) {
    return (
      <p className="fg-caption text-muted" data-testid="fix-not-live" data-issue={issueKey}>
        {t("previews.fix.notLive", { issue: issueKey })}
      </p>
    );
  }
  const said: FixConfirmation | undefined = confirm.data?.confirmations.find((c) => c.previewId === preview.id);
  return (
    <div className="grid gap-2 border-t border-line-subtle pt-3" data-testid="fix-confirm" data-issue={issueKey}>
      <h3 className="fg-label text-fg">{t("previews.fix.title", { issue: issueKey })}</h3>
      <PreviewFrame preview={preview} issueLabel={issueKey} height={420} />
      {said ? (
        <p role="status" data-testid="fix-recorded" data-verdict={said.verdict} className="fg-body-sm text-fg">
          {t(said.verdict === "fixed" ? "previews.fix.recorded.fixed" : "previews.fix.recorded.not_fixed", { patch: shortSha(said.patchId), fb: fbKey })}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" loading={confirm.isPending && confirm.variables?.verdict === "fixed"} onClick={() => confirm.mutate({ previewId: preview.id, verdict: "fixed" })}>
            {t("previews.fix.fixed")}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setAsking(true)} aria-expanded={asking}>
            {t("previews.fix.notFixed")}
          </Button>
        </div>
      )}
      {asking && !said ? (
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            confirm.mutate({ previewId: preview.id, verdict: "not_fixed" });
          }}
        >
          <Textarea aria-label={t("previews.fix.note")} placeholder={t("previews.fix.note")} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          <div>
            <Button type="submit" size="sm" disabled={note.trim() === ""} loading={confirm.isPending && confirm.variables?.verdict === "not_fixed"}>
              {t("previews.fix.send")}
            </Button>
          </div>
        </form>
      ) : null}
      <Refusal error={confirm.error} lead={t("previews.fix.failed")} />
    </div>
  );
}
