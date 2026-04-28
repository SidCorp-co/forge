'use client';

import { Label, Textarea } from '@/components/ui';

interface ChatAgentSectionProps {
  systemPromptOverride: string;
  setSystemPromptOverride: (v: string) => void;
}

export function ChatAgentSection({
  systemPromptOverride,
  setSystemPromptOverride,
}: ChatAgentSectionProps) {
  return (
    <section className="space-y-6">
      <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">
          02. Chat Agent
        </h2>
        <span className="text-[9px] font-mono text-outline">AGT_CFG_01</span>
      </div>

      <div className="bg-surface-container-low border border-outline-variant/30 p-8 space-y-8">
        <div>
          <Label>Custom System Prompt</Label>
          <Textarea
            value={systemPromptOverride}
            onChange={(e) => setSystemPromptOverride(e.target.value)}
            rows={10}
            placeholder="Project-specific instructions appended to the default agent prompt. Leave empty to use the platform default."
            className="font-mono text-xs"
          />
          <p className="mt-2 text-[10px] text-outline">
            Stored on <code className="font-mono">app_config.systemPromptOverride</code>. Empty
            value clears the override.
          </p>
        </div>
      </div>
    </section>
  );
}
