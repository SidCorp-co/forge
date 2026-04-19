import { View, type ViewProps } from 'react-native';

interface CardProps extends ViewProps {
  children: React.ReactNode;
}

export function Card({ children, className, ...props }: CardProps) {
  return (
    <View
      className={`bg-white rounded-xl border border-gray-200 p-4 shadow-sm ${className ?? ''}`}
      {...props}
    >
      {children}
    </View>
  );
}
