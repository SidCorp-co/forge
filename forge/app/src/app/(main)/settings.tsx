import { View, Text, Pressable, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { useAuth } from '@/providers/auth-provider';
import { useProjects } from '@/features/project/hooks';

export default function SettingsScreen() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const { data: projectsData } = useProjects();
  const projects = projectsData?.data ?? [];

  const handleLogout = async () => {
    await logout();
  };

  const appVersion = Constants.expoConfig?.version ?? '1.0.0';

  return (
    <SafeAreaView className="flex-1 bg-gray-950">
      <ScrollView className="flex-1 px-5 pt-6" showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View className="flex-row items-baseline justify-between mb-1">
          <Text className="text-2xl font-bold text-white tracking-tight uppercase">
            Account Settings
          </Text>
          <Text className="text-xs font-mono text-gray-500">
            {user?.username ?? '—'}
          </Text>
        </View>
        <Text className="text-xs text-gray-500 mb-8">
          Manage your identity, projects, and system preferences.
        </Text>

        {/* Section 1 — Account */}
        <View className="mb-8">
          <Text className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-3">
            Account
          </Text>
          <View className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <View className="mb-4">
              <Text className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">
                Identity
              </Text>
              <Text className="text-base font-bold text-white">
                {user?.username ?? '—'}
              </Text>
            </View>
            <View className="border-t border-gray-800 pt-4">
              <Text className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">
                Communication
              </Text>
              <Text className="text-base font-bold text-white">
                {user?.email ?? '—'}
              </Text>
            </View>
          </View>
        </View>

        {/* Section 2 — Projects */}
        <View className="mb-8">
          <View className="flex-row items-center mb-3">
            <Text className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">
              Project Distribution
            </Text>
            <View className="bg-gray-800 rounded-full px-2 py-0.5 ml-2">
              <Text className="text-[10px] font-bold text-gray-400">
                {projects.length}
              </Text>
            </View>
          </View>
          <View className="bg-gray-900 border border-gray-800 rounded-lg">
            {projects.length === 0 ? (
              <View className="p-6 items-center">
                <Text className="text-gray-600 text-2xl mb-2">○</Text>
                <Text className="text-gray-500 text-xs">No projects found</Text>
              </View>
            ) : (
              projects.map((project, index) => (
                <Pressable
                  key={project.documentId}
                  className="flex-row items-center p-4 active:bg-gray-800"
                  style={index < projects.length - 1 ? { borderBottomWidth: 1, borderBottomColor: '#1f2937' } : undefined}
                  onPress={() => router.push(`/projects/${project.slug}`)}
                >
                  <View className="w-2 h-2 rounded-full bg-emerald-500 mr-3" />
                  <View className="flex-1">
                    <Text className="text-sm font-bold text-white">{project.name}</Text>
                    <Text className="text-[10px] text-gray-500 mt-0.5">
                      {project.defaultProvider ?? 'No provider'}
                    </Text>
                  </View>
                  <Text className="text-gray-600 text-xs">›</Text>
                </Pressable>
              ))
            )}
          </View>
        </View>

        {/* Section 3 — Devices */}
        <View className="mb-8">
          <Text className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-3">
            Devices
          </Text>
          <Pressable
            className="bg-gray-900 border border-gray-800 rounded-lg p-4 active:bg-gray-800"
            onPress={() => router.push('/(main)/devices')}
          >
            <View className="flex-row items-center justify-between">
              <View className="flex-1">
                <Text className="text-sm font-bold text-white mb-1">
                  Device Management
                </Text>
                <Text className="text-xs text-gray-500 leading-5">
                  View, rename, and manage connected desktop devices.
                </Text>
              </View>
              <Text className="text-gray-600 text-xs">›</Text>
            </View>
          </Pressable>
        </View>

        {/* Section 4 — About */}
        <View className="mb-8">
          <View className="flex-row items-center mb-3">
            <View className="w-2 h-2 rounded-full bg-emerald-500 mr-2" />
            <Text className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">
              System Info
            </Text>
          </View>
          <View className="bg-gray-950 border border-gray-800 rounded-lg p-4">
            <Text className="text-xs font-mono text-gray-400 leading-6">
              {`[SYS] App: Forge Mobile\n[SYS] Version: ${appVersion}\n[SYS] User: ${user?.username ?? '—'}\n[SYS] Projects: ${projects.length}\n[SYS] Platform: React Native (Expo)`}
            </Text>
          </View>
        </View>

        {/* Section 5 — Danger Zone */}
        <View className="mb-12">
          <Text className="text-[10px] font-bold text-red-500 uppercase tracking-widest mb-3">
            Danger Zone
          </Text>
          <Pressable
            className="bg-red-600 rounded-lg py-3.5 items-center active:bg-red-700"
            onPress={handleLogout}
          >
            <Text className="text-white font-bold text-sm">Logout</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
