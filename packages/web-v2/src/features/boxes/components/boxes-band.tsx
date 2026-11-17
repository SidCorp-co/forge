// The Boxes overview (ISS-1276 c7; REQ-43 r3 BC-14): how many boxes run, how many a person holds and
// how many wait, and the flow of them by state in their rows' tones, counted over the very records
// the list and queue below draw (L-57). A box's state is its state now and core serves no history of
// it, so the band draws no chart.

import { BOX_STATES, type BoxRecord } from "@forge/contracts/boxes";
import { OverviewBand } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { isRunning, STATE_TONE } from "../labels";

export function BoxesBand({ boxes }: { boxes: readonly BoxRecord[] }) {
  const t = useCopy();
  const count = (state: string) => boxes.filter((b) => b.state === state).length;
  return (
    <OverviewBand
      label={t("boxes.band.label")}
      testId="boxes-band"
      figures={[
        { key: "running", value: boxes.filter(isRunning).length, label: t("boxes.figure.running") },
        { key: "held", value: count("person"), label: t("boxes.figure.held") },
        { key: "waiting", value: count("waiting"), label: t("boxes.figure.waiting") },
      ]}
      flow={BOX_STATES.map((s) => ({ key: s, label: t(`boxes.state.${s}`), count: count(s), tone: STATE_TONE[s] }))}
    />
  );
}
