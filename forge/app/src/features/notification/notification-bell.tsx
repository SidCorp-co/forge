import { View, Text, Pressable, FlatList, Modal } from 'react-native';
import { useState } from 'react';
import { useNotifications, useUnreadCount, useMarkAsRead, useMarkAllRead } from './hooks';
import type { Notification } from './types';

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const { data: countData } = useUnreadCount();
  const { data: notifData } = useNotifications();
  const markAsRead = useMarkAsRead();
  const markAllRead = useMarkAllRead();

  const unreadCount = countData?.data?.count ?? 0;
  const notifications = notifData?.data ?? [];

  function handlePress(n: Notification) {
    if (!n.read) markAsRead.mutate(n.documentId);
    setOpen(false);
  }

  return (
    <View>
      <Pressable onPress={() => setOpen(true)} className="relative mr-4">
        <Text className="text-lg">🔔</Text>
        {unreadCount > 0 && (
          <View className="absolute -right-1 -top-1 h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1">
            <Text className="text-[9px] font-bold text-white">
              {unreadCount > 99 ? '99+' : unreadCount}
            </Text>
          </View>
        )}
      </Pressable>

      <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setOpen(false)}>
        <View className="flex-1 bg-white">
          <View className="flex-row items-center justify-between border-b border-gray-200 px-4 py-3">
            <Text className="text-lg font-bold text-gray-900">Notifications</Text>
            <View className="flex-row items-center gap-4">
              {unreadCount > 0 && (
                <Pressable onPress={() => markAllRead.mutate()}>
                  <Text className="text-sm text-blue-600">Mark all read</Text>
                </Pressable>
              )}
              <Pressable onPress={() => setOpen(false)}>
                <Text className="text-sm text-gray-500">Close</Text>
              </Pressable>
            </View>
          </View>

          <FlatList
            data={notifications}
            keyExtractor={(n) => n.documentId}
            ListEmptyComponent={
              <Text className="py-12 text-center text-sm text-gray-400">No notifications</Text>
            }
            renderItem={({ item: n }) => (
              <Pressable
                onPress={() => handlePress(n)}
                className={`flex-row gap-3 border-b border-gray-100 px-4 py-3 ${!n.read ? 'bg-blue-50/50' : ''}`}
              >
                <View className="flex-1">
                  <Text
                    className={`text-sm ${!n.read ? 'font-medium text-gray-900' : 'text-gray-700'}`}
                    numberOfLines={2}
                  >
                    {n.title}
                  </Text>
                  {n.body && (
                    <Text className="mt-0.5 text-xs text-gray-500" numberOfLines={1}>
                      {n.body}
                    </Text>
                  )}
                  <Text className="mt-1 text-xs text-gray-400">{timeAgo(n.createdAt)}</Text>
                </View>
                {!n.read && <View className="mt-2 h-2 w-2 rounded-full bg-blue-500" />}
              </Pressable>
            )}
          />
        </View>
      </Modal>
    </View>
  );
}
