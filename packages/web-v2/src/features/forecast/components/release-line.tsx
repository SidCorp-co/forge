"use client";

import Link from "next/link";
import { releaseHref } from "@/lib/routes/releases";
import type { Said } from "../text";

/** A forecast line with the release it names as a link to that release's page, the rest as plain text. */
export function ReleaseLine({ said, slug, className, testId }: { said: Said; slug: string; className?: string; testId?: string }) {
  const { line, detail, release } = said;
  const at = release ? line.indexOf(release) : -1;
  return (
    <span className={className} title={detail} data-testid={testId}>
      {release && at >= 0 ? (
        <>
          {line.slice(0, at)}
          <Link href={releaseHref(slug, release)} className="font-mono text-link hover:underline" data-testid="release-line-link">
            {release}
          </Link>
          {line.slice(at + release.length)}
        </>
      ) : (
        line
      )}
    </span>
  );
}
