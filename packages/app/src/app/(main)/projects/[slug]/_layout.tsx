import { Stack } from 'expo-router';
import { useLocalSearchParams } from 'expo-router';

export default function ProjectLayout() {
  const { slug } = useLocalSearchParams<{ slug: string }>();

  return (
    <Stack
      screenOptions={{
        headerTitle: slug || 'Project',
      }}
    >
      <Stack.Screen name="skills" options={{ headerTitle: 'Skills' }} />
      <Stack.Screen name="settings" options={{ headerTitle: 'Project Settings' }} />
    </Stack>
  );
}
