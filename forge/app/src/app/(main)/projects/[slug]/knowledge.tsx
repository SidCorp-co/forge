import { useState, useCallback, useMemo } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';
import { useKnowledgeIndex, useKnowledgeEdges, useIndexCodebase } from '@/features/knowledge/hooks';
import { Card } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import type { KnowledgeIndex } from '@/features/knowledge/types';

type Tab = 'index' | 'graph';

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function CollapsibleSection({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <View className="border-b border-gray-100">
      <Pressable
        onPress={() => setOpen(!open)}
        className="flex-row items-center gap-2 px-3 py-2.5"
      >
        <Text className="text-xs text-gray-400">{open ? 'v' : '>'}</Text>
        <Text className="font-medium text-sm text-gray-800">{label}</Text>
      </Pressable>
      {open && <View className="px-4 pb-3 gap-1">{children}</View>}
    </View>
  );
}

function KnowledgeTreeView({ index }: { index: KnowledgeIndex }) {
  return (
    <Card className="overflow-hidden">
      {index.project && (
        <View className="border-b border-gray-100 px-3 py-2">
          <Text className="text-sm text-gray-800">{index.project}</Text>
        </View>
      )}
      {index.architecture && (
        <View className="border-b border-gray-100 px-3 py-2">
          <Text className="text-xs text-blue-600">{index.architecture}</Text>
        </View>
      )}
      {index.conventions && Object.keys(index.conventions).length > 0 && (
        <CollapsibleSection label="Conventions">
          {Object.entries(index.conventions).map(([k, v]) => (
            <Text key={k} className="text-xs text-gray-600">
              <Text className="font-medium">{k}: </Text>{v}
            </Text>
          ))}
        </CollapsibleSection>
      )}
      {index.recipes && Object.keys(index.recipes).length > 0 && (
        <CollapsibleSection label="Recipes">
          {Object.entries(index.recipes).map(([k, v]) => (
            <Text key={k} className="text-xs text-gray-600">
              <Text className="font-medium">{k}: </Text>{v}
            </Text>
          ))}
        </CollapsibleSection>
      )}
      {index.paths && Object.keys(index.paths).length > 0 && (
        <CollapsibleSection label="Path Templates">
          {Object.entries(index.paths).map(([k, v]) => (
            <View key={k} className="flex-row flex-wrap">
              <Text className="text-xs font-medium text-gray-600">{k}: </Text>
              <Text className="text-xs text-gray-500 font-mono">{v}</Text>
            </View>
          ))}
        </CollapsibleSection>
      )}
      {index.domains && Object.keys(index.domains).length > 0 && (
        <CollapsibleSection label="Domains">
          {Object.entries(index.domains).map(([k, resources]) => (
            <View key={k} className="flex-row flex-wrap">
              <Text className="text-xs font-medium text-gray-600">{k}: </Text>
              <Text className="text-xs text-blue-600">{(resources as string[]).join(', ')}</Text>
            </View>
          ))}
        </CollapsibleSection>
      )}
      {index.commands && Object.keys(index.commands).length > 0 && (
        <CollapsibleSection label="Commands">
          {Object.entries(index.commands).map(([k, v]) => (
            <View key={k} className="flex-row flex-wrap">
              <Text className="text-xs font-mono text-gray-500">{k}</Text>
              <Text className="text-xs text-gray-600">: {v}</Text>
            </View>
          ))}
        </CollapsibleSection>
      )}
    </Card>
  );
}

function GraphListView({ projectDocId }: { projectDocId: string }) {
  const { data, isLoading } = useKnowledgeEdges(projectDocId);
  const edges = data?.data ?? [];

  const grouped = useMemo(() => {
    const map = new Map<string, { predicate: string; object: string }[]>();
    for (const edge of edges) {
      const list = map.get(edge.subject) ?? [];
      list.push({ predicate: edge.predicate, object: edge.object });
      map.set(edge.subject, list);
    }
    return Array.from(map.entries())
      .sort((a, b) => b[1].length - a[1].length);
  }, [edges]);

  if (isLoading) {
    return (
      <View className="items-center py-8">
        <Spinner />
      </View>
    );
  }

  if (grouped.length === 0) {
    return <EmptyState icon="🔗" title="No knowledge edges" description="Index the codebase to generate knowledge graph edges" />;
  }

  return (
    <View className="gap-2">
      {grouped.map(([subject, connections]) => (
        <Card key={subject}>
          <View className="flex-row items-center justify-between mb-2">
            <Text className="flex-1 text-sm font-medium text-gray-800" numberOfLines={1}>
              {subject}
            </Text>
            <View className="bg-blue-100 px-2 py-0.5 rounded-full ml-2">
              <Text className="text-xs text-blue-700 font-medium">{connections.length}</Text>
            </View>
          </View>
          {connections.slice(0, 5).map((conn, i) => (
            <Text key={i} className="text-xs text-gray-500 ml-2">
              {conn.predicate} → {conn.object}
            </Text>
          ))}
          {connections.length > 5 && (
            <Text className="text-xs text-gray-400 ml-2 mt-1">
              +{connections.length - 5} more
            </Text>
          )}
        </Card>
      ))}
    </View>
  );
}

