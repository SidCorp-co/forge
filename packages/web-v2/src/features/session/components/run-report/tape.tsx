import { cn } from "@/lib/utils/cn";

import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import type { TapeTick } from "../../run-report";

const TICK_TONE: Record<TapeTick, string> = {
  prose: "bg-line-strong",
  tool: "bg-info-9",
  edit: "bg-accent-9",
  err: "bg-danger-9",
  think: "bg-neutral-7",
};

const TICK_LABEL: Record<TapeTick, ProductCopyKey> = {
  prose: "runs.tape.prose",
  tool: "runs.tape.tool",
  edit: "runs.tape.edit",
  err: "runs.tape.err",
  think: "runs.tape.think",
};

export function Tape({ ticks }: { ticks: TapeTick[] }) {
  const t = useCopy();
  const time = useTimeFormat();
  if (ticks.length === 0) return null;
  // the tape IS the event order: a tick is its kind and which tick of that kind it is
  const seen = new Map<TapeTick, number>();
  const keyed = ticks.map((tick) => {
    const nth = (seen.get(tick) ?? 0) + 1;
    seen.set(tick, nth);
    return { tick, key: `${tick}#${nth}` };
  });
  return (
    <div
      className="flex w-3.5 flex-col gap-px self-stretch rounded-sm bg-sunken p-0.5"
      aria-label={t("runs.tape.label", { n: time.number(ticks.length) })}
      role="img"
    >
      {keyed.map(({ tick, key }) => (
        <i
          key={key}
          className={cn("block min-h-px flex-1 rounded-1", TICK_TONE[tick])}
          title={t(TICK_LABEL[tick])}
        />
      ))}
    </div>
  );
}
