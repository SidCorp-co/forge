"use client";

// cm:why every gap listed here used to be found by a job — the driver with no build command, the batch with no labelled box, the release agent with no procedure falling back to a floor written for another repo. Saying it in settings does not add a rule; it moves the same sentence to a moment a person can act on it.
// cm:edge contract -> packages/core/src/release-batch/readiness.ts — the gap keys and the has-production rule are decided there; this file only renders them

import { Badge, Banner, ErrorState, Skeleton } from "@/design";
import { formatApiError } from "@/lib/api/error";
import Link from "next/link";
import { useReleaseReadiness } from "../hooks";
import type { ReleaseReadiness } from "../types";

const GAP_TEXT: Record<ReleaseReadiness["gaps"][number], string> = {
  "build-commands": "No build-commands fact — a session has nothing to build with.",
  "test-commands": "No test-commands fact — a session has nothing to prove its work with.",
  "release-procedure":
    "No release-procedure fact — the release runs a generic fallback written for another repo.",
  "release-runner":
    "The production binding names no release runner — a release is refused rather than sent to an arbitrary box.",
  rollback:
    "No rollback declared — a failed release aborts and comments, and rolls back nothing.",
  "rollback-prose":
    "The production Coolify binding declares its rollback as free text, which Forge no longer executes — convert it to the Coolify rollback action, or a failed release aborts and comments.",
};

// cm:edge contract -> packages/core/src/release-batch/channel.ts — the three modes are decided by `classifyRollback`; rendering `unrepresentable` as "declared" would show a green-looking declaration for a release that will abort (ISS-925).
const ROLLBACK_TEXT: Record<NonNullable<ReleaseReadiness["rollbackMode"]>, string> = {
  manual: "declared — the release agent follows it",
  "coolify-image": "Forge rolls back to a Coolify image",
  unrepresentable: "free text — not executed, abort and comment",
};

const FACT_GAPS = new Set(["build-commands", "test-commands", "release-procedure"]);

export function ReleaseSection({
  projectId,
  slug,
}: {
  projectId: string;
  slug?: string;
}) {
  const q = useReleaseReadiness(projectId);

  const heading = (
    <div>
      <h3 className="fg-label text-fg">Release</h3>
      <p className="fg-caption mt-0.5 text-muted">
        An issue reaches <b>Awaiting release</b> only when this project has a production to send
        it to. Otherwise the session closes it directly.
      </p>
    </div>
  );

  if (q.isLoading) {
    return (
      <div className="mt-6 border-t border-line pt-5">
        {heading}
        <div className="mt-3 space-y-2">
          <Skeleton className="h-8 w-full rounded-md" />
          <Skeleton className="h-8 w-1/2 rounded-md" />
        </div>
      </div>
    );
  }

  if (q.isError) {
    return (
      <div className="mt-6 border-t border-line pt-5">
        {heading}
        <div className="mt-3">
          <ErrorState message={formatApiError(q.error)} onRetry={() => q.refetch()} />
        </div>
      </div>
    );
  }

  const r = q.data;
  if (!r) return null;
  const factsHref = slug ? `/projects/${slug}/settings?tab=facts` : undefined;
  const integrationsHref = slug ? `/projects/${slug}/settings?tab=integrations` : undefined;

  return (
    <div className="mt-6 border-t border-line pt-5">
      {heading}

      <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        <div>
          <dt className="fg-caption text-subtle">Production</dt>
          <dd className="fg-body-sm text-fg">
            <Badge tone={r.hasProduction ? "accent" : "neutral"}>
              {r.hasProduction ? "declared" : "none"}
            </Badge>
          </dd>
        </div>
        <div>
          <dt className="fg-caption text-subtle">Branches</dt>
          <dd className="fg-body-sm font-mono text-fg">
            {r.baseBranch}
            {r.productionBranch !== r.baseBranch ? ` → ${r.productionBranch}` : " (trunk)"}
          </dd>
        </div>
        <div>
          <dt className="fg-caption text-subtle">Channel</dt>
          <dd className="fg-body-sm text-fg">{r.provider ?? "—"}</dd>
        </div>
        <div>
          <dt className="fg-caption text-subtle">Release runner label</dt>
          <dd className="fg-body-sm font-mono text-fg">{r.releaseRunnerLabel ?? "—"}</dd>
        </div>
        <div>
          <dt className="fg-caption text-subtle">Rollback</dt>
          <dd className="fg-body-sm text-fg">
            {r.rollbackMode ? ROLLBACK_TEXT[r.rollbackMode] : "abort and comment"}
          </dd>
        </div>
        <div>
          <dt className="fg-caption text-subtle">Deploy verified by</dt>
          <dd className="fg-body-sm text-fg">{r.hasVerify ? "a probe" : "nothing"}</dd>
        </div>
      </dl>

      {!r.hasProduction && (
        <p className="fg-caption mt-3 text-muted">
          A project has production when it has an active <b>prod</b> integration binding{" "}
          <i>and</i> a production branch different from its base branch. This one does not, so
          sessions close their issues rather than parking them for a release nobody would cut.
        </p>
      )}

      {r.gaps.length > 0 && (
        <div className="mt-3 space-y-2">
          {r.gaps.map((g) => (
            <Banner key={g} tone="attention">
              {GAP_TEXT[g]}{" "}
              {FACT_GAPS.has(g) && factsHref ? (
                <Link href={factsHref} className="underline">
                  Write it in Project Facts
                </Link>
              ) : integrationsHref ? (
                <Link href={integrationsHref} className="underline">
                  Set it on the production binding
                </Link>
              ) : null}
            </Banner>
          ))}
        </div>
      )}
    </div>
  );
}
