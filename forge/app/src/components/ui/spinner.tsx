import { ActivityIndicator, type ActivityIndicatorProps } from 'react-native';

export function Spinner({ size = 'small', color = '#6b7280', ...props }: ActivityIndicatorProps) {
  return <ActivityIndicator size={size} color={color} {...props} />;
}
