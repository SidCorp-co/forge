"use client";

// An item's recordings as one list (REQ-35 BC-8, REQ-41 BC-18, BC-21; Feedback lifecycle step
// `evidence`): a video someone attached and a recording a reproduce made are rows of the same table,
// newest first, each naming who made it, with one player below. An attached video plays in the page;
// a reproduce recording reads as its timeline, the text a screen reader reads for it, and replays its
// scrubbed events with rrweb's own player while they are kept. Reproduce recordings are for members
// only: core refuses anyone else by name, RECORDING_FORBIDDEN, and that refusal is what this draws.

import type { RecordingRecord } from "@forge/contracts/reproduce";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { Button, ViewHeading, Table, THead, TBody, TR, TH, TD } from "@/design";
import { formatSize } from "@/features/attachments";
import { reproduceApi } from "@/features/previews";
import { recordingsKey } from "@/features/previews";
import { Timeline } from "@/features/previews";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { coreFileUrl } from "@/lib/utils/core-url";
import { useItemRecordings } from "../hooks";
import type { FeedbackView } from "../types";

type Attachment = FeedbackView["attachments"][number];

/** One row of the list: a video attached to the item, or a recording a reproduce made. */
type RecordingRow =
  | { kind: "upload"; id: string; at: string; by: string; file: Attachment }
  | { kind: "reproduce"; id: string; at: string; by: string; recording: RecordingRecord };

/** The videos attached to an item, which are its recordings as much as a reproduce's are. */
export const uploadedRecordings = (f: FeedbackView): Attachment[] => f.attachments.filter((a) => a.mime.startsWith("video/"));

