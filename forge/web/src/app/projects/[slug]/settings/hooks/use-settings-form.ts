'use client';

import { useEffect, useState } from 'react';
import { useProject, useUpdateProject } from '@/features/project/hooks/use-projects';
import type { AIProvider, ChannelConfig } from '@/features/project/types';

export function useSettingsForm(slug: string) {
  const { data, isLoading } = useProject(slug);
  const project = data?.data;
  const updateProject = useUpdateProject();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [baseBranch, setBaseBranch] = useState('main');
  const [productionBranch, setProductionBranch] = useState('');
  const [defaultProvider, setDefaultProvider] = useState<AIProvider | ''>('');
  const [agentProvider, setAgentProvider] = useState<AIProvider | ''>('');
  const [agentPrompt, setAgentPrompt] = useState('');
  const [agentMemoryEnabled, setAgentMemoryEnabled] = useState(true);
  const [coolifyResources, setCoolifyResources] = useState<{ name: string; uuid: string }[]>([]);
  const [sentryProject, setSentryProject] = useState('');
  const [gitRepoUrl, setGitRepoUrl] = useState('');
  const [previewEnvVars, setPreviewEnvVars] = useState<{ key: string; value: string }[]>([]);
  const [useRegistry, setUseRegistry] = useState(false);
  const [testingUrls, setTestingUrls] = useState<{ label: string; url: string }[]>([]);
  const [testCredentials, setTestCredentials] = useState<{ label: string; username: string; password: string }[]>([]);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [webhookStatuses, setWebhookStatuses] = useState<string[]>([]);
  const [agentName, setAgentName] = useState('');
  const [agentRole, setAgentRole] = useState('');
  const [enabledTools, setEnabledTools] = useState<string[]>([]);
  const [enabledSkills, setEnabledSkills] = useState<string[]>([]);
  const [domainTemplate, setDomainTemplate] = useState('');
  const [behaviorRules, setBehaviorRules] = useState<string[]>([]);
  const [queryStrategies, setQueryStrategies] = useState<Record<string, string>>({});
  const [pipelineEnabled, setPipelineEnabled] = useState(false);
  const [antigravityProjectId, setAntigravityProjectId] = useState('');
  const [antigravityModel, setAntigravityModel] = useState('');
  // Heartbeat
  const [heartbeatEnabled, setHeartbeatEnabled] = useState(false);
  const [heartbeatPaused, setHeartbeatPaused] = useState(false);
  const [heartbeatInterval, setHeartbeatInterval] = useState(60);
  const [channels, setChannels] = useState<ChannelConfig[]>([]);

  interface StepConfig { enabled: boolean; runner: 'desktop' | 'antigravity'; model?: string }
  interface CustomPipelineStep {
    status: string;
    skill: string;
    runner: 'desktop' | 'antigravity';
    model?: string;
    skip?: { field: string; op: 'eq' | 'neq' | 'in' | 'notIn'; value: string | string[] };
    nextStatus?: string;
  }
  const defaultSteps: Record<string, StepConfig> = {
    autoTriage: { enabled: false, runner: 'desktop' },
    autoClarify: { enabled: false, runner: 'desktop' },
    autoPlan: { enabled: false, runner: 'desktop' },
    autoCode: { enabled: false, runner: 'desktop' },
    autoReview: { enabled: false, runner: 'desktop' },
    autoTest: { enabled: false, runner: 'desktop' },
    autoFix: { enabled: false, runner: 'desktop' },
    autoRelease: { enabled: false, runner: 'desktop' },
  };
  const [pipelineSteps, setPipelineSteps] = useState<Record<string, StepConfig>>(defaultSteps);
  const [customPipelineSteps, setCustomPipelineSteps] = useState<CustomPipelineStep[]>([]);
  const [useCustomPipeline, setUseCustomPipeline] = useState(false);

  useEffect(() => {
    if (!project) return;
    setName(project.name);
    setDescription(project.description ?? '');
    setRepoPath(project.repoPath ?? '');
    setBaseBranch(project.baseBranch ?? 'main');
    setProductionBranch(project.productionBranch ?? '');
    setDefaultProvider(project.defaultProvider ?? '');
    setAgentProvider(project.agentProvider ?? '');
    setAgentPrompt(project.agentPrompt ?? '');
    setAgentMemoryEnabled(project.agentMemoryEnabled !== false);
    setCoolifyResources(project.coolifyResources ?? []);
    setSentryProject(project.sentryProject ?? '');
    setGitRepoUrl(project.previewDeploy?.repoUrl ?? '');
    setUseRegistry(project.previewDeploy?.useRegistry ?? false);
    const pd = project.previewDeploy;
    if (pd?.testingUrls?.length) {
      setTestingUrls(pd.testingUrls);
    } else {
      const migrated: { label: string; url: string }[] = [];
      if (pd?.stagingUrl) migrated.push({ label: 'Frontend', url: pd.stagingUrl });
      if (pd?.stagingApiUrl) migrated.push({ label: 'API', url: pd.stagingApiUrl });
      setTestingUrls(migrated);
    }
    setTestCredentials(project.previewDeploy?.testCredentials ?? []);
    const envObj = project.previewDeploy?.envVars as Record<string, string> | undefined;
    setPreviewEnvVars(envObj ? Object.entries(envObj).map(([key, value]) => ({ key, value })) : []);
    setWebhookUrl(project.webhookUrl ?? '');
    setWebhookSecret(project.webhookSecret ?? '');
    setWebhookStatuses(project.webhookStatuses ?? []);
    setAgentName(project.agentConfig?.agentName ?? '');
    setAgentRole(project.agentConfig?.agentRole ?? '');
    setEnabledTools(project.agentConfig?.enabledTools ?? []);
    setEnabledSkills(project.agentConfig?.enabledSkills ?? []);
    setDomainTemplate(project.agentConfig?.domainTemplate ?? '');
    setBehaviorRules(project.agentConfig?.behaviorRules ?? []);
    setQueryStrategies(project.agentConfig?.queryStrategies ?? {});
    setAntigravityProjectId(project.antigravityProjectId ?? '');
    setAntigravityModel(project.agentConfig?.antigravityModel ?? '');
    // Heartbeat
    const hb = project.heartbeatConfig as any;
    setHeartbeatEnabled(hb?.enabled ?? false);
    setHeartbeatPaused(hb?.paused ?? false);
    setHeartbeatInterval(hb?.intervalSeconds ?? 60);
    setChannels(project.channels ?? []);
    const pc = project.agentConfig?.pipelineConfig;
    setPipelineEnabled(pc?.enabled ?? false);
    const parseStep = (val: any): StepConfig => {
      if (!val) return { enabled: false, runner: 'desktop' };
      if (typeof val === 'boolean') return { enabled: val, runner: 'desktop' };
      return { enabled: val.enabled !== false, runner: val.runner || 'desktop', model: val.model };
    };
    setPipelineSteps({
      autoTriage: parseStep(pc?.autoTriage),
      autoClarify: parseStep(pc?.autoClarify),
      autoPlan: parseStep(pc?.autoPlan),
      autoCode: parseStep(pc?.autoCode),
      autoReview: parseStep(pc?.autoReview),
      autoTest: parseStep(pc?.autoTest),
      autoFix: parseStep(pc?.autoFix),
      autoRelease: parseStep(pc?.autoRelease),
    });
    // Custom pipeline steps
    const cps = (pc as any)?.pipelineSteps as CustomPipelineStep[] | undefined;
    if (Array.isArray(cps) && cps.length > 0) {
      setCustomPipelineSteps(cps.map((s: any) => ({
        status: s.status || '',
        skill: s.skill || '',
        runner: s.runner || 'desktop',
        model: s.model || undefined,
        skip: s.skip ? { field: s.skip.field, op: s.skip.op, value: s.skip.value } : undefined,
        nextStatus: s.nextStatus || undefined,
      })));
      setUseCustomPipeline(true);
    } else {
      setCustomPipelineSteps([]);
      setUseCustomPipeline(false);
    }
  }, [project]);

  const handleSave = () => {
    if (!project) return;

    // Only send fields that changed
    const data: Record<string, any> = {};
    const eq = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

    if (name !== project.name) data.name = name;
    if (description !== (project.description ?? '')) data.description = description;
    if ((repoPath || null) !== (project.repoPath ?? null)) data.repoPath = repoPath || null;
    if (baseBranch !== (project.baseBranch ?? 'main')) data.baseBranch = baseBranch;
    if ((productionBranch || null) !== (project.productionBranch ?? null)) data.productionBranch = productionBranch || null;
    const dp = (defaultProvider || 'anthropic') as AIProvider;
    if (dp !== (project.defaultProvider ?? 'anthropic')) data.defaultProvider = dp;
    const ap = (agentProvider || null) as AIProvider | null;
    if (ap !== (project.agentProvider ?? null)) data.agentProvider = ap;
    if ((agentPrompt || null) !== (project.agentPrompt ?? null)) data.agentPrompt = agentPrompt || null;
    if (agentMemoryEnabled !== (project.agentMemoryEnabled !== false)) data.agentMemoryEnabled = agentMemoryEnabled;
    if (!eq(coolifyResources, project.coolifyResources ?? [])) data.coolifyResources = coolifyResources;
    if ((sentryProject || null) !== (project.sentryProject ?? null)) data.sentryProject = sentryProject || null;
    if ((antigravityProjectId || null) !== (project.antigravityProjectId ?? null)) data.antigravityProjectId = antigravityProjectId || null;

    // Preview deploy — check repoUrl and envVars
    const origRepoUrl = project.previewDeploy?.repoUrl ?? '';
    const origEnvVars = project.previewDeploy?.envVars ?? {};
    const origUseRegistry = project.previewDeploy?.useRegistry ?? false;
    const origTestingUrls = project.previewDeploy?.testingUrls ?? [];
    const origTestCreds = project.previewDeploy?.testCredentials ?? [];
    const newEnvVars = previewEnvVars.reduce((acc, { key, value }) => {
      if (key.trim()) acc[key.trim()] = value;
      return acc;
    }, {} as Record<string, string>);
    const cleanCreds = testCredentials.filter(c => c.label.trim() || c.username.trim());
    const cleanUrls = testingUrls.filter(u => u.url.trim());
    if (gitRepoUrl !== origRepoUrl || !eq(newEnvVars, origEnvVars) || useRegistry !== origUseRegistry
        || !eq(cleanUrls, origTestingUrls) || !eq(cleanCreds, origTestCreds)) {
      data.previewDeploy = {
        ...(project.previewDeploy || {}),
        ...(gitRepoUrl ? { repoUrl: gitRepoUrl } : {}),
        envVars: newEnvVars,
        useRegistry,
        testingUrls: cleanUrls.length ? cleanUrls : undefined,
        stagingUrl: undefined,
        stagingApiUrl: undefined,
        testCredentials: cleanCreds.length ? cleanCreds : undefined,
      };
    }

    if ((webhookUrl || null) !== (project.webhookUrl ?? null)) data.webhookUrl = webhookUrl || null;
    if ((webhookSecret || null) !== (project.webhookSecret ?? null)) data.webhookSecret = webhookSecret || null;
    if (!eq(webhookStatuses, project.webhookStatuses ?? [])) data.webhookStatuses = webhookStatuses;

    // Agent config — diff sub-fields
    const origCfg = project.agentConfig || {};
    const newCfg: Record<string, any> = {};
    let cfgChanged = false;
    const checkCfg = (key: string, val: any, orig: any) => {
      if (!eq(val, orig)) { newCfg[key] = val; cfgChanged = true; } else { newCfg[key] = orig; }
    };
    checkCfg('agentName', agentName || undefined, origCfg.agentName);
    checkCfg('agentRole', agentRole || undefined, origCfg.agentRole);
    checkCfg('enabledTools', enabledTools.length ? enabledTools : undefined, origCfg.enabledTools);
    checkCfg('enabledSkills', enabledSkills.length ? enabledSkills : undefined, origCfg.enabledSkills);
    checkCfg('domainTemplate', domainTemplate || undefined, origCfg.domainTemplate);
    checkCfg('behaviorRules', behaviorRules.length ? behaviorRules : undefined, origCfg.behaviorRules);
    checkCfg('queryStrategies', Object.keys(queryStrategies).length ? queryStrategies : undefined, origCfg.queryStrategies);
    checkCfg('antigravityModel', antigravityModel || undefined, origCfg.antigravityModel);
    // Serialize step configs — collapse to boolean only if default (desktop, no model)
    const serializeStep = (s: StepConfig): boolean | { enabled: boolean; runner: string; model?: string } => {
      // Only collapse to boolean if runner is default desktop and no model set
      if (s.runner === 'desktop' && !s.model) return s.enabled;
      const obj: any = { enabled: s.enabled, runner: s.runner };
      if (s.model) obj.model = s.model;
      return obj;
    };
    const newPipelineCfg: Record<string, any> = {
      enabled: pipelineEnabled,
    };
    for (const [key, step] of Object.entries(pipelineSteps)) {
      newPipelineCfg[key] = serializeStep(step);
    }
    // Custom pipeline steps — only include if enabled and non-empty
    if (useCustomPipeline && customPipelineSteps.length > 0) {
      newPipelineCfg.pipelineSteps = customPipelineSteps
        .filter((s) => s.status && s.skill)
        .map((s) => {
          const step: any = { status: s.status, skill: s.skill };
          if (s.runner && s.runner !== 'desktop') step.runner = s.runner;
          if (s.model) step.model = s.model;
          if (s.skip?.field && s.skip?.op) step.skip = s.skip;
          if (s.nextStatus) step.nextStatus = s.nextStatus;
          return step;
        });
    }
    checkCfg('pipelineConfig', newPipelineCfg, origCfg.pipelineConfig);
    if (cfgChanged) data.agentConfig = { ...origCfg, ...newCfg };

    // Heartbeat config — stored on project.heartbeatConfig (separate from agentConfig)
    const origHb = (project as any).heartbeatConfig || {};
    const newHb: Record<string, any> = {
      enabled: heartbeatEnabled,
      paused: heartbeatPaused,
      intervalSeconds: heartbeatInterval,
    };
    if (!eq(newHb, { enabled: origHb.enabled ?? false, paused: origHb.paused ?? false, intervalSeconds: origHb.intervalSeconds ?? 60 })) {
      data.heartbeatConfig = { ...origHb, ...newHb };
    }

    // Channels
    if (!eq(channels, project.channels ?? [])) data.channels = channels;

    // Skip if nothing changed
    if (Object.keys(data).length === 0) return;

    updateProject.mutate({ id: project.documentId, data });
  };

  const updateChannel = (index: number, update: Partial<ChannelConfig>) => {
    setChannels((prev) => prev.map((ch, i) => (i === index ? { ...ch, ...update } : ch)));
  };

  const updateChannelConfig = (index: number, key: string, value: string) => {
    setChannels((prev) => prev.map((ch, i) =>
      i === index ? { ...ch, config: { ...ch.config, [key]: value } } : ch
    ));
  };

  const removeChannel = (index: number) => {
    setChannels((prev) => prev.filter((_, i) => i !== index));
  };

  const addChannel = () => {
    setChannels((prev) => [...prev, { type: 'rocketchat', name: '', enabled: true, config: {} }]);
  };

  const updateResource = (index: number, field: 'name' | 'uuid', value: string) => {
    setCoolifyResources((prev) => prev.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  };

  const removeResource = (index: number) => {
    setCoolifyResources((prev) => prev.filter((_, i) => i !== index));
  };

  const addResource = () => {
    setCoolifyResources((prev) => [...prev, { name: '', uuid: '' }]);
  };

  return {
    isLoading,
    project,
    updateProject,
    // general
    name, setName,
    description, setDescription,
    repoPath, setRepoPath,
    baseBranch, setBaseBranch,
    productionBranch, setProductionBranch,
    // ai config
    defaultProvider, setDefaultProvider,
    agentProvider, setAgentProvider,
    agentPrompt, setAgentPrompt,
    agentMemoryEnabled, setAgentMemoryEnabled,
    // coolify
    coolifyResources,
    updateResource,
    removeResource,
    addResource,
    // sentry
    sentryProject, setSentryProject,
    // gitlab / preview
    gitRepoUrl, setGitRepoUrl,
    useRegistry, setUseRegistry,
    previewEnvVars, setPreviewEnvVars,
    testingUrls, setTestingUrls,
    testCredentials, setTestCredentials,
    // webhook
    webhookUrl, setWebhookUrl,
    webhookSecret, setWebhookSecret,
    webhookStatuses, setWebhookStatuses,
    // agent config
    agentName, setAgentName,
    agentRole, setAgentRole,
    enabledTools, setEnabledTools,
    enabledSkills, setEnabledSkills,
    domainTemplate, setDomainTemplate,
    behaviorRules, setBehaviorRules,
    queryStrategies, setQueryStrategies,
    // channels
    channels, updateChannel, updateChannelConfig, removeChannel, addChannel,
    // pipeline
    pipelineEnabled, setPipelineEnabled,
    pipelineSteps, setPipelineSteps,
    customPipelineSteps, setCustomPipelineSteps,
    useCustomPipeline, setUseCustomPipeline,
    antigravityProjectId, setAntigravityProjectId,
    antigravityModel, setAntigravityModel,
    // heartbeat
    heartbeatEnabled, setHeartbeatEnabled,
    heartbeatPaused, setHeartbeatPaused,
    heartbeatInterval, setHeartbeatInterval,
    // antigravity health
    antigravityError: project?.agentConfig?.antigravityError as string | null ?? null,
    antigravityErrorAt: project?.agentConfig?.antigravityErrorAt as string | null ?? null,
    // actions
    handleSave,
  };
}
