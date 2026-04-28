import { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, Pressable } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { apiClient, apiUpload, mediaUrl } from '@/lib/api-client';
import { WS_URL } from '@/lib/constants';
import { ChatMessageList } from '@/components/chat/chat-message-list';
import { ChatInput } from '@/components/chat/chat-input';
import { SessionList } from '@/components/chat/session-list';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import type { ChatMessageData } from '@/components/chat/chat-message';

let idCounter = 0;
const genId = () => `chat-${Date.now()}-${++idCounter}`;

interface SessionItem {
  documentId: string;
  title: string;
  status: string;
  updatedAt: string;
}

export default function ProjectChatScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const [view, setView] = useState<'sessions' | 'chat'>('sessions');
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [sending, setSending] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);
  const streamMsgId = useRef<string | null>(null);
  const fullText = useRef('');

  useEffect(() => {
    apiClient<{ data: SessionItem[] }>(`/chat-sessions?filters[project][slug][$eq]=${slug}&sort=updatedAt:desc`)
      .then((res) => setSessions(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        const mid = streamMsgId.current;
        if (!mid) return;

        if (msg.event === 'chat:text_delta') {
          fullText.current += msg.data?.text || '';
          setMessages((prev) => prev.map((m) => m.id === mid ? { ...m, content: fullText.current } : m));
        } else if (msg.event === 'chat:tool_use') {
          const tc = { id: msg.data?.id || genId(), name: msg.data?.name || 'tool', input: msg.data?.input, isStreaming: true };
          setMessages((prev) => prev.map((m) => m.id === mid ? { ...m, toolCalls: [...(m.toolCalls || []), tc] } : m));
        } else if (msg.event === 'chat:done') {
          setMessages((prev) => prev.map((m) => m.id === mid ? { ...m, isStreaming: false } : m));
          streamMsgId.current = null;
          fullText.current = '';
          setSending(false);
        }
      } catch { /* ignore */ }
    };

    ws.onerror = () => ws.close();
    return () => { ws.close(); };
  }, []);

  const handleSend = useCallback(async (text: string, files?: { uri: string; name: string }[]) => {
    if (!sessionId || sending) return;

    // Upload files if any
    const uploaded: { id: number; url: string; name: string }[] = [];
    if (files && files.length > 0) {
      for (const file of files) {
        try {
          const formData = new FormData();
          formData.append('files', { uri: file.uri, name: file.name, type: 'image/jpeg' } as any);
          const data = await apiUpload(formData);
          if (data[0]?.id) uploaded.push({ id: data[0].id, url: data[0].url, name: file.name });
        } catch { /* continue without this file */ }
      }
    }

    const userMsg: ChatMessageData = {
      id: genId(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
      attachments: uploaded.length > 0 ? uploaded : undefined,
    };
    const aId = genId();
    const assistantMsg: ChatMessageData = { id: aId, role: 'assistant', content: '', timestamp: Date.now(), isStreaming: true };
    streamMsgId.current = aId;
    fullText.current = '';
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setSending(true);

    // Append file info to message for the agent
    const messageText = uploaded.length > 0
      ? `${text}\n\n[Attached files (uploaded media): ${uploaded.map((f) => `${f.name} (media ID: ${f.id}, url: ${mediaUrl(f.url)})`).join(', ')}]`
      : text;

    try {
      await apiClient(`/chat-sessions/${sessionId}/message`, {
        method: 'POST',
        body: JSON.stringify({ message: messageText }),
      });
    } catch {
      setMessages((prev) => prev.map((m) => m.id === aId ? { ...m, content: 'Error sending message', isStreaming: false } : m));
      streamMsgId.current = null;
      setSending(false);
    }
  }, [sessionId, sending]);

  const handleNewSession = useCallback(async () => {
    try {
      const res = await apiClient<{ data: { documentId: string } }>('/chat-sessions', {
        method: 'POST',
        body: JSON.stringify({ data: { project: slug } }),
      });
      const sid = res.data.documentId;
      setSessionId(sid);
      setMessages([]);
      setView('chat');
    } catch { /* ignore */ }
  }, [slug]);

  const handleSelectSession = useCallback(async (id: string) => {
    setSessionId(id);
    setView('chat');
    try {
      const res = await apiClient<{ data: { messages: any[] } }>(`/chat-sessions/${id}?populate=*`);
      const stored = res.data?.messages || [];
      setMessages(stored.map((m: any, i: number) => ({
        id: `stored-${i}`,
        role: m.role as 'user' | 'assistant',
        content: typeof m.content === 'string' ? m.content : '',
        timestamp: m.timestamp || Date.now(),
        toolCalls: m.toolCalls,
      })).filter((m: any) => m.content || m.toolCalls?.length));
    } catch {
      setMessages([]);
    }
  }, []);

  if (loading) return <View className="flex-1 items-center justify-center"><Spinner /></View>;

  if (view === 'sessions') {
    return (
      <View className="flex-1 bg-white">
        <View className="px-4 py-3 border-b border-gray-200">
          <Button title="New Session" onPress={handleNewSession} size="sm" />
        </View>
        <SessionList sessions={sessions} onSelect={handleSelectSession} activeSessionId={sessionId || undefined} />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-white">
      <View className="flex-row items-center px-4 py-3 border-b border-gray-200">
        <Pressable onPress={() => setView('sessions')} className="mr-3">
          <Text className="text-xl text-gray-600">←</Text>
        </Pressable>
        <Text className="text-base font-semibold text-gray-900 flex-1" numberOfLines={1}>
          {sessions.find((s) => s.documentId === sessionId)?.title || 'Chat'}
        </Text>
      </View>
      <ChatMessageList messages={messages} isStreaming={sending} />
      <ChatInput onSend={handleSend} isStreaming={sending} placeholder="Send a message..." />
    </View>
  );
}
