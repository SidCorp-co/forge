"use client";

// cm:why every gap listed here used to be found by a job — the driver with no build command, the batch with no labelled box, the release agent with no procedure falling back to a floor written for another repo. Saying it in settings does not add a rule; it moves the same sentence to a moment a person can act on it.
// cm:edge contract -> packages/core/src/release-batch/readiness.ts — the gap keys and the release-gate rule are decided there; this file only renders them

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
    "The live binding names no release runner — a release is refused rather than sent to an arbitrary box.",
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
};

// cm:guard the link says what the operator must DO, and for one gap that is not "set it on the
// live binding" — `release-target` IS the absence of a live binding, so sending the reader to
// change one names a row that does not exist. Every other integration gap is about a declaration
// missing FROM a binding that is there.
const INTEGRATION_GAP_LINK: Partial<Record<ReleaseReadiness["gaps"][number], string>> = {
  "release-target": "Add a live deploy binding",
  "release-runner-ambiguous": "Reconcile the release runner labels",
  "release-multi-channel": "Review the live deploy bindings",
};

// cm:edge contract -> packages/core/src/release-batch/channel.ts — the three modes are decided by `classifyRollback`; rendering `unrepresentable` as "declared" would show a green-looking declaration for a release that will abort (ISS-925).
const ROLLBACK_TEXT: Record<NonNullable<ReleaseReadiness["rollbackMode"]>, string> = {
  manual: "declared — the release agent follows it",
  "coolify-image": "Forge rolls back to a Coolify image",
  unrepresentable: "free text — not executed, abort and comment",
};

const FACT_GAPS = new Set(["build-commands", "test-commands", "release-procedure"]);

/** What the badge says for each declared model — the words a reader of the screen uses. */
const RELEASE_MODEL_TEXT: Record<ReleaseReadiness["releaseModel"], string> = {
  none: "none",
  promote: "promote — code moves to a live branch",
  publish: "publish — an act on a live target",
};

// cm:guard the branch pair is shown ONLY under `promote`. Under `publish` and `none` a project may still carry a live branch it was created with, and printing it is how the retired gate came to read "this project promotes" for one that promotes nothing.
function branchPair(r: ReleaseReadiness): string {
  return r.releaseModel === "promote" && r.liveBranch
    ? `${r.baseBranch} → ${r.liveBranch}`
    : `${r.baseBranch} (no branch moves)`;
}

// cm:guard THREE states, never two. "Otherwise the session closes it directly" was true of one
// project in two and wrong about the third: a project that declares a model and has no live target
// neither gates nor closes — core throws `ReleaseTargetUndeclaredError` and the API answers
// `409 RELEASE_TARGET_UNDECLARED` (packages/core/src/release-batch/routes.ts). The panel said the
// issue would close while its own banner below said the release was refused.
function stateLine(r: ReleaseReadiness) {
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
      <h3 className="fg-label text-fg">Release</h3>
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
  // cm:guard this used to point at `settings?tab=facts`, a tab ISS-1048 deleted. A remediation
  // link whose destination no longer exists is worse than no link: the operator follows the one
  // affordance the gap offers and lands on a fallback pane. `sub=rules` opens the editor that
  // now holds this text — the Knowledge screen's Rules tab.
  const knowledgeHref = slug ? `/projects/${slug}/library?tab=knowledge&sub=rules` : undefined;
  const integrationsHref = slug ? `/projects/${slug}/settings?tab=integrations` : undefined;

  return (
    <div className="mt-6 border-t border-line pt-5">
      {headingFor(r)}

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
            {r.providers.length > 0 ? r.providers.join(", ") : "—"}
          </dd>
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

      {!r.hasReleaseGate && (
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

      {r.gaps.length > 0 && (
        <div className="mt-3 space-y-2">
          {r.gaps.map((g) => (
            <Banner key={g} tone="attention">
              {GAP_TEXT[g]}{" "}
              {FACT_GAPS.has(g) && knowledgeHref ? (
                <Link href={knowledgeHref} className="underline">
                  Write it in Knowledge rules
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
