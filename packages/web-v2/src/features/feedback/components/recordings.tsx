"use client";

// What a reproduce recorded for this item, on the item's page (REQ-41 BC-18, BC-21): beside the
// Reproduce entry and the fix's confirm (`previews/reproduce-section.tsx`), every recording as a flat
// row, its timeline as a table of what was done and what the page logged, and a replay of its
// scrubbed events with rrweb's own player while they are kept. Members only: core refuses anyone
// else by name, RECORDING_FORBIDDEN, and that refusal is what this draws.

import type { RecordingRecord } from "@forge/contracts/reproduce";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button, ViewHeading } from "@/design";
import { reproduceApi } from "@/features/previews/reproduce-api";
import { ReproduceSection, recordingsKey } from "@/features/previews/reproduce-section";
import { TimelineTable } from "@/features/previews/reproduce-timeline";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { FeedbackView } from "../types";

/** While a recording is still taking batches its row is read again on this clock. */
const RECORDING_POLL_MS = 10_000;

/** The Reproduce entry, the fix's confirm and the recordings, as one section of the item's overview. */
export function FeedbackRecordings({ projectId, f }: { projectId: string; f: FeedbackView }) {
  const carriers =
    f.route?.route === "issue" ? f.route.carriers.flatMap((c) => (c.key ? [c.key] : [])) : [];
  return (
    <div className="grid gap-6">
      <ReproduceSection projectId={projectId} fbKey={f.key} carriers={carriers} redacted={f.redacted} />
      <Recordings projectId={projectId} f={f} />
    </div>
  );
}

