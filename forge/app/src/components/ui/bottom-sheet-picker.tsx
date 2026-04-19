import { useCallback } from 'react';
import { View, Text, Pressable } from 'react-native';
import BottomSheet, { BottomSheetFlatList, BottomSheetBackdrop } from '@gorhom/bottom-sheet';

interface PickerOption {
  value: string;
  label: string;
  color?: { bg: string; text: string };
}

interface BottomSheetPickerProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  options: PickerOption[];
  selectedValue?: string;
  onSelect: (value: string) => void;
}

export function BottomSheetPicker({
  visible,
  onClose,
  title,
  options,
  selectedValue,
  onSelect,
}: BottomSheetPickerProps) {
  const handleSelect = useCallback(
    (value: string) => {
      onSelect(value);
      onClose();
    },
    [onSelect, onClose],
  );

  const renderItem = useCallback(
    ({ item }: { item: PickerOption }) => {
      const isSelected = item.value === selectedValue;
      return (
        <Pressable
          className={`flex-row items-center justify-between px-4 py-3 ${isSelected ? 'bg-gray-50' : ''}`}
          onPress={() => handleSelect(item.value)}
        >
          <View className="flex-row items-center gap-2">
            {item.color && (
              <View
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: item.color.bg,
                }}
              />
            )}
            <Text className="text-base text-gray-900">{item.label}</Text>
          </View>
          {isSelected && <Text className="text-blue-600 font-semibold">✓</Text>}
        </Pressable>
      );
    },
    [selectedValue, handleSelect],
  );

  return (
    <BottomSheet
      index={visible ? 0 : -1}
      snapPoints={['50%']}
      enablePanDownToClose
      onChange={(i) => { if (i === -1) onClose(); }}
      backdropComponent={(props) => (
        <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} />
      )}
    >
      <View className="px-4 py-3 border-b border-gray-200">
        <Text className="text-base font-semibold text-gray-900">{title}</Text>
      </View>
      <BottomSheetFlatList
        data={options}
        keyExtractor={(item) => item.value}
        renderItem={renderItem}
      />
    </BottomSheet>
  );
}
