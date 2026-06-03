'use client';

import { useMemo, useState } from 'react';
import {
  useProjectSkillRegistrations,
  useRegisterSkill,
  useSkills,
} from '@/features/skill/hooks/use-skills';

interface Props {
  projectId: string;
  onSaved: () => void;
}

const DEFAULT_BINDINGS: Array<{ stage: string; skillName: string; label: string }> = [
  { stage: 'open', skillName: 'forge-triage', label: 'Open → Triage' },
  { stage: 'clarified', skillName: 'forge-plan', label: 'Clarified → Plan' },
  { stage: 'approved', skillName: 'forge-code', label: 'Approved → Code' },
  { stage: 'developed', skillName: 'forge-review', label: 'Developed → Review' },
  { stage: 'testing', skillName: 'forge-test', label: 'Testing → Test' },
  { stage: 'reopen', skillName: 'forge-fix', label: 'Reopen → Fix' },
  { stage: 'released', skillName: 'forge-release', label: 'Released → Release' },
];

export function SkillsStep({ projectId, onSaved }: Props) {
  const skills = useSkills(projectId);
  const registrations = useProjectSkillRegistrations(projectId);
  const registerSkill = useRegisterSkill(projectId);

  const [selections, setSelections] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const skillsByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of skills.data?.data ?? []) {
      map.set(s.name, s.id);
    }
    return map;
  }, [skills.data]);

  const allSkills = useMemo(() => skills.data?.data ?? [], [skills.data]);

  const registeredByStage = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of registrations.data?.registrations ?? []) {
      map.set(r.stage, r.skillId);
    }
    return map;
  }, [registrations.data]);

  const resolvedFor = (b: (typeof DEFAULT_BINDINGS)[number]): string => {
    if (selections[b.stage] !== undefined) return selections[b.stage];
    const already = registeredByStage.get(b.stage);
    if (already) return already;
    return skillsByName.get(b.skillName) ?? '';
  };

  const onSave = async () => {
    setError(null);
    setIsSaving(true);
    try {
      for (const b of DEFAULT_BINDINGS) {
        const skillId = resolvedFor(b);
        if (!skillId) continue;
        if (registeredByStage.get(b.stage) === skillId) continue;
        await registerSkill.mutateAsync({ skillId, stage: b.stage });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to register skills.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-on-surface-variant">
        Bind the seven default Forge skills to their pipeline stages. You can
        customise individual rows or accept the defaults.
      </p>

      <div className="space-y-2">
        {DEFAULT_BINDINGS.map((b) => {
          const value = resolvedFor(b);
          const defaultSkillExists = skillsByName.has(b.skillName);
          return (
            <div
              key={b.stage}
              className="flex items-center gap-3 border border-outline-variant/20 px-3 py-2"
            >
              <span className="w-44 text-sm text-on-surface-variant">{b.label}</span>
              <select
                value={value}
                onChange={(e) =>
                  setSelections((prev) => ({ ...prev, [b.stage]: e.target.value }))
                }
                disabled={isSaving}
                className="flex-1 bg-transparent border border-outline/30 py-1 px-2 text-sm rounded-sm"
              >
                <option value="">— none —</option>
                {allSkills.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              {!defaultSkillExists && (
                <span className="text-[10px] text-warning">Default not available</span>
              )}
            </div>
          );
        })}
      </div>

      {error && (
        <p className="text-xs text-error" role="alert">
          {error}
        </p>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void onSave()}
          disabled={isSaving || skills.isLoading}
          className="bg-primary text-on-primary px-4 py-2 text-sm rounded-sm disabled:opacity-50"
        >
          {isSaving ? 'Registering…' : 'Bind skills'}
        </button>
      </div>
    </div>
  );
}
