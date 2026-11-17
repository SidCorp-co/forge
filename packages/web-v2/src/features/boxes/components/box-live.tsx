// The selected box (ISS-1276 c4, c5, c7; mockup MK-12): its head with who holds it and the one act a
// person has on it now (Take control, or Hand back while they hold it, with the idle countdown that
// hands it back for them), the live view beside the agent's command feed, and the criteria it is
// demonstrating in the footer with its recording's clock.

import { BOX_LIMITS, type BoxRecord, type BoxSpanRecord } from "@forge/contracts/boxes";
import { useState } from "react";
import { Button, NativeSelect, ToneBadge, useNow } from "@/design";
import { RefusedLine } from "@/lib/api/refusal-line";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { useBoxActs, useBoxSpans, useCloseBox, useReleaseBox, useTakeBox } from "../hooks";
import { clock, heldBy, holderWords, isEnded, isLive, sizeOf, STATE_TONE } from "../labels";
import { BoxFeed } from "./box-feed";
import { BoxInputLayer } from "./box-input";
import { BoxView } from "./box-view";

const FPS_CHOICES = [5, 10, 20, 30].filter((n) => n >= BOX_LIMITS.viewFpsMin && n <= BOX_LIMITS.viewFpsMax);
const SPAN_TONE = { open: "run", cutting: "neutral", attached: "done", failed: "err" } as const;

interface LiveProps {
  box: BoxRecord;
  projectId: string;
  label: string;
  me: string | undefined;
  canWrite: boolean;
}

/** When an idle hold goes back to the agent: the hold's last input (the person's newest act, or this page's own), plus the idle limit. */
function useHoldDeadline(box: BoxRecord, localInput: number) {
  const acts = useBoxActs(box.id).data ?? [];
  const lastPerson = acts.reduce((at, a) => (a.by === "person" ? Math.max(at, Date.parse(a.at)) : at), 0);
  const since = box.heldSince ? Date.parse(box.heldSince) : 0;
  return Math.max(since, lastPerson, localInput) + BOX_LIMITS.holdIdleSeconds * 1000;
}

function HoldLine({ box, me, localInput }: { box: BoxRecord; me: string | undefined; localInput: number }) {
  const t = useCopy();
  const time = useTimeFormat();
  const now = useNow(1000, box.state === "person");
  const deadline = useHoldDeadline(box, localInput);
  if (box.state !== "person" || !box.heldSince) return null;
  return (
    <span className="flex flex-wrap gap-x-3 text-12 text-muted" data-testid="box-hold">
      <span data-testid="box-held-by">{t("boxes.live.heldBy", { name: holderWords(box, me, t) ?? "", since: time.clock(box.heldSince) })}</span>
      <span className="tabular-nums text-warn-11" data-testid="box-idle">
        {t("boxes.live.idle", { left: clock(deadline - now) })}
      </span>
    </span>
  );
}

function BoxActs({ box, projectId, me, canWrite, fps, onFps }: LiveProps & { fps: number; onFps: (n: number) => void }) {
  const t = useCopy();
  const take = useTakeBox(projectId);
  const release = useReleaseBox(projectId);
  const close = useCloseBox(projectId);
  const mine = heldBy(box, me);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {isLive(box) ? (
        <div className="w-24 flex-none">
          <NativeSelect
            aria-label={t("boxes.live.fpsLabel")}
            className="py-1 text-12"
            value={String(fps)}
            onChange={(e) => onFps(Number(e.target.value))}
            options={FPS_CHOICES.map((n) => ({ value: String(n), label: t("boxes.live.fps", { n }) }))}
          />
        </div>
      ) : null}
      {canWrite && box.state === "agent" ? (
        <Button size="sm" variant="primary" loading={take.isPending} onClick={() => take.mutate(box.id)}>
          {t("boxes.live.take")}
        </Button>
      ) : null}
      {canWrite && mine ? (
        <Button size="sm" variant="primary" loading={release.isPending} onClick={() => release.mutate(box.id)}>
          {t("boxes.live.handBack")}
        </Button>
      ) : null}
      {canWrite && !isEnded(box) ? (
        <Button size="sm" variant="ghost" loading={close.isPending} onClick={() => close.mutate(box.id)}>
          {t("boxes.live.close")}
        </Button>
      ) : null}
      <RefusedLine label={t("boxes.live.take.failed")} error={take.error} className="basis-full text-12 text-danger-11" />
      <RefusedLine label={t("boxes.live.handBack.failed")} error={release.error} className="basis-full text-12 text-danger-11" />
      <RefusedLine label={t("boxes.live.close.failed")} error={close.error} className="basis-full text-12 text-danger-11" />
    </div>
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

function BoxFoot({ box }: { box: BoxRecord }) {
  const t = useCopy();
  const spans = useBoxSpans(box.id).data ?? [];
  const recording = box.recording?.state === "recording" && box.recording.startedAt ? box.recording.startedAt : null;
  const now = useNow(1000, !!recording && isLive(box));
  return (
    <footer className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line-subtle px-3 py-2 text-12 text-muted" data-testid="box-foot">
      {spans.map((s) => (
        <SpanChip key={s.id} span={s} />
      ))}
      <span className="flex-1" />
      {recording ? <span className="tabular-nums">{`● ${t("boxes.foot.recording", { at: clock(now - Date.parse(recording)) })}`}</span> : null}
    </footer>
  );
}

export function BoxLive(props: LiveProps) {
  const { box, label, me } = props;
  const t = useCopy();
  const [fps, setFps] = useState<number>(BOX_LIMITS.viewFpsDefault);
  const [localInput, setLocalInput] = useState(0);
  const mine = heldBy(box, me);
  const meta = [t(`boxes.mode.${box.mode}`), sizeOf(box), box.criterion ? t("boxes.row.criterion", { n: box.criterion }) : null].filter(Boolean).join(" · ");
  return (
    <section aria-label={label} className="min-w-0" data-testid="box-live" data-state={box.state}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line-subtle px-3 py-2">
        <h2 className="text-14 font-semibold">{label}</h2>
        <ToneBadge tone={STATE_TONE[box.state]} label={t(`boxes.state.${box.state}`)} title={t(`boxes.state.${box.state}`)} value={box.state} pulse={isLive(box)} />
        <span className="text-12 text-muted">{meta}</span>
        {isLive(box) && !mine ? <span className="text-12 text-muted">{t("boxes.live.watchOnly")}</span> : null}
        <span className="flex-1" />
        <BoxActs {...props} fps={fps} onFps={setFps} />
        <span className="basis-full empty:hidden">
          <HoldLine box={box} me={me} localInput={localInput} />
        </span>
      </header>
      <div className="grid min-w-0 lg:grid-cols-3">
        <div className="min-w-0 p-3 lg:col-span-2">
          {isLive(box) ? (
            <BoxView box={box} label={label} fps={fps} overlay={mine ? <BoxInputLayer box={box} label={label} onInput={() => setLocalInput(Date.now())} /> : undefined} />
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
