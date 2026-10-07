import { statusReading } from "@/design";
import type { SuggestionBreakdownBlocker, SuggestionBreakdownRead, SuggestionBreakdownSlice } from "../types";

/** What a slice waits on, in the words its accept would write the edge with, or the refusal it would give. */
function blockerLine(b: SuggestionBreakdownBlocker): { text: string; refused?: string } {
  if ("slice" in b) return { text: `After slice ${b.slice + 1} · ${b.title}` };
  if ("issue" in b) return { text: `After ${b.issue} · ${b.title} (${statusReading("issue", b.status).label})` };
  return { text: `Accept would refuse ${b.ref}: ${b.refusal}`, refused: b.code };
}

function buildsLine(s: SuggestionBreakdownSlice): string {
  if (s.buildsRefusal) return `Accept would refuse its design: ${s.buildsRefusal}`;
  if (!s.builds) return "Builds no design";
  return `Builds ${s.builds.flow}${s.builds.designRevision === null ? "" : ` r${s.builds.designRevision}`}`;
}

function Slice({ s, n }: { s: SuggestionBreakdownSlice; n: number }) {
  return (
    <li className="grid gap-0.5" data-testid="breakdown-slice">
      <p className="text-fg">
        <span className="font-semibold">
          {n}. {s.title}
        </span>{" "}
        <span className="text-subtle">· complexity {s.complexity}</span>
      </p>
      <p className="whitespace-pre-wrap">{s.description ?? "No description"}</p>
      <ul className="grid gap-0.5 pl-3">
        {s.criteria.map((c) => (
          <li key={`${c.code} · ${c.body}`}>{`${c.code} · ${c.body}`}</li>
        ))}
      </ul>
      <p className={s.buildsRefusal ? "text-danger" : undefined}>{buildsLine(s)}</p>
      {s.blockedBy.map((b) => {
        const line = blockerLine(b);
        return (
          <p key={line.text} className={line.refused ? "text-danger" : undefined} title={line.refused}>
            {line.text}
          </p>
        );
      })}
    </li>
  );
}

/** Each slice with the number its blockers name it by, `slice n`. */
const numbered = (slices: SuggestionBreakdownSlice[]) => slices.map((s, i) => ({ s, n: i + 1 }));

/**
 * A proposed breakdown's slices as core reads them for its accept (ISS-278): each slice's description,
 * criteria by BC code, the design revision it builds and what it waits on, so it is judged before its
 * issues exist. A breakdown that no longer reads says so in words, its code and path beside them.
 */
export function BreakdownSlices({ read }: { read: SuggestionBreakdownRead | undefined }) {
  if (!read) return <p data-testid="breakdown-slices">Core sent no reading of this breakdown's slices.</p>;
  if (read.unreadable) {
    return (
      <div data-testid="breakdown-slices" className="mt-1 grid gap-0.5">
        <p className="text-danger">This breakdown can no longer be read, so it cannot be accepted as it is stored.</p>
        <p className="font-mono text-11-5 text-subtle">{read.unreadable}</p>
      </div>
    );
  }
  return (
    <div className="mt-1 grid gap-2" data-testid="breakdown-slices">
      <ol className="grid gap-2">
        {numbered(read.slices).map(({ s, n }) => (
          <Slice key={`${n}. ${s.title}`} s={s} n={n} />
        ))}
      </ol>
      {read.uncovered.length > 0 ? (
        <p>{`Leaves uncovered: ${read.uncovered.map((u) => `${u.code} · ${u.reason}`).join("; ")}`}</p>
      ) : null}
    </div>
  );
}