export function Recordings({ projectId, f }: { projectId: string; f: FeedbackView }) {
  const t = useCopy();
  const time = useTimeFormat();
  const q = useQuery({
    queryKey: recordingsKey(projectId, f.key),
    queryFn: () => reproduceApi.recordings(projectId, f.key),
    refetchInterval: (query) => (query.state.data?.some((r) => r.state === "recording") ? RECORDING_POLL_MS : false),
  });
  const [openId, setOpenId] = useState<string | null>(null);
  const recordings = q.data ?? [];
  const open = recordings.find((r) => r.id === openId) ?? recordings[0] ?? null;
  const by = (r: RecordingRecord) => (r.recordedBy === f.reporter.id ? (f.reporter.name ?? t("previews.recordings.reporter")) : t("previews.recordings.member"));

  return (
    <section aria-label={t("previews.recordings.title")} data-testid="recordings" className="grid gap-3">
      <ViewHeading>{t("previews.recordings.title")}</ViewHeading>
      {q.isError ? (
        <p role="alert" className="fg-body-sm" style={{ color: "var(--red-600)" }}>
          {t("previews.recordings.loadFailed")}: {formatApiError(q.error)}
        </p>
      ) : null}
      {q.isSuccess && recordings.length === 0 ? <p className="fg-body-sm text-muted">{t("previews.recordings.none", { fb: f.key })}</p> : null}
      {recordings.length > 0 ? (
        <table className="w-full border-collapse text-13" data-testid="recordings-table">
          <thead>
            <tr className="border-b border-line text-left text-muted">
              <th className="py-1.5 pr-3 font-medium">{t("previews.recordings.col.started")}</th>
              <th className="py-1.5 pr-3 font-medium">{t("previews.recordings.col.by")}</th>
              <th className="py-1.5 pr-3 font-medium">{t("previews.recordings.col.build")}</th>
              <th className="py-1.5 pr-3 font-medium">{t("previews.recordings.col.state")}</th>
              <th className="py-1.5 font-medium" />
            </tr>
          </thead>
          <tbody>
            {recordings.map((r) => (
              <tr key={r.id} className="border-b border-line-subtle" data-testid="recording-row" data-state={r.state} aria-current={open?.id === r.id ? "true" : undefined}>
                <td className="py-1.5 pr-3" title={time.dateTime(r.startedAt)}>
                  {time.relative(r.startedAt)}
                </td>
                <td className="py-1.5 pr-3">{by(r)}</td>
                <td className="py-1.5 pr-3 font-mono">{r.build.release ?? r.build.sha.slice(0, 12)}</td>
                <td className="py-1.5 pr-3">
                  {t(`previews.recordings.state.${r.state}`)}
                  {r.reason ? <span className="text-muted"> · {t(`previews.recordings.reason.${r.reason}`)}</span> : null}
                </td>
                <td className="py-1.5 text-right">
                  {open?.id === r.id ? null : (
                    <Button size="sm" variant="ghost" onClick={() => setOpenId(r.id)}>
                      {t("previews.recordings.show")}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {open ? <RecordingDetail recording={open} projectId={projectId} fbKey={f.key} /> : null}
    </section>
  );
}

function RecordingDetail({ recording, projectId, fbKey }: { recording: RecordingRecord; projectId: string; fbKey: string }) {
  const t = useCopy();
  const qc = useQueryClient();
  const stop = useMutation({
    mutationFn: () => reproduceApi.stop(recording.id),
    onSettled: () => qc.invalidateQueries({ queryKey: recordingsKey(projectId, fbKey) }),
  });
  const replayable = recording.state === "stopped" || recording.state === "recording" || recording.state === "failed";
  return (
    <div className="grid gap-3" data-testid="recording-detail" data-recording={recording.id}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="fg-label text-fg">{t("previews.recordings.timeline")}</h3>
        <span className="min-w-0 flex-1" />
        {recording.state === "recording" ? (
          <Button size="sm" variant="secondary" loading={stop.isPending} onClick={() => stop.mutate()}>
            {t("previews.recordings.stop")}
          </Button>
        ) : null}
      </div>
      {stop.error ? (
        <p role="alert" className="fg-body-sm" style={{ color: "var(--red-600)" }}>
          {t("previews.recordings.stopFailed")}: {formatApiError(stop.error)}
        </p>
      ) : null}
      {recording.timeline.length === 0 ? (
        <p className="fg-body-sm text-muted">{t("previews.recordings.timelineEmpty")}</p>
      ) : (
        <TimelineTable entries={recording.timeline} />
      )}
      {recording.state === "expired" ? <p className="fg-caption text-muted">{t("previews.recordings.expired")}</p> : null}
      {recording.state === "redacted" ? <p className="fg-caption text-muted">{t("previews.recordings.redacted")}</p> : null}
      {replayable && recording.events > 0 ? <Replay recordingId={recording.id} /> : null}
    </div>
  );
}

/** rrweb's own player over the scrubbed events (buy before build): it replays in a sandboxed frame of its own, scripts off. */
function Replay({ recordingId }: { recordingId: string }) {
  const t = useCopy();
  const [asked, setAsked] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const eventsQ = useQuery({
    queryKey: ["recordings", "events", recordingId],
    queryFn: () => reproduceApi.events(recordingId),
    enabled: asked,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [failure, setFailure] = useState<unknown>(null);

  useEffect(() => {
    const el = root.current;
    const events = eventsQ.data;
    if (!el || !events) return;
    let player: { destroy(): void } | null = null;
    let current = true;
    setFailure(null);
    import("rrweb")
      .then(({ Replayer }) => {
        if (!current) return;
        const replayer = new Replayer(events as unknown as ConstructorParameters<typeof Replayer>[0], { root: el, mouseTail: false, showWarning: false });
        player = replayer;
        replayer.play();
      })
      .catch((err: unknown) => current && setFailure(err));
    return () => {
      current = false;
      player?.destroy();
      el.replaceChildren();
    };
  }, [eventsQ.data]);

  if (!asked) {
    return (
      <div>
        <Button size="sm" variant="secondary" onClick={() => setAsked(true)} data-testid="recording-replay">
          {t("previews.recordings.replay")}
        </Button>
      </div>
    );
  }
  const problem = eventsQ.error ?? failure;
  return (
    <div className="grid gap-2" data-testid="recording-player">
      {problem ? (
        <p role="alert" className="fg-body-sm" style={{ color: "var(--red-600)" }}>
          {t("previews.recordings.replayFailed")}: {formatApiError(problem)}
        </p>
      ) : null}
      {eventsQ.isLoading ? <p role="status" className="fg-body-sm text-muted">{t("previews.recordings.replayLoading")}</p> : null}
      <div ref={root} className="max-w-full overflow-auto rounded-md border border-line bg-surface" />
    </div>
  );
}

