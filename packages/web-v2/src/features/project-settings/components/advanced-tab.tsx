"use client";

// Project settings → Advanced: the technical view. The documents every other section's fields are
// stored in, edited raw (who each document is stays fixed), what a run reads of them, the plugins a
// device installs, and the two acts on the project itself: moving it to another organization and
// archiving it (ISS-353), both org-admin only and both confirmed first.
import { useState } from "react";
import { Button, PageSection, PageSectionBody, Field, Input, SectionTitle, Select } from "@/design";
import { useOrgs } from "@/features/orgs/hooks";
import type { ProjectDetail } from "@/features/projects/types";
import { isOrgAdmin } from "@/features/projects/write-access";
import { useCopy } from "@/lib/i18n/interface-language";
import { useArchiveProject, useUnarchiveProject, useUpdateProject } from "../hooks";
import { BindingsSection, PolicyDocumentSection, ProjectDocumentSection, TestingProfilesSection } from "./config-documents";
import { EffectiveSection, EnvironmentStateSection } from "./config-readings";
import { PluginsSection } from "./plugins-section";
import { SecretsSection } from "./secrets-section";

export function AdvancedSection({ project, canEdit }: { project: ProjectDetail; canEdit: boolean }) {
  const t = useCopy();
  return (
    <div className="space-y-6">
      <section id="documents" aria-label={t("settings.project.advanced.technical")} className="scroll-mt-24">
        <h3 className="fg-h3 text-accent-text!">{t("settings.project.advanced.technical")}</h3>
        <p className="fg-body-sm mt-1 max-w-[68ch] text-muted">{t("settings.project.advanced.technicalLead")}</p>
        <ProjectDocumentSection project={project} canEdit={canEdit} />
        <PolicyDocumentSection projectId={project.id} canEdit={canEdit} />
        <TestingProfilesSection projectId={project.id} canEdit={canEdit} />
        <SecretsSection projectId={project.id} canEdit={canEdit} />
        <BindingsSection projectId={project.id} canEdit={canEdit} />
        <EnvironmentStateSection projectId={project.id} />
        <EffectiveSection projectId={project.id} />
        <PluginsSection projectId={project.id} canEdit={canEdit} />
      </section>
      <div className="border-t border-line pt-2">
        {canEdit && <MoveToOrgCard project={project} />}
        <ArchiveCard project={project} canEdit={canEdit} />
      </div>
    </div>
  );
}

function ArchiveCard({ project, canEdit }: { project: ProjectDetail; canEdit: boolean }) {
  const t = useCopy();
  const archive = useArchiveProject(project.id);
  const unarchive = useUnarchiveProject(project.id);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const nameMatches = typed.trim() === project.name && project.name.length > 0;
  const stopConfirming = () => {
    setConfirming(false);
    setTyped("");
  };

  return (
    <PageSection>
      <PageSectionBody>
        <SectionTitle className="fg-h3 mb-1 text-accent-text!">{t("settings.project.advanced.archive")}</SectionTitle>
        {project.archivedAt ? (
          <>
            <p className="fg-caption mb-4 text-muted">{t("settings.project.advanced.archivedBody")}</p>
            {canEdit && (
              <Button variant="primary" loading={unarchive.isPending} onClick={() => unarchive.mutate()} className="min-h-11">
                {t("settings.project.advanced.unarchive")}
              </Button>
            )}
          </>
        ) : (
          <>
            <p className="fg-caption mb-4 text-muted">{t("settings.project.advanced.archiveBody")}</p>
            {canEdit &&
              (confirming ? (
                <div className="space-y-4">
                  <Field label={t("settings.project.advanced.confirmArchive")} hint={t("settings.project.advanced.typeName", { name: project.name })}>
                    <Input
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                      placeholder={project.name}
                      autoComplete="off"
                      aria-label={t("settings.project.advanced.typeNameLabel")}
                    />
                  </Field>
                  <div className="flex gap-2">
                    <Button
                      variant="danger"
                      loading={archive.isPending}
                      disabled={!nameMatches}
                      onClick={() => archive.mutate(undefined, { onSuccess: stopConfirming })}
                      className="min-h-11"
                    >
                      {t("settings.project.advanced.confirmArchive")}
                    </Button>
                    <Button variant="secondary" onClick={stopConfirming} className="min-h-11">
                      {t("common.cancel")}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button variant="danger" onClick={() => setConfirming(true)} className="min-h-11">
                  {t("settings.project.advanced.archive")}
                </Button>
              ))}
          </>
        )}
      </PageSectionBody>
    </PageSection>
  );
}

/** Move the project to another org the caller administers (owner/admin on the
 *  destination; core also requires admin on the current org). */
function MoveToOrgCard({ project }: { project: ProjectDetail }) {
  const t = useCopy();
  const orgsQ = useOrgs();
  const update = useUpdateProject(project.id);
  const [targetOrgId, setTargetOrgId] = useState("");
  const targets = (orgsQ.data ?? []).filter(
    (o) => isOrgAdmin(o.role) && o.id !== project.orgId,
  );

  if (targets.length === 0) return null;

  function move() {
    const target = targets.find((o) => o.id === targetOrgId);
    if (!target) return;
    const ok = window.confirm(t("settings.project.advanced.moveConfirm", { name: project.name, org: target.name }));
    if (!ok) return;
    update.mutate({ orgId: target.id }, { onSuccess: () => setTargetOrgId("") });
  }

  return (
    <PageSection>
      <PageSectionBody>
        <SectionTitle className="fg-h3 mb-1 text-accent-text!">{t("settings.project.advanced.move")}</SectionTitle>
        <p className="fg-caption mb-4 text-muted">{t("settings.project.advanced.moveBody")}</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1 sm:max-w-80">
            <Field label={t("settings.project.advanced.destination")}>
              <Select
                options={targets.map((o) => ({ value: o.id, label: o.name }))}
                value={targetOrgId}
                onChange={(v) => setTargetOrgId(v)}
                placeholder={t("settings.project.advanced.destinationPlaceholder")}
              />
            </Field>
          </div>
          <Button
            variant="primary"
            loading={update.isPending}
            disabled={!targetOrgId}
            onClick={move}
            className="min-h-11"
          >
            {t("settings.project.advanced.moveAct")}
          </Button>
        </div>
      </PageSectionBody>
    </PageSection>
  );
}
