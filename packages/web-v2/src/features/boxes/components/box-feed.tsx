// The box's command feed (ISS-1276 c5, c7): every act in the order the box got it, the agent's
// commands and a person's input, each at its time into the session. The newest is the feed's cursor.
// An agent's write refused while a person held the box reads Refused, with core's code on hover.

import type { BoxActRecord, BoxRecord } from "@forge/contracts/boxes";
import { ToneBadge } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { useBoxActs } from "../hooks";
import { clock } from "../labels";

const STATE_WORD = { refused: "boxes.feed.refused", pending: "boxes.feed.pending", failed: "boxes.feed.failed" } as const;

/** A person's input in a few words: `tap 0.42, 0.61`, `text "hi"`. */
function inputWords(command: readonly string[]): string {
  try {
    const i = JSON.parse(command[0] ?? "{}") as Record<string, unknown>;
    const xy = typeof i.x === "number" && typeof i.y === "number" ? ` ${i.x.toFixed(2)}, ${i.y.toFixed(2)}` : "";
    if (i.t === "text") return `text "${String(i.text)}"`;
    if (i.t === "key") return `key ${String(i.key)}`;
    if (i.t === "pointer") return `${String(i.action)}${xy}`;
    return `${String(i.t)}${xy}`;
  } catch {
    return command.join(" ");
  }
}

function FeedLine({ act, start, cursor }: { act: BoxActRecord; start: number; cursor: boolean }) {
  const t = useCopy();
  const said = act.by === "person" ? inputWords(act.command) : act.command.join(" ");
  const word = act.state === "done" ? null : STATE_WORD[act.state];
  return (
    <li
      aria-current={cursor ? "step" : undefined}
      data-testid="box-feed-line"
      data-state={act.state}
      data-by={act.by}
      className={`flex min-w-0 items-baseline gap-2 border-b border-dashed border-line-subtle py-1 ${cursor ? "text-fg" : "text-muted"}`}
    >
      <span className="w-3 flex-none" aria-hidden>
        {cursor ? "▸" : ""}
      </span>
      <span className="flex-none tabular-nums">{clock(Date.parse(act.at) - start)}</span>
      {act.by === "person" ? <span className="flex-none font-semibold">{t("boxes.feed.you")}</span> : null}
      <span className="min-w-0 flex-1 break-words">{said}</span>
      {word ? (
        <span title={act.refusal ?? act.stderr ?? undefined} className="flex-none">
          <ToneBadge tone={act.state === "pending" ? "run" : "err"} label={t(word)} title={t(word)} value={act.state} />
        </span>
      ) : null}
    </li>
  );
}

export function BoxFeed({ box }: { box: BoxRecord }) {
  const t = useCopy();
  const acts = useBoxActs(box.id).data ?? [];
  // the session's clock: a recording starts and stops when asked, so it counts from the open
  const start = Date.parse(box.createdAt);
  return (
    <section aria-label={t("boxes.feed.title")} className="min-w-0 font-mono text-12" data-testid="box-feed">
      {acts.length === 0 ? (
        <p className="py-2 text-muted">{t("boxes.feed.empty")}</p>
      ) : (
        <ol className="grid max-h-96 overflow-y-auto">
          {acts.map((a, i) => (
            <FeedLine key={a.id} act={a} start={start} cursor={i === acts.length - 1} />
          ))}
        </ol>
      )}
    </section>
  );
}
