"use client";

// The parts of Shape & release that edit the project row: the shape choice, the repository fields,
// the release path, and what the page says when a save would strand work.

import { ISSUE_STATUS_LABELS } from "@forge/contracts/issue-vocabulary";
import Link from "next/link";
import { useState } from "react";
import {
  Banner,
  Button,
  Field,
  Input,
  Radio,
  RadioGroup,
  SectionTitle,
  Select,
  type SelectOption,
  type SettingsForm,
  SettingsSection,
  SlideOver,
  Textarea,
} from "@/design";
import { ApiError } from "@/lib/api/client";
import { formatApiError } from "@/lib/api/error";
import { type Hop, IN_FLIGHT, type Shape, SHAPES, type ShapeDraft } from "../shape-form";
import { inlineCode } from "./inline-code";
import type { ReleaseCrossing } from "../types";
import { REPOSITORY_PATH_HINT } from "@/features/projects/repository-path";

const CROSSINGS: SelectOption[] = [
  { value: "merge-branch", label: "merge-branch — merge the branch above into this one" },
  { value: "cherry-pick", label: "cherry-pick — copy chosen commits, giving them new shas" },
];

const FIELD_ERROR = { color: "var(--red-600)" } as const;

export function ShapeChoice({
  form,
  canEdit,
  clash,
}: {
  form: SettingsForm<ShapeDraft>;
  canEdit: boolean;
  /** Why the stored kind and chain fit none of the four, or null where they fit one. */
  clash: string | null;
}) {
  const shape = form.draft.shape;
  return (
    <SettingsSection id="shape">
      <SectionTitle className="fg-h3 mb-1">Shape</SectionTitle>
      <p className="fg-caption mb-4 text-muted">
        What kind of project this is. It decides which settings below apply, whether issues wait
        for a release, and how a finished change is judged to have landed.
      </p>
      {clash && shape === null && (
        <p role="alert" className="fg-body-sm mb-4 text-fg">
          {inlineCode(clash)}
        </p>
      )}
      <RadioGroup
        name="project-shape"
        value={shape ?? ""}
        onChange={(v) => canEdit && form.setDraft((d) => ({ ...d, shape: v as Shape }))}
        className="gap-0 divide-y divide-line border-y border-line"
      >
        {SHAPES.map((s) => (
          <div key={s.value} className="py-3" data-shape-row={s.value}>
            <Radio value={s.value} label={<b>{s.label}</b>} disabled={!canEdit} />
            <p className="fg-caption mt-1 pl-7 text-muted">{s.hint}</p>
          </div>
        ))}
      </RadioGroup>
      {form.errorAt("shape") && (
        <p role="alert" className="fg-caption mt-2" style={FIELD_ERROR}>
          {form.errorAt("shape")}
        </p>
      )}
    </SettingsSection>
  );
}

export function RepositoryFields({
  form,
  canEdit,
}: {
  form: SettingsForm<ShapeDraft>;
  canEdit: boolean;
}) {
  const d = form.draft;
  const set = (next: Partial<ShapeDraft>) => form.setDraft((cur) => ({ ...cur, ...next }));
  return (
    <SettingsSection id="repository">
      <SectionTitle className="fg-h3 mb-4">Repository</SectionTitle>
      <div className="space-y-4">
        <Field label="Repository path" hint={REPOSITORY_PATH_HINT}>
          <Input
            value={d.repoPath}
            onChange={(e) => set({ repoPath: e.target.value })}
            disabled={!canEdit}
            placeholder="/home/runner/projects/my-repo"
            maxLength={500}
          />
        </Field>
        <Field
          label="Repository URL"
          hint="SSH clone URL. A newly assigned device clones from here when its folder is missing; its deploy key is on the Runners tab."
        >
          <Input
            value={d.repoUrl}
            onChange={(e) => set({ repoUrl: e.target.value })}
            disabled={!canEdit}
            placeholder="git@github.com:org/repo.git"
            spellCheck={false}
            maxLength={500}
          />
        </Field>
        <Field
          label="Base branch"
          hint="Where ISS-* branches are cut from and land, e.g. main."
          error={form.errorAt("baseBranch")}
        >
          <Input
            value={d.baseBranch}
            onChange={(e) => set({ baseBranch: e.target.value })}
            disabled={!canEdit}
            placeholder="main"
            maxLength={100}
          />
        </Field>
        <Field
          label="Workspace setup"
          hint="How to bring a fresh or broken checkout to a state that can build, test and commit — install commands, hook setup, toolchain quirks. Leave it blank and an agent works it out each time, then records what it found here."
        >
          <Textarea
            value={d.workspaceSetup}
            onChange={(e) => set({ workspaceSetup: e.target.value })}
            disabled={!canEdit}
            placeholder={"pnpm install --frozen-lockfile\npnpm prepare"}
            spellCheck={false}
            maxLength={8000}
            rows={4}
          />
        </Field>
      </div>
    </SettingsSection>
  );
}

