"use client";

// Project-tier Skills registry (`/v2/projects/[slug]/skills`). Responsive card
// grid of global + project skills with scope, sync state, registered-stage
// chips, and an owner/admin enable control. ISS-299.
import { useMemo } from "react";
import {
  EmptyState,
  ErrorState,
  ProjectCardSkeleton,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useRegisterSkill, useSkills, useSkillSyncStatus, useUnregisterSkill } from "../hooks";
import { mergeSkills } from "../types";
import { SkillCard } from "./skill-card";

interface SkillsScreenProps {
  scope: { projectId: string; canManage: boolean };
}

export function SkillsScreen({ scope }: SkillsScreenProps) {
  const { projectId, canManage } = scope;
  const skillsQ = useSkills(projectId);
  const syncQ = useSkillSyncStatus(projectId);
  const register = useRegisterSkill(projectId);
  const unregister = useUnregisterSkill(projectId);

  const isLoading = skillsQ.isLoading || syncQ.isLoading;
  const isError = skillsQ.isError || syncQ.isError;
  const error = skillsQ.error ?? syncQ.error;

  const skills = useMemo(
    () => mergeSkills(skillsQ.data ?? [], syncQ.data ?? []),
    [skillsQ.data, syncQ.data],
  );
  const pending = register.isPending || unregister.isPending;

  return (
    <div className="mx-auto w-full min-h-dvh max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
      <header className="mb-6">
        <h1 className="fg-h2">Skills</h1>
        <p className="fg-body-sm mt-1">
          Global and project skills, and the pipeline stages they run on.
        </p>
      </header>

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

      {!isLoading && !isError && skills.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {skills.map((skill) => (
            <SkillCard
              key={skill.id}
              skill={skill}
              canManage={canManage}
              pending={pending}
              onRegister={(skillId, stage) => register.mutate({ skillId, stage })}
              onUnregister={(stage) => unregister.mutate(stage)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
