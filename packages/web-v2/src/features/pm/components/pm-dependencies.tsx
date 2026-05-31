"use client";

// PM Dependencies tab: pick an issue, view its dependency edges (the
// client-derived graph — incoming blockers + outgoing dependencies), add/remove
// edges, and dispatch a pipeline stage. PM has no server graph route, so this
// is built from the real dependency REST surface (ISS-296 finding).
import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  IconButton,
  Menu,
  MonoTag,
  ProjectLoader,
  Select,
  type MenuItem,
  type SelectOption,
} from "@/design";
import {
  useAddDependency,
  useIssueDependencies,
  useProjectIssues,
  useRemoveDependency,
  useRunPipelineStep,
} from "../hooks";
import type { IssueDependency, IssueLite, PipelineStage } from "../types";

const STAGES: PipelineStage[] = ["triage", "clarify", "plan", "code", "review", "test", "fix", "release"];

function EdgeRow({
  label,
  issue,
  kind,
  onRemove,
}: {
  label: string;
  issue: IssueLite | undefined;
  kind: string;
  onRemove?: () => void;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-line-subtle bg-sunken px-3 py-2.5">
      <span className="fg-caption w-16 flex-none">{label}</span>
      <MonoTag hue="cobalt">{issue?.displayId ?? "?"}</MonoTag>
      <span className="fg-body-sm min-w-0 flex-1 truncate text-fg">{issue?.title ?? "Unknown issue"}</span>
      <Badge tone="neutral">{kind}</Badge>
      {onRemove && <IconButton icon="x" size="sm" aria-label="Remove dependency" onClick={onRemove} />}
    </div>
  );
}

export function PmDependencies({ projectId }: { projectId: string }) {
  const issuesQ = useProjectIssues(projectId);
  const issues = issuesQ.data?.items ?? [];
  const [selectedId, setSelectedId] = useState("");
  const [addTarget, setAddTarget] = useState("");

  const selected = issues.find((i) => i.id === selectedId);
  const depsQ = useIssueDependencies(selectedId || undefined);
  const add = useAddDependency(selectedId);
  const remove = useRemoveDependency(selectedId);
  const dispatch = useRunPipelineStep();

  const byId = useMemo(() => {
    const m = new Map<string, IssueLite>();
    for (const i of issues) m.set(i.id, i);
    return m;
  }, [issues]);

  const issueOptions: SelectOption[] = issues.map((i) => ({
    value: i.id,
    label: `${i.displayId} · ${i.title}`,
  }));
  const targetOptions: SelectOption[] = issues
    .filter((i) => i.id !== selectedId)
    .map((i) => ({ value: i.id, label: `${i.displayId} · ${i.title}` }));

  if (issuesQ.isLoading) {
    return (
      <div className="grid min-h-[40vh] place-items-center">
        <ProjectLoader label="loading issues…" />
      </div>
    );
  }

  if (issues.length === 0) {
    return <EmptyState title="No issues" message="This project has no issues to build a dependency graph from." />;
  }

  const outgoing = depsQ.data?.outgoing ?? [];
  const incoming = depsQ.data?.incoming ?? [];

  const dispatchItems: MenuItem[] = STAGES.map((stage) => ({
    label: `Dispatch ${stage}`,
    icon: "pipeline",
    onSelect: () => dispatch.mutate({ issueId: selectedId, stage }),
  }));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[260px] flex-1">
          <label className="fg-caption mb-1 block">Issue</label>
          <Select
            options={issueOptions}
            value={selectedId}
            onChange={(v) => {
              setSelectedId(v);
              setAddTarget("");
            }}
            placeholder="Select an issue"
          />
        </div>
        {selected && (
          <Menu
            align="right"
            items={dispatchItems}
            trigger={
              <Button variant="secondary" size="sm" icon="play">
                Dispatch stage
              </Button>
            }
          />
        )}
      </div>

      {!selected ? (
        <EmptyState
          title="Pick an issue"
          message="Select an issue above to view and edit its dependency graph, or dispatch a pipeline stage."
          mascot={false}
        />
      ) : depsQ.isLoading ? (
        <div className="grid min-h-[20vh] place-items-center">
          <ProjectLoader label="loading dependencies…" />
        </div>
      ) : (
        <>
          {/*
            Core semantics (issues/dependency-routes.ts): for the selected
            issue, `incoming` edges (to=:id) are the issues it DEPENDS ON /
            is blocked by, and `outgoing` edges (from=:id) are the issues it
            BLOCKS. POST {dependsOnId} stores (from=dependsOnId, to=:id) — an
            incoming edge — so Add + Remove live on the "Depends on" card and
            round-trip there. The referenced issue is `fromIssueId` for an
            incoming (depends-on) edge and `toIssueId` for an outgoing
            (blocking) edge.
          */}
          <Card>
            <CardContent>
              <p className="fg-label mb-3">
                Depends on <span className="fg-caption">(blocked by)</span>
              </p>
              {incoming.length === 0 ? (
                <p className="fg-caption">This issue has no dependencies.</p>
              ) : (
                <div className="space-y-2">
                  {incoming.map((e: IssueDependency) => (
                    <EdgeRow
                      key={e.id}
                      label="needs"
                      issue={byId.get(e.fromIssueId)}
                      kind={e.kind}
                      onRemove={() => remove.mutate(e.id)}
                    />
                  ))}
                </div>
              )}

              <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-line-subtle pt-4">
                <div className="min-w-[220px] flex-1">
                  <label className="fg-caption mb-1 block">Add dependency</label>
                  <Select
                    options={targetOptions}
                    value={addTarget}
                    onChange={setAddTarget}
                    placeholder="Select an issue this depends on"
                  />
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  icon="plus"
                  loading={add.isPending}
                  disabled={!addTarget}
                  onClick={() =>
                    add.mutate(
                      { dependsOnId: addTarget, kind: "blocks" },
                      { onSuccess: () => setAddTarget("") },
                    )
                  }
                >
                  Add
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent>
              <p className="fg-label mb-3">
                Blocking <span className="fg-caption">(outgoing)</span>
              </p>
              {outgoing.length === 0 ? (
                <p className="fg-caption">This issue blocks nothing.</p>
              ) : (
                <div className="space-y-2">
                  {outgoing.map((e: IssueDependency) => (
                    <EdgeRow
                      key={e.id}
                      label="blocks"
                      issue={byId.get(e.toIssueId)}
                      kind={e.kind}
                      onRemove={() => remove.mutate(e.id)}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
