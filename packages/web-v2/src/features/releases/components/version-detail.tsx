"use client";

import { useState } from "react";
import { Badge, Button, ErrorState, Kicker, Skeleton } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { statusLabel } from "../version-status";
import { useCutRelease, useReleaseVersion } from "../versions-hooks";
import type { ReleaseChangelogSection, ReleaseDraft } from "../versions-types";
import type { ReleaseFlow } from "../flow";
import { ReleaseTimeline } from "./release-timeline";

function Changelog({ sections, without }: { sections: ReleaseChangelogSection[]; without: Array<{ key: string; title: string }> }) {
  return (
    <section className="grid gap-1.5" data-testid="changelog">
      <Kicker>Changelog</Kicker>
      {sections.length === 0 ? (
        <p className="text-13 text-subtle">No issue in this release carries a release note that reaches the changelog.</p>
      ) : (
        sections.map((s) => (
          <div key={s.section} className="grid gap-1">
            <span className="text-12 font-semibold text-subtle">{s.section}</span>
            {s.entries.map((e) => (
              <div key={e.issueId} className="grid grid-cols-[72px_minmax(0,1fr)] gap-2.5 text-13">
                <span className="whitespace-nowrap font-mono text-11 text-link">{e.key}</span>
                <span>{e.userFacing}</span>
              </div>
            ))}
          </div>
        ))
      )}
      {without.length > 0 ? (
        <p className="text-12 text-amber">
          No release note: {without.map((w) => w.key).join(", ")}
        </p>
      ) : null}
    </section>
  );
}

export function DraftDetail({ projectId, draft, canCut }: { projectId: string; draft: ReleaseDraft; canCut: boolean }) {
  const cut = useCutRelease(projectId);
  const sections = [...new Set(draft.issues.map((i) => i.section ?? "No release note"))];
  return (
    <div className="grid content-start gap-4 overflow-auto px-4 pb-6 pt-4 sm:px-7" data-testid="draft-detail">
      <h4 className="flex items-center gap-2.5 text-lg font-semibold">
        <span className="font-mono">{draft.version}</span>
        <Badge>draft</Badge>
      </h4>
      <p className="text-13 text-muted">
        Not cut yet: {draft.issues.length} merged issues wait at the release gate and are in no release.
      </p>
      <section className="grid gap-1.5">
        <Kicker>Would ship</Kicker>
        {sections.map((section) => (
          <div key={section} className="grid gap-1">
            <span className="text-12 font-semibold text-subtle">{section}</span>
            {draft.issues
              .filter((i) => (i.section ?? "No release note") === section)
              .map((i) => (
                <div key={i.id} className="grid grid-cols-[72px_minmax(0,1fr)] gap-2.5 text-13">
                  <span className="whitespace-nowrap font-mono text-11 text-link">{i.key}</span>
                  <span>{i.title}</span>
                </div>
              ))}
          </div>
        ))}
      </section>
      {draft.blockers.length > 0 ? (
        <section className="grid gap-1" data-testid="draft-blockers">
          <Kicker>Why it cannot be cut now</Kicker>
          {draft.blockers.map((b) => (
            <p key={b.code} className="text-12 text-muted">
              <span className="font-mono text-11 text-amber">{b.code}</span> {b.message}
            </p>
          ))}
        </section>
      ) : null}
      {canCut ? (
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={draft.blockers.length > 0 || cut.isPending}
            onClick={() => cut.mutate(draft.issues.map((i) => i.id))}
          >
            Cut {draft.version}
          </Button>
          {cut.isError ? <span className="text-12 text-red">{formatApiError(cut.error)}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

export function VersionDetail({
  projectId,
  version,
  canDecide,
  flow,
}: { projectId: string; version: string; canDecide: boolean; flow: ReleaseFlow }) {
  const q = useReleaseVersion(projectId, version);
  const [open, setOpen] = useState<string | null>(null);
  if (q.isLoading) return <div className="p-7"><Skeleton className="h-40 w-full" /></div>;
  if (q.isError || !q.data) {
    return <div className="p-7"><ErrorState message={formatApiError(q.error)} onRetry={() => q.refetch()} /></div>;
  }
  const v = q.data;
  const s = statusLabel(v);
  return (
    <div className="grid content-start gap-4 overflow-auto px-4 pb-6 pt-4 sm:px-7" data-testid="version-detail">
      <h4 className="flex items-center gap-2.5 text-lg font-semibold">
        <span className="font-mono">{v.version}</span>
        <Badge tone={s.tone}>{s.label}</Badge>
      </h4>
      <ReleaseTimeline
        v={v}
        flow={flow}
        projectId={projectId}
        canDecide={canDecide}
        open={open}
        onToggle={(id) => setOpen((o) => (o === id ? null : id))}
      />
      <Changelog sections={v.changelog} without={v.withoutNotes} />
    </div>
  );
}
