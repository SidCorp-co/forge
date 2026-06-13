"use client";

// Project-tier Skills registry (`/projects/[slug]/skills`). Responsive card
// grid of global + project skills with scope, sync state, registered-stage
// chips, and an owner/admin enable control. ISS-299.
import { useMemo, useState } from "react";
import {
  Button,
  EmptyState,
  ErrorState,
  Input,
  PageContainer,
  ProjectCardSkeleton,
  SegmentedControl,
  Stat,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import {
  useAdoptSkill,
  useRegisterSkill,
  useSkills,
  useSkillSyncStatus,
  useUnregisterSkill,
} from "../hooks";
import { mergeSkills, projectSkillNames, type SkillScope, type SkillView } from "../types";
import { SkillCard } from "./skill-card";
import { SkillStudioDrawer } from "./skill-studio-drawer";
import { SmokeVerifyPanel } from "./smoke-verify-panel";

interface SkillsScreenProps {
  scope: { projectId: string; canManage: boolean };
}

type ScopeFilter = "all" | SkillScope;

const SCOPE_OPTIONS: { value: ScopeFilter; label: string }[] = [
  { value: "all", label: "All" },
  // `global` skills are org templates you adopt; `project` skills are usable.
  { value: "global", label: "Templates" },
  { value: "project", label: "Project" },
];

export function SkillsScreen({ scope }: SkillsScreenProps) {
  const { projectId, canManage } = scope;
  const skillsQ = useSkills(projectId);
  const syncQ = useSkillSyncStatus(projectId);
  const register = useRegisterSkill(projectId);
  const unregister = useUnregisterSkill(projectId);
  const adopt = useAdoptSkill(projectId);

  const isLoading = skillsQ.isLoading || syncQ.isLoading;
  const isError = skillsQ.isError || syncQ.isError;
  const error = skillsQ.error ?? syncQ.error;

  const skills = useMemo(
    () => mergeSkills(skillsQ.data ?? [], syncQ.data ?? []),
    [skillsQ.data, syncQ.data],
  );
  const pending = register.isPending || unregister.isPending || adopt.isPending;

  // A global template whose name already has a project copy is redundant in the
  // list — the project card represents it, so hide the global.
  const shadowedGlobalNames = useMemo(() => projectSkillNames(skills), [skills]);

  const [query, setQuery] = useState("");
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  // Skill Studio drawer: null = closed; { skill: null } = create; { skill } = edit.
  const [studio, setStudio] = useState<{ skill: SkillView | null } | null>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skills.filter((s) => {
      if (s.scope === "global" && shadowedGlobalNames.has(s.name)) return false;
      if (scopeFilter !== "all" && s.scope !== scopeFilter) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        (s.description?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [skills, query, scopeFilter, shadowedGlobalNames]);

  const isFiltered = query.trim() !== "" || scopeFilter !== "all";

  // Hide the per-card scope badge when every visible card shares one scope —
  // the badge only earns its place in a mixed view.
  const singleScope = useMemo(() => {
    if (visible.length === 0) return false;
    const first = visible[0].scope;
    return visible.every((s) => s.scope === first);
  }, [visible]);

  return (
    <PageContainer className="min-h-dvh">
      <header className="mb-6 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="fg-h2">Skills</h1>
          <p className="fg-body-sm mt-1">
            Project skills (usable) and org templates you can adopt, plus the pipeline stages they
            run on.
          </p>
        </div>
        {canManage && (
          <Button variant="primary" icon="plus" onClick={() => setStudio({ skill: null })}>
            New skill
          </Button>
        )}
      </header>

      {/* ISS-455 — per-stage smoke-verify report (execution/static evidence,
          not the `synced` badge). The tier-2 canary is gated on canManage. */}
      <div className="mb-4">
        <SmokeVerifyPanel projectId={projectId} canManage={canManage} />
      </div>

      {!isLoading && !isError && skills.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Input
            icon="search"
            placeholder="Filter skills…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full sm:w-64"
          />
          <SegmentedControl
            options={SCOPE_OPTIONS}
            value={scopeFilter}
            onChange={setScopeFilter}
          />
          <div className="ml-auto">
            <Stat icon="book" mono={false}>
              {visible.length} {visible.length === 1 ? "skill" : "skills"}
            </Stat>
          </div>
        </div>
      )}

      {isLoading && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <ProjectCardSkeleton key={i} />
          ))}
        </div>
      )}

      {isError && (
        <ErrorState
          title="Couldn't load skills"
          message={formatApiError(error)}
          onRetry={() => {
            skillsQ.refetch();
            syncQ.refetch();
          }}
        />
      )}

      {!isLoading && !isError && skills.length === 0 && (
        <EmptyState
          title="No skills yet"
          message="Skills synced from a paired device will appear here."
        />
      )}

      {!isLoading && !isError && skills.length > 0 && visible.length === 0 && (
        <EmptyState
          title="Nothing here"
          message="No skills match the current filter."
          mascot={false}
        />
      )}

      {!isLoading && !isError && visible.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((skill) => (
            <SkillCard
              key={skill.id}
              skill={skill}
              canManage={canManage}
              pending={pending}
              showScope={!singleScope}
              onRegister={(skillId, stage) => register.mutate({ skillId, stage })}
              onUnregister={(stage) => unregister.mutate(stage)}
              onAdopt={(globalSkillId) => adopt.mutate(globalSkillId)}
              onEdit={() => setStudio({ skill })}
            />
          ))}
        </div>
      )}

      {canManage && (
        <SkillStudioDrawer
          open={studio !== null}
          onClose={() => setStudio(null)}
          projectId={projectId}
          skill={studio?.skill}
        />
      )}
    </PageContainer>
  );
}
