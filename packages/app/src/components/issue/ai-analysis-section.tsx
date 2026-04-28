import { useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import type { Issue } from '@/features/issue/types';

interface AIAnalysisSectionProps {
  issue: Pick<Issue, 'aiSummary' | 'aiSuggestedSolution' | 'aiAcceptanceCriteria' | 'aiConfidence'>;
}

export function AIAnalysisSection({ issue }: AIAnalysisSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const { aiSummary, aiSuggestedSolution, aiAcceptanceCriteria, aiConfidence } = issue;

  if (!aiSummary && !aiSuggestedSolution && !aiAcceptanceCriteria?.length) return null;

  return (
    <View className="mt-4">
      <Pressable
        className="flex-row items-center justify-between py-2"
        onPress={() => setExpanded(!expanded)}
      >
        <Text className="text-base font-semibold text-gray-900">AI Analysis</Text>
        <Text className="text-gray-400">{expanded ? '\u25B2' : '\u25BC'}</Text>
      </Pressable>

      {expanded && (
        <View className="mt-1 gap-3">
          {aiSummary && (
            <View>
              <Text className="text-xs font-semibold text-gray-500 mb-1">Summary</Text>
              <Text className="text-sm text-gray-700">{aiSummary}</Text>
            </View>
          )}
          {aiSuggestedSolution && (
            <View>
              <Text className="text-xs font-semibold text-gray-500 mb-1">Suggested Solution</Text>
              <Text className="text-sm text-gray-700">{aiSuggestedSolution}</Text>
            </View>
          )}
          {aiAcceptanceCriteria && aiAcceptanceCriteria.length > 0 && (
            <View>
              <Text className="text-xs font-semibold text-gray-500 mb-1">Acceptance Criteria</Text>
              {aiAcceptanceCriteria.map((c, i) => (
                <Text key={i} className="text-sm text-gray-700 ml-2">{'\u2022'} {c}</Text>
              ))}
            </View>
          )}
          {aiConfidence != null && (
            <View>
              <Text className="text-xs font-semibold text-gray-500 mb-1">
                Confidence: {Math.round(aiConfidence * 100)}%
              </Text>
              <View className="h-2 bg-gray-200 rounded-full">
                <View
                  className="h-2 bg-blue-500 rounded-full"
                  style={{ width: `${aiConfidence * 100}%` }}
                />
              </View>
            </View>
          )}
        </View>
      )}
    </View>
  );
}
