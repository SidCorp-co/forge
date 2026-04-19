'use client';

import { useEffect, useState } from 'react';
import { Switch, Input, Label, Textarea } from '@/components/ui';
import { apiClient } from '@/lib/api/client';

interface Skill {
  name: string;
  description: string;
}

interface DomainTemplateItem {
  documentId: string;
  key: string;
  label: string;
  description: string;
  isBuiltIn: boolean;
  behaviorRules?: string[];
  queryStrategies?: Record<string, string>;
  agentName?: string;
  agentRole?: string;
}

interface ChatAgentSectionProps {
  agentName: string;
  setAgentName: (v: string) => void;
  agentRole: string;
  setAgentRole: (v: string) => void;
  agentPrompt: string;
  setAgentPrompt: (v: string) => void;
  agentMemoryEnabled: boolean;
  setAgentMemoryEnabled: (v: boolean) => void;
  enabledSkills: string[];
  setEnabledSkills: (v: string[]) => void;
  domainTemplate: string;
  setDomainTemplate: (v: string) => void;
  behaviorRules: string[];
  setBehaviorRules: (v: string[]) => void;
  queryStrategies: Record<string, string>;
  setQueryStrategies: (v: Record<string, string>) => void;
  projectDocumentId: string;
  projectName: string;
}

const DEFAULT_AGENT_NAME = 'AI Assistant';
const STRATEGY_KEYS = ['LOOKUP', 'CREATE', 'SUMMARY', 'SEARCH', 'CHAT', 'ACTION'] as const;

