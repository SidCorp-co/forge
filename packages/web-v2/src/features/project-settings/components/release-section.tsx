"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, Banner, CardTitle, ErrorState, Skeleton } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { inlineCode } from "./inline-code";
import { useReleaseReadiness } from "../hooks";
import type { ReleaseReadiness } from "../types";

const GAP_TEXT: Record<ReleaseReadiness["gaps"][number], string> = {
  "build-commands": "No build-commands fact — a session has nothing to build with.",
  "test-commands": "No test-commands fact — a session has nothing to prove its work with.",
  "release-procedure":
    "No release-procedure fact — the release runs a generic fallback written for another repo.",
  "release-target":
    "The project document does not say where a release lands — every issue would wait for a release nobody can cut. Give its production environment an active deploy binding, or declare no production environment.",
  rollback:
    "No rollback declared — a failed release aborts and comments, and rolls back nothing.",
  "rollback-prose":
    "The production Coolify connection declares its rollback as free text, which Forge no longer executes — convert it to the Coolify rollback action, or a failed release aborts and comments.",
  "verify-probes":
    "The production environment declares no runtime probe that identifies its source — a release is proved only by the commit its deployment record names, and one whose platform records none is refused RELEASE_NOT_VERIFIED and closes nothing. Declare one in `environments.<name>.verification.runtime` of the project document.",
};

const DOCUMENT_GAPS = new Set(["release-target", "verify-probes"]);

const PROJECT_DOCUMENT_DOOR = "Written in the project document, on the Configuration tab.";

const ROLLBACK_TEXT: Record<NonNullable<ReleaseReadiness["rollbackMode"]>, string> = {
  manual: "declared — the release agent follows it",
  "coolify-image": "Forge rolls back to a Coolify image",
  unrepresentable: "free text — not executed, abort and comment",
};

/** What a field says when the read behind it failed. Never its default, which
 *  would show an unreadable binding as a binding that declares nothing. */
const UNREAD = "could not be read";

/** Every other row on this card says what follows from its own absence —
 *  `Rollback` abort and comment, `Deploy verified by` nothing. This one said
 *  `—`, which left a reader unable to tell a settled state from an outstanding
 *  one, on the card about the very question ISS-1275 was filed on. */
const NO_RELEASE_RUNNER_LABEL = "none — a release goes to any box in this project's pool";

const FACT_GAPS = new Set(["build-commands", "test-commands", "release-procedure"]);
const KNOWLEDGE_DOOR = "Write it as a project knowledge entry: `PUT /api/projects/:id/knowledge/<slug>` or `forge knowledge write`.";

/** What the badge says about where a landed change goes — the words a reader of the screen uses. */
function pathText(r: ReleaseReadiness): string {
  if (!r.production) return "none — this project ships nothing";
  if (r.promotions.length === 0) return "production deploys where work lands — no branch moves";
  return `${r.promotions.length} promotion${r.promotions.length === 1 ? "" : "s"} — code crosses to production's branch`;
}

/** The path as its branches, each named with the promotion that reaches it. */
function pathBranches(r: ReleaseReadiness): string {
  const start = r.defaultBranch ?? "no git source";
  if (r.promotions.length === 0) return start;
  return [start, ...r.promotions.map((p) => `${p.via} → ${p.to}`)].join("  ");
}

const TRIGGER_TEXT: Record<NonNullable<ReleaseReadiness["production"]>["trigger"], string> = {
  "on-land": "deploys on land — no human confirm",
  "on-request": "deploys on request — a human confirms",
  provider: "the provider deploys it itself",
};

function stateLine(r: ReleaseReadiness) {
  // An unreadable declaration is not a project that declares nothing. Saying so
  // would be the substitution this whole section exists to stop (ISS-1127).
  if (!r.declarationRead)
    return (
      <>
        This project's release declaration could not be read just now, so nothing below it is a
        reading. What could not be evaluated is named underneath.
      </>
    );
  if (r.hasReleaseGate)
    return (
      <>
        This one does, so its issues wait at <b>Awaiting release</b>.
      </>
    );
  if (r.targetUndeclared)
    return (
      <>
        This one&apos;s project document does not say where a release lands, so nothing can be
        released and a release is refused by name until it does.
      </>
    );
  return <>This one declares no release, so a session closes its issues directly.</>;
}

function SectionShell({ heading, children }: { heading: ReactNode; children: ReactNode }) {
  return (
    <div className="mt-6 border-t border-line pt-5">
      {heading}
      {children}
    </div>
  );
}

