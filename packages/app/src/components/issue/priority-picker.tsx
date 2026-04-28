import { BottomSheetPicker } from '@/components/ui/bottom-sheet-picker';
import { ALL_PRIORITIES, PRIORITY_COLORS } from '@/lib/colors';
import type { IssuePriority } from '@/features/issue/types';

interface PriorityPickerProps {
  visible: boolean;
  currentPriority: IssuePriority;
  onSelect: (priority: IssuePriority) => void;
  onClose: () => void;
}

export function PriorityPicker({ visible, currentPriority, onSelect, onClose }: PriorityPickerProps) {
  const options = ALL_PRIORITIES.map((p) => ({
    value: p.value,
    label: p.label,
    color: PRIORITY_COLORS[p.value],
  }));

  return (
    <BottomSheetPicker
      visible={visible}
      onClose={onClose}
      title="Change Priority"
      options={options}
      selectedValue={currentPriority}
      onSelect={(val) => onSelect(val as IssuePriority)}
    />
  );
}
