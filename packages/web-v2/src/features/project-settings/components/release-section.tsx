"use client";


import {
  Badge,
  Banner,
  CardTitle,
  ErrorState,
  Skeleton,
} from "@/design";
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
    "The live binding names no release runner — a release is refused rather than sent to an arbitrary box. Naming one recommends a box; it does not stop the others releasing when that box is unavailable.",
  "release-runner-ambiguous":
    "Two live bindings name different release runners — a release is refused rather than sent to whichever was created first. Give them the same label, or retire one.",
  "release-multi-channel":
    "Two live deploy bindings are declared, and a release run records ONE check of ONE address — so closing the batch on it would claim a delivery nobody looked at. Cutting a release is refused by name until then. Retire one of the two, or keep both and cut this project's releases by hand.",
  "release-target":
    "This project declares a release but has no live deploy binding to send it to — every issue would wait for a release nobody can cut. Add one, or set the release model to none.",
  rollback:
    "No rollback declared — a failed release aborts and comments, and rolls back nothing.",
  "rollback-prose":
    "A live Coolify binding declares its rollback as free text, which Forge no longer executes — convert it to the Coolify rollback action, or a failed release aborts and comments.",
  "verify-probes":
    "A live binding declares no verify probe — a release batch is refused, because a gate with no probes closes on the agent's word.",
  "live-commit-endpoint":
    "This project records no live commit endpoint — nothing holds the address a release ships to, so every live binding has to declare its own probe. Set it under Settings → Testing → Live.",
};

const INTEGRATION_GAP_LINK: Partial<Record<ReleaseReadiness["gaps"][number], string>> = {
  "release-target": "Add a live deploy binding",
  "release-runner-ambiguous": "Reconcile the release runner labels",
  "release-multi-channel": "Review the live deploy bindings",
};

const ROLLBACK_TEXT: Record<NonNullable<ReleaseReadiness["rollbackMode"]>, string> = {
  manual: "declared — the release agent follows it",
  "coolify-image": "Forge rolls back to a Coolify image",
  unrepresentable: "free text — not executed, abort and comment",
};

/** What a field says when the read behind it failed. Never its default, which
 *  would show an unreadable binding as a binding that declares nothing. */
const UNREAD = "could not be read";

const FACT_GAPS = new Set(["build-commands", "test-commands", "release-procedure"]);

/** What the badge says for each declared model — the words a reader of the screen uses. */
const RELEASE_MODEL_TEXT: Record<ReleaseReadiness["releaseModel"], string> = {
  none: "none",
  promote: "promote — code moves to a live branch",
  publish: "publish — an act on a live target",
};

function branchPair(r: ReleaseReadiness): string {
  return r.releaseModel === "promote" && r.liveBranch
    ? `${r.baseBranch} → ${r.liveBranch}`
    : `${r.baseBranch} (no branch moves)`;
}

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
        This one declares both, so its issues wait at <b>Awaiting release</b>.
      </>
    );
  if (r.targetUndeclared)
    return (
      <>
        This one declares what releasing means and has <i>no</i> live target, so nothing can be
        released and a release is refused by name until a live deploy binding is declared.
      </>
    );
  return <>This one declares no release, so a session closes its issues directly.</>;
}

