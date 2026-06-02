'use client';

import { useParams } from 'next/navigation';
import { Suspense } from 'react';
import { useProjectBySlug } from '@/features/project/hooks/use-projects';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { useAuth } from '@/providers/auth-provider';
import { BasicsSection } from './components/basics-section';
import { ChatAgentSection } from './components/chat-agent-section';
import { ChannelsSection } from './components/channels-section';
import { CoolifySection } from './components/coolify-section';
import { DevicesSection } from './components/devices-section';
import { GitlabWebhookSection } from './components/gitlab-webhook-section';
import { LabelsSection } from './components/labels-section';
import { MembersSection } from './components/members-section';
import { PipelineConfigSection } from './components/pipeline-config-section';
import { ProvidersToolsSection } from './components/providers-tools-section';
import { RepoSection } from './components/repo-section';
import { SentrySection } from './components/sentry-section';
import { SettingsHeader } from './components/settings-header';
import { SettingsLayout, type SettingsGroup } from './components/settings-layout';
import { SkillRegistrationsSection } from './components/skill-registrations-section';
import { TestingSection } from './components/testing-section';
import { WebhookSection } from './components/webhook-section';
import { AntigravitySection } from './components/antigravity-section';
import { ArchiveSection } from './components/archive-section';

export default function ProjectSettingsPage() {
  useSetPageTitle('Project settings');
  const { user } = useAuth();
  const { slug } = useParams<{ slug: string }>();
  // ISS-353 — include archived projects so an archived project's settings
  // page (and its Unarchive action) stays reachable after archiving.
  const project = useProjectBySlug(slug, { includeArchived: true });

  if (!project) {
    return (
      <div className="flex flex-col gap-6 p-6">
        <p className="text-sm text-primary-fixed">Loading project…</p>
      </div>
    );
  }

  const isOwner = project.ownerId === user?.id;
  const projectId = project.id;

  const groups: SettingsGroup[] = [
    {
      label: 'Identity',
      items: [
        { id: 'identity.basics', label: 'Basics', tag: 'IDN_BSC', render: () => <BasicsSection projectId={projectId} /> },
        { id: 'identity.repo', label: 'Repository', tag: 'IDN_REP', render: () => <RepoSection projectId={projectId} /> },
        { id: 'identity.members', label: 'Members', tag: 'IDN_MBR', render: () => <MembersSection projectId={projectId} isOwner={isOwner} /> },
        { id: 'identity.devices', label: 'Devices', tag: 'IDN_DEV', render: () => <DevicesSection projectId={projectId} isOwner={isOwner} /> },
        { id: 'identity.labels', label: 'Labels', tag: 'IDN_LBL', render: () => <LabelsSection projectId={projectId} /> },
      ],
    },
    {
      label: 'Pipeline',
      items: [
        { id: 'pipeline.config', label: 'Configuration', tag: 'PLC_CFG', render: () => <PipelineConfigSection projectId={projectId} /> },
        { id: 'pipeline.skills', label: 'Skills', tag: 'PLC_SKL', render: () => <SkillRegistrationsSection projectId={projectId} isOwner={isOwner} /> },
        { id: 'pipeline.testing', label: 'Testing', tag: 'PLC_TST', render: () => <TestingSection projectId={projectId} isOwner={isOwner} /> },
      ],
    },
    {
      label: 'Agent',
      items: [
        { id: 'agent.chat', label: 'Chat Agent', tag: 'AGT_CHT', render: () => <ChatAgentSection projectId={projectId} /> },
        { id: 'agent.providers', label: 'Providers', tag: 'AGT_PRV', render: () => <ProvidersToolsSection projectId={projectId} /> },
      ],
    },
    {
      label: 'Integrations',
      items: [
        { id: 'int.antigravity', label: 'Antigravity', tag: 'INT_ATG', render: () => <AntigravitySection previewMode /> },
        { id: 'int.coolify', label: 'Coolify', tag: 'INT_CLF', render: () => <CoolifySection projectId={projectId} /> },
        { id: 'int.sentry', label: 'Sentry', tag: 'INT_SNT', render: () => <SentrySection previewMode /> },
        { id: 'int.gitlab', label: 'GitLab Webhook', tag: 'INT_GLB', render: () => <GitlabWebhookSection previewMode /> },
        { id: 'int.channels', label: 'Channels', tag: 'INT_CHN', render: () => <ChannelsSection previewMode /> },
        { id: 'int.webhooks', label: 'Generic Webhooks', tag: 'INT_WHK', render: () => <WebhookSection previewMode /> },
      ],
    },
    {
      label: 'Advanced',
      items: [
        { id: 'danger.archive', label: 'Archive', tag: 'DNG_ARC', render: () => <ArchiveSection projectId={projectId} isOwner={isOwner} /> },
      ],
    },
  ];

  return (
    <div className="flex flex-col gap-8 p-6">
      <Suspense fallback={<div className="h-6" />}>
        <SettingsHeader
          projectId={projectId}
          title={project.name}
          subtitle="Identity, pipeline, agent, and integration configuration."
        />
      </Suspense>

      <Suspense fallback={<div className="h-12" />}>
        <SettingsLayout groups={groups} defaultSectionId="identity.basics" />
      </Suspense>
    </div>
  );
}
