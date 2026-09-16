"use client";

// Project settings → Repository. repoPath + baseBranch, and — only under
// `releaseModel: 'promote'` — the live branch, persisted via
// PATCH /api/projects/:id. The pipeline branches from these.
import { useEffect, useState } from "react";
import { Button, Card, CardContent, Field, Input } from "@/design";
import type { ProjectDetail } from "@/features/projects/types";
import { useUpdateProject } from "../hooks";

export function RepoTab({ project, canEdit }: { project: ProjectDetail; canEdit: boolean }) {
  const update = useUpdateProject(project.id);

  const [repoPath, setRepoPath] = useState(project.repoPath ?? "");
  const [baseBranch, setBaseBranch] = useState(project.baseBranch ?? "");
  const [liveBranch, setLiveBranch] = useState(project.liveBranch ?? "");

  useEffect(() => {
    setRepoPath(project.repoPath ?? "");
    setBaseBranch(project.baseBranch ?? "");
    setLiveBranch(project.liveBranch ?? "");
  }, [project.repoPath, project.baseBranch, project.liveBranch]);

  // Empty string → null (clears the column); a set value trims.
  const norm = (v: string) => (v.trim() === "" ? null : v.trim());
  const dirty =
    norm(repoPath) !== (project.repoPath ?? null) ||
    norm(baseBranch) !== (project.baseBranch ?? null) ||
    norm(liveBranch) !== (project.liveBranch ?? null);

  const promotes = project.releaseModel === "promote";

  const oneBranch =
    promotes && norm(baseBranch) !== null && norm(baseBranch) === norm(liveBranch);

  function save() {
    const patch: Record<string, unknown> = {};
    if (norm(repoPath) !== (project.repoPath ?? null)) patch.repoPath = norm(repoPath);
    if (norm(baseBranch) !== (project.baseBranch ?? null)) patch.baseBranch = norm(baseBranch);
    if (norm(liveBranch) !== (project.liveBranch ?? null)) {
      patch.liveBranch = norm(liveBranch);
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
          {promotes ? (
            <Field
              label="Live branch"
              hint="Where a release moves code to, by this project's release strategy."
            >
              <Input
                value={liveBranch}
                onChange={(e) => setLiveBranch(e.target.value)}
                disabled={!canEdit}
                placeholder="main"
                maxLength={100}
              />
            </Field>
          ) : (
            <p className="fg-caption text-subtle">
              This project's release model is <strong>{project.releaseModel}</strong>, which moves no
              branch, so it has no live branch. Change the release model under Release to declare one.
            </p>
          )}
          {oneBranch && (
            <p className="fg-caption text-subtle">
              Base and live are the same branch, so every merge lands straight on the deployed
              branch — there is no buffer to catch a bad merge. Supported; just worth knowing.
            </p>
          )}
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
