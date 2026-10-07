"use client";

// Owner picker for NEW connections: Personal (default) vs the project's org.
// Renders nothing unless the project lives in a team org the caller
// administers (org connections must stay inside their own org, and creating
// one requires org admin — the server enforces both).
import { Field, Select } from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { useCopy } from "@/lib/i18n/interface-language";

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
  const t = useCopy();
  const project = projectsQ.data?.find((p) => p.id === projectId);
  const canCreateOrgOwned =
    project &&
    !project.orgIsPersonal &&
    (project.orgRole === "owner" || project.orgRole === "admin");

  if (!canCreateOrgOwned) return null;

  return (
    <Field
      label={t("integrations.owner.label")}
      hint={t("integrations.owner.hint")}
    >
      <Select
        value={value ?? ""}
        onChange={(v) => onChange(v === "" ? undefined : v)}
        options={[
          { value: "", label: t("integrations.owner.personal") },
          { value: project.orgId, label: t("integrations.owner.orgNamed", { org: project.orgName }) },
        ]}
      />
    </Field>
  );
}
