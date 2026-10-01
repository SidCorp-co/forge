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
    "The production Coolify binding declares its rollback as free text, which Forge no longer executes — convert it to the Coolify rollback action, or a failed release aborts and comments.",
  "verify-probes":
    "The production environment declares no runtime probe that identifies its source — a release still runs, but nothing reads the deployment, so it closes unverified and each issue it closes says so. Declare one in `environments.<name>.verification.runtime` of the project document.",
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
        An issue reaches <b>Awaiting release</b> only when the project document declares a
        production environment with an active deploy binding. {r ? stateLine(r) : null}
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

  return (
    <div className="mt-6 border-t border-line pt-5">
      {headingFor(r)}

      {r.declarationRead && (
      <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        <div>
          <dt className="fg-caption text-subtle">Release</dt>
          <dd className="fg-body-sm text-fg">
            <Badge tone={r.hasReleaseGate ? "accent" : "neutral"}>
              {pathText(r)}
            </Badge>
          </dd>
        </div>
        <div>
          <dt className="fg-caption text-subtle">Release path</dt>
          <dd className="fg-body-sm font-mono text-fg">{pathBranches(r)}</dd>
        </div>
        <div>
          <dt className="fg-caption text-subtle">Production</dt>
          <dd className="fg-body-sm text-fg">
            {r.production ? (
              <>
                <span className="font-mono">{r.production.environment}</span>
                {" — "}
                {!r.channelsRead ? UNREAD : r.providers.join(", ")}, {TRIGGER_TEXT[r.production.trigger]}
              </>
            ) : (
              "—"
            )}
          </dd>
        </div>
        <div>
          <dt className="fg-caption text-subtle">Release runner label</dt>
          <dd className="fg-body-sm text-fg">
            {!r.channelsRead ? (
              UNREAD
            ) : r.releaseRunnerLabel ? (
              <span className="font-mono">{r.releaseRunnerLabel}</span>
            ) : (
              NO_RELEASE_RUNNER_LABEL
            )}
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

      {r.blockers.length > 0 && (
        <div className="mt-4 space-y-2">
          <h4 className="fg-caption text-subtle">
            Why a release will not start — every reason, now
          </h4>
          {r.blockers.map((b) => (
            <Banner key={`${b.code}:${b.message}`} tone={b.evaluated ? "danger" : "attention"}>
              <span className="font-mono">{b.code}</span> — {inlineCode(b.message)}
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
              <span className="font-mono">{w.code}</span> — {inlineCode(w.message)}
            </Banner>
          ))}
        </div>
      )}

      {r.gaps.length > 0 && (
        <div className="mt-4 space-y-2">
          <h4 className="fg-caption text-subtle">What this project has not declared</h4>
          {r.gaps.map((g) => (
            <Banner key={g} tone="attention">
              {inlineCode(GAP_TEXT[g])}{" "}
              {FACT_GAPS.has(g) && knowledgeHref ? (
                <Link href={knowledgeHref} className="underline">
                  Write it in Knowledge rules
                </Link>
              ) : DOCUMENT_GAPS.has(g) ? (
                inlineCode(PROJECT_DOCUMENT_DOOR)
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
