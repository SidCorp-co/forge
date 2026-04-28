import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  Switch,
  Pressable,
  ScrollView,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';
import { useAuth } from '@/providers/auth-provider';
import {
  useProject,
  useUpdateProject,
  useAddMember,
  useRemoveMember,
  useSearchUsers,
  useSetDefaultDevice,
} from '@/features/project/hooks';
import type { PipelineStep, ProjectUser, Device } from '@/features/project/types';

const PIPELINE_STEPS = [
  'autoTriage',
  'autoClarify',
  'autoPlan',
  'autoCode',
  'autoReview',
  'autoTest',
  'autoFix',
  'autoRelease',
] as const;

const STEP_LABELS: Record<string, string> = {
  autoTriage: 'Auto Triage',
  autoClarify: 'Auto Clarify',
  autoPlan: 'Auto Plan',
  autoCode: 'Auto Code',
  autoReview: 'Auto Review',
  autoTest: 'Auto Test',
  autoFix: 'Auto Fix',
  autoRelease: 'Auto Release',
};

const SWITCH_TRACK_COLOR = { false: '#374151', true: '#2563eb' } as const;
const BORDER_BOTTOM_STYLE = { borderBottomWidth: 1, borderBottomColor: '#374151' } as const;
const BORDER_TOP_STYLE = { borderTopWidth: 1, borderTopColor: '#374151' } as const;

const MUTATE_OPTIONS = {
  onSuccess: () => Alert.alert('Saved', 'Settings updated successfully.'),
  onError: () => Alert.alert('Error', 'Failed to save settings. Please try again.'),
};

function isPipelineStepEnabled(step: boolean | PipelineStep | undefined): boolean {
  if (typeof step === 'boolean') return step;
  if (typeof step === 'object' && step !== null) return step.enabled;
  return false;
}

function SectionHeader({ number, title }: { number: string; title: string }) {
  return (
    <Text className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-3">
      {number}. {title}
    </Text>
  );
}

function FieldLabel({ children }: { children: string }) {
  return (
    <Text className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">
      {children}
    </Text>
  );
}

function BottomBorderInput({
  value,
  onChangeText,
  placeholder,
  multiline,
}: {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  multiline?: boolean;
}) {
  return (
    <TextInput
      className="text-sm text-white py-2"
      style={BORDER_BOTTOM_STYLE}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor="#6b7280"
      multiline={multiline}
    />
  );
}

function SaveButton({
  onPress,
  loading,
}: {
  onPress: () => void;
  loading?: boolean;
}) {
  return (
    <Pressable
      className="bg-blue-600 rounded-lg py-3 items-center mt-4 active:bg-blue-700"
      onPress={onPress}
      disabled={loading}
    >
      {loading ? (
        <ActivityIndicator color="#fff" size="small" />
      ) : (
        <Text className="text-white font-bold text-sm">Save Changes</Text>
      )}
    </Pressable>
  );
}