export default function KnowledgeScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const {
    knowledgeIndex,
    knowledgeIndexedAt,
    defaultDevice,
    projectDocId,
    isLoading,
    refetch,
    isRefetching,
  } = useKnowledgeIndex(slug);
  const { startIndexing, status, error, isIndexing } = useIndexCodebase(projectDocId, slug);
  const [tab, setTab] = useState<Tab>('index');

  const repoKeys = useMemo(
    () => (knowledgeIndex ? Object.keys(knowledgeIndex) : []),
    [knowledgeIndex],
  );
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const activeRepo = selectedRepo ?? repoKeys[0] ?? null;
  const activeIndex = activeRepo && knowledgeIndex ? knowledgeIndex[activeRepo] : null;

  const onRefresh = useCallback(() => {
    refetch();
  }, [refetch]);

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center">
        <Spinner />
      </View>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-white" edges={['bottom']}>
      <ScrollView
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={onRefresh} />}
      >
        {/* Header */}
        <View className="px-4 pt-3 pb-2">
          <View className="flex-row items-center justify-between">
            <View>
              <Text className="text-lg font-semibold text-gray-900">Knowledge Base</Text>
              {knowledgeIndexedAt && (
                <Text className="text-xs text-gray-400 mt-0.5">
                  Last indexed: {formatRelativeTime(knowledgeIndexedAt)}
                </Text>
              )}
            </View>
            <View className="items-end">
              {status === 'completed' && (
                <Text className="text-xs text-green-600 mb-1">Indexing completed</Text>
              )}
              {status === 'failed' && error && (
                <Text className="text-xs text-red-500 mb-1">{error}</Text>
              )}
              {defaultDevice ? (
                <Pressable
                  onPress={startIndexing}
                  disabled={isIndexing}
                  className="flex-row items-center gap-1.5 border border-gray-300 px-3 py-1.5 rounded-md"
                  style={isIndexing ? { opacity: 0.5 } : undefined}
                >
                  {isIndexing && <ActivityIndicator size="small" color="#6b7280" />}
                  <Text className="text-xs font-medium text-gray-700">
                    {isIndexing ? 'Indexing...' : 'Index Codebase'}
                  </Text>
                </Pressable>
              ) : (
                <Text className="text-xs text-gray-400 text-right max-w-[180px]">
                  Connect a desktop device to enable indexing
                </Text>
              )}
            </View>
          </View>
        </View>

        {/* Tab selector */}
        <View className="flex-row mx-4 mb-3 border border-gray-200 rounded-lg overflow-hidden">
          <Pressable
            onPress={() => setTab('index')}
            className={`flex-1 py-2 ${tab === 'index' ? 'bg-blue-50' : 'bg-white'}`}
          >
            <Text className={`text-center text-sm font-medium ${tab === 'index' ? 'text-blue-700' : 'text-gray-500'}`}>
              Index
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setTab('graph')}
            className={`flex-1 py-2 ${tab === 'graph' ? 'bg-blue-50' : 'bg-white'}`}
          >
            <Text className={`text-center text-sm font-medium ${tab === 'graph' ? 'text-blue-700' : 'text-gray-500'}`}>
              Graph
            </Text>
          </Pressable>
        </View>

        {/* Repo selector (when multiple repos) */}
        {repoKeys.length > 1 && tab === 'index' && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} className="px-4 mb-3">
            <View className="flex-row gap-2">
              {repoKeys.map((key) => (
                <Pressable
                  key={key}
                  onPress={() => setSelectedRepo(key)}
                  className={`px-3 py-1.5 rounded-full border ${
                    activeRepo === key
                      ? 'bg-blue-50 border-blue-300'
                      : 'bg-white border-gray-200'
                  }`}
                >
                  <Text
                    className={`text-xs font-medium ${
                      activeRepo === key ? 'text-blue-700' : 'text-gray-600'
                    }`}
                  >
                    {key}
                  </Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>
        )}

        {/* Content */}
        <View className="px-4 pb-8">
          {tab === 'index' ? (
            activeIndex ? (
              <KnowledgeTreeView index={activeIndex} />
            ) : (
              <EmptyState
                icon="📚"
                title="No knowledge indexed yet"
                description="Use the Index Codebase button to generate knowledge from your codebase"
              />
            )
          ) : (
            projectDocId ? (
              <GraphListView projectDocId={projectDocId} />
            ) : (
              <EmptyState icon="🔗" title="No project data" />
            )
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
