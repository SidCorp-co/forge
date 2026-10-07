"use client";

// Settings → Agents → "New agent". The one caller `POST /api/orgs/:orgId/agents`
// has ever had: before ISS-1093 an agent could only appear by being spoken to in
// a room, so an org admin who wanted a box to run as an agent had no way to make
// one at all.
//
// The project list is a CHECKBOX SET and not a single select, because
// `projectIds` is the whole reach a credential for this agent will be fenced to
// (`orgs/agent-accounts.ts:fenceFor`), and one box serving eight projects is the
// case that made this issue.

import { useState } from "react";
import {
  Banner,
  Button,
  PageSection,
  PageSectionBody,
  PageSectionTitle,
  Checkbox,
  Field,
  Input,
  MonoTag,
} from "@/design";
import { useOrgScopedProjects } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { useSubmitGuard } from "@/lib/utils/use-submit-guard";
import { useCreateAgent } from "../hooks";

const HANDLE_RULE = /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/;

/**
 * Whether this handle is one the server will take, and what is wrong when it is not.
 */
function handleProblem(handle: string): ProductCopyKey | null {
  const v = handle.trim();
  if (!v) return "settings.agents.handleMissing";
  if (v !== v.toLowerCase()) return "settings.agents.handleLower";
  if (!HANDLE_RULE.test(v)) return "settings.agents.handleShape";
  return null;
}

export function CreateAgentForm({ orgId }: { orgId: string }) {
  const { projects, isLoading } = useOrgScopedProjects();
  const create = useCreateAgent(orgId);
  const submitting = useSubmitGuard();
  const [handle, setHandle] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [minted, setMinted] = useState<{ handle: string; plaintext: string } | null>(null);
  const [touched, setTouched] = useState(false);
  const t = useCopy();

  const problem = handleProblem(handle);
  const noProjects = picked.length === 0;

  function toggle(id: string) {
    setPicked((cur) => (cur.includes(id) ? cur.filter((p) => p !== id) : [...cur, id]));
  }

  async function submit() {
    setTouched(true);
    if (problem || noProjects) return;
    if (!submitting.claim()) return;
    try {
      const agent = await create.mutateAsync({ handle: handle.trim(), projectIds: picked });
      setMinted({ handle: agent.handle, plaintext: agent.plaintext });
      setHandle("");
      setPicked([]);
      setTouched(false);
    } catch {
      // The banner below renders `create.error`; nothing is lost by not toasting.
    } finally {
      submitting.release();
    }
  }

  return (
    <PageSection>
      <PageSectionBody>
        <PageSectionTitle className="mb-1">{t("settings.agents.new")}</PageSectionTitle>
        <p className="fg-body-sm mb-4">{t("settings.agents.newIntro")}</p>

        {minted && (
          <div className="mb-4">
            <Banner tone="success">
              <div className="flex flex-col gap-2">
                <span>
                  {t("settings.agents.minted", { handle: `@${minted.handle}` })}
                </span>
                <MonoTag>{minted.plaintext}</MonoTag>
              </div>
            </Banner>
          </div>
        )}

        <div className="flex flex-col gap-4">
          <Field
            label={t("settings.agents.handle")}
            hint={t("settings.agents.handleHint")}
            error={touched && problem ? t(problem) : undefined}
          >
            <Input
              value={handle}
              placeholder="forge-vm"
              onChange={(e) => setHandle(e.target.value)}
              onBlur={() => setTouched(true)}
            />
          </Field>

          <Field
            label={t("settings.orgs.projects")}
            hint={t("settings.agents.projectsHint")}
            error={touched && noProjects ? t("settings.agents.pickProject") : undefined}
          >
            {isLoading ? (
              <p className="fg-body-sm">{t("settings.agents.loadingProjects")}</p>
            ) : projects.length === 0 ? (
              <p className="fg-body-sm">
                {t("settings.agents.orgNoProjects")}
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {projects.map((p) => (
                  <Checkbox
                    key={p.id}
                    label={p.name}
                    checked={picked.includes(p.id)}
                    onChange={() => toggle(p.id)}
                  />
                ))}
              </div>
            )}
          </Field>

          {create.isError && <Banner tone="danger">{formatApiError(create.error)}</Banner>}

          <div className="flex justify-end">
            <Button variant="primary" loading={create.isPending} onClick={submit}>
              {t("settings.agents.create")}
            </Button>
          </div>
        </div>
      </PageSectionBody>
    </PageSection>
  );
}
