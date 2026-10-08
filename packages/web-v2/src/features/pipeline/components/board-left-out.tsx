"use client";

// What the board does not draw, said above its columns so a figure here cannot disagree with the
// Issues strip in silence: the states it leaves out, each with its count and a link to the list
// that holds them, and a page that was cut short, with how many it cut.

import Link from "next/link";
import type { LeftOutState } from "../derive";

export function BoardLeftOut({
  leftOut,
  slug,
  drawn,
  matching,
}: {
  leftOut: LeftOutState[];
  slug: string;
  /** Issues in the columns. */
  drawn: number;
  /** Issues the search says the board's query matches. */
  matching: number;
}) {
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
      {drawn < matching && (
        <p className="fg-body-sm text-muted" data-testid="board-page-cut">
          The columns hold the {drawn} most recently updated of {matching} issues; the rest are on
          the Issues list.
        </p>
      )}
    </div>
  );
}
