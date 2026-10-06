"use client";

// Project settings → Basics. The name and the one-line description are the project document's
// `project.name` and `project.description`, so either is a project document write at the revision read
// here; PATCH /api/projects/:id refuses both.
import { useEffect, useState } from "react";
import {
  Banner,
  Button,
  PageSection,
  PageSectionBody,
  Divider,
  Field,
  Input,
  MonoTag,
  SectionTitle,
} from "@/design";
import { ContentLanguageField } from "./content-language-field";
import type { ProjectDetail } from "@/features/projects/types";
import { formatApiError } from "@/lib/api/error";
import { useProjectDocument, useWriteProjectDocument } from "../config-hooks";
import { projectDescriptionOf } from "../project-document";

/** The document Basics writes: the one read, with `project.name` and `project.description` as edited; an empty description is removed. */
function renamedDocument(document: Record<string, unknown>, name: string, description?: string) {
  const { description: _old, ...project } = (document.project ?? {}) as Record<string, unknown>;
  const kept = description === undefined ? _old : description.trim() || undefined;
  return { ...document, project: { ...project, name, ...(kept === undefined ? {} : { description: kept }) } };
}

export function BasicsTab({ project, canEdit }: { project: ProjectDetail; canEdit: boolean }) {
  const read = useProjectDocument(project.id);
  const write = useWriteProjectDocument(project.id);
  const held = read.data;

  const [name, setName] = useState(project.name);
  const saved = projectDescriptionOf(held?.document) ?? "";
  const [description, setDescription] = useState(saved);

  // Re-hydrate when the underlying project refetches (e.g. after a save).
  useEffect(() => {
    setName(project.name);
  }, [project.name]);
  useEffect(() => {
    setDescription(saved);
  }, [saved]);

  const dirty = name.trim() !== project.name || description.trim() !== saved;
  const undeclared = held?.declared === false;

  function save() {
    if (!dirty || !held?.declared) return;
    write.mutate({
      baseRevision: held.revision,
      document: renamedDocument(held.document, name.trim(), description),
    });
  }

  return (
    <PageSection>
      <PageSectionBody>
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
          <Field label="Description" hint="What the system is, in one line. The Workflows overview leads with it.">
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={!canEdit || undeclared}
              placeholder="What the system is and who it is for"
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
            <Button
              variant="primary"
              loading={write.isPending}
              disabled={!dirty || name.trim() === "" || !held?.declared}
              onClick={save}
              className="min-h-11 w-fit"
            >
              Save basics
            </Button>
          )}
        </div>
        <Divider className="my-6" />
        <ContentLanguageField projectId={project.id} canEdit={canEdit} />
      </PageSectionBody>
    </PageSection>
  );
}