export function ReleaseSection({ projectId, slug }: { projectId: string; slug: string }) {
  const q = useReleaseReadiness(projectId);
  const heading = (r?: ReleaseReadiness) => (
    <div>
      <CardTitle className="fg-label text-fg">Release</CardTitle>
      <p className="fg-caption mt-0.5 text-muted">
        An issue reaches <b>Awaiting release</b> only when the project document declares a
        production environment with an active deploy binding. {r ? stateLine(r) : null}
      </p>
    </div>
  );

  if (q.isLoading)
    return (
      <SectionShell heading={heading()}>
        <div className="mt-3 space-y-2">
          <Skeleton className="h-8 w-full rounded-md" />
          <Skeleton className="h-8 w-1/2 rounded-md" />
        </div>
      </SectionShell>
    );
  if (q.isError)
    return (
      <SectionShell heading={heading()}>
        <div className="mt-3">
          <ErrorState message={formatApiError(q.error)} onRetry={() => q.refetch()} />
        </div>
      </SectionShell>
    );
  const r = q.data;
  if (!r) return null;

  return (
    <SectionShell heading={heading(r)}>
      {r.declarationRead && <ReadinessFacts r={r} />}
      {r.declarationRead && !r.hasReleaseGate && (
        <p className="fg-caption mt-3 text-muted">
          {r.targetUndeclared && r.targetUndeclaredReason ? (
            inlineCode(r.targetUndeclaredReason)
          ) : (
            <>
              A project has a release gate when its project document declares a production
              environment with an active deploy binding. This one declares none, so sessions close
              their issues rather than parking them for a release nobody would cut.
            </>
          )}{" "}
          {inlineCode(PROJECT_DOCUMENT_DOOR)}
        </p>
      )}
      <Notices
        title="Why a release will not start — every reason, now"
        items={r.blockers.map((b) => ({ ...b, tone: b.evaluated ? "danger" : "attention" }))}
      />
      <Notices
        title="What will change how the release runs, without stopping it"
        items={r.warnings.map((w) => ({ ...w, tone: "attention" }))}
      />
      {r.gaps.length > 0 && (
        <div className="mt-4 space-y-2">
          <h4 className="fg-caption text-subtle">What this project has not declared</h4>
          {r.gaps.map((g) => (
            <Banner key={g} tone="attention">
              {inlineCode(GAP_TEXT[g])}{" "}
              {FACT_GAPS.has(g) ? (
                inlineCode(KNOWLEDGE_DOOR)
              ) : DOCUMENT_GAPS.has(g) ? (
                inlineCode(PROJECT_DOCUMENT_DOOR)
              ) : (
                <Link href={`/projects/${slug}/settings?tab=integrations`} className="underline">
                  Set it on the production connection
                </Link>
              )}
            </Banner>
          ))}
        </div>
      )}
    </SectionShell>
  );
}

function Notices({
  title,
  items,
}: {
  title: string;
  items: { code: string; message: string; tone: "danger" | "attention" }[];
}) {
  if (items.length === 0) return null;
  return (
    <div className="mt-4 space-y-2">
      <h4 className="fg-caption text-subtle">{title}</h4>
      {items.map((n) => (
        <Banner key={`${n.code}:${n.message}`} tone={n.tone}>
          <span className="font-mono">{n.code}</span> — {inlineCode(n.message)}
        </Banner>
      ))}
    </div>
  );
}

function Fact({ label, mono, children }: { label: string; mono?: boolean; children: ReactNode }) {
  return (
    <div>
      <dt className="fg-caption text-subtle">{label}</dt>
      <dd className={mono ? "fg-body-sm font-mono text-fg" : "fg-body-sm text-fg"}>{children}</dd>
    </div>
  );
}

function ReadinessFacts({ r }: { r: ReleaseReadiness }) {
  return (
    <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
      <Fact label="Release">
        <Badge tone={r.hasReleaseGate ? "accent" : "neutral"}>{pathText(r)}</Badge>
      </Fact>
      <Fact label="Release path" mono>
        {pathBranches(r)}
      </Fact>
      <Fact label="Production">
        {r.production ? (
          <>
            <span className="font-mono">{r.production.environment}</span>
            {" — "}
            {!r.channelsRead ? UNREAD : r.providers.join(", ")}, {TRIGGER_TEXT[r.production.trigger]}
          </>
        ) : (
          "—"
        )}
      </Fact>
      <Fact label="Release runner label">
        {!r.channelsRead ? (
          UNREAD
        ) : r.releaseRunnerLabel ? (
          <span className="font-mono">{r.releaseRunnerLabel}</span>
        ) : (
          NO_RELEASE_RUNNER_LABEL
        )}
      </Fact>
      <Fact label="Rollback">
        {!r.channelsRead ? UNREAD : r.rollbackMode ? ROLLBACK_TEXT[r.rollbackMode] : "abort and comment"}
      </Fact>
      <Fact label="Deploy verified by">{!r.channelsRead ? UNREAD : r.hasVerify ? "a probe" : "nothing"}</Fact>
    </dl>
  );
}
