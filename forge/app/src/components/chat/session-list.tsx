import { FlatList, Pressable, Text, View } from 'react-native';
import { StatusDot } from '@/components/ui/status-dot';
import { relativeTime } from '@/lib/format';
import { EmptyState } from '@/components/ui/empty-state';

interface Session {
  documentId: string;
  title: string;
  status: string;
  updatedAt: string;
}

interface SessionListProps {
  sessions: Session[];
  onSelect: (id: string) => void;
  activeSessionId?: string;
}

const STATUS_COLORS: Record<string, string> = {
  running: '#22c55e',
  completed: '#6b7280',
  failed: '#ef4444',
  idle: '#eab308',
};

export function SessionList({ sessions, onSelect, activeSessionId }: SessionListProps) {
  if (!sessions.length) {
    return <EmptyState icon="💬" title="No sessions yet" description="Start a new conversation" />;
  }

  return (
    <FlatList
      data={sessions}
      keyExtractor={(item) => item.documentId}
      renderItem={({ item }) => (
        <Pressable
          className={`flex-row items-center px-4 py-3 border-b border-gray-100 ${item.documentId === activeSessionId ? 'bg-blue-50' : ''}`}
          onPress={() => onSelect(item.documentId)}
        >
          <StatusDot color={STATUS_COLORS[item.status] || '#9ca3af'} />
          <View className="flex-1 ml-3">
            <Text className="font-semibold text-gray-900" numberOfLines={1}>{item.title || 'Untitled'}</Text>
            <Text className="text-xs text-gray-500">{relativeTime(item.updatedAt)}</Text>
          </View>
        </Pressable>
      )}
    />
  );
}
