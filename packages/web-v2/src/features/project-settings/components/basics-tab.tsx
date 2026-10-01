"use client";

// Project settings → Basics. The name, persisted via PATCH
// /api/projects/:id. Mirrors the account-tab dirty/save pattern.
import { useEffect, useState } from "react";
import {
  Button,
  Card,
  CardContent,
  Field,
  Input,
  MonoTag,
  SectionTitle,
} from "@/design";
import type { ProjectDetail } from "@/features/projects/types";
import { useUpdateProject } from "../hooks";

export function BasicsTab({ project, canEdit }: { project: ProjectDetail; canEdit: boolean }) {
  const update = useUpdateProject(project.id);

  const [name, setName] = useState(project.name);

  // Re-hydrate when the underlying project refetches (e.g. after a save).
  useEffect(() => {
    setName(project.name);
  }, [project.name]);

  const dirty = name.trim() !== project.name;

  function save() {
    if (dirty) update.mutate({ name: name.trim() });
  }

  return (
    <Card>
      <CardContent>
        <SectionTitle className="fg-h3 mb-4">Basics</SectionTitle>
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
