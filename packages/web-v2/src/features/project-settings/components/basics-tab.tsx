"use client";

// Project settings → Basics. Name + description, persisted via PATCH
// /api/projects/:id. Mirrors the account-tab dirty/save pattern.
import { useEffect, useState } from "react";
import { Button, Card, CardContent, Field, Input, MonoTag, Textarea } from "@/design";
import type { ProjectDetail } from "@/features/projects/types";
import { useUpdateProject } from "../hooks";

export function BasicsTab({ project, canEdit }: { project: ProjectDetail; canEdit: boolean }) {
  const update = useUpdateProject(project.id);

  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");

  // Re-hydrate when the underlying project refetches (e.g. after a save).
  useEffect(() => {
    setName(project.name);
    setDescription(project.description ?? "");
  }, [project.name, project.description]);

  const dirty = name.trim() !== project.name || (description ?? "") !== (project.description ?? "");

  function save() {
    const patch: Record<string, unknown> = {};
    if (name.trim() !== project.name) patch.name = name.trim();
    if ((description ?? "") !== (project.description ?? "")) {
      patch.description = description.trim() === "" ? null : description.trim();
    }
    if (Object.keys(patch).length > 0) update.mutate(patch);
  }

  return (
    <Card>
      <CardContent>
        <h2 className="fg-h3 mb-4">Basics</h2>
        <div className="space-y-4">
          <Field label="Slug" hint="The project's URL identifier (read-only).">
            <MonoTag>{project.slug}</MonoTag>
          </Field>
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!canEdit}
              maxLength={200}
            />
          </Field>
          <Field label="Description" hint="Optional. Shown on the project console.">
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={!canEdit}
              maxLength={2000}
              rows={3}
            />
          </Field>
          {canEdit && (
            <div>
              <Button
                variant="primary"
                loading={update.isPending}
                disabled={!dirty || name.trim() === ""}
                onClick={save}
                className="min-h-11"
              >
                Save basics
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
