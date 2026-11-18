// The controls a box's live view keeps wherever it is drawn (ISS-1276 c5, ISS-1325): on the Boxes
// page, in full screen and at the box's own address. Who holds it and the idle countdown, the frame
// rate, and Take control or Hand back, each through the same doors as everywhere else.

import { BOX_LIMITS, type BoxRecord } from "@forge/contracts/boxes";
import { Button, NativeSelect, useNow } from "@/design";
import { RefusedLine } from "@/lib/api/refusal-line";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { useBoxActs, useReleaseBox, useTakeBox } from "../hooks";
import { clock, heldBy, holderWords } from "../labels";

export const FPS_CHOICES = [5, 10, 20, 30].filter((n) => n >= BOX_LIMITS.viewFpsMin && n <= BOX_LIMITS.viewFpsMax);

/** When an idle hold goes back to the agent: the hold's last input (the person's newest act, or this page's own), plus the idle limit. */
function useHoldDeadline(box: BoxRecord, localInput: number) {
  const acts = useBoxActs(box.id).data ?? [];
  const lastPerson = acts.reduce((at, a) => (a.by === "person" ? Math.max(at, Date.parse(a.at)) : at), 0);
  const since = box.heldSince ? Date.parse(box.heldSince) : 0;
  return Math.max(since, lastPerson, localInput) + BOX_LIMITS.holdIdleSeconds * 1000;
}

/** Who holds the box and since when, and when an idle hold goes back to the agent; nothing unless a person holds it. */
export function HoldLine({ box, me, localInput }: { box: BoxRecord; me: string | undefined; localInput: number }) {
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

/** This viewer's own frame rate for the view. */
export function FpsSelect({ fps, onFps }: { fps: number; onFps: (n: number) => void }) {
  const t = useCopy();
  return (
    <div className="w-24 flex-none">
      <NativeSelect
        aria-label={t("boxes.live.fpsLabel")}
        className="py-1 text-12"
        value={String(fps)}
        onChange={(e) => onFps(Number(e.target.value))}
        options={FPS_CHOICES.map((n) => ({ value: String(n), label: t("boxes.live.fps", { n }) }))}
      />
    </div>
  );
}

/** Take control while the agent holds the box, or Hand back while this person does; a refusal says why where it happened. */
export function HoldMove({ box, projectId, me }: { box: BoxRecord; projectId: string; me: string | undefined }) {
  const t = useCopy();
  const take = useTakeBox(projectId);
  const release = useReleaseBox(projectId);
  return (
    <>
      {box.state === "agent" ? (
        <Button size="sm" variant="primary" loading={take.isPending} onClick={() => take.mutate(box.id)}>
          {t("boxes.live.take")}
        </Button>
      ) : null}
      {heldBy(box, me) ? (
        <Button size="sm" variant="primary" loading={release.isPending} onClick={() => release.mutate(box.id)}>
          {t("boxes.live.handBack")}
        </Button>
      ) : null}
      <RefusedLine label={t("boxes.live.take.failed")} error={take.error} className="basis-full text-12 text-danger-11" />
      <RefusedLine label={t("boxes.live.handBack.failed")} error={release.error} className="basis-full text-12 text-danger-11" />
    </>
  );
}
