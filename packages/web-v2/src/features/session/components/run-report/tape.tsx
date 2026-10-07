
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import type { TapeTick } from "../../run-report";

const TICK_COLOR: Record<TapeTick, string> = {
  prose: "var(--border-strong)",
  tool: "var(--cobalt-500)",
  edit: "var(--flame-500)",
  err: "var(--red-500)",
  think: "var(--paper-300)",
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
  return (
    <div
      className="flex w-3.5 flex-col gap-px self-stretch rounded-sm bg-sunken p-0.5"
      aria-label={t("runs.tape.label", { n: time.number(ticks.length) })}
      role="img"
    >
      {ticks.map((tick, i) => (
        <i
          // biome-ignore lint/suspicious/noArrayIndexKey: the tape IS the event order; there is no other identity
          key={i}
          className="block min-h-px flex-1 rounded-1"
          style={{ background: TICK_COLOR[tick] }}
          title={t(TICK_LABEL[tick])}
        />
      ))}
    </div>
  );
}
