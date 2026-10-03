"use client";

// Project settings → Basics. The name is the project document's `project.name`, so a rename is a
// project document write at the revision read here; PATCH /api/projects/:id refuses `name`.
import { useEffect, useState } from "react";
import {
  Banner,
  Button,
  Card,
  CardContent,
  Divider,
  Field,
  Input,
  MonoTag,
  SectionTitle,
} from "@/design";
import { ContentLanguageField } from "@/features/content-language/components/content-language-field";
import type { ProjectDetail } from "@/features/projects/types";
import { formatApiError } from "@/lib/api/error";
import { useProjectDocument, useWriteProjectDocument } from "../config-hooks";

/** The document a rename writes: the one read, with only `project.name` changed. */
export function renamedDocument(document: Record<string, unknown>, name: string) {
  const project = (document.project ?? {}) as Record<string, unknown>;
  return { ...document, project: { ...project, name } };
}

export function BasicsTab({ project, canEdit }: { project: ProjectDetail; canEdit: boolean }) {
  const read = useProjectDocument(project.id);
  const write = useWriteProjectDocument(project.id);
  const held = read.data;

  const [name, setName] = useState(project.name);

  // Re-hydrate when the underlying project refetches (e.g. after a save).
  useEffect(() => {
    setName(project.name);
  }, [project.name]);

  const dirty = name.trim() !== project.name;
  const undeclared = held?.declared === false;

  function save() {
    if (!dirty || !held?.declared) return;
    write.mutate({
      baseRevision: held.revision,
      document: renamedDocument(held.document, name.trim()),
    });
  }

  return (
    <Card>
      <CardContent>
        <SectionTitle className="fg-h3 mb-4">Basics</SectionTitle>
        <div className="space-y-4">
          <Field label="Slug" hint="The project's URL identifier (read-only).">
            <MonoTag>{project.slug}</MonoTag>
          </Field>
          <Field label="Name" hint="The project document's project.name.">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!canEdit || undeclared}
              maxLength={120}
            />
          </Field>
          {undeclared && (
            <Banner tone="attention">
              This project has no project document yet, and its name is that document&apos;s
              project.name. Declare the document on the Configuration tab to rename it.
            </Banner>
          )}
          {write.error && <Banner tone="danger">{formatApiError(write.error)}</Banner>}
          {canEdit && (
            <div>
              <Button
                variant="primary"
                loading={write.isPending}
                disabled={!dirty || name.trim() === "" || !held?.declared}
                onClick={save}
                className="min-h-11"
              >
                Save basics
              </Button>
            </div>
          )}
        </div>
        <Divider className="my-6" />
        <ContentLanguageField projectId={project.id} canEdit={canEdit} />
      </CardContent>
    </Card>
  );
}