export function ReleaseSection({
  projectId,
  slug,
}: {
  projectId: string;
  slug?: string;
}) {
  const q = useReleaseReadiness(projectId);

  const headingFor = (r?: ReleaseReadiness) => (
    <div>
      <CardTitle className="fg-label text-fg">Release</CardTitle>
      <p className="fg-caption mt-0.5 text-muted">
        An issue reaches <b>Awaiting release</b> only when this project declares what releasing it
        means <i>and</i> has a live target to send it to. {r ? stateLine(r) : null}
      </p>
    </div>
  );
  const heading = headingFor();

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
  const knowledgeHref = slug ? `/projects/${slug}/library?tab=knowledge&sub=rules` : undefined;
  const integrationsHref = slug ? `/projects/${slug}/settings?tab=integrations` : undefined;
  const testingHref = slug ? `/projects/${slug}/settings?tab=testing` : undefined;

  return (
    <div className="mt-6 border-t border-line pt-5">
      {headingFor(r)}

      {r.declarationRead && (
      <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        <div>
          <dt className="fg-caption text-subtle">Release</dt>
          <dd className="fg-body-sm text-fg">
            <Badge tone={r.hasReleaseGate ? "accent" : "neutral"}>
              {RELEASE_MODEL_TEXT[r.releaseModel]}
            </Badge>
          </dd>
        </div>
        <div>
          <dt className="fg-caption text-subtle">Branches</dt>
          <dd className="fg-body-sm font-mono text-fg">{branchPair(r)}</dd>
        </div>
        <div>
          <dt className="fg-caption text-subtle">Live targets</dt>
          <dd className="fg-body-sm text-fg">
            {!r.channelsRead ? UNREAD : r.providers.length > 0 ? r.providers.join(", ") : "—"}
          </dd>
        </div>
        <div>
          <dt className="fg-caption text-subtle">Release runner label</dt>
          <dd className="fg-body-sm font-mono text-fg">
            {!r.channelsRead ? UNREAD : (r.releaseRunnerLabel ?? "—")}
          </dd>
        </div>
        <div>
          <dt className="fg-caption text-subtle">Rollback</dt>
          <dd className="fg-body-sm text-fg">
            {!r.channelsRead
              ? UNREAD
              : r.rollbackMode
                ? ROLLBACK_TEXT[r.rollbackMode]
                : "abort and comment"}
          </dd>
        </div>
        <div>
          <dt className="fg-caption text-subtle">Deploy verified by</dt>
          <dd className="fg-body-sm text-fg">
            {!r.channelsRead ? UNREAD : r.hasVerify ? "a probe" : "nothing"}
          </dd>
        </div>
      </dl>
      )}

      {r.declarationRead && !r.hasReleaseGate && (
        <p className="fg-caption mt-3 text-muted">
          {r.targetUndeclared ? (
            <>
              This project declares a release but has no active <b>live</b> deploy binding to send
              it to, so a release cannot be cut and nothing will say why at the moment it is
              needed.
            </>
          ) : (
            <>
              A project has a release gate when it declares what releasing it means — moving code
              to a live branch, or publishing to a live target — <i>and</i> has an active{" "}
              <b>live</b> deploy binding. This one declares none, so sessions close their issues
              rather than parking them for a release nobody would cut.
            </>
          )}
        </p>
      )}

      {r.blockers.length > 0 && (
        <div className="mt-4 space-y-2">
          <h4 className="fg-caption text-subtle">
            Why a release will not start — every reason, now
          </h4>
          {r.blockers.map((b) => (
            <Banner key={`${b.code}:${b.message}`} tone={b.evaluated ? "danger" : "attention"}>
              <span className="font-mono">{b.code}</span> — {b.message}
            </Banner>
          ))}
        </div>
      )}

      {r.warnings.length > 0 && (
        <div className="mt-4 space-y-2">
          <h4 className="fg-caption text-subtle">
            What will change how the release runs, without stopping it
          </h4>
          {r.warnings.map((w) => (
            <Banner key={`${w.code}:${w.message}`} tone="attention">
              <span className="font-mono">{w.code}</span> — {w.message}
            </Banner>
          ))}
        </div>
      )}

      {r.gaps.length > 0 && (
        <div className="mt-4 space-y-2">
          <h4 className="fg-caption text-subtle">What this project has not declared</h4>
          {r.gaps.map((g) => (
            <Banner key={g} tone="attention">
              {GAP_TEXT[g]}{" "}
              {FACT_GAPS.has(g) && knowledgeHref ? (
                <Link href={knowledgeHref} className="underline">
                  Write it in Knowledge rules
                </Link>
              ) : g === "live-commit-endpoint" && testingHref ? (
                <Link href={testingHref} className="underline">
                  Record the live commit endpoint
                </Link>
              ) : integrationsHref ? (
                <Link href={integrationsHref} className="underline">
                  {INTEGRATION_GAP_LINK[g] ?? "Set it on the live binding"}
                </Link>
              ) : null}
            </Banner>
          ))}
        </div>
      )}
    </div>
  );
}
