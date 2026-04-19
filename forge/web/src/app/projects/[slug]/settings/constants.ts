import type { AIProvider } from '@/features/project/types';

export const AI_PROVIDERS: { value: AIProvider | ''; label: string }[] = [
  { value: '', label: 'Default' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'gemini', label: 'Gemini' },
];
