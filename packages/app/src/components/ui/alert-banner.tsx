import { View, Text } from 'react-native';

type AlertType = 'warning' | 'error' | 'info';

const ALERT_STYLES: Record<AlertType, { bg: string; border: string; text: string }> = {
  warning: { bg: '#fffbeb', border: '#f59e0b', text: '#92400e' },
  error: { bg: '#fef2f2', border: '#ef4444', text: '#991b1b' },
  info: { bg: '#eff6ff', border: '#3b82f6', text: '#1e40af' },
};

export function AlertBanner({ type, message }: { type: AlertType; message: string }) {
  const s = ALERT_STYLES[type];
  return (
    <View
      style={{ backgroundColor: s.bg, borderLeftWidth: 3, borderLeftColor: s.border }}
      className="px-4 py-3 rounded-lg"
    >
      <Text style={{ color: s.text }} className="text-sm font-medium">
        {message}
      </Text>
    </View>
  );
}
