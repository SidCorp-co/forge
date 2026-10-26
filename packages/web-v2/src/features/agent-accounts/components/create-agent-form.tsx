"use client";

// Settings → Agents → "New agent". The one caller `POST /api/orgs/:orgId/agents`
// has ever had: before ISS-1093 an agent could only appear by being spoken to in
// a room, so an org admin who wanted a box to run as an agent had no way to make
// one at all.
//
// The projects are a SET and not a single select, because `projectIds` is the whole
// reach a credential for this agent will be fenced to (`orgs/agent-accounts.ts:fenceFor`),
// and one box serving eight projects is the case that made this issue. The set is chosen
// through a searchable picker, so an organization with two dozen projects does not push
// the submit button off the screen (ISS-1169).

import { useState } from "react";
import { Banner, Button, Field, Input, MonoTag, SectionTitle } from "@/design";
import { useOrgScopedProjects } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";
import { useCreateAgent } from "../hooks";
import { ProjectPicker } from "./project-picker";

const HANDLE_RULE = /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/;

/**
 * Whether this handle is one the server will take, and what is wrong when it is not.
 */
export function handleProblem(handle: string): string | null {
  const v = handle.trim();
  if (!v) return "An agent needs a handle — it is the address typed after @.";
  if (v !== v.toLowerCase()) return "A handle is lowercase.";
  if (!HANDLE_RULE.test(v)) {
    return "3–40 characters: lowercase letters, digits or hyphens, starting and ending on a letter or digit.";
  }
  return null;
}

export function CreateAgentForm({ orgId }: { orgId: string }) {
  const { projects, isLoading, error: projectsUnread, refetch: readProjects } = useOrgScopedProjects();
  const create = useCreateAgent(orgId);
  const [handle, setHandle] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [minted, setMinted] = useState<{ handle: string; plaintext: string } | null>(null);
  const [touched, setTouched] = useState(false);

  const problem = handleProblem(handle);
  const noProjects = picked.length === 0;

  function toggle(id: string) {
    setPicked((cur) => (cur.includes(id) ? cur.filter((p) => p !== id) : [...cur, id]));
  }

  async function submit() {
    setTouched(true);
    if (problem || noProjects) return;
    try {
      const agent = await create.mutateAsync({ handle: handle.trim(), projectIds: picked });
      setMinted({ handle: agent.handle, plaintext: agent.plaintext });
      setHandle("");
      setPicked([]);
      setTouched(false);
    } catch {
      // The banner below renders `create.error`; nothing is lost by not toasting.
    }
  }

  return (
    <section aria-labelledby="new-agent" className="border-t border-line pt-6">
      <div>
        <SectionTitle id="new-agent" className="fg-h3 mb-1">
          New agent
        </SectionTitle>
        <p className="fg-body-sm mb-4">
          An agent is a principal of its own: work it files is filed as the agent, not as whoever
          set it up. Its credential reaches exactly the projects picked here and nothing else.
        </p>

        {minted && (
          <div className="mb-4">
            <Banner tone="success">
              <div className="flex flex-col gap-2">
                <span>
                  @{minted.handle} exists and holds a credential. Copy it now — it is shown once.
                </span>
                <MonoTag>{minted.plaintext}</MonoTag>
              </div>
            </Banner>
          </div>
        )}

        <div className="flex flex-col gap-4">
          <Field
            label="Handle"
            hint="The address typed after @. Lowercase, one per organization."
            error={touched && problem ? problem : undefined}
          >
            <Input
              value={handle}
              placeholder="forge-vm"
              onChange={(e) => setHandle(e.target.value)}
              onBlur={() => setTouched(true)}
            />
          </Field>

          <Field
            label="Projects"
            hint="Every project this agent works on. A box paired as this agent reaches these projects and no others."
            error={touched && noProjects ? "Pick at least one project." : undefined}
          >
            {isLoading ? (
              <p className="fg-body-sm">Loading projects…</p>
            ) : projectsUnread ? (
              // Projects that could not be read are not projects the organization has none of (ISS-1229 r47).
              <p className="fg-body-sm" role="alert" data-testid="agent-projects-unread">
                This organization&apos;s projects could not be read: {formatApiError(projectsUnread)}{" "}
                <Button variant="secondary" size="sm" onClick={readProjects}>
                  Retry
                </Button>
              </p>
            ) : projects.length === 0 ? (
              <p className="fg-body-sm">
                This organization has no projects yet. An agent needs one to act on.
              </p>
            ) : (
              <ProjectPicker projects={projects} picked={picked} onToggle={toggle} />
            )}
          </Field>

          {create.isError && <Banner tone="danger">{formatApiError(create.error)}</Banner>}

          <div className="flex justify-end">
            <Button variant="primary" loading={create.isPending} onClick={submit}>
              Create agent
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
