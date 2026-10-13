"use client";

// Project settings → Basics. Name + description, persisted via PATCH
// /api/projects/:id as one form with one save bar.
import { z } from "zod";
import {
  Card,
  CardContent,
  Field,
  Input,
  MonoTag,
  SectionTitle,
  SettingsFormBar,
  Textarea,
  useSettingsForm,
} from "@/design";
import type { ProjectDetail } from "@/features/projects/types";
import { useUpdateProject } from "../hooks";
import type { ProjectUpdateInput } from "../types";

interface BasicsDraft {
  name: string;
  description: string;
}

const schema: z.ZodType<BasicsDraft, BasicsDraft> = z.object({
  name: z.string().refine((v) => v.trim() !== "", "Name is required."),
  description: z.string(),
});

const readOf = (project: ProjectDetail): BasicsDraft => ({
  name: project.name,
  description: project.description ?? "",
});

export function BasicsTab({ project, canEdit }: { project: ProjectDetail; canEdit: boolean }) {
  const update = useUpdateProject(project.id);
  const form = useSettingsForm<BasicsDraft>({
    read: readOf(project),
    schema,
    comparable: (d) => ({ name: d.name.trim(), description: d.description.trim() }),
  });
  const { name, description } = form.draft;

  async function save() {
    await form.save(async (held) => {
      const patch: ProjectUpdateInput = {};
      if (held.name.trim() !== project.name) patch.name = held.name.trim();
      const description = held.description.trim();
      if (description !== (project.description ?? "").trim()) {
        patch.description = description === "" ? null : description;
      }
      if (Object.keys(patch).length > 0) await update.mutateAsync(patch);
    });
  }

  return (
    <>
      <Card>
        <CardContent>
          <SectionTitle className="fg-h3 mb-4">Basics</SectionTitle>
          <div className="space-y-4">
            <Field label="Slug" hint="The project's URL identifier (read-only).">
              <MonoTag>{project.slug}</MonoTag>
            </Field>
            <Field label="Name" error={form.errorAt("name")}>
              <Input
                value={name}
                onChange={(e) => form.setDraft((d) => ({ ...d, name: e.target.value }))}
                disabled={!canEdit}
                maxLength={200}
              />
            </Field>
            <Field label="Description" hint="Optional. Shown on the project console.">
              <Textarea
                value={description}
                onChange={(e) => form.setDraft((d) => ({ ...d, description: e.target.value }))}
                disabled={!canEdit}
                maxLength={2000}
                rows={3}
              />
            </Field>
          </div>
        </CardContent>
      </Card>
      {canEdit && (
        <SettingsFormBar
          dirty={form.dirty}
          saving={update.isPending}
          blockedBy={form.invalid ? "Fix what is marked above before saving." : null}
          onSave={() => void save().catch(() => undefined)}
          onDiscard={form.discard}
        />
      )}
    </>
  );
}
