'use client';

import type { ReactNode } from 'react';
import { useState } from 'react';
import { UnimplementedBanner } from '@/components/common/unimplemented-banner';
import { AlertBanner } from '@/components/ui';
import type { useSettingsForm } from '../hooks';
import { ChatAgentSection } from './chat-agent-section';
import { GeneralSection } from './general-section';
import { ProvidersToolsSection } from './providers-tools-section';

type SettingsFormReturn = ReturnType<typeof useSettingsForm>;

type SettingsViewProps = SettingsFormReturn & {
  projectSlug?: string;
  generalExtra?: ReactNode;
};

const TABS = [
  { key: 'general', label: 'General', code: 'GEN' },
  { key: 'chat-agent', label: 'Chat Agent', code: 'AGT' },
  { key: 'pipeline', label: 'Pipeline', code: 'PLC' },
  { key: 'providers', label: 'Providers', code: 'PRV' },
  { key: 'integrations', label: 'Integrations', code: 'EXT' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export function SettingsView({
  state,
  setField,
  isDirty,
  isSubmitting,
  isError,
  isSuccess,
  save,
  reset,
  projectSlug,
  generalExtra,
}: SettingsViewProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('general');

  return (
    <div className="w-full max-w-4xl mx-auto">
      {isError && (
        <div className="mb-4">
          <AlertBanner variant="error">Failed to save settings. Please try again.</AlertBanner>
        </div>
      )}
      {isSuccess && !isDirty && (
        <div className="mb-4 rounded-sm border border-success/30 bg-success-surface p-3 text-[10px] font-bold uppercase tracking-widest text-success">
          Settings committed successfully.
        </div>
      )}

      <div className="mb-10">
        <nav className="grid w-full grid-cols-5 border-b border-outline-variant/10">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`py-3 text-[10px] uppercase tracking-[0.15em] font-bold transition-colors border-b-2 text-center ${
                activeTab === tab.key
                  ? 'border-primary text-primary'
                  : 'border-transparent text-on-surface-variant hover:text-on-surface'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="space-y-12">
        {activeTab === 'general' && (
          <>
            <GeneralSection
              name={state.name}
              setName={(v) => setField('name', v)}
              description={state.description}
              setDescription={(v) => setField('description', v)}
              repoPath={state.repoPath}
              setRepoPath={(v) => setField('repoPath', v)}
              baseBranch={state.baseBranch}
              setBaseBranch={(v) => setField('baseBranch', v)}
              productionBranch={state.productionBranch}
              setProductionBranch={(v) => setField('productionBranch', v)}
            />
            {generalExtra}
          </>
        )}

        {activeTab === 'chat-agent' && (
          <ChatAgentSection
            systemPromptOverride={state.systemPromptOverride}
            setSystemPromptOverride={(v) => setField('systemPromptOverride', v)}
          />
        )}

        {activeTab === 'pipeline' && (
          <UnimplementedBanner
            feature="Pipeline configuration"
            hint="Pipeline step configuration, custom flows, heartbeat sweep, and test credentials land in v0.1.7+ once the pipeline schema ships in forge/core."
          />
        )}

        {activeTab === 'providers' && (
          <ProvidersToolsSection
            chatProviderId={state.chatProviderId}
            setChatProviderId={(v) => setField('chatProviderId', v)}
            chatModel={state.chatModel}
            setChatModel={(v) => setField('chatModel', v)}
          />
        )}

        {activeTab === 'integrations' && (
          <UnimplementedBanner
            feature="Integrations"
            hint="Antigravity, GitLab, Coolify, Sentry, generic webhooks, channels, and the embeddable widget snippet land in v0.1.8–v0.1.10 (Phase E)."
          />
        )}
      </div>

      <div className="pt-8 mt-12 border-t border-outline-variant/10 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void save()}
            disabled={isSubmitting || !isDirty}
            className="bg-gradient-to-br from-primary to-tertiary text-on-primary px-8 py-2.5 text-[10px] font-black uppercase tracking-[0.15em] rounded-sm hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? 'Committing...' : 'Commit Changes'}
          </button>
          {isDirty && (
            <button
              type="button"
              onClick={reset}
              disabled={isSubmitting}
              className="text-[10px] font-medium uppercase tracking-[0.15em] text-on-surface-variant hover:text-on-surface disabled:opacity-50"
            >
              Discard
            </button>
          )}
        </div>
        <span className="text-[9px] font-mono text-outline hidden sm:block">
          {projectSlug?.toUpperCase() ?? 'PROJECT'}
        </span>
      </div>
    </div>
  );
}