export function ReleasePath({
  form,
  canEdit,
}: {
  form: SettingsForm<ShapeDraft>;
  canEdit: boolean;
}) {
  const d = form.draft;
  const base = d.baseBranch.trim();
  const hops = d.hops;
  const setHops = (next: Hop[]) => form.setDraft((cur) => ({ ...cur, hops: next }));
  const noBase = base === "";
  const promote = d.shape === "promote";

  return (
    <SettingsSection id="release-path">
      <SectionTitle className="fg-h3 mb-1">Release path</SectionTitle>
      <p className="fg-caption mb-4 text-muted">
        {promote
          ? "A release starts at the base branch, crosses into each branch below in order, and deploys the last one."
          : "A release deploys the base branch to the live target. No branch moves."}
      </p>
      {noBase && (
        <p role="alert" className="fg-body-sm mb-3 text-fg">
          Name the base branch under Repository first: a release starts there.
        </p>
      )}
      <ol className="space-y-3">
        <li className="fg-body">
          <span className="text-subtle">1.</span> <strong>{noBase ? "no base branch yet" : base}</strong>{" "}
          <span className="text-subtle">— where work merges{promote ? "" : ", and what is deployed"}</span>
        </li>
        {promote &&
          hops.map((hop, i) => (
            // A hop IS its position in the chain, and the half-typed branch name is not.
            // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
            <li key={i} className="space-y-2 border-t border-line pt-3">
              <Field label={`${i + 2}. Branch`} hint="Where the release lands at this step.">
                <Input
                  value={hop.branch}
                  onChange={(e) =>
                    setHops(hops.map((h, j) => (j === i ? { ...h, branch: e.target.value } : h)))
                  }
                  disabled={!canEdit || noBase}
                  placeholder="production"
                  maxLength={100}
                />
              </Field>
              <Field label="Crossed by" hint="How the release gets from the branch above into this one.">
                <Select
                  options={CROSSINGS}
                  value={hop.from}
                  onChange={(v) =>
                    setHops(hops.map((h, j) => (j === i ? { ...h, from: v as ReleaseCrossing } : h)))
                  }
                  disabled={!canEdit || noBase}
                />
              </Field>
              {canEdit && (
                <Button
                  variant="ghost"
                  onClick={() => setHops(hops.filter((_, j) => j !== i))}
                  className="min-h-11"
                >
                  Remove {hop.branch.trim() === "" ? "this branch" : hop.branch}
                </Button>
              )}
            </li>
          ))}
      </ol>
      {promote && canEdit && (
        <Button
          variant="secondary"
          onClick={() => setHops([...hops, { branch: "", from: "merge-branch" }])}
          disabled={noBase}
          className="mt-3 min-h-11"
        >
          Add a branch
        </Button>
      )}
      {promote && hops.some((h) => h.branch.trim() === "") && (
        <p className="fg-caption mt-2 text-subtle">
          A branch with no name is dropped when this is saved. Name it, or remove it.
        </p>
      )}
      {form.errorAt("hops") && (
        <p role="alert" className="fg-caption mt-2" style={FIELD_ERROR}>
          {form.errorAt("hops")}
        </p>
      )}
      {promote && hops[0]?.branch.trim() === base && base !== "" && (
        <p className="fg-caption mt-2 text-subtle">
          Base and live are the same branch, so every merge lands straight on the deployed branch —
          there is no buffer to catch a bad merge. Supported; just worth knowing.
        </p>
      )}
    </SettingsSection>
  );
}

