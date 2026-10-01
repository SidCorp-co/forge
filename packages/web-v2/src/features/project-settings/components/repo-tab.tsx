"use client";

// Project settings → Repository. baseBranch (where ISS-* branches are cut from),
// persisted via PATCH /api/projects/:id. The checkout is each device binding's. Where a landed change goes is
// the project document's, written through PUT /api/projects/:id/config.
import { useEffect, useState } from "react";
import {
  Button,
  Card,
  CardContent,
  Field,
  Input,
  SectionTitle,
} from "@/design";
import type { ProjectDetail } from "@/features/projects/types";
import { useUpdateProject } from "../hooks";

export function RepoTab({ project, canEdit }: { project: ProjectDetail; canEdit: boolean }) {
  const update = useUpdateProject(project.id);

  const [baseBranch, setBaseBranch] = useState(project.baseBranch ?? "");

  useEffect(() => {
    setBaseBranch(project.baseBranch ?? "");
  }, [project.baseBranch]);

  const norm = (v: string) => (v.trim() === "" ? null : v.trim());
  const base = norm(baseBranch);
  const baseMoved = base !== (project.baseBranch ?? null);

  function save() {
    if (baseMoved) update.mutate({ baseBranch: base });
  }

  return (
    <Card>
      <CardContent>
        <SectionTitle className="fg-h3 mb-4">Repository</SectionTitle>
        <div className="space-y-4">
          <Field
            label="Base branch"
            hint="Where ISS-* branches are cut from (e.g. main). It is not where a release goes."
          >
            <Input
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              disabled={!canEdit}
              placeholder="main"
              maxLength={100}
            />
          </Field>

          <div className="space-y-2">
            <SectionTitle className="fg-h4">Release path</SectionTitle>
            <p className="fg-caption text-subtle">
              Where work lands, the promotions it crosses and the environment production deploys
              from are the project document&apos;s — read it with{" "}
              <code className="fg-code">GET /api/projects/:id/config</code> and write it with{" "}
              <code className="fg-code">PUT /api/projects/:id/config</code>. The Release card under
              Pipeline shows what it declares.
            </p>
          </div>

          {canEdit && (
            <div>
              <Button
                variant="primary"
                loading={update.isPending}
                disabled={!baseMoved}
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
