"use client";

import { useEffect } from "react";
import {
  Badge,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  HelpButton,
  Markdown,
  Skeleton,
} from "@/design";
import { FORGE_RELEASES_URL } from "@/lib/changelog";
import { formatApiError } from "@/lib/api/error";
import { useWhatsNewStatus } from "../hooks";

/** What's New — Forge's product release feed (CHANGELOG by version, newest
 *  first, `[Unreleased]` pinned on top). Opening the page clears the nav badge
 *  by recording the current top entry as the user's last-seen marker. */
export function WhatsNewScreen() {
  const { data, isLoading, isError, error, refetch, markSeen, topId } = useWhatsNewStatus();

  // Mark the feed seen once it has loaded. Keyed on the top entry id so a later
  // release (or changed [Unreleased]) re-marks correctly on the next visit.
  useEffect(() => {
    if (topId) void markSeen();
    // markSeen is a fresh closure each render; topId is the stable trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topId]);

  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4 px-6 py-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="fg-h2">What&apos;s New</h1>
          <p className="fg-body-sm text-muted">
            Forge release notes — newest first.{" "}
            <a
              href={FORGE_RELEASES_URL}
              target="_blank"
              rel="noreferrer"
              className="text-[color:var(--link)] hover:underline"
            >
              All releases on GitHub
            </a>
          </p>
        </div>
        <HelpButton
          summary="The Forge product changelog, pulled live from GitHub. Each release lists what changed, grouped by Added / Changed / Fixed. The newest entry (including the upcoming [Unreleased] section) is at the top; opening this page clears the 'new' badge in the sidebar."
          docPath="CHANGELOG.md"
        />
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-[160px] w-full" />
          <Skeleton className="h-[120px] w-full" />
        </div>
      ) : isError ? (
        <Card>
          <CardContent>
            <ErrorState message={formatApiError(error)} onRetry={() => refetch()} />
          </CardContent>
        </Card>
      ) : !data || data.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              title="Nothing here yet"
              message="No release notes are available right now."
              mascot={false}
            />
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {data.map((rel) => (
            <Card key={rel.id}>
              <CardContent>
                <div className="mb-3 flex items-center gap-2.5">
                  {rel.isUnreleased ? (
                    <Badge tone="accent">Unreleased</Badge>
                  ) : (
                    <span className="fg-h3 font-mono">{rel.version}</span>
                  )}
                  {rel.date && <span className="fg-caption text-subtle">{rel.date}</span>}
                </div>
                {rel.sections.length === 0 ? (
                  <p className="fg-body-sm text-subtle">No notes for this release.</p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {rel.sections.map((s) => (
                      <div key={s.title}>
                        <p className="fg-overline mb-1 font-mono text-subtle">{s.title}</p>
                        <Markdown>{s.body}</Markdown>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
