'use client';

import { Switch, Label, Select } from '@/components/ui';
import type { AIProvider } from '@/features/project/types';
import { AI_PROVIDERS } from '../constants';

const ALL_TOOLS = [
  { value: 'forge_issues', label: 'Issues' },
  { value: 'forge_comments', label: 'Comments' },
  { value: 'forge_skills', label: 'Skills' },
  { value: 'forge_memory', label: 'Memory' },
  { value: 'forge_language', label: 'Language' },
  { value: 'forge_config', label: 'Config' },
  { value: 'forge_coolify_deploy', label: 'Coolify Deploy' },
  { value: 'forge_sentry', label: 'Sentry' },
  { value: 'forge_agent_sessions', label: 'Agent Sessions' },
];

interface ProvidersToolsSectionProps {
  defaultProvider: AIProvider | '';
  setDefaultProvider: (v: AIProvider | '') => void;
  agentProvider: AIProvider | '';
  setAgentProvider: (v: AIProvider | '') => void;
  enabledTools: string[];
  setEnabledTools: (v: string[]) => void;
}

export function ProvidersToolsSection({
  defaultProvider,
  setDefaultProvider,
  agentProvider,
  setAgentProvider,
  enabledTools,
  setEnabledTools,
}: ProvidersToolsSectionProps) {
  const handleToolToggle = (tool: string, checked: boolean) => {
    const current = enabledTools.length === 0 ? ALL_TOOLS.map((t) => t.value) : enabledTools;
    if (checked) {
      setEnabledTools([...current, tool]);
    } else {
      setEnabledTools(current.filter((t) => t !== tool));
    }
  };

  return (
    <section className="space-y-6">
      <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">04. Providers &amp; Tools</h2>
        <span className="text-[9px] font-mono text-outline">PRV_CFG_04</span>
      </div>
      <div className="bg-surface-container-low border border-outline-variant/30 p-8 space-y-8">
        <div>
          <Label>Default Provider</Label>
          <Select
            value={defaultProvider}
            onChange={(e) => setDefaultProvider(e.target.value as AIProvider | '')}
            className="w-full"
          >
            {AI_PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Agent Provider</Label>
          <Select
            value={agentProvider}
            onChange={(e) => setAgentProvider(e.target.value as AIProvider | '')}
            className="w-full"
          >
            {AI_PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </Select>
          <p className="mt-1 text-[10px] text-outline">Overrides the default provider for agent tasks.</p>
        </div>
        <div>
          <Label>Enabled Tools</Label>
          <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {ALL_TOOLS.map((tool) => (
              <Switch
                key={tool.value}
                id={`tool-${tool.value}`}
                checked={enabledTools.length === 0 || enabledTools.includes(tool.value)}
                onChange={(e) => handleToolToggle(tool.value, e.target.checked)}
                label={tool.label}
              />
            ))}
          </div>
          <p className="mt-1 text-[10px] text-outline">Tools available to the AI agent. Unchecked tools will not appear in chat.</p>
        </div>
      </div>
    </section>
  );
}