/** Issues waiting at the release gate of a project that ships nothing: nothing releases them. */
export function StrandedNotice({ waiting, slug }: { waiting: number; slug?: string }) {
  if (waiting === 0) return null;
  return (
    <p role="alert" className="fg-body-sm border-y border-line py-3 text-fg" data-testid="stranded-notice">
      {waiting} {waiting === 1 ? "issue waits" : "issues wait"} at{" "}
      <b>{ISSUE_STATUS_LABELS.awaiting_release}</b>, and this project ships nothing, so no release
      will ever carry {waiting === 1 ? "it" : "them"}. Release {waiting === 1 ? "it" : "them"} under
      a shape that releases, or return {waiting === 1 ? "it" : "them"} to{" "}
      <b>{ISSUE_STATUS_LABELS.developed}</b>.{" "}
      {slug && (
        <Link href={`/projects/${slug}/issues?status=awaiting_release`} className="text-accent-text hover:underline">
          Open {waiting === 1 ? "it" : "them"}
        </Link>
      )}
    </p>
  );
}

const STRANDS = new Set(["RELEASE_CHAIN_STRANDS_WORK", "PROJECT_KIND_STRANDS_WORK"]);

function strandedKeys(err: unknown): string[] {
  if (!(err instanceof ApiError) || !err.code || !STRANDS.has(err.code)) return [];
  const issues = (err.details as { issues?: unknown } | undefined)?.issues;
  return Array.isArray(issues) ? issues.filter((k): k is string => typeof k === "string") : [];
}

/** The gap left between the page's sticky top bar and the shape row brought up under it. */
const BELOW_TOP_BAR_PX = 12;

/**
 * Bring the chosen shape up to just under the page's sticky top bar, with the refusal that follows
 * it below. Centring the refusal instead scrolled the choice it refuses under that bar at 390 px.
 */
export function keepChosenShapeInView(): void {
  const chosen = document.querySelector('#shape [role="radio"][aria-checked="true"]');
  const row = chosen?.closest<HTMLElement>("[data-shape-row]");
  if (!row) return;
  const covered = [...document.querySelectorAll("header")]
    .filter((h) => ["sticky", "fixed"].includes(getComputedStyle(h).position))
    .reduce((bottom, h) => Math.max(bottom, h.getBoundingClientRect().bottom), 0);
  row.style.scrollMarginTop = `${Math.round(covered) + BELOW_TOP_BAR_PX}px`;
  row.scrollIntoView?.({ block: "start", behavior: "smooth" });
}

/** A refused project save, said whole, with the issues it names one click away. It sits in the
 *  page under the shape it refuses rather than in the sticky save bar, where it would cover that
 *  choice; the page brings that choice into view with it ({@link keepChosenShapeInView}). */
export function ProjectRefusal({
  error,
  slug,
  onDismiss,
}: {
  error: unknown;
  slug?: string;
  onDismiss: () => void;
}) {
  if (!error) return null;
  const keys = strandedKeys(error);
  const chain = error instanceof ApiError && error.code === "RELEASE_CHAIN_STRANDS_WORK";
  return (
    <Banner tone="danger" onDismiss={onDismiss}>
      <div className="space-y-2" data-testid="project-refusal">
        <p>Nothing was saved. {formatApiError(error)}</p>
        {keys.length > 0 && slug && (
          <p className="flex flex-wrap gap-x-3 gap-y-1">
            {chain ? (
              <Link href={`/projects/${slug}/issues?status=awaiting_release`} className="underline">
                Open the {keys.length} waiting {keys.length === 1 ? "issue" : "issues"}
              </Link>
            ) : (
              keys.map((k) => (
                <Link key={k} href={`/projects/${slug}/issues/${k}`} className="underline">
                  {k}
                </Link>
              ))
            )}
          </p>
        )}
      </div>
    </Banner>
  );
}

