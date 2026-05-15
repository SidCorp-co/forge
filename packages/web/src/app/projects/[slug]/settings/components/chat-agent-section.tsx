'use client';

import { Label, Textarea } from '@/components/ui';
import { useChatAgentForm } from '../hooks/use-chat-agent-form';
import { useFocusOnMount } from '../hooks/use-focus-on-mount';
import { SectionSaveBar } from './section-save-bar';

interface Props {
  projectId: string;
  previewMode?: boolean;
}

export function ChatAgentSection({ projectId, previewMode = false }: Props) {
  const form = useChatAgentForm(previewMode ? undefined : projectId);
  useFocusOnMount();

  return (
    <section className="space-y-6">
      <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">
          Chat Agent
        </h2>
        <span className="text-[9px] font-mono text-outline">AGT_CHT</span>
      </div>

      <div className="bg-surface-container-low border border-outline-variant/30 p-8 space-y-8">
        <div>
          <Label>Custom System Prompt</Label>
          <div data-config-health-target="agent.systemPrompt">
            <Textarea
              value={form.state.systemPromptOverride}
              onChange={(e) => form.setField('systemPromptOverride', e.target.value)}
              rows={10}
              placeholder="Project-specific instructions appended to the default agent prompt. Leave empty to use the platform default."
              className="font-mono text-xs"
              disabled={previewMode}
            />
          </div>
          <p className="mt-2 text-[10px] text-outline">
            Stored on <code className="font-mono">app_config.systemPromptOverride</code>. Empty
            value clears the override.
          </p>
        </div>

        {!previewMode && (
          <SectionSaveBar
            isDirty={form.isDirty}
            isSubmitting={form.isSubmitting}
            isError={form.isError}
            isSuccess={form.isSuccess}
            onSave={() => void form.save()}
            onDiscard={form.reset}
          />
        )}
      </div>
    </section>
  );
}
