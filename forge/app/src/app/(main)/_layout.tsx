import { Tabs } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useWebSocket } from '@/hooks/use-websocket';
import { NotificationBell } from '@/features/notification/notification-bell';

export default function MainLayout() {
  const router = useRouter();
  useWebSocket();
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: '#111827',
        tabBarInactiveTintColor: '#9ca3af',
        headerRight: () => (
          <View className="mr-4 flex-row items-center gap-2">
            <NotificationBell />
            <Pressable onPress={() => router.push('/(main)/settings')}>
              <Text className="text-lg">⚙</Text>
            </Pressable>
          </View>
        ),
      }}
    >
      <Tabs.Screen name="(home)" options={{ title: 'Home', tabBarLabel: 'Home' }} />
      <Tabs.Screen name="(chat)" options={{ title: 'Chat', tabBarLabel: 'Chat' }} />
      <Tabs.Screen name="(usage)" options={{ title: 'Usage', tabBarLabel: 'Usage' }} />
      <Tabs.Screen name="(chat-logs)" options={{ title: 'Logs', tabBarLabel: 'Logs' }} />
      <Tabs.Screen name="(pipeline)" options={{ title: 'Pipeline', tabBarLabel: 'Pipeline' }} />
      <Tabs.Screen name="chat-logs" options={{ href: null }} />
      <Tabs.Screen name="devices" options={{ href: null }} />
      <Tabs.Screen name="settings" options={{ href: null }} />
      <Tabs.Screen name="projects" options={{ href: null }} />
    </Tabs>
  );
}
