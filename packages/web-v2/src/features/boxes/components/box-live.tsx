// The selected box (ISS-1276 c4, c5, c7; mockup MK-12): its head with who holds it and the one act a
// person has on it now (Take control, or Hand back while they hold it, with the idle countdown that
// hands it back for them), the live view beside the agent's command feed, and the criteria it is
// demonstrating in the footer with whether it records, why, and its clock (ISS-1321), beside the
// toggle that starts or stops it. Full screen opens the screen alone over everything (ISS-1325). A box
// that ended plays its session recording and its spans' clips there, as its own address does (ISS-1338).

import { BOX_LIMITS, type BoxRecord, type BoxSpanRecord } from "@forge/contracts/boxes";
import { useState } from "react";
import { Button, IconButton, ToneBadge, useNow } from "@/design";
import { RefusedLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { useBoxSpans, useCloseBox, useStartRecording, useStopRecording } from "../hooks";
import { clock, heldBy, isEnded, isLive, sizeOf, STATE_TONE } from "../labels";
import { FpsSelect, HoldLine, HoldMove } from "./box-controls";
import { BoxEnded } from "./box-ended";
import { BoxFeed } from "./box-feed";
import { BoxInputLayer } from "./box-input";
import { BoxScreen } from "./box-screen";
import { BoxView } from "./box-view";
const SPAN_TONE = { open: "run", cutting: "neutral", attached: "done", failed: "err" } as const;

interface LiveProps {
  box: BoxRecord;
  projectId: string;
  label: string;
  me: string | undefined;
  canWrite: boolean;
}

function BoxActs({ box, projectId, me, canWrite, fps, onFps, onFull }: LiveProps & { fps: number; onFps: (n: number) => void; onFull: () => void }) {
  const t = useCopy();
  const close = useCloseBox(projectId);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {isLive(box) ? <FpsSelect fps={fps} onFps={onFps} /> : null}
      {isLive(box) ? <IconButton icon="maximize" size="sm" variant="secondary" aria-label={t("boxes.screen.full")} title={t("boxes.screen.full")} onClick={onFull} data-testid="box-full" /> : null}
      {canWrite ? <HoldMove box={box} projectId={projectId} me={me} /> : null}
      {canWrite && isLive(box) ? <RecordToggle box={box} projectId={projectId} /> : null}
      {canWrite && !isEnded(box) ? (
        <Button size="sm" variant="ghost" loading={close.isPending} onClick={() => close.mutate(box.id)}>
          {t("boxes.live.close")}
        </Button>
      ) : null}
      <RefusedLine label={t("boxes.live.close.failed")} error={close.error} className="basis-full text-12 text-danger-11" />
    </div>
  );
}

/** Start or stop the box's recording: its holder or a project writer (ISS-1321). */
function RecordToggle({ box, projectId }: { box: BoxRecord; projectId: string }) {
  const t = useCopy();
  const start = useStartRecording(projectId);
  const stop = useStopRecording(projectId);
  const on = box.recording?.state === "recording";
  const move = on ? stop : start;
  return (
    <>
      <Button size="sm" variant="ghost" loading={move.isPending} onClick={() => move.mutate(box.id)} data-testid="box-record-toggle" aria-pressed={on}>
        {t(on ? "boxes.rec.stop" : "boxes.rec.start")}
      </Button>
      <RefusedLine label={t("boxes.rec.failed")} error={move.error} className="basis-full text-12 text-danger-11" />
    </>
  );
}

function SpanChip({ span }: { span: BoxSpanRecord }) {
  const t = useCopy();
  return (
    <span className="inline-flex items-center gap-1.5" data-testid="box-span" data-state={span.state}>
      <ToneBadge tone={SPAN_TONE[span.state]} label={t(`boxes.span.${span.state}`)} title={t(`boxes.span.${span.state}`)} value={span.state} />
      {t("boxes.row.criterion", { n: span.criterion })}
    </span>
  );
}

/** Whether the box records, its clock and why (ISS-1321), read at a glance in the box's head. */
function RecordingLine({ box }: { box: BoxRecord }) {
  const t = useCopy();
  const on = box.recording?.state === "recording";
  const recording = on && box.recording?.startedAt ? box.recording.startedAt : null;
  const why = on && box.recording?.why ? t(`boxes.rec.why.${box.recording.why}`) : null;
  const now = useNow(1000, !!recording && isLive(box));
  if (!isLive(box) && !on) return null;
  return (
    <span className={`text-12 tabular-nums ${on ? "text-danger-11" : "text-muted"}`} data-testid="box-recording" data-on={on} data-why={on ? (box.recording?.why ?? "") : undefined}>
      {on ? [`● ${recording ? t("boxes.foot.recording", { at: clock(now - Date.parse(recording)) }) : t("boxes.rec.on")}`, why].filter(Boolean).join(" · ") : t("boxes.rec.off")}
    </span>
  );
}

function BoxFoot({ box }: { box: BoxRecord }) {
  const spans = useBoxSpans(box.id).data ?? [];
  return (
    <footer className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line-subtle px-3 py-2 text-12 text-muted empty:hidden" data-testid="box-foot">
      {spans.map((s) => (
        <SpanChip key={s.id} span={s} />
      ))}
    </footer>
  );
}

export function BoxLive(props: LiveProps) {
  const { box, label, me } = props;
  const t = useCopy();
  const [fps, setFps] = useState<number>(BOX_LIMITS.viewFpsDefault);
  const [localInput, setLocalInput] = useState(0);
  // in full screen the page's own view lets go of its sockets: the screen enters with its own tickets
  const [full, setFull] = useState(false);
  const mine = heldBy(box, me);
  const meta = [t(`boxes.mode.${box.mode}`), sizeOf(box), box.criterion ? t("boxes.row.criterion", { n: box.criterion }) : null].filter(Boolean).join(" · ");
  return (
    <section aria-label={label} className="min-w-0" data-testid="box-live" data-state={box.state}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line-subtle px-3 py-2">
        <h2 className="text-14 font-semibold">{label}</h2>
        <ToneBadge tone={STATE_TONE[box.state]} label={t(`boxes.state.${box.state}`)} title={t(`boxes.state.${box.state}`)} value={box.state} pulse={isLive(box)} />
        <span className="text-12 text-muted">{meta}</span>
        {isLive(box) && !mine ? <span className="text-12 text-muted">{t("boxes.live.watchOnly")}</span> : null}
        <RecordingLine box={box} />
        <span className="flex-1" />
        <BoxActs {...props} fps={fps} onFps={setFps} onFull={() => setFull(true)} />
        <span className="basis-full empty:hidden">
          <HoldLine box={box} me={me} localInput={localInput} />
        </span>
      </header>
      <div className="grid min-w-0 lg:grid-cols-3">
        <div className="min-w-0 p-3 lg:col-span-2">
          {full ? (
            <BoxScreen {...props} fps={fps} onFps={setFps} enter onExit={() => setFull(false)} />
          ) : isLive(box) ? (
            <BoxView box={box} label={label} fps={fps} overlay={mine ? <BoxInputLayer box={box} label={label} onInput={() => setLocalInput(Date.now())} /> : undefined} />
          ) : isEnded(box) ? (
            <BoxEnded box={box} label={label} />
          ) : (
            <p className="py-8 text-center text-13 text-muted">{t("boxes.live.notRunning")}</p>
          )}
        </div>
        <div className="min-w-0 border-line-subtle px-3 py-2 max-lg:border-t lg:border-l">
          <BoxFeed box={box} />
        </div>
      </div>
      <BoxFoot box={box} />
    </section>
  );
}
