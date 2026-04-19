import { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  Pressable,
  FlatList,
  TextInput,
  Alert,
  Animated,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useDevices, useUpdateDevice, useDeleteDevice } from '@/features/device/hooks';
import type { Device } from '@/features/device/types';

function isOnline(lastSeen: string | null): boolean {
  if (!lastSeen) return false;
  return Date.now() - new Date(lastSeen).getTime() < 5 * 60 * 1000;
}

function PulseDot() {
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.3,
          duration: 1000,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 1000,
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [opacity]);

  return (
    <Animated.View
      style={{ opacity, width: 8, height: 8, borderRadius: 4, backgroundColor: '#22c55e' }}
    />
  );
}

function DeviceCard({ device }: { device: Device }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name);
  const updateDevice = useUpdateDevice();
  const deleteDevice = useDeleteDevice();
  const online = isOnline(device.lastSeen);

  const handleSave = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    updateDevice.mutate(
      { docId: device.documentId, data: { name: trimmed } },
      { onSuccess: () => setEditing(false) },
    );
  };

  const handleDelete = () => {
    Alert.alert(
      'Delete Device',
      `Remove "${device.name}" from all projects?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => deleteDevice.mutate(device.documentId),
        },
      ],
    );
  };

  return (
    <View
      className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden mb-4"
      style={{ borderLeftWidth: 3, borderLeftColor: online ? '#22c55e' : '#4b5563' }}
    >
      <View className="p-4">
        {/* Header row */}
        <View className="flex-row items-center justify-between mb-4">
          <View className="flex-row items-center gap-2">
            {online ? <PulseDot /> : (
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#4b5563' }} />
            )}
            <Text className="text-sm font-bold text-white uppercase tracking-widest">
              {device.name}
            </Text>
          </View>
          <View className="flex-row items-center gap-2">
            {!editing && (
              <>
                <Pressable
                  className="border border-gray-700 rounded px-3 py-1.5 active:bg-gray-800"
                  onPress={() => setEditing(true)}
                >
                  <Text className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">
                    Edit
                  </Text>
                </Pressable>
                <Pressable
                  className="border border-red-900 rounded px-3 py-1.5 active:bg-red-900/30"
                  onPress={handleDelete}
                >
                  <Text className="text-[10px] font-bold text-red-500 uppercase tracking-widest">
                    Delete
                  </Text>
                </Pressable>
              </>
            )}
          </View>
        </View>

        {/* Detail rows */}
        <View className="gap-2">
          <View className="flex-row items-center">
            <Text className="text-[10px] font-bold text-gray-500 uppercase tracking-widest w-24">
              Device ID
            </Text>
            <Text className="text-xs font-mono text-gray-400 flex-1" numberOfLines={1}>
              {device.deviceId}
            </Text>
          </View>
          <View className="flex-row items-center">
            <Text className="text-[10px] font-bold text-gray-500 uppercase tracking-widest w-24">
              Status
            </Text>
            <Text className={`text-xs font-mono ${online ? 'text-emerald-400' : 'text-gray-500'}`}>
              {online ? 'ONLINE' : 'OFFLINE'}
            </Text>
          </View>
          <View className="flex-row items-center">
            <Text className="text-[10px] font-bold text-gray-500 uppercase tracking-widest w-24">
              Last Seen
            </Text>
            <Text className="text-xs font-mono text-gray-400">
              {device.lastSeen ? new Date(device.lastSeen).toLocaleString() : 'NEVER'}
            </Text>
          </View>
          <View className="flex-row items-center">
            <Text className="text-[10px] font-bold text-gray-500 uppercase tracking-widest w-24">
              Root Path
            </Text>
            <Text className="text-xs font-mono text-gray-400 flex-1" numberOfLines={1}>
              {device.projectsRoot ?? '~/forge-projects'}
            </Text>
          </View>
        </View>

        {/* Project paths */}
        {device.projectPaths && Object.keys(device.projectPaths).length > 0 && (
          <View className="mt-4 pt-4 border-t border-gray-800">
            <Text className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">
              Project Paths
            </Text>
            {Object.entries(device.projectPaths).map(([slug, path]) => (
              <View key={slug} className="flex-row items-center mb-1">
                <Text className="text-[10px] text-gray-500 uppercase tracking-widest w-28" numberOfLines={1}>
                  {slug}
                </Text>
                <Text className="text-[10px] font-mono text-gray-400 flex-1" numberOfLines={1}>
                  {path}
                </Text>
              </View>
            ))}
          </View>
        )}

        {/* Edit mode */}
        {editing && (
          <View className="mt-4 pt-4 border-t border-gray-800">
            <Text className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">
              Device Name
            </Text>
            <TextInput
              value={name}
              onChangeText={setName}
              className="border border-gray-700 rounded bg-gray-950 px-3 py-2.5 text-sm text-white mb-3"
              placeholderTextColor="#6b7280"
            />
            <View className="flex-row gap-2">
              <Pressable
                className="bg-white rounded px-5 py-2 active:bg-gray-300"
                onPress={handleSave}
                disabled={updateDevice.isPending}
              >
                <Text className="text-xs font-bold text-gray-900 uppercase tracking-widest">
                  {updateDevice.isPending ? 'Saving...' : 'Save'}
                </Text>
              </Pressable>
              <Pressable
                className="border border-gray-700 rounded px-5 py-2 active:bg-gray-800"
                onPress={() => {
                  setEditing(false);
                  setName(device.name);
                }}
              >
                <Text className="text-xs font-bold text-gray-400 uppercase tracking-widest">
                  Cancel
                </Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>
    </View>
  );
}

export default function DevicesScreen() {
  const { data, isLoading } = useDevices();
  const devices = data?.data ?? [];

  return (
    <SafeAreaView className="flex-1 bg-gray-950">
      <View className="flex-1 px-5 pt-6">
        {/* Header */}
        <View className="mb-1">
          <Text className="text-2xl font-bold text-white tracking-tight uppercase">
            Devices
          </Text>
        </View>
        <Text className="text-xs text-gray-500 mb-6">
          Manage connected desktop devices that run Claude CLI agents.
        </Text>

        {isLoading ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator color="#6b7280" />
            <Text className="text-[10px] font-mono text-gray-600 uppercase tracking-widest mt-3">
              Loading devices...
            </Text>
          </View>
        ) : devices.length === 0 ? (
          <View className="bg-gray-900 border border-gray-800 rounded-lg p-8 items-center">
            <Text className="text-gray-600 text-2xl mb-2">○</Text>
            <Text className="text-[10px] font-bold text-gray-500 uppercase tracking-widest text-center">
              No devices registered. Connect a Forge desktop app to get started.
            </Text>
          </View>
        ) : (
          <FlatList
            data={devices}
            keyExtractor={(d) => d.documentId}
            renderItem={({ item }) => <DeviceCard device={item} />}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 32 }}
          />
        )}
      </View>
    </SafeAreaView>
  );
}
