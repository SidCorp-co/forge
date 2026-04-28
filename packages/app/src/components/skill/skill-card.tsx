import { View, Text, Pressable } from 'react-native';
import type { Skill } from '@/features/skill/types';

const TARGET_LABELS: Record<string, { label: string; bg: string; text: string }> = {
  dev: { label: 'Dev', bg: 'bg-gray-100', text: 'text-gray-600' },
  cloud: { label: 'Cloud', bg: 'bg-blue-50', text: 'text-blue-600' },
  all: { label: 'All', bg: 'bg-purple-50', text: 'text-purple-600' },
};

interface SkillCardProps {
  skill: Skill;
  onPress: (skill: Skill) => void;
}

export function SkillCard({ skill, onPress }: SkillCardProps) {
  const target = TARGET_LABELS[skill.target] ?? TARGET_LABELS.dev;
  const hasHash = !!skill.contentHash;

  return (
    <Pressable onPress={() => onPress(skill)}>
      <View className={`bg-white border border-gray-200 rounded-xl p-4 mb-3 border-l-2 ${hasHash ? 'border-l-green-500' : 'border-l-gray-300'}`}>
        {/* Header */}
        <View className="flex-row items-center mb-1">
          <Text className="text-base font-semibold text-gray-900 flex-1" numberOfLines={1}>
            {skill.name}
          </Text>
          <Text className="text-xs text-gray-400">v{skill.version}</Text>
        </View>

        {/* Description */}
        {skill.description ? (
          <Text className="text-sm text-gray-500 mb-2" numberOfLines={1}>
            {skill.description}
          </Text>
        ) : null}

        {/* Tags row */}
        <View className="flex-row items-center gap-2">
          <View className={`${target.bg} px-2 py-0.5 rounded`}>
            <Text className={`text-xs font-medium ${target.text}`}>{target.label}</Text>
          </View>
          {skill.isGlobal && (
            <View className="bg-amber-50 px-2 py-0.5 rounded">
              <Text className="text-xs font-medium text-amber-600">Global</Text>
            </View>
          )}
          {skill.contentHash && (
            <Text className="text-xs text-gray-400 ml-auto">
              {skill.contentHash.slice(0, 8)}
            </Text>
          )}
        </View>
      </View>
    </Pressable>
  );
}
