import { Pressable, Text, type PressableProps } from 'react-native';

type Variant = 'primary' | 'secondary' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends PressableProps {
  variant?: Variant;
  size?: Size;
  title: string;
}

const variantStyles: Record<Variant, { container: string; text: string }> = {
  primary: { container: 'bg-gray-900', text: 'text-white' },
  secondary: { container: 'bg-gray-100 border border-gray-300', text: 'text-gray-900' },
  danger: { container: 'bg-red-600', text: 'text-white' },
};

const sizeStyles: Record<Size, { container: string; text: string }> = {
  sm: { container: 'px-3 py-1.5 rounded-lg', text: 'text-sm' },
  md: { container: 'px-4 py-2.5 rounded-xl', text: 'text-base' },
  lg: { container: 'px-6 py-3.5 rounded-xl', text: 'text-lg' },
};

export function Button({ variant = 'primary', size = 'md', title, disabled, className, ...props }: ButtonProps) {
  const v = variantStyles[variant];
  const s = sizeStyles[size];
  return (
    <Pressable
      className={`${v.container} ${s.container} items-center ${disabled ? 'opacity-50' : ''} ${className ?? ''}`}
      disabled={disabled}
      {...props}
    >
      <Text className={`${v.text} ${s.text} font-semibold`}>{title}</Text>
    </Pressable>
  );
}
