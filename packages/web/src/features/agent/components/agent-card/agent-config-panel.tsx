'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import type { Agent, AgentSchedule, AgentApprovalMode } from '../../api';
import { FOCUS_AREAS } from '../../constants';

interface AgentConfigPanelProps {
  agent: Agent;
  draft: Partial<Agent>;
  saving: boolean;
  onDraftChange: (patch: Partial<Agent>) => void;
  onSave: () => void;
}

export function AgentConfigPanel({
  agent,
  draft,
  saving,
  onDraftChange,
  onSave,
}: AgentConfigPanelProps) {
  return (
    <div className="border-t border-outline-variant/20 p-5 space-y-4">
      <Checkbox
        id={`enabled-${agent.documentId}`}
        label="Enabled"
        checked={draft.enabled ?? false}
        onChange={(e) => onDraftChange({ enabled: e.target.checked })}
      />

      <div>
        <Label>Focus Areas</Label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {FOCUS_AREAS.map((area) => (
            <label
              key={area.value}
              className="flex items-start gap-2 rounded-lg border border-outline-variant/30 p-2.5 hover:bg-surface-container-low"
            >
              <input
                type="checkbox"
                checked={(draft.focusAreas || []).includes(area.value)}
                onChange={(e) => {
                  onDraftChange({
                    focusAreas: e.target.checked
                      ? [...(draft.focusAreas || []), area.value]
                      : (draft.focusAreas || []).filter((v) => v !== area.value),
                  });
                }}
                className="mt-0.5 h-4 w-4 rounded border-outline-variant"
              />
              <div>
                <span className="text-sm font-medium text-on-surface">{area.label}</span>
                <p className="text-xs text-primary-fixed">{area.description}</p>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div>
        <Label>Custom Instructions</Label>
        <Textarea
          value={draft.customInstructions || ''}
          onChange={(e) => onDraftChange({ customInstructions: e.target.value })}
          rows={3}
          placeholder='e.g. "Focus on mobile experience", "Ignore admin panel"'
        />
      </div>

      {agent.definition?.promptTemplate && (
        <div>
          <Label hint="Leave empty to use definition default">Review Prompt</Label>
          <Textarea
            value={draft.promptTemplate || ''}
            onChange={(e) => onDraftChange({ promptTemplate: e.target.value })}
            rows={6}
            placeholder={
              agent.definition.promptTemplate.slice(0, 500) +
              (agent.definition.promptTemplate.length > 500 ? '...' : '')
            }
            className="font-mono text-xs"
          />
        </div>
      )}

      {agent.definition?.reindexPromptTemplate && (
        <div>
          <Label hint="Leave empty to use definition default">Reindex Prompt</Label>
          <Textarea
            value={draft.reindexPromptTemplate || ''}
            onChange={(e) => onDraftChange({ reindexPromptTemplate: e.target.value })}
            rows={6}
            placeholder={
              agent.definition.reindexPromptTemplate.slice(0, 500) +
              (agent.definition.reindexPromptTemplate.length > 500 ? '...' : '')
            }
            className="font-mono text-xs"
          />
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <Label>Schedule</Label>
          <Select
            value={draft.schedule || 'off'}
            onChange={(e) =>
              onDraftChange({ schedule: e.target.value as AgentSchedule })
            }
          >
            <option value="off">Off</option>
            <option value="weekly">Weekly (Monday)</option>
            <option value="biweekly">Biweekly</option>
            <option value="monthly">Monthly (1st)</option>
          </Select>
        </div>
        <div>
          <Label>Approval Mode</Label>
          <Select
            value={draft.approvalMode || 'preview'}
            onChange={(e) =>
              onDraftChange({ approvalMode: e.target.value as AgentApprovalMode })
            }
          >
            <option value="preview">Preview (human reviews)</option>
            <option value="auto-create">Auto-create issues</option>
          </Select>
        </div>
        <div>
          <Label>Max Proposals</Label>
          <Input
            type="number"
            min={1}
            max={50}
            value={draft.maxProposals ?? 10}
            onChange={(e) =>
              onDraftChange({ maxProposals: parseInt(e.target.value) || 10 })
            }
          />
        </div>
      </div>

      <div className="flex justify-end pt-2">
        <Button onClick={onSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save Configuration'}
        </Button>
      </div>
    </div>
  );
}
