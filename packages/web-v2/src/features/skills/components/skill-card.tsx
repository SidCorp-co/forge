"use client";

import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Icon,
  MonoTag,
  Select,
  type SelectOption,
} from "@/design";
import { REGISTERABLE_STAGES, STAGE_LABELS, type SkillView } from "../types";

interface SkillCardProps {
  skill: SkillView;
  /** Owner/admin can mutate registrations; others get read-only chips. */
  canManage: boolean;
  onRegister: (skillId: string, stage: string) => void;
  onUnregister: (stage: string) => void;
  /** Clone a global template into this project (only called for global cards). */
  onAdopt: (globalSkillId: string) => void;
  /** Open the Skill Studio to edit this skill (project cards only). */
  onEdit: () => void;
  pending: boolean;
  /** Show the scope badge. Suppressed when the surrounding view is single-scope. */
  showScope?: boolean;
}

export function SkillCard({
  skill,
  canManage,
  onRegister,
  onUnregister,
  onAdopt,
  onEdit,
  pending,
  showScope = true,
}: SkillCardProps) {
  const isGlobal = skill.scope === "global";
  const registered = new Set(skill.registeredStages);
  const stageOptions = useMemo<SelectOption[]>(
    () =>
      REGISTERABLE_STAGES.filter((s) => !registered.has(s)).map((s) => ({
        value: s,
        label: `${STAGE_LABELS[s]} (${s})`,
      })),
    [skill.registeredStages],
  );
  const [stage, setStage] = useState("");

  return (
    <Card>
      <CardContent>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="fg-body truncate font-semibold text-fg">{skill.name}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {showScope && (
                <Badge tone={skill.scope === "global" ? "cobalt" : "accent"}>{skill.scope}</Badge>
              )}
              {skill.synced ? (
                <Badge tone="green">synced</Badge>
              ) : (
                <Badge tone="neutral">unsynced</Badge>
              )}
              {skill.version != null && <MonoTag>v{skill.version}</MonoTag>}
            </div>
          </div>
          <span className="fg-caption flex-none whitespace-nowrap">
            {isGlobal
              ? "template"
              : `${skill.registeredStages.length} ${
                  skill.registeredStages.length === 1 ? "stage" : "stages"
                }`}
          </span>
        </div>

        {skill.description && (
          <p className="fg-body-sm mt-3 line-clamp-3 text-muted">{skill.description}</p>
        )}

        {isGlobal ? (
          <div className="mt-3">
            <p className="fg-caption text-muted">
              Org template — adopt a project copy you can then edit and enable on a stage.
            </p>
            {canManage && (
              <Button
                variant="secondary"
                size="sm"
                icon="plus"
                disabled={pending}
                onClick={() => onAdopt(skill.id)}
                className="mt-2 min-h-11"
              >
                Adopt to project
              </Button>
            )}
          </div>
        ) : (
          <>
            {canManage && (
              <div className="mt-3">
                <Button variant="secondary" size="sm" onClick={onEdit} className="min-h-11">
                  Edit skill
                </Button>
              </div>
            )}
            <div className="mt-3">
              <p className="fg-overline mb-1.5">Enabled stages</p>
              {skill.registeredStages.length === 0 ? (
                <p className="fg-caption">Not enabled on any stage.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {skill.registeredStages.map((s) => (
                    <span key={s} className="inline-flex items-center gap-1">
                      <MonoTag hue="cobalt">{s}</MonoTag>
                      {canManage && (
                        <button
                          type="button"
                          aria-label={`Disable ${skill.name} for ${s}`}
                          disabled={pending}
                          onClick={() => onUnregister(s)}
                          className="grid size-5 place-items-center rounded-sm text-subtle transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
                        >
                          <Icon name="x" size={12} />
                        </button>
                      )}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {canManage && stageOptions.length > 0 && (
              <div className="mt-3 flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <Select
                    options={stageOptions}
                    value={stage}
                    onChange={setStage}
                    placeholder="Enable on stage…"
                  />
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  icon="plus"
                  disabled={!stage || pending}
                  onClick={() => {
                    onRegister(skill.id, stage);
                    setStage("");
                  }}
                  className="min-h-11"
                >
                  Enable
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
