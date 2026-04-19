import { BottomSheetPicker } from '@/components/ui/bottom-sheet-picker';
import { ALL_STATUSES, STATUS_COLORS } from '@/lib/colors';
import type { IssueStatus } from '@/features/issue/types';

interface StatusPickerProps {
  visible: boolean;
  currentStatus: IssueStatus;
  onSelect: (status: IssueStatus) => void;
  onClose: () => void;
}

export function StatusPicker({ visible, currentStatus, onSelect, onClose }: StatusPickerProps) {
  const options = ALL_STATUSES.map((s) => ({
    value: s.value,
    label: s.label,
    color: STATUS_COLORS[s.value],
  }));

  return (
    <BottomSheetPicker
      visible={visible}
      onClose={onClose}
      title="Change Status"
      options={options}
      selectedValue={currentStatus}
      onSelect={(val) => onSelect(val as IssueStatus)}
    />
  );
}
