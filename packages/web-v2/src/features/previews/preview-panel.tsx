"use client";

// The issue's live preview (REQ-39): what state it is in, the page itself while it serves, why it
// failed where it did (BC-10), who may approve or abandon it, and the box that asks the run for a
// change (BC-6). Used on the issue and, compact, beside the chat. Core decides every move; this
// draws the record and says by name what core refused.

import { PREVIEW_FAILURE_REASONS, PREVIEW_LIMITS, PREVIEW_SERVING_STATES, type PreviewFailureReason, type PreviewRecord } from "@forge/contracts/preview";
import { useState } from "react";
import { Banner, Button, Skeleton, Textarea, ViewHeading } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { cn } from "@/lib/utils/cn";
import { useCopy } from "@/lib/i18n/interface-language";
import { useCurrentProject } from "@/features/projects/current-project";
import { settingsHref } from "@/features/project-settings/sections";
import { useAbandonPreview, useApprovePreview, useIssueLane, useOpenPreview, usePreview, useSendPreviewMessage } from "./hooks";
import { PreviewFrame } from "./preview-frame";

type Copy = ReturnType<typeof useCopy>;

/** Each failure reason's two copy keys, built from the contract's list; preview-panel.test.tsx fails a reason whose copy is missing. */
const REASON_KEYS = Object.fromEntries(
  PREVIEW_FAILURE_REASONS.map((r) => [r, { name: `previews.failed.reason.${r}`, fix: `previews.failed.fix.${r}` }]),
) as Record<PreviewFailureReason, { name: Parameters<Copy>[0]; fix: Parameters<Copy>[0] }>;

const reasonLines = (t: Copy, reason: PreviewFailureReason) => ({ name: t(REASON_KEYS[reason].name), fix: t(REASON_KEYS[reason].fix) });

const SETTINGS_REASONS: readonly PreviewFailureReason[] = ["NO_START_COMMAND", "PORT_UNDECLARED", "PORT_IN_USE", "PRODUCTION_ENVIRONMENT"];

export interface PreviewPanelProps {
  issueId: string;
  /** The issue's key, for the frame's title. */
  issueLabel: string;
  canWrite: boolean;
  /** A run holds a worktree to serve now; without one nothing can be started. */
  hasLiveRun: boolean;
  compact?: boolean;
  /** Classes for the section itself, so a wrapper never stands empty where the panel draws nothing. */
  className?: string;
}

export function PreviewPanel(props: PreviewPanelProps) {
  const { issueId, canWrite, hasLiveRun, compact = false, className } = props;
  const t = useCopy();
  const previewQ = usePreview(issueId);
  const open = useOpenPreview(issueId);
  const preview = previewQ.data ?? null;

  if (previewQ.isLoading) return compact ? null : <Skeleton className="h-24 w-full rounded-md" />;
  if (previewQ.isError) {
    return (
      <div data-testid="preview-load-failed">
        <Banner tone="danger">
          {t("previews.loadFailed")}: {formatApiError(previewQ.error)}
        </Banner>
      </div>
    );
  }
  // nothing to show and nothing a reader could start (beside the chat, nothing is started): the section stays out of the way
  if (!preview && (compact || !(hasLiveRun && canWrite))) return null;

  return (
    <section aria-label={t("previews.title")} data-testid="preview-panel" data-state={preview?.state ?? "none"} className={cn("grid gap-3", className)}>
      {compact ? null : <ViewHeading>{t("previews.title")}</ViewHeading>}
      {preview ? (
        <PreviewBody {...props} preview={preview} />
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <p className="fg-body-sm min-w-0 flex-1 text-muted">{t("previews.lead")}</p>
          <Button size="sm" loading={open.isPending} onClick={() => open.mutate()}>
            {t("previews.start")}
          </Button>
        </div>
      )}
      <Refusal error={open.error} lead={t("previews.startFailed")} />
    </section>
  );
}

function Refusal({ error, lead }: { error: unknown; lead: string }) {
  if (!error) return null;
  return (
    <p role="alert" className="fg-body-sm" style={{ color: "var(--red-600)" }}>
      {lead}: {formatApiError(error)}
    </p>
  );
}