/** Both kinds in one list, newest first. */
function rowsOf(f: FeedbackView, recordings: readonly RecordingRecord[]): RecordingRow[] {
  const rows: RecordingRow[] = [
    ...uploadedRecordings(f).map((file): RecordingRow => ({ kind: "upload", id: file.id, at: file.createdAt, by: file.uploadedBy, file })),
    ...recordings.map((recording): RecordingRow => ({ kind: "reproduce", id: recording.id, at: recording.startedAt, by: recording.recordedBy, recording })),
  ];
  return rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export function Recordings({ projectId, f }: { projectId: string; f: FeedbackView }) {
  const t = useCopy();
  const time = useTimeFormat();
  const q = useItemRecordings(projectId, f.key);
  const [openId, setOpenId] = useState<string | null>(null);
  const rows = rowsOf(f, q.data ?? []);
  const open = rows.find((r) => r.id === openId) ?? rows[0] ?? null;
  const by = (r: RecordingRow) => {
    if (r.by === f.reporter.id) return f.reporter.name ?? t("previews.recordings.reporter");
    return (r.kind === "upload" ? r.file.uploadedByName : null) ?? t("previews.recordings.member");
  };
  const alt = (r: RecordingRow) => t("feedback.evidence.recordingAlt", { n: rows.indexOf(r) + 1, of: rows.length, key: f.key, title: f.title });

  return (
    <section aria-label={t("previews.recordings.title")} data-testid="recordings" className="grid gap-3">
      <ViewHeading>{t("previews.recordings.title")}</ViewHeading>
      {q.isError ? (
        <p role="alert" className="fg-body-sm text-danger-11">
          {t("previews.recordings.loadFailed")}: {formatApiError(q.error)}
        </p>
      ) : null}
      {rows.length > 0 ? (
        <Table className="w-full border-collapse text-13" data-testid="recordings-table">
          <THead>
            <TR className="border-b border-line text-left text-muted">
              <TH className="py-1.5 pr-3 font-medium">{t("previews.recordings.col.started")}</TH>
              <TH className="py-1.5 pr-3 font-medium">{t("previews.recordings.col.by")}</TH>
              <TH className="py-1.5 pr-3 font-medium max-md:hidden">{t("previews.recordings.col.build")}</TH>
              <TH className="py-1.5 pr-3 font-medium">{t("previews.recordings.col.state")}</TH>
              <TH className="py-1.5 font-medium" />
            </TR>
          </THead>
          <TBody>
            {rows.map((r) => (
              <TR
                key={r.id}
                className="border-b border-line-subtle"
                data-testid="recording-row"
                data-kind={r.kind}
                data-state={r.kind === "reproduce" ? r.recording.state : undefined}
                aria-current={open?.id === r.id ? "true" : undefined}
              >
                <TD className="py-1.5 pr-3" title={time.dateTime(r.at)}>
                  {time.relative(r.at)}
                </TD>
                <TD className="py-1.5 pr-3">{by(r)}</TD>
                <TD className="py-1.5 pr-3 font-mono max-md:hidden">{r.kind === "reproduce" ? (r.recording.build.release ?? r.recording.build.sha.slice(0, 12)) : null}</TD>
                <TD className="py-1.5 pr-3">
                  {r.kind === "upload" ? <RecordingFile file={r.file} /> : <ReproduceState recording={r.recording} />}
                </TD>
                <TD className="py-1.5 text-right">
                  {open?.id === r.id ? null : (
                    <Button size="sm" variant="ghost" onClick={() => setOpenId(r.id)}>
                      {t("previews.recordings.show")}
                    </Button>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : null}
      {open?.kind === "upload" ? <UploadedVideo key={open.file.id} file={open.file} alt={alt(open)} /> : null}
      {open?.kind === "reproduce" ? <RecordingDetail recording={open.recording} projectId={projectId} fbKey={f.key} /> : null}
    </section>
  );
}

function ReproduceState({ recording }: { recording: RecordingRecord }) {
  const t = useCopy();
  return (
    <>
      {t(`previews.recordings.state.${recording.state}`)}
      {recording.reason ? <span className="text-muted"> · {t(`previews.recordings.reason.${recording.reason}`)}</span> : null}
    </>
  );
}

/** A file's type as a person names it: its format, not its media type. */
const FORMATS: Record<string, string> = { "video/mp4": "MP4", "video/webm": "WebM", "video/quicktime": "MOV" };
export const formatOf = (mime: string) => FORMATS[mime] ?? (mime.split("/")[1] ?? mime).toUpperCase();

/** A length in seconds as m:ss, or h:mm:ss past the hour. */
export function clockOf(seconds: number): string {
  const s = Math.round(seconds);
  const mmss = `${Math.floor((s % 3600) / 60)}:${String(s % 60).padStart(2, "0")}`;
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mmss.padStart(5, "0")}` : mmss;
}

/** How long a video runs, read from its metadata alone; null until read, or where it cannot be. */
function useVideoLength(src: string): number | null {
  const [length, setLength] = useState<number | null>(null);
  useEffect(() => {
    const v = document.createElement("video");
    v.preload = "metadata";
    const read = () => setLength(Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null);
    v.addEventListener("loadedmetadata", read);
    v.src = src;
    return () => {
      v.removeEventListener("loadedmetadata", read);
      v.removeAttribute("src");
    };
  }, [src]);
  return length;
}

/** An attached video's row facts: its name, then its format, size and length. */
function RecordingFile({ file }: { file: Attachment }) {
  const length = useVideoLength(coreFileUrl(file.url));
  const facts = [formatOf(file.mime), formatSize(file.size), ...(length === null ? [] : [clockOf(length)])];
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2" data-testid="recording-file">
      <span className="min-w-0 truncate font-mono">{file.name}</span>
      <span className="text-muted">{facts.join(" · ")}</span>
    </span>
  );
}

/**
 * A video attached to the item, played in the page and read by its text alternative. One this browser
 * cannot decode, or decodes with no picture, is said so with a way to download it, never a black box.
 */
/** A recording attached with no captions file carries its text alternative as one caption over its whole length. */
function captionsOf(alt: string): string {
  return `data:text/vtt;charset=utf-8,${encodeURIComponent(`WEBVTT\n\n00:00:00.000 --> 99:59:59.000\n${alt}\n`)}`;
}

function UploadedVideo({ file, alt }: { file: Attachment; alt: string }) {
  const t = useCopy();
  const [unplayable, setUnplayable] = useState(false);
  const src = coreFileUrl(file.url);
  return (
    <div className="grid gap-3" data-testid="recording-detail" data-recording={file.id}>
      {unplayable ? (
        <p role="status" className="fg-body-sm text-muted" data-testid="recording-unplayable">
          {t("feedback.evidence.unplayable", { format: formatOf(file.mime) })}{" "}
          <a href={src} download={file.name} className="font-semibold text-link hover:underline">
            {t("feedback.evidence.download", { name: file.name })}
          </a>
        </p>
      ) : (
        <video
          src={src}
          controls
          preload="metadata"
          aria-label={alt}
          className="max-h-105 w-full max-w-180 rounded-md border border-line bg-black"
          data-testid="recording-video"
          onError={() => setUnplayable(true)}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (v.videoWidth === 0 && v.videoHeight === 0) setUnplayable(true);
          }}
        >
          <track kind="captions" src={captionsOf(alt)} label={alt} />
        </video>
      )}
    </div>
  );
}

function RecordingDetail({ recording, projectId, fbKey }: { recording: RecordingRecord; projectId: string; fbKey: string }) {
  const t = useCopy();
  const qc = useQueryClient();
  const timelineId = useId();
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
        <p role="alert" className="fg-body-sm text-danger-11">
          {t("previews.recordings.stopFailed")}: {formatApiError(stop.error)}
        </p>
      ) : null}
      <div id={timelineId}>
        {recording.timeline.length === 0 ? (
          <p className="fg-body-sm text-muted">{t("previews.recordings.timelineEmpty")}</p>
        ) : (
          <Timeline entries={recording.timeline} />
        )}
      </div>
      {recording.state === "expired" ? <p className="fg-caption text-muted">{t("previews.recordings.expired")}</p> : null}
      {recording.state === "redacted" ? <p className="fg-caption text-muted">{t("previews.recordings.redacted")}</p> : null}
      {replayable && recording.events > 0 ? <Replay recordingId={recording.id} describedBy={timelineId} /> : null}
    </div>
  );
}

/** rrweb's own player over the scrubbed events (buy before build): it replays in a sandboxed frame of its own, scripts off. */
function Replay({ recordingId, describedBy }: { recordingId: string; describedBy: string }) {
  const t = useCopy();
  const [asked, setAsked] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const eventsQ = useQuery({
    queryKey: ["recordings", "events", recordingId],
    queryFn: () => reproduceApi.events(recordingId),
    enabled: asked,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [failure, setFailure] = useState<unknown>(null);

  useEffect(() => {
    const el = rootRef.current;
    const events = eventsQ.data;
    if (!el || !events) return;
    let player: { destroy(): void } | null = null;
    let current = true;
    setFailure(null);
    import("rrweb")
      .then(({ Replayer }) => {
        if (!current) return;
        const replayer = new Replayer(events, { root: el, mouseTail: false, showWarning: false });
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
        <p role="alert" className="fg-body-sm text-danger-11">
          {t("previews.recordings.replayFailed")}: {formatApiError(problem)}
        </p>
      ) : null}
      {eventsQ.isLoading ? <p role="status" className="fg-body-sm text-muted">{t("previews.recordings.replayLoading")}</p> : null}
      <figure
        ref={rootRef}
        aria-label={t("previews.recordings.replayAlt")}
        aria-describedby={describedBy}
        className="m-0 max-w-full overflow-auto rounded-md border border-line bg-surface"
      />
    </div>
  );
}
