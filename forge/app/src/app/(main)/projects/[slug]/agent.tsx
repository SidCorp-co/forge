import { useState, useEffect, useCallback } from 'react';
import { View, Text, Pressable } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAgentStream } from '@/hooks/use-agent-stream';
import { agentApi } from '@/features/agent/api';
import { ChatMessageList } from '@/components/chat/chat-message-list';
import { ChatInput } from '@/components/chat/chat-input';
import { SessionList } from '@/components/chat/session-list';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

interface AgentSessionItem {
  documentId: string;
  title: string;
  status: string;
  updatedAt: string;
}

export default function AgentChatScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const router = useRouter();
  const {
    messages, isRunning, sessionId, desktopConnected,
    startAgent, sendMessage, abortAgent, loadSession, resetSession,
  } = useAgentStream({ projectSlug: slug });

  const [view, setView] = useState<'sessions' | 'chat'>('sessions');
  const [sessions, setSessions] = useState<AgentSessionItem[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);

  useEffect(() => {
    agentApi.getSessions(slug)
      .then((res) => setSessions(res.data as AgentSessionItem[]))
      .catch(() => {})
      .finally(() => setLoadingSessions(false));
  }, [slug]);

  const handleSelectSession = useCallback((id: string) => {
    loadSession(id);
    setView('chat');
  }, [loadSession]);

  const handleNewSession = useCallback(() => {
    resetSession();
    setView('chat');
  }, [resetSession]);

  const handleSend = useCallback((text: string) => {
    if (!sessionId) {
      startAgent(text);
    } else {
      sendMessage(text);
    }
  }, [sessionId, startAgent, sendMessage]);

  if (loadingSessions) return <View className="flex-1 items-center justify-center"><Spinner /></View>;

  return (
    <View className="flex-1 bg-white">
      {/* Desktop status banner */}
      <View className={`px-4 py-2 ${desktopConnected ? 'bg-green-50' : 'bg-amber-50'}`}>
        <Text className={`text-sm ${desktopConnected ? 'text-green-700' : 'text-amber-700'}`}>
          {desktopConnected ? 'Desktop agent connected' : 'Desktop agent offline'}
        </Text>
        {!desktopConnected && (
          <Pressable onPress={() => router.navigate(`/projects/${slug}/chat`)}>
            <Text className="text-sm text-blue-600 underline">Use Project Chat instead</Text>
          </Pressable>
        )}
      </View>

      {view === 'sessions' ? (
        <View className="flex-1">
          <View className="px-4 py-3 border-b border-gray-200">
            <Button title="New Session" onPress={handleNewSession} size="sm" />
          </View>
          <SessionList
            sessions={sessions}
            onSelect={handleSelectSession}
            activeSessionId={sessionId || undefined}
          />
        </View>
      ) : (
        <View className="flex-1">
          <View className="flex-row items-center px-4 py-3 border-b border-gray-200">
            <Pressable onPress={() => setView('sessions')} className="mr-3">
              <Text className="text-xl text-gray-600">←</Text>
            </Pressable>
            <Text className="text-base font-semibold text-gray-900 flex-1" numberOfLines={1}>
              {sessions.find((s) => s.documentId === sessionId)?.title || 'Agent Chat'}
            </Text>
          </View>
          <ChatMessageList messages={messages} isStreaming={isRunning} />
          <ChatInput
            onSend={handleSend}
            onStop={abortAgent}
            isStreaming={isRunning}
            placeholder={sessionId ? 'Send a message...' : 'Start a new agent task...'}
          />
        </View>
      )}
    </View>
  );
}
