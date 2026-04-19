import { Button, FormInput, FormTextarea, FormSelect, FormCheckbox, FormLabel } from "@/components/ui";
import type { Agent, AgentSchedule, AgentApprovalMode } from "@/lib/types";
import { FOCUS_AREAS } from "./constants";

interface AgentConfigPanelProps {
  agent: Agent;
  draft: Partial<Agent>;
  isSaving: boolean;
  onDraftChange: (updater: (prev: Partial<Agent>) => Partial<Agent>) => void;
  onSave: () => void;
}

export function AgentConfigPanel({ agent, draft, isSaving, onDraftChange, onSave }: AgentConfigPanelProps) {
  return (
    <div className="border-t border-gray-100 p-5 space-y-4">
      <FormCheckbox
        id={`enabled-${agent.documentId}`}
        label="Enabled"
        checked={draft.enabled ?? false}
        onChange={(e) => onDraftChange((prev) => ({ ...prev, enabled: e.target.checked }))}
      />

      <div>
        <FormLabel>Focus Areas</FormLabel>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {FOCUS_AREAS.map((area) => (
            <label
              key={area.value}
              className="flex items-start gap-2 rounded-lg border border-gray-200 p-2.5 hover:bg-gray-50"
            >
              <input
                type="checkbox"
                checked={(draft.focusAreas || []).includes(area.value)}
                onChange={(e) => {
                  onDraftChange((prev) => ({
                    ...prev,
                    focusAreas: e.target.checked
                      ? [...(prev.focusAreas || []), area.value]
                      : (prev.focusAreas || []).filter((v) => v !== area.value),
                  }));
                }}
                className="mt-0.5 h-4 w-4 rounded border-gray-300"
              />
              <div>
                <span className="text-sm font-medium text-gray-800">{area.label}</span>
                <p className="text-xs text-gray-500">{area.description}</p>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div>
        <FormLabel>Custom Instructions</FormLabel>
        <FormTextarea
          value={draft.customInstructions || ""}
          onChange={(e) => onDraftChange((prev) => ({ ...prev, customInstructions: e.target.value }))}
          rows={3}
          placeholder='e.g. "Focus on mobile experience", "Ignore admin panel"'
        />
      </div>

      {agent.definition?.promptTemplate && (
        <div>
          <FormLabel hint="Leave empty to use definition default">Review Prompt</FormLabel>
          <FormTextarea
            value={draft.promptTemplate || ""}
            onChange={(e) => onDraftChange((prev) => ({ ...prev, promptTemplate: e.target.value }))}
            rows={6}
            placeholder={
              agent.definition.promptTemplate.slice(0, 500) +
              (agent.definition.promptTemplate.length > 500 ? "..." : "")
            }
            className="font-mono text-xs"
          />
        </div>
      )}

      {agent.definition?.reindexPromptTemplate && (
        <div>
          <FormLabel hint="Leave empty to use definition default">Reindex Prompt</FormLabel>
          <FormTextarea
            value={draft.reindexPromptTemplate || ""}
            onChange={(e) => onDraftChange((prev) => ({ ...prev, reindexPromptTemplate: e.target.value }))}
            rows={6}
            placeholder={
              agent.definition.reindexPromptTemplate.slice(0, 500) +
              (agent.definition.reindexPromptTemplate.length > 500 ? "..." : "")
            }
            className="font-mono text-xs"
          />
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <FormLabel>Schedule</FormLabel>
          <FormSelect
            value={draft.schedule || "off"}
            onChange={(e) => onDraftChange((prev) => ({ ...prev, schedule: e.target.value as AgentSchedule }))}
          >
            <option value="off">Off</option>
            <option value="weekly">Weekly (Monday)</option>
            <option value="biweekly">Biweekly</option>
            <option value="monthly">Monthly (1st)</option>
          </FormSelect>
        </div>
        <div>
          <FormLabel>Approval Mode</FormLabel>
          <FormSelect
            value={draft.approvalMode || "preview"}
            onChange={(e) =>
              onDraftChange((prev) => ({ ...prev, approvalMode: e.target.value as AgentApprovalMode }))
            }
          >
            <option value="preview">Preview (human reviews)</option>
            <option value="auto-create">Auto-create issues</option>
          </FormSelect>
        </div>
        <div>
          <FormLabel>Max Proposals</FormLabel>
          <FormInput
            type="number"
            min={1}
            max={50}
            value={draft.maxProposals ?? 10}
            onChange={(e) =>
              onDraftChange((prev) => ({ ...prev, maxProposals: parseInt(e.target.value) || 10 }))
            }
          />
        </div>
      </div>

      <div className="flex justify-end pt-2">
        <Button onClick={onSave} disabled={isSaving}>
          {isSaving ? "Saving..." : "Save Configuration"}
        </Button>
      </div>
    </div>
  );
}
