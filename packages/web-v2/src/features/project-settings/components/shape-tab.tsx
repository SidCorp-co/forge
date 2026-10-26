"use client";

// Project settings → Shape & release. One decision on one page, in causal order: can this project
// release; what shape it is; its repository; the path a release takes; where it runs; how QA gets in;
// what a release runs with. One save bar writes the project row and the environments document.

import { ISSUE_STATUS_LABELS } from "@forge/contracts/issue-vocabulary";
import { useEffect, useMemo, useState } from "react";
import {
  Banner,
  Button,
  ErrorState,
  SectionTitle,
  SettingsFormBar,
  SettingsSection,
  Skeleton,
  useSettingsForm,
} from "@/design";
import { useIssues } from "@/features/issues/hooks";
import type { ProjectDetail } from "@/features/projects/types";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import { documentWrite } from "../document-write";
import {
  documentPathOfField,
  type EnvironmentsDraft,
  environmentsComparable,
  environmentsDocument,
  environmentsSchema,
  locateField,
  parseEnvironments,
} from "../environments-form";
import { type SaveToastOptions, useEnvironments, useUpdateEnvironments, useUpdateProject } from "../hooks";
import {
  chainOf,
  IN_FLIGHT,
  readShape,
  SHAPES,
  type ShapeDraft,
  shapeClash,
  shapeComparable,
  shapeMoved,
  shapePatch,
  shapeSchema,
  shipsNothing,
} from "../shape-form";
import type { ReleaseChainEntry } from "../types";
import { EnvironmentBlocks } from "./environment-blocks";
import { ReleaseAnswer, ReleaseDetails } from "./release-section";
import { SaveRefusedBanner } from "./save-refused-banner";
import {
  keepChosenShapeInView,
  ProjectRefusal,
  ReleasePath,
  RepositoryFields,
  ShapeChoice,
  ShapeConfirm,
  StrandedNotice,
} from "./shape-sections";

const QUIET: SaveToastOptions = { toastSuccess: false, toastFailure: false };

export function ShapeTab({ project, canEdit }: { project: ProjectDetail; canEdit: boolean }) {
  const envQ = useEnvironments(project.id);

  // No form before the document is in hand: a blank one over an unread document would let
  // somebody type against a base nobody has seen.
  if (envQ.isPending) {
    return (
      <SettingsSection>
        <div className="space-y-3">
          <Skeleton className="h-10 w-full rounded-md" />
          <Skeleton className="h-10 w-full rounded-md" />
          <Skeleton className="h-10 w-full rounded-md" />
        </div>
      </SettingsSection>
    );
  }
  // Only a first read that failed has nothing to show. A later one that fails keeps the page, and
  // every unsaved edit on it, over the reading already in hand.
  if (envQ.isError && envQ.data === undefined) {
    return (
      <SettingsSection>
        <ErrorState title="Couldn't load environments" message={formatApiError(envQ.error)} onRetry={() => envQ.refetch()} />
      </SettingsSection>
    );
  }
  return (
    <>
      {envQ.isError && (
        <div className="mb-4" data-testid="environments-reread-failed">
          <Banner
            tone="attention"
            action={
              <Button variant="ghost" size="sm" onClick={() => envQ.refetch()}>
                Read again
              </Button>
            }
          >
            The environments could not be read again ({formatApiError(envQ.error)}), so what is
            shown is the last reading. Your edits are kept.
          </Banner>
        </div>
      )}
      <ShapePage
        project={project}
        canEdit={canEdit}
        environments={envQ.data?.environments}
        readRevision={envQ.dataUpdatedAt}
      />
    </>
  );
}

/** What Live tracks for the draft's shape, in words. */
function liveBranchText(d: ShapeDraft, chain: readonly ReleaseChainEntry[]): string {
  if (d.shape === "no-repository") return "None — this project's work lands outside git.";
  if (d.shape === "no-release") return "None — this project ships nothing.";
  const last = chain[chain.length - 1];
  return last ? `${last.branch} — the release deploys it` : "None yet — name the base branch.";
}