export function ChatAgentSection({
  agentName,
  setAgentName,
  agentRole,
  setAgentRole,
  agentPrompt,
  setAgentPrompt,
  agentMemoryEnabled,
  setAgentMemoryEnabled,
  enabledSkills,
  setEnabledSkills,
  domainTemplate,
  setDomainTemplate,
  behaviorRules,
  setBehaviorRules,
  queryStrategies,
  setQueryStrategies,
  projectDocumentId,
  projectName,
}: ChatAgentSectionProps) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [templates, setTemplates] = useState<DomainTemplateItem[]>([]);

  useEffect(() => {
    apiClient<{ data: any[] }>(`/skills?fields[0]=name&fields[1]=description&fields[2]=target`)
      .then((res) => {
        const cloudSkills = res.data.filter((s) => s.target === 'cloud' || s.target === 'all');
        setSkills(cloudSkills.map((s) => ({ name: s.name, description: s.description || '' })));
      })
      .catch(() => {});

    apiClient<{ data: DomainTemplateItem[] }>(
      `/domain-templates?fields[0]=key&fields[1]=label&fields[2]=description&fields[3]=isBuiltIn&fields[4]=behaviorRules&fields[5]=queryStrategies&fields[6]=agentName&fields[7]=agentRole`,
    )
      .then((res) => {
        setTemplates(res.data || []);
      })
      .catch(() => {});
  }, []);

  const handleSkillToggle = (name: string, checked: boolean) => {
    if (checked) {
      setEnabledSkills([...enabledSkills, name]);
    } else {
      setEnabledSkills(enabledSkills.filter((s) => s !== name));
    }
  };

  const handleApplyTemplate = (key: string) => {
    setDomainTemplate(key);
    if (!key) return;
    const tpl = templates.find((t) => t.key === key);
    if (!tpl) return;
    // Flatten template values into form state
    if (tpl.agentName) setAgentName(tpl.agentName);
    if (tpl.agentRole) setAgentRole(tpl.agentRole);
    if (tpl.behaviorRules) setBehaviorRules(tpl.behaviorRules);
    if (tpl.queryStrategies) setQueryStrategies(tpl.queryStrategies);
  };

  const handleBehaviorRuleChange = (index: number, value: string) => {
    setBehaviorRules(behaviorRules.map((r, i) => (i === index ? value : r)));
  };

  const handleRemoveBehaviorRule = (index: number) => {
    setBehaviorRules(behaviorRules.filter((_, i) => i !== index));
  };

  const handleAddBehaviorRule = () => {
    setBehaviorRules([...behaviorRules, '']);
  };

  const handleStrategyChange = (key: string, value: string) => {
    if (!value.trim()) {
      const next = { ...queryStrategies };
      delete next[key];
      setQueryStrategies(next);
    } else {
      setQueryStrategies({ ...queryStrategies, [key]: value });
    }
  };

  const selectedTemplate = templates.find((t) => t.key === domainTemplate);

  return (
    <section className="space-y-6">
      <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">02. Agent Configuration</h2>
        <span className="text-[9px] font-mono text-outline">AGT_CFG_02</span>
      </div>
      <div className="bg-surface-container-low border border-outline-variant/30 p-8 space-y-8">
        {/* Domain Template Selector */}
        <div>
          <Label>Domain Template</Label>
          <select
            value={domainTemplate}
            onChange={(e) => handleApplyTemplate(e.target.value)}
            className="bg-surface-container-high border-b border-outline rounded-none px-0 py-3 text-sm text-on-surface focus:border-b-primary focus:outline-none focus:ring-0 w-full appearance-none"
          >
            <option value="">None (custom configuration)</option>
            {templates.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}{t.isBuiltIn ? '' : ' (custom)'}
              </option>
            ))}
          </select>
          {selectedTemplate && (
            <p className="mt-1 text-[10px] text-outline">
              {selectedTemplate.description} — Template values are copied below. Edit freely.
            </p>
          )}
          {!domainTemplate && (
            <p className="mt-1 text-[10px] text-outline">
              Select a template to populate behavior rules and query strategies. Values are copied to this project and can be edited independently.
            </p>
          )}
        </div>

        <div>
          <Label>Agent Name</Label>
          <Input
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            placeholder={DEFAULT_AGENT_NAME}
          />
          <p className="mt-1 text-xs text-outline">
            Identity: You are <strong>{agentName || DEFAULT_AGENT_NAME}</strong>, the project assistant for &quot;{projectName}&quot;.
          </p>
        </div>
        <div>
          <Label>Agent Role</Label>
          <Textarea
            value={agentRole}
            onChange={(e) => setAgentRole(e.target.value)}
            rows={2}
            placeholder="You help users manage issues, tasks, and comments."
          />
          <p className="mt-1 text-xs text-outline">Describes the core behavior of the agent.</p>
        </div>

        {/* Behavior Rules */}
        <div>
          <Label>Behavior Rules</Label>
          <p className="mb-2 text-[10px] text-outline">
            Domain-specific instructions injected into the system prompt. Each rule becomes a bullet point.
          </p>
          <div className="space-y-2">
            {behaviorRules.map((rule, i) => (
              <div key={i} className="flex gap-2">
                <Textarea
                  value={rule}
                  onChange={(e) => handleBehaviorRuleChange(i, e.target.value)}
                  rows={2}
                  className="flex-1"
                  placeholder="e.g. Always present a draft before creating items..."
                />
                <button
                  type="button"
                  onClick={() => handleRemoveBehaviorRule(i)}
                  className="self-start rounded px-2 py-1 text-xs text-danger hover:bg-danger-surface"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={handleAddBehaviorRule}
            className="mt-2 rounded border border-dashed border-outline-variant px-3 py-1.5 text-xs text-primary-fixed hover:border-outline-variant hover:text-on-surface-variant"
          >
            + Add Rule
          </button>
        </div>

        {/* Query Strategies */}
        <div>
          <Label>Query Strategies</Label>
          <p className="mb-2 text-[10px] text-outline">
            Override how the agent handles each query intent. Leave empty to use default behavior.
          </p>
          <div className="space-y-3">
            {STRATEGY_KEYS.map((key) => (
              <div key={key}>
                <label className="mb-1 block text-xs font-medium text-on-surface-variant">{key}</label>
                <Textarea
                  value={queryStrategies[key] || ''}
                  onChange={(e) => handleStrategyChange(key, e.target.value)}
                  rows={2}
                  placeholder={`Strategy for ${key} intent...`}
                />
              </div>
            ))}
          </div>
        </div>

        <div>
          <Label>Custom Guidelines</Label>
          <Textarea
            value={agentPrompt}
            onChange={(e) => setAgentPrompt(e.target.value)}
            rows={4}
            placeholder="Add project-specific instructions here..."
          />
          <p className="mt-1 text-xs text-outline">
            Added as &quot;Project Guidelines&quot; section. Variables: {'{projectName}'}, {'{projectDescription}'}, {'{model}'}, {'{source}'}, {'{serverKeys}'}, {'{language}'}
          </p>
        </div>
        <Switch
          id="agentMemory"
          checked={agentMemoryEnabled}
          onChange={(e) => setAgentMemoryEnabled(e.target.checked)}
          label="Enable agent memory"
        />

        <div>
          <Label>Enabled Skills</Label>
          {skills.length > 0 ? (
            <>
              <p className="mb-2 text-[10px] text-outline">Select which cloud skills the agent can use. Leave all unchecked to enable all.</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {skills.map((skill) => (
                  <Switch
                    key={skill.name}
                    id={`skill-${skill.name}`}
                    checked={enabledSkills.length === 0 || enabledSkills.includes(skill.name)}
                    onChange={(e) => {
                      if (enabledSkills.length === 0) {
                        const allNames = skills.map((s) => s.name);
                        if (!e.target.checked) {
                          setEnabledSkills(allNames.filter((n) => n !== skill.name));
                        }
                      } else {
                        handleSkillToggle(skill.name, e.target.checked);
                      }
                    }}
                    label={skill.name}
                  />
                ))}
              </div>
            </>
          ) : (
            <p className="mt-1 text-[10px] text-outline">No cloud skills found. Create skills with target &quot;cloud&quot; or &quot;all&quot; to enable selection here.</p>
          )}
        </div>
      </div>
    </section>
  );
}