function PreviewBody({ preview, issueId, issueLabel, canWrite, hasLiveRun, compact }: PreviewPanelProps & { preview: PreviewRecord }) {
  const t = useCopy();
  const open = useOpenPreview(issueId);
  const approve = useApprovePreview(issueId);
  const abandon = useAbandonPreview(issueId);
  const serving = (PREVIEW_SERVING_STATES as readonly string[]).includes(preview.state);
  const approvable = preview.state === "live" || preview.state === "idle_closed";
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span data-testid="preview-state" className="fg-label text-fg">
          {t(`previews.state.${preview.state}`)}
        </span>
        <span className="min-w-0 flex-1" />
        {canWrite && approvable ? (
          <Button size="sm" variant="primary" loading={approve.isPending} onClick={() => approve.mutate(preview.id)}>
            {t("previews.approve")}
          </Button>
        ) : null}
        {canWrite && serving ? (
          <Button size="sm" variant="secondary" loading={abandon.isPending} onClick={() => abandon.mutate(preview.id)}>
            {t("previews.abandon")}
          </Button>
        ) : null}
        {canWrite && preview.state === "idle_closed" ? (
          <Button size="sm" variant="secondary" loading={open.isPending} onClick={() => open.mutate()}>
            {t("previews.reopen")}
          </Button>
        ) : null}
      </div>
      <Refusal error={approve.error} lead={t("previews.approveFailed")} />
      <Refusal error={abandon.error} lead={t("previews.abandonFailed")} />
      <Refusal error={open.error} lead={t("previews.reopenFailed")} />

      {preview.state === "starting" ? (
        <p role="status" className="fg-body-sm text-muted">
          {t("previews.starting")}
        </p>
      ) : null}
      {preview.state === "live" ? <PreviewFrame preview={preview} issueLabel={issueLabel} height={compact ? 360 : 520} /> : null}
      {preview.state === "live" && canWrite && !compact ? <p className="fg-caption text-muted">{t("previews.approveHint")}</p> : null}
      {preview.state === "idle_closed" ? <p className="fg-body-sm text-muted">{t("previews.closed.idle_closed", { minutes: preview.idleMinutes })}</p> : null}
      {preview.state === "approved" ? (
        <>
          <p className="fg-body-sm text-muted">{t("previews.closed.approved")}</p>
          <LaneRead issueId={issueId} />
        </>
      ) : null}
      {preview.state === "abandoned" ? (
        <>
          <p className="fg-body-sm text-muted">{t("previews.closed.abandoned")}</p>
          {preview.detail ? <p className="fg-caption text-muted">{preview.detail}</p> : null}
        </>
      ) : null}
      {preview.state === "failed" ? <FailureNote preview={preview} /> : null}
      {(preview.state === "failed" || preview.state === "abandoned") && canWrite && hasLiveRun ? (
        <div>
          <Button size="sm" variant="secondary" loading={open.isPending} onClick={() => open.mutate()}>
            {preview.state === "failed" ? t("previews.tryAgain") : t("previews.start")}
          </Button>
        </div>
      ) : null}
      {preview.state === "live" || preview.state === "starting" ? <MessageBox preview={preview} canWrite={canWrite} /> : null}
    </>
  );
}

/** Why it did not start, in the three words the criterion names and the other ways the same promise breaks. */
function FailureNote({ preview }: { preview: PreviewRecord }) {
  const t = useCopy();
  const slug = useCurrentProject()?.slug;
  if (!preview.reason) {
    // a failed preview with no reason is core's defect; say so rather than draw an empty failure
    return <Banner tone="danger">{t("previews.failed.lead")}</Banner>;
  }
  const { name, fix } = reasonLines(t, preview.reason);
  return (
    <div data-testid="preview-failure" data-reason={preview.reason} className="grid gap-1.5">
      <Banner tone="danger">
        <span className="font-medium">{name}.</span> {fix}
      </Banner>
      {preview.detail ? (
        <pre data-testid="preview-failure-detail" className="fg-caption max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-sunken p-3 font-mono text-fg">
          {preview.detail}
        </pre>
      ) : null}
      {slug && SETTINGS_REASONS.includes(preview.reason) ? (
        <a className="fg-body-sm text-link hover:underline" href={settingsHref(slug, "preview")}>
          {t("previews.failed.openSettings")}
        </a>
      ) : null}
    </div>
  );
}

/** The lane the approved change takes (fast-lane's read), and where it is not the fast one, why. */
function LaneRead({ issueId }: { issueId: string }) {
  const t = useCopy();
  const laneQ = useIssueLane(issueId, true);
  if (laneQ.isLoading) return null;
  if (laneQ.isError || !laneQ.data) {
    return <p className="fg-caption text-muted">{t("previews.lane.unread")}{laneQ.isError ? `: ${formatApiError(laneQ.error)}` : ""}</p>;
  }
  const lane = laneQ.data;
  return (
    <p data-testid="preview-lane" data-lane={lane.lane} className="fg-body-sm text-fg">
      <span className="fg-label">{t("previews.lane.title")}. </span>
      {lane.lane === "fast" ? t("previews.lane.fast") : t("previews.lane.full", { why: lane.refusal?.detail ?? "" })}
    </p>
  );
}

/** BC-6: a person asks for a change here and sees it in the same preview; writes no record, so there is nothing to refresh. */
function MessageBox({ preview, canWrite }: { preview: PreviewRecord; canWrite: boolean }) {
  const t = useCopy();
  const [text, setText] = useState("");
  const send = useSendPreviewMessage();
  if (!canWrite) return <p className="fg-caption text-muted">{t("previews.message.readOnly")}</p>;
  const submit = () => {
    const body = text.trim();
    if (!body) return;
    send.mutate({ id: preview.id, text: body }, { onSuccess: () => setText("") });
  };
  return (
    <form
      className="grid gap-2"
      aria-label={t("previews.message.label")}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Textarea
        aria-label={t("previews.message.label")}
        value={text}
        rows={2}
        maxLength={PREVIEW_LIMITS.message}
        placeholder={t("previews.message.placeholder")}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={text.trim() === ""} loading={send.isPending}>
          {t("previews.message.send")}
        </Button>
        {send.isSuccess ? (
          <span role="status" className="fg-caption text-muted">
            {t("previews.message.sent")}
          </span>
        ) : null}
      </div>
      <Refusal error={send.error} lead={t("previews.message.failed")} />
    </form>
  );
}