function ShapePage({
  project,
  canEdit,
  environments,
  readRevision,
}: {
  project: ProjectDetail;
  canEdit: boolean;
  /** The environments document as stored: a write's `base` is read from it. */
  environments: unknown;
  readRevision: number;
}) {
  const slug = project.slug;
  const storedChain = (project.releaseChain ?? []) as ReleaseChainEntry[];
  // The tab says how a save went itself: one toast for the save, its refusal once, in the bar.
  const updateProject = useUpdateProject(project.id, QUIET);
  const updateEnv = useUpdateEnvironments(project.id, QUIET);
  const { toast } = useToast();
  const countsQ = useIssues(project.id, { pageSize: 1 });

  const shapeRead = useMemo(() => readShape(project), [project]);
  const schema = useMemo(() => shapeSchema(project), [project]);
  const comparable = useMemo(() => shapeComparable(project), [project]);
  const shapeForm = useSettingsForm<ShapeDraft>({ read: shapeRead, schema, comparable });

  const envRead = useMemo(() => parseEnvironments(environments), [environments]);
  const envForm = useSettingsForm<EnvironmentsDraft>({
    read: envRead,
    schema: environmentsSchema,
    locate: locateField,
    documentPathOf: documentPathOfField,
    comparable: environmentsComparable,
    readRevision,
  });

  const [confirming, setConfirming] = useState(false);
  const [refusal, setRefusal] = useState<unknown>(null);
  /** The project half of the last save landed and the environments half did not. */
  const [halfSaved, setHalfSaved] = useState(false);

  useEffect(() => {
    if (refusal) keepChosenShapeInView();
  }, [refusal]);

  const byStatus = countsQ.data?.extra?.buckets?.byStatus;
  const inFlight = byStatus ? IN_FLIGHT.reduce((n, s) => n + (byStatus[s] ?? 0), 0) : null;
  const waiting = byStatus?.awaiting_release ?? 0;

  const d = shapeForm.draft;
  const draftChain = chainOf(d, storedChain);
  const clash = shapeClash(project.kind, storedChain);
  const showsRepository = d.shape !== "no-repository";
  const showsPath = d.shape === "publish" || d.shape === "promote";
  const shipsNothingNow = storedChain.length === 0;
  const dirty = shapeForm.dirty || envForm.dirty;
  const saving = updateProject.isPending || updateEnv.isPending;
  const blockedBy =
    shapeForm.dirty && d.shape === null
      ? "Pick the shape this project has before saving."
      : shapeForm.invalid || envForm.invalid
        ? "Fix what is marked above before saving."
        : null;

  async function write() {
    setRefusal(null);
    setHalfSaved(false);
    updateEnv.reset();
    let projectSaved = false;
    if (shapeForm.dirty) {
      try {
        const ran = await shapeForm.save(async (held) => {
          const patch = shapePatch(held, project);
          if (Object.keys(patch).length > 0) await updateProject.mutateAsync(patch);
        });
        if (!ran) return;
        projectSaved = true;
      } catch (err) {
        setRefusal(err);
        return;
      }
    }
    if (envForm.dirty) {
      try {
        const ran = await envForm.save(async (now) => {
          const w = documentWrite(
            environmentsDocument(envForm.seeded),
            environmentsDocument(now),
            environments,
          );
          if (w) await updateEnv.mutateAsync(w);
        });
        if (!ran) return;
      } catch {
        // The refusal itself is the banner below, read off the mutation.
        setHalfSaved(projectSaved);
        return;
      }
    }
    toast({ title: "Shape & release saved", tone: "success" });
  }

  function save() {
    if (shapeForm.dirty && shapeMoved(shapeForm.draft, project)) {
      setConfirming(true);
      return;
    }
    void write();
  }

  const toLabel = SHAPES.find((s) => s.value === d.shape)?.label ?? "";

  return (
    <>
      <SettingsSection id="release-answer">
        <SectionTitle className="fg-h3 mb-2">Shape &amp; release</SectionTitle>
        <ReleaseAnswer
          projectId={project.id}
          slug={slug}
          after={shipsNothingNow && waiting > 0 && <StrandedNotice waiting={waiting} slug={slug} />}
        />
        {shapeForm.dirty && (
          <p className="fg-caption mt-2 text-muted">
            This answers for what is saved. Save to have your changes answered.
          </p>
        )}
      </SettingsSection>

      <ShapeChoice form={shapeForm} canEdit={canEdit} clash={clash} />

      <ProjectRefusal error={refusal} slug={slug} onDismiss={() => setRefusal(null)} />

      {showsRepository && <RepositoryFields form={shapeForm} canEdit={canEdit} />}

      {showsPath && <ReleasePath form={shapeForm} canEdit={canEdit} />}

      <EnvironmentBlocks
        projectId={project.id}
        slug={slug}
        form={envForm}
        canEdit={canEdit}
        liveBranch={liveBranchText(d, draftChain)}
        shipsNothing={shipsNothing(d, storedChain)}
      />

      {!shipsNothingNow && (
        <SettingsSection id="release-details">
          <SectionTitle className="fg-h3 mb-1">What a release runs with</SectionTitle>
          <p className="fg-caption mb-4 text-muted">
            Read off the live deploy connections. An issue waits at{" "}
            <b>{ISSUE_STATUS_LABELS.awaiting_release}</b> only while this project declares a release{" "}
            <i>and</i> one of them serves Live.
          </p>
          <ReleaseDetails projectId={project.id} />
        </SettingsSection>
      )}

      {canEdit && (
        <SettingsFormBar
          dirty={dirty}
          saving={saving}
          blockedBy={blockedBy}
          onSave={save}
          onDiscard={() => {
            setRefusal(null);
            setHalfSaved(false);
            updateEnv.reset();
            shapeForm.discard();
            envForm.discard();
          }}
        >
          <SaveRefusedBanner
            projectId={project.id}
            error={updateEnv.isError ? updateEnv.error : null}
            onDismiss={() => {
              setHalfSaved(false);
              updateEnv.reset();
            }}
            document="environments"
            draft={envForm}
            credentialLabels={envForm.draft.testCredentials.map((c) => c.label)}
            saved={halfSaved ? "The shape and repository were saved; the environments were not." : undefined}
          />
        </SettingsFormBar>
      )}

      <ShapeConfirm
        open={confirming}
        projectName={project.name}
        inFlight={inFlight}
        byStatus={byStatus}
        to={toLabel}
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void write();
        }}
      />
    </>
  );
}
