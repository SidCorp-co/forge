"use client";

// What the board does not draw, said above its columns so a figure here cannot disagree with the
// Issues strip in silence: the states it leaves out, each with its count and a link to the list
// that holds them, and the states whose columns hold fewer issues than the search counts, with how
// many each is short and a link to the list that holds them.

import Link from "next/link";
import type { LeftOutState, StateFigure } from "../derive";

function shortOf(f: StateFigure): string {
  return f.drawn < f.total
    ? `${f.label}: ${f.drawn} of ${f.total} drawn`
    : `${f.label}: the board draws ${f.drawn}, Issues counts ${f.total}`;
}

export function BoardLeftOut({
  leftOut,
  figures,
  slug,
}: {
  leftOut: LeftOutState[];
  /** Each state the board draws, with the search's count and the cards its columns hold. */
  figures: StateFigure[];
  slug: string;
}) {
  const short = figures.filter((f) => f.drawn !== f.total);
  const drawn = figures.reduce((n, f) => n + f.drawn, 0);
  const total = figures.reduce((n, f) => n + f.total, 0);
  return (
    <div className="mb-3 flex-none space-y-1" data-testid="board-left-out">
      <p className="fg-body-sm text-muted">
        Not drawn on this board:{" "}
        {leftOut.map((l, i) => (
          <span key={l.state}>
            {i > 0 ? " · " : ""}
            <Link
              href={`/projects/${slug}/issues?filter=${l.state}`}
              className="text-accent-text hover:underline"
            >
              {l.label}
              {l.count === undefined ? "" : ` ${l.count}`}
            </Link>
          </span>
        ))}
        . They are on the Issues list.
      </p>
      {short.length > 0 && (
        <p className="fg-body-sm text-muted" data-testid="board-page-cut">
          The columns hold {drawn} of the {total} open issues, the most recently updated first. Not
          all drawn:{" "}
          {short.map((f, i) => (
            <span key={f.state}>
              {i > 0 ? " · " : ""}
              <Link
                href={`/projects/${slug}/issues?filter=${f.state}`}
                className="text-accent-text hover:underline"
              >
                {shortOf(f)}
              </Link>
            </span>
          ))}
          . The rest are on the Issues list.
        </p>
      )}
    </div>
  );
}