/**
 * What each in-flight status is called in a sentence about issues standing at it. Each phrase is
 * one list item once several are joined with commas and "and", so none holds a comma or a list word.
 */
const STANDING: Record<(typeof IN_FLIGHT)[number], string> = {
  in_progress: "in progress",
  developed: "waiting to be tested",
  testing: "in testing",
  awaiting_release: "waiting for release",
};

/** The in-flight issues by what each is doing, e.g. "1 in progress and 2 waiting for release". */
function standingParts(byStatus: Record<string, number> | undefined): string[] {
  return IN_FLIGHT.filter((s) => (byStatus?.[s] ?? 0) > 0).map((s) => `${byStatus?.[s]} ${STANDING[s]}`);
}

/** The sentence naming the in-flight issues by their status, never as one word none of them holds. */
export function inFlightSentence(inFlight: number, byStatus: Record<string, number> | undefined): string {
  const one = inFlight === 1;
  const parts = standingParts(byStatus);
  const routed = `the new shape decides how ${one ? "it lands and is released" : "each one lands and is released"}.`;
  if (parts.length === 1) {
    const only = IN_FLIGHT.find((s) => (byStatus?.[s] ?? 0) > 0) as (typeof IN_FLIGHT)[number];
    return `${inFlight} ${one ? "issue is" : "issues are"} ${STANDING[only]}, and ${routed}`;
  }
  if (parts.length === 0) return `${inFlight} ${one ? "issue is" : "issues are"} started and not finished, and ${routed}`;
  const listed = `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `${inFlight} issues are started and not finished: ${listed}. The new shape decides how each one lands and is released.`;
}

/** The confirmation a shape change asks for: the project name where work is in flight. */
export function ShapeConfirm({
  open,
  projectName,
  inFlight,
  byStatus,
  to,
  onConfirm,
  onClose,
}: {
  open: boolean;
  projectName: string;
  /** Issues started and not closed; `null` while that count could not be read. */
  inFlight: number | null;
  /** The issue count at each status, which names what the in-flight issues are doing. */
  byStatus?: Record<string, number> | undefined;
  to: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const strict = inFlight === null || inFlight > 0;
  const matches = typed.trim() === projectName;
  const close = () => {
    setTyped("");
    onClose();
  };
  return (
    <SlideOver open={open} onClose={close} title="Change this project's shape?" width={440}>
      <div className="flex h-full flex-col gap-4" data-testid="shape-confirm">
        <p className="fg-body-sm text-fg">
          The project becomes <b>{to}</b>. That changes which settings apply, whether issues wait for
          a release, and how a finished change is judged to have landed.
        </p>
        {strict ? (
          <>
            <p className="fg-body-sm text-fg">
              {inFlight === null
                ? "How many issues are started and not finished could not be read, so this asks as if some are."
                : inFlightSentence(inFlight, byStatus)}
            </p>
            <Field label="Type the project name to confirm" hint={projectName}>
              <Input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={projectName}
                aria-label="Type the project name to confirm the shape change"
              />
            </Field>
          </>
        ) : (
          <p className="fg-body-sm text-muted">
            No issue is started and not finished, so nothing already started is re-routed.
          </p>
        )}
        <div className="mt-auto flex items-center justify-end gap-2.5 pt-2">
          <Button type="button" variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={strict ? "danger" : "primary"}
            disabled={strict && !matches}
            onClick={() => {
              setTyped("");
              onConfirm();
            }}
          >
            Change the shape
          </Button>
        </div>
      </div>
    </SlideOver>
  );
}
