"use client";

// Owner picker for NEW connections: Personal (default) vs the project's org.
// Renders nothing unless the project lives in a team org the caller
// administers (org connections must stay inside their own org, and creating
// one requires org admin — the server enforces both).
import { Field, Select } from "@/design";
import { useProjects } from "@/features/projects/hooks";

export function ConnectionOwnerField({
  projectId,
  value,
  onChange,
}: {
  projectId: string;
  /** undefined = personal; an org id = org-owned. */
  value: string | undefined;
  onChange: (orgId: string | undefined) => void;
}) {
  const projectsQ = useProjects();
  const project = projectsQ.data?.find((p) => p.id === projectId);
  const canCreateOrgOwned =
    project &&
    !project.orgIsPersonal &&
    (project.orgRole === "owner" || project.orgRole === "admin");

  if (!canCreateOrgOwned) return null;

  return (
    <Field
      label="Credential owner"
      hint="Org-owned connections are shared with every project in the org."
    >
      <Select
        value={value ?? ""}
        onChange={(v) => onChange(v === "" ? undefined : v)}
        options={[
          { value: "", label: "Personal (only me)" },
          { value: project.orgId, label: `Organization — ${project.orgName}` },
        ]}
      />
    </Field>
  );
}
