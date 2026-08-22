// The session tape — one tick per transcript event, in order. Reading it is
// the fastest way to see the SHAPE of a run: where the errors cluster, whether
// the agent read for two minutes before writing anything.
//
// Ticks share the column height (`flex-1`) rather than carrying a fixed one, so
// a 40-call run and a 1,000-call run both fit the card they sit beside.
import type { TapeTick } from "../../run-report";

const TICK_COLOR: Record<TapeTick, string> = {
  prose: "var(--border-strong)",
  tool: "var(--cobalt-500)",
  edit: "var(--flame-500)",
  err: "var(--red-500)",
  think: "var(--paper-300)",
};

const TICK_LABEL: Record<TapeTick, string> = {
  prose: "wrote",
  tool: "tool call",
  edit: "edit",
  err: "error",
  think: "thinking pause",
};

export function Tape({ ticks }: { ticks: TapeTick[] }) {
  if (ticks.length === 0) return null;
  return (
    <div
      className="flex w-3.5 flex-col gap-px self-stretch rounded-sm bg-sunken p-0.5"
      aria-label={`Session tape — ${ticks.length} events`}
      role="img"
    >
      {ticks.map((tick, i) => (
        <i
          // biome-ignore lint/suspicious/noArrayIndexKey: the tape IS the event order; there is no other identity
          key={i}
          className="block min-h-px flex-1 rounded-[1px]"
          style={{ background: TICK_COLOR[tick] }}
          title={TICK_LABEL[tick]}
        />
      ))}
    </div>
  );
}
