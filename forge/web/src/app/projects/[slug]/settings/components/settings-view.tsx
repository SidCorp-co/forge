'use client';

import type { ReactNode } from 'react';
import { useState } from 'react';
import { AlertBanner } from '@/components/ui';
import type { Device } from '@/features/project/types';
import type { useSettingsForm } from '../hooks';
import { ChatAgentSection } from './chat-agent-section';
import { CoolifySection } from './coolify-section';
import { GeneralSection } from './general-section';
import { ProvidersToolsSection } from './providers-tools-section';
import { SentrySection } from './sentry-section';
import { GitlabWebhookSection } from './gitlab-webhook-section';
import { AntigravitySection } from './antigravity-section';
import { DeviceIntegrationSection } from './device-integration-section';
import { PipelineSection } from './pipeline-section';
import { WebhookSection } from './webhook-section';
import { ChannelsSection } from './channels-section';

type SettingsFormReturn = ReturnType<typeof useSettingsForm>;

type SettingsViewProps = Omit<SettingsFormReturn, 'isLoading' | 'project'> & {
  projectDocumentId: string;
  projectName: string;
  projectSlug?: string;
  devices?: Device[];
  generalExtra?: ReactNode;
  integrationsExtra?: ReactNode;
};

const TABS = [
  { key: 'general', label: 'General', code: 'GEN' },
  { key: 'chat-agent', label: 'Chat Agent', code: 'AGT' },
  { key: 'pipeline', label: 'Pipeline', code: 'PLC' },
  { key: 'providers-tools', label: 'Providers', code: 'PRV' },
  { key: 'integrations', label: 'Integrations', code: 'EXT' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export function SettingsView({
  updateProject,
  name, setName,
  description, setDescription,
  repoPath, setRepoPath,
  baseBranch, setBaseBranch,
  productionBranch, setProductionBranch,
  defaultProvider, setDefaultProvider,
  agentProvider, setAgentProvider,
  agentPrompt, setAgentPrompt,
  agentMemoryEnabled, setAgentMemoryEnabled,
  agentName, setAgentName,
  agentRole, setAgentRole,
  enabledTools, setEnabledTools,
  enabledSkills, setEnabledSkills,
  domainTemplate, setDomainTemplate,
  behaviorRules, setBehaviorRules,
  queryStrategies, setQueryStrategies,
  coolifyResources, updateResource, removeResource, addResource,
  sentryProject, setSentryProject,
  gitRepoUrl, setGitRepoUrl,
  useRegistry, setUseRegistry,
  previewEnvVars, setPreviewEnvVars,
  webhookUrl, setWebhookUrl,
  webhookSecret, setWebhookSecret,
  webhookStatuses, setWebhookStatuses,
  channels, updateChannel, updateChannelConfig, removeChannel, addChannel,
  pipelineEnabled, setPipelineEnabled,
  pipelineSteps, setPipelineSteps,
  customPipelineSteps, setCustomPipelineSteps,
  useCustomPipeline, setUseCustomPipeline,
  heartbeatEnabled, setHeartbeatEnabled,
  heartbeatPaused, setHeartbeatPaused,
  heartbeatInterval, setHeartbeatInterval,
  testingUrls, setTestingUrls,
  testCredentials, setTestCredentials,
  antigravityProjectId, setAntigravityProjectId,
  antigravityModel, setAntigravityModel,
  antigravityError, antigravityErrorAt,
  handleSave,
  projectDocumentId,
  projectName,
  projectSlug,
  devices,
  generalExtra,
  integrationsExtra,
}: SettingsViewProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('general');

  return (
    <div className="w-full max-w-4xl mx-auto">
      {/* Alerts */}
      {updateProject.isError && (
        <div className="mb-4">
          <AlertBanner variant="error">Failed to save settings. Please try again.</AlertBanner>
        </div>
      )}
      {updateProject.isSuccess && (
        <div className="mb-4 rounded-sm border border-success/30 bg-success-surface p-3 text-[10px] font-bold uppercase tracking-widest text-success">
          Settings committed successfully.
        </div>
      )}

      {/* Tab Navigation — equal-width */}
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

      {/* Tab Content */}
      <div className="space-y-12">
      {activeTab === 'general' && (
        <>
          <GeneralSection
            name={name} setName={setName}
            description={description} setDescription={setDescription}
            repoPath={repoPath} setRepoPath={setRepoPath}
            baseBranch={baseBranch} setBaseBranch={setBaseBranch}
            productionBranch={productionBranch} setProductionBranch={setProductionBranch}
          />
          {generalExtra}
        </>
      )}

      {activeTab === 'chat-agent' && (
        <ChatAgentSection
          agentName={agentName} setAgentName={setAgentName}
          agentRole={agentRole} setAgentRole={setAgentRole}
          agentPrompt={agentPrompt} setAgentPrompt={setAgentPrompt}
          agentMemoryEnabled={agentMemoryEnabled} setAgentMemoryEnabled={setAgentMemoryEnabled}
          enabledSkills={enabledSkills} setEnabledSkills={setEnabledSkills}
          domainTemplate={domainTemplate} setDomainTemplate={setDomainTemplate}
          behaviorRules={behaviorRules} setBehaviorRules={setBehaviorRules}
          queryStrategies={queryStrategies} setQueryStrategies={setQueryStrategies}
          projectDocumentId={projectDocumentId}
          projectName={projectName}
        />
      )}

      {activeTab === 'pipeline' && (
        <PipelineSection
          projectDocumentId={projectDocumentId}
          pipelineEnabled={pipelineEnabled} setPipelineEnabled={setPipelineEnabled}
          pipelineSteps={pipelineSteps} setPipelineSteps={setPipelineSteps}
          customPipelineSteps={customPipelineSteps} setCustomPipelineSteps={setCustomPipelineSteps}
          useCustomPipeline={useCustomPipeline} setUseCustomPipeline={setUseCustomPipeline}
          antigravityConnected={!!antigravityProjectId}
          testingUrls={testingUrls} setTestingUrls={setTestingUrls}
          testCredentials={testCredentials} setTestCredentials={setTestCredentials}
          heartbeatEnabled={heartbeatEnabled} setHeartbeatEnabled={setHeartbeatEnabled}
          heartbeatPaused={heartbeatPaused} setHeartbeatPaused={setHeartbeatPaused}
          heartbeatInterval={heartbeatInterval} setHeartbeatInterval={setHeartbeatInterval}
        />
      )}

      {activeTab === 'providers-tools' && (
        <ProvidersToolsSection
          defaultProvider={defaultProvider} setDefaultProvider={setDefaultProvider}
          agentProvider={agentProvider} setAgentProvider={setAgentProvider}
          enabledTools={enabledTools} setEnabledTools={setEnabledTools}
        />
      )}

      {activeTab === 'integrations' && (
        <>
          <AntigravitySection
            antigravityProjectId={antigravityProjectId}
            setAntigravityProjectId={setAntigravityProjectId}
            antigravityModel={antigravityModel}
            setAntigravityModel={setAntigravityModel}
            projectDocumentId={projectDocumentId}
            projectSlug={projectSlug}
            gitRepoUrl={gitRepoUrl}
            antigravityError={antigravityError}
            antigravityErrorAt={antigravityErrorAt}
          />

          <DeviceIntegrationSection
            devices={devices ?? []}
            projectDocumentId={projectDocumentId}
            projectSlug={projectSlug}
            gitRepoUrl={gitRepoUrl}
          />

          <CoolifySection
            coolifyResources={coolifyResources}
            updateResource={updateResource}
            removeResource={removeResource}
            addResource={addResource}
          />

          <SentrySection
            sentryProject={sentryProject} setSentryProject={setSentryProject}
          />

          <GitlabWebhookSection
            gitRepoUrl={gitRepoUrl} setGitRepoUrl={setGitRepoUrl}
            webhookSecret={webhookSecret} setWebhookSecret={setWebhookSecret}
            useRegistry={useRegistry} setUseRegistry={setUseRegistry}
            previewEnvVars={previewEnvVars} setPreviewEnvVars={setPreviewEnvVars}
          />

          <WebhookSection
            webhookUrl={webhookUrl} setWebhookUrl={setWebhookUrl}
            webhookSecret={webhookSecret} setWebhookSecret={setWebhookSecret}
            webhookStatuses={webhookStatuses} setWebhookStatuses={setWebhookStatuses}
          />

          <ChannelsSection
            channels={channels}
            updateChannel={updateChannel}
            updateChannelConfig={updateChannelConfig}
            removeChannel={removeChannel}
            addChannel={addChannel}
          />

          {integrationsExtra}
        </>
      )}

      </div>

      {/* Save Footer */}
      <div className="pt-8 mt-12 border-t border-outline-variant/10 flex items-center justify-between">
        <button
          onClick={handleSave}
          disabled={updateProject.isPending}
          className="bg-gradient-to-br from-primary to-tertiary text-on-primary px-8 py-2.5 text-[10px] font-black uppercase tracking-[0.15em] rounded-sm hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {updateProject.isPending ? 'Committing...' : 'Commit Changes'}
        </button>
        <span className="text-[9px] font-mono text-outline hidden sm:block">
          {projectSlug?.toUpperCase() ?? 'PROJECT'}
        </span>
      </div>
    </div>
  );
}
