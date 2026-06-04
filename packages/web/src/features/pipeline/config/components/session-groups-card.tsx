'use client';

import { useState } from 'react';
import { Button, Input, Select } from '@/components/ui';
import { STAGE_NAMES, type StageName } from '../types';
import type { SessionGroupsFormState } from '../hooks/use-pipeline-config';

interface Props {
  value: SessionGroupsFormState;
  /** stage → registered skill name (e.g. `clarified → forge-plan`). */
  skillByStage: Record<string, string>;
  onAddGroup: (name: string) => void;
  onRenameGroup: (oldName: string, newName: string) => void;
  onRemoveGroup: (name: string) => void;
  onAssign: (stage: StageName, group: string | null) => void;
  disabled?: boolean;
}

const UNGROUPED = '';

/**
 * ISS-382 — view + edit `pipelineConfig.sessionGroups`. Adjacent stages in the
 * same group reuse one agent CLI session (continuity). The partition is shown
 * explicitly, including an always-visible "Ungrouped" bucket so an operator is
 * never misled into thinking every stage is covered. Each stage is annotated
 * with its registered stage→skill so the continuity impact is legible.
 */
export function SessionGroupsCard({
  value,
  skillByStage,
  onAddGroup,
  onRenameGroup,
  onRemoveGroup,
  onAssign,
  disabled,
}: Props) {
  const [newName, setNewName] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  const groupedStages = (group: string): StageName[] =>
    STAGE_NAMES.filter((s) => value.assignment[s] === group);
  const ungroupedStages = STAGE_NAMES.filter((s) => !value.assignment[s]);

  const submitAdd = () => {
    const trimmed = newName.trim();
    if (!trimmed) {
      setAddError('Group name is required.');
      return;
    }
    if (value.groupNames.includes(trimmed)) {
      setAddError('A group with that name already exists.');
      return;
    }
    onAddGroup(trimmed);
    setNewName('');
    setAddError(null);
  };

  return (
    <div className="bg-surface-container-low border border-outline-variant/30 p-6 space-y-5">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-on-surface">Session groups</h3>
        <p className="text-xs text-on-surface-variant">
          Stages in the same group reuse one agent session, preserving context across adjacent
          pipeline steps. A stage belongs to at most one group; stages left{' '}
          <span className="font-medium">Ungrouped</span> each run in their own fresh session.
        </p>
      </div>

      {/* Add group */}
      <div className="flex items-end gap-2">
        <label className="space-y-1 block flex-1 max-w-xs">
          <span className="text-xs font-medium text-on-surface block">New group</span>
          <Input
            value={newName}
            disabled={disabled}
            placeholder="e.g. build"
            onChange={(e) => {
              setNewName(e.target.value);
              if (addError) setAddError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitAdd();
              }
            }}
            className="h-9"
          />
        </label>
        <Button type="button" variant="secondary" disabled={disabled} onClick={submitAdd}>
          Add group
        </Button>
      </div>
      {addError && <p className="text-[11px] text-error -mt-3">{addError}</p>}

      {/* Existing groups */}
      {value.groupNames.length === 0 ? (
        <p className="text-xs text-on-surface-variant border-t border-outline-variant/20 pt-4">
          No session groups yet. Every stage runs in its own session (see Ungrouped below).
        </p>
      ) : (
        <div className="space-y-4 border-t border-outline-variant/20 pt-4">
          {value.groupNames.map((group) => {
            const members = groupedStages(group);
            return (
              <div
                key={group}
                className="border border-outline-variant/30 rounded-sm p-4 space-y-3"
              >
                <div className="flex items-center gap-2">
                  <RenameInput
                    name={group}
                    disabled={disabled}
                    existing={value.groupNames}
                    onCommit={(next) => onRenameGroup(group, next)}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => onRemoveGroup(group)}
                  >
                    Delete
                  </Button>
                </div>
                {members.length === 0 ? (
                  <p className="text-[11px] text-on-surface-variant">
                    No stages assigned — this group will be dropped when you save.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {members.map((stage) => (
                      <StageRow
                        key={stage}
                        stage={stage}
                        group={group}
                        skillByStage={skillByStage}
                        groupNames={value.groupNames}
                        disabled={disabled}
                        onAssign={onAssign}
                      />
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Ungrouped — always visible */}
      <div className="border-t border-outline-variant/20 pt-4 space-y-2">
        <h4 className="text-xs font-medium text-on-surface uppercase tracking-wider">
          Ungrouped
          <span className="ml-2 normal-case font-normal text-[11px] text-on-surface-variant">
            each stage runs in its own session
          </span>
        </h4>
        {ungroupedStages.length === 0 ? (
          <p className="text-[11px] text-on-surface-variant">Every stage is assigned to a group.</p>
        ) : (
          <ul className="space-y-2">
            {ungroupedStages.map((stage) => (
              <StageRow
                key={stage}
                stage={stage}
                group={UNGROUPED}
                skillByStage={skillByStage}
                groupNames={value.groupNames}
                disabled={disabled}
                onAssign={onAssign}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function StageRow({
  stage,
  group,
  skillByStage,
  groupNames,
  disabled,
  onAssign,
}: {
  stage: StageName;
  group: string;
  skillByStage: Record<string, string>;
  groupNames: string[];
  disabled?: boolean;
  onAssign: (stage: StageName, group: string | null) => void;
}) {
  const skill = skillByStage[stage];
  return (
    <li className="flex items-center justify-between gap-3">
      <span className="text-xs text-on-surface font-mono">
        {stage}
        {skill && <span className="text-on-surface-variant"> · {skill}</span>}
      </span>
      <Select
        value={group}
        disabled={disabled}
        aria-label={`Group for ${stage}`}
        className="h-8 py-1 text-xs min-w-[8rem]"
        onChange={(e) => onAssign(stage, e.target.value === UNGROUPED ? null : e.target.value)}
      >
        <option value={UNGROUPED}>Ungrouped</option>
        {groupNames.map((g) => (
          <option key={g} value={g}>
            {g}
          </option>
        ))}
      </Select>
    </li>
  );
}

/**
 * Controlled rename input that commits on blur / Enter and surfaces a
 * duplicate-name error inline without mutating global state mid-keystroke.
 */
function RenameInput({
  name,
  existing,
  disabled,
  onCommit,
}: {
  name: string;
  existing: string[];
  disabled?: boolean;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === name) {
      setError(null);
      return;
    }
    if (!trimmed) {
      setError('Required');
      setDraft(name);
      return;
    }
    if (existing.includes(trimmed)) {
      setError('Name already exists');
      return;
    }
    setError(null);
    onCommit(trimmed);
  };

  return (
    <div className="flex-1 space-y-0.5">
      <Input
        value={draft}
        disabled={disabled}
        aria-label={`Rename group ${name}`}
        onChange={(e) => {
          setDraft(e.target.value);
          if (error) setError(null);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
        className="h-8 text-sm font-medium"
      />
      {error && <span className="text-[10px] text-error block">{error}</span>}
    </div>
  );
}
