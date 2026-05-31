"use client";

// Project settings → Repository. repoPath + base/production branches, persisted
// via PATCH /api/projects/:id. The pipeline branches from these.
import { useEffect, useState } from "react";
import { Button, Card, CardContent, Field, Input } from "@/design";
import type { ProjectDetail } from "@/features/projects/types";
import { useUpdateProject } from "../hooks";

export function RepoTab({ project, canEdit }: { project: ProjectDetail; canEdit: boolean }) {
  const update = useUpdateProject(project.id);

  const [repoPath, setRepoPath] = useState(project.repoPath ?? "");
  const [baseBranch, setBaseBranch] = useState(project.baseBranch ?? "");
  const [productionBranch, setProductionBranch] = useState(project.productionBranch ?? "");

  useEffect(() => {
    setRepoPath(project.repoPath ?? "");
    setBaseBranch(project.baseBranch ?? "");
    setProductionBranch(project.productionBranch ?? "");
  }, [project.repoPath, project.baseBranch, project.productionBranch]);

  // Empty string → null (clears the column); a set value trims.
  const norm = (v: string) => (v.trim() === "" ? null : v.trim());
  const dirty =
    norm(repoPath) !== (project.repoPath ?? null) ||
    norm(baseBranch) !== (project.baseBranch ?? null) ||
    norm(productionBranch) !== (project.productionBranch ?? null);

  function save() {
    const patch: Record<string, unknown> = {};
    if (norm(repoPath) !== (project.repoPath ?? null)) patch.repoPath = norm(repoPath);
    if (norm(baseBranch) !== (project.baseBranch ?? null)) patch.baseBranch = norm(baseBranch);
    if (norm(productionBranch) !== (project.productionBranch ?? null)) {
      patch.productionBranch = norm(productionBranch);
    }
    if (Object.keys(patch).length > 0) update.mutate(patch);
  }

  return (
    <Card>
      <CardContent>
        <h2 className="fg-h3 mb-4">Repository</h2>
        <div className="space-y-4">
          <Field label="Repository path" hint="Absolute path on the runner host where the repo is checked out.">
            <Input
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              disabled={!canEdit}
              placeholder="/home/runner/projects/my-repo"
              maxLength={500}
            />
          </Field>
          <Field label="Base branch" hint="Where ISS-* branches are cut from (e.g. main).">
            <Input
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              disabled={!canEdit}
              placeholder="main"
              maxLength={100}
            />
          </Field>
          <Field label="Production branch" hint="Where releases squash-merge (often the same as base).">
            <Input
              value={productionBranch}
              onChange={(e) => setProductionBranch(e.target.value)}
              disabled={!canEdit}
              placeholder="main"
              maxLength={100}
            />
          </Field>
          {canEdit && (
            <div>
              <Button
                variant="primary"
                loading={update.isPending}
                disabled={!dirty}
                onClick={save}
                className="min-h-11"
              >
                Save repository
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
