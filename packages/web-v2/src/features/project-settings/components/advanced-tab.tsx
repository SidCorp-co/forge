
// Project settings → Advanced: whether the assistant may compute over the project's data, the plugins a
// device installs, then the raw documents every other tab reads its fields from, each folded and
// never the first thing shown (test accounts live under Testing, environments under Delivery), and
// the two acts on the project itself: moving it to another organization and archiving it (ISS-353),
// both org-admin only and both confirmed first.
import { useState } from "react";
import { Button, Disclosure, PageSection, PageSectionBody, Field, Input, SectionTitle, Select, SettingsGroup } from "@/design";
import { useOrgs } from "@/features/orgs";
import type { ProjectDetail } from "@/features/projects";
import { isOrgAdmin } from "@/features/projects";
import { useCopy } from "@/lib/i18n/interface-language";
import { useArchiveProject, useUnarchiveProject, useUpdateProject } from "../hooks";
import { ComputeSettings } from "./compute-section";
import { BindingDocuments, PolicyDocumentEditor, ProjectDocumentEditor } from "./config-documents";
import { EffectiveConfig } from "./config-readings";
import { PluginSettings } from "./plugins-section";

export function AdvancedSettings({ project, canEdit }: { project: ProjectDetail; canEdit: boolean }) {
  const t = useCopy();
  return (
    <div className="space-y-6">
      <ComputeSettings projectId={project.id} slug={project.slug} canEdit={canEdit} />
      <PluginSettings projectId={project.id} canEdit={canEdit} />
      <SettingsGroup id="documents" title={t("settings.project.raw.documents")} summary={t("settings.project.raw.documentsSummary")}>
        <div>
          <Disclosure title={t("settings.project.raw.projectDocument")} testId="raw-project">
            <ProjectDocumentEditor project={project} canEdit={canEdit} />
          </Disclosure>
          <Disclosure title={t("settings.project.raw.policy")} testId="raw-policy">
            <PolicyDocumentEditor projectId={project.id} canEdit={canEdit} />
          </Disclosure>
          <Disclosure title={t("settings.project.raw.bindings")} testId="raw-bindings">
            <BindingDocuments projectId={project.id} canEdit={canEdit} />
          </Disclosure>
          <Disclosure title={t("settings.project.raw.effective")} testId="raw-effective">
            <EffectiveConfig projectId={project.id} />
          </Disclosure>
        </div>
      </SettingsGroup>
      <div className="border-t border-line pt-2">
        {canEdit && <MoveToOrg project={project} />}
        <ArchiveProject project={project} canEdit={canEdit} />
      </div>
    </div>
  );
}

function ArchiveProject({ project, canEdit }: { project: ProjectDetail; canEdit: boolean }) {
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
function MoveToOrg({ project }: { project: ProjectDetail }) {
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
        <SectionTitle className="fg-h3 mb-4 text-accent-text!">{t("settings.project.advanced.move")}</SectionTitle>
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