export default function ProjectSettingsScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { user } = useAuth();
  const { data: projectData, isLoading } = useProject(slug);
  const project = projectData?.data;

  const updateProject = useUpdateProject(slug);
  const addMember = useAddMember(slug);
  const removeMember = useRemoveMember(slug);
  const setDefaultDevice = useSetDefaultDevice(slug);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [productionBranch, setProductionBranch] = useState('');
  const [pipelineEnabled, setPipelineEnabled] = useState(false);
  const [stepStates, setStepStates] = useState<Record<string, boolean>>({});
  const [sentryProject, setSentryProject] = useState('');

  // Debounced member search
  const [memberSearch, setMemberSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const handleMemberSearchChange = useCallback((text: string) => {
    setMemberSearch(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(text), 300);
  }, []);
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  const searchUsers = useSearchUsers(debouncedSearch);
  const searchResults = useMemo(() => {
    const users = Array.isArray(searchUsers.data) ? searchUsers.data : [];
    const memberIds = new Set((project?.members ?? []).map((m: ProjectUser) => m.documentId));
    return users.filter((u: ProjectUser) => !memberIds.has(u.documentId));
  }, [searchUsers.data, project?.members]);

  // Seed form once when project data first arrives
  const initializedRef = useRef(false);
  useEffect(() => {
    if (!project || initializedRef.current) return;
    setName(project.name ?? '');
    setDescription(project.description ?? '');
    setRepoPath(project.repoPath ?? '');
    setBaseBranch(project.baseBranch ?? '');
    setProductionBranch(project.productionBranch ?? '');
    setSentryProject(project.sentryProject ?? '');

    const pc = project.agentConfig?.pipelineConfig;
    setPipelineEnabled(pc?.enabled ?? false);
    const states: Record<string, boolean> = {};
    for (const step of PIPELINE_STEPS) {
      states[step] = isPipelineStepEnabled(pc?.[step]);
    }
    setStepStates(states);
    initializedRef.current = true;
  }, [project]);

  const isOwner = project?.owner?.documentId === user?.documentId;

  const handleSave = useCallback(
    (data: Record<string, unknown>) => {
      if (!project) return;
      updateProject.mutate({ docId: project.documentId, data }, MUTATE_OPTIONS);
    },
    [project, updateProject],
  );

  const handleSaveGeneral = useCallback(() => {
    handleSave({
      name,
      description,
      repoPath: repoPath || null,
      baseBranch: baseBranch || null,
      productionBranch: productionBranch || null,
    });
  }, [name, description, repoPath, baseBranch, productionBranch, handleSave]);

  const handleSavePipeline = useCallback(() => {
    if (!project) return;
    const pipelineConfig: Record<string, unknown> = { enabled: pipelineEnabled };
    for (const step of PIPELINE_STEPS) {
      const current = project.agentConfig?.pipelineConfig?.[step];
      if (typeof current === 'object' && current !== null) {
        pipelineConfig[step] = { ...current, enabled: stepStates[step] ?? false };
      } else {
        pipelineConfig[step] = stepStates[step] ?? false;
      }
    }
    handleSave({ agentConfig: { ...project.agentConfig, pipelineConfig } });
  }, [pipelineEnabled, stepStates, project, handleSave]);

  const handleSaveIntegrations = useCallback(() => {
    handleSave({ sentryProject: sentryProject || null });
  }, [sentryProject, handleSave]);

  const handleAddMember = useCallback(
    (userDocId: string) => {
      if (!project) return;
      addMember.mutate({ projectDocId: project.documentId, userDocId });
      setMemberSearch('');
      setDebouncedSearch('');
    },
    [project, addMember],
  );

  const handleRemoveMember = useCallback(
    (userDocId: string) => {
      if (!project) return;
      Alert.alert('Remove Member', 'Are you sure you want to remove this member?', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => removeMember.mutate({ projectDocId: project.documentId, userDocId }),
        },
      ]);
    },
    [project, removeMember],
  );

  const handleSetDefaultDevice = useCallback(
    (deviceDocId: string | null) => {
      if (!project) return;
      setDefaultDevice.mutate({ projectDocId: project.documentId, deviceDocId });
    },
    [project, setDefaultDevice],
  );

  if (isLoading) {
    return (
      <SafeAreaView className="flex-1 bg-gray-950 items-center justify-center">
        <ActivityIndicator color="#fff" size="large" />
      </SafeAreaView>
    );
  }

  const members: ProjectUser[] = project?.members ?? [];
  const devices: Device[] = project?.devices ?? [];
  const coolifyResources: { name: string; uuid: string }[] = project?.coolifyResources ?? [];

  return (
    <SafeAreaView className="flex-1 bg-gray-950" edges={['bottom']}>
      <ScrollView className="flex-1 px-5 pt-6" showsVerticalScrollIndicator={false}>
        <View className="flex-row items-baseline justify-between mb-1">
          <Text className="text-2xl font-bold text-white tracking-tight uppercase">
            Project Settings
          </Text>
        </View>
        <Text className="text-xs text-gray-500 mb-8">
          {project?.name ?? slug}
        </Text>

        <View className="mb-8">
          <SectionHeader number="01" title="General Identity" />
          <View className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <View className="mb-4">
              <FieldLabel>Project Name</FieldLabel>
              <BottomBorderInput value={name} onChangeText={setName} placeholder="Project name" />
            </View>
            <View className="mb-4">
              <FieldLabel>Description</FieldLabel>
              <BottomBorderInput
                value={description}
                onChangeText={setDescription}
                placeholder="Project description"
                multiline
              />
            </View>
            <View className="mb-4">
              <FieldLabel>Repository Path</FieldLabel>
              <BottomBorderInput
                value={repoPath}
                onChangeText={setRepoPath}
                placeholder="/path/to/repo"
              />
            </View>
            <View className="mb-4">
              <FieldLabel>Base Branch</FieldLabel>
              <BottomBorderInput
                value={baseBranch}
                onChangeText={setBaseBranch}
                placeholder="main"
              />
            </View>
            <View>
              <FieldLabel>Production Branch</FieldLabel>
              <BottomBorderInput
                value={productionBranch}
                onChangeText={setProductionBranch}
                placeholder="production"
              />
            </View>
            <SaveButton onPress={handleSaveGeneral} loading={updateProject.isPending} />
          </View>
        </View>

        <View className="mb-8">
          <SectionHeader number="02" title="Members" />
          <View className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            {project?.owner && (
              <View className="mb-4">
                <FieldLabel>Owner</FieldLabel>
                <Text className="text-sm font-bold text-white">
                  {project.owner.username}
                </Text>
                <Text className="text-[10px] text-gray-500">
                  {project.owner.email}
                </Text>
              </View>
            )}

            {members.length > 0 && (
              <View className="mb-4">
                <FieldLabel>Members</FieldLabel>
                {members.map((member) => (
                  <View
                    key={member.documentId}
                    className="flex-row items-center justify-between py-3"
                    style={BORDER_BOTTOM_STYLE}
                  >
                    <View>
                      <Text className="text-sm text-white">{member.username}</Text>
                      <Text className="text-[10px] text-gray-500">{member.email}</Text>
                    </View>
                    {isOwner && member.documentId !== project?.owner?.documentId && (
                      <Pressable
                        onPress={() => handleRemoveMember(member.documentId)}
                        className="px-3 py-1 active:opacity-70"
                      >
                        <Text className="text-red-400 text-xs font-bold">Remove</Text>
                      </Pressable>
                    )}
                  </View>
                ))}
              </View>
            )}

            {isOwner && (
              <View>
                <FieldLabel>Add Member</FieldLabel>
                <BottomBorderInput
                  value={memberSearch}
                  onChangeText={handleMemberSearchChange}
                  placeholder="Search by username..."
                />
                {searchResults.length > 0 && (
                  <View className="mt-2 bg-gray-800 rounded-lg">
                    {searchResults.slice(0, 5).map((u: ProjectUser) => (
                      <Pressable
                        key={u.documentId}
                        className="p-3 active:bg-gray-700"
                        style={BORDER_BOTTOM_STYLE}
                        onPress={() => handleAddMember(u.documentId)}
                      >
                        <Text className="text-sm text-white">{u.username}</Text>
                        <Text className="text-[10px] text-gray-500">{u.email}</Text>
                      </Pressable>
                    ))}
                  </View>
                )}
              </View>
            )}
          </View>
        </View>

        <View className="mb-8">
          <SectionHeader number="03" title="Devices" />
          <View className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <View className="mb-4">
              <FieldLabel>Default Device</FieldLabel>
              {devices.length === 0 ? (
                <Text className="text-xs text-gray-500">No devices in pool</Text>
              ) : (
                devices.map((device) => {
                  const isDefault = project?.defaultDevice?.documentId === device.documentId;
                  return (
                    <Pressable
                      key={device.documentId}
                      className="flex-row items-center justify-between py-3 active:opacity-70"
                      style={BORDER_BOTTOM_STYLE}
                      onPress={() =>
                        handleSetDefaultDevice(isDefault ? null : device.documentId)
                      }
                    >
                      <View className="flex-row items-center flex-1">
                        <View
                          className={`w-2 h-2 rounded-full mr-3 ${
                            device.lastSeen &&
                            Date.now() - new Date(device.lastSeen).getTime() < 5 * 60 * 1000
                              ? 'bg-emerald-500'
                              : 'bg-gray-600'
                          }`}
                        />
                        <View>
                          <Text className="text-sm text-white">{device.name}</Text>
                          <Text className="text-[10px] text-gray-500">{device.deviceId}</Text>
                        </View>
                      </View>
                      {isDefault && (
                        <View className="bg-blue-600 rounded-full px-2 py-0.5">
                          <Text className="text-[10px] text-white font-bold">Default</Text>
                        </View>
                      )}
                    </Pressable>
                  );
                })
              )}
            </View>
          </View>
        </View>

        <View className="mb-8">
          <SectionHeader number="04" title="Pipeline" />
          <View className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <View className="flex-row items-center justify-between mb-4">
              <Text className="text-sm text-white font-bold">Pipeline Enabled</Text>
              <Switch
                value={pipelineEnabled}
                onValueChange={setPipelineEnabled}
                trackColor={SWITCH_TRACK_COLOR}
                thumbColor="#fff"
              />
            </View>

            {pipelineEnabled &&
              PIPELINE_STEPS.map((step) => (
                <View
                  key={step}
                  className="flex-row items-center justify-between py-3"
                  style={BORDER_TOP_STYLE}
                >
                  <Text className="text-sm text-gray-300">{STEP_LABELS[step]}</Text>
                  <Switch
                    value={stepStates[step] ?? false}
                    onValueChange={(val: boolean) =>
                      setStepStates((prev: Record<string, boolean>) => ({ ...prev, [step]: val }))
                    }
                    trackColor={SWITCH_TRACK_COLOR}
                    thumbColor="#fff"
                  />
                </View>
              ))}

            <SaveButton onPress={handleSavePipeline} loading={updateProject.isPending} />
          </View>
        </View>

        <View className="mb-12">
          <SectionHeader number="05" title="Integrations" />
          <View className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <View className="mb-4">
              <FieldLabel>Antigravity Project ID</FieldLabel>
              <Text className="text-sm text-gray-300">
                {project?.antigravityProjectId ?? 'Not configured'}
              </Text>
            </View>

            <View className="mb-4" style={BORDER_TOP_STYLE}>
              <View className="pt-4">
                <FieldLabel>Sentry Project</FieldLabel>
                <BottomBorderInput
                  value={sentryProject}
                  onChangeText={setSentryProject}
                  placeholder="sentry-project-slug"
                />
              </View>
            </View>

            <View className="mb-4" style={BORDER_TOP_STYLE}>
              <View className="pt-4">
                <FieldLabel>Webhook URL</FieldLabel>
                <Text className="text-sm text-gray-300" numberOfLines={1}>
                  {project?.webhookUrl ?? 'Not configured'}
                </Text>
              </View>
            </View>

            <View style={BORDER_TOP_STYLE}>
              <View className="pt-4">
                <FieldLabel>Coolify Resources</FieldLabel>
                {coolifyResources.length === 0 ? (
                  <Text className="text-xs text-gray-500">No resources configured</Text>
                ) : (
                  coolifyResources.map((r, i) => (
                    <View
                      key={r.uuid}
                      className="flex-row items-center py-2"
                      style={
                        i < coolifyResources.length - 1
                          ? BORDER_BOTTOM_STYLE
                          : undefined
                      }
                    >
                      <View className="w-2 h-2 rounded-full bg-blue-500 mr-3" />
                      <View>
                        <Text className="text-sm text-white">{r.name}</Text>
                        <Text className="text-[10px] text-gray-500 font-mono">{r.uuid}</Text>
                      </View>
                    </View>
                  ))
                )}
              </View>
            </View>

            <SaveButton onPress={handleSaveIntegrations} loading={updateProject.isPending} />
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
