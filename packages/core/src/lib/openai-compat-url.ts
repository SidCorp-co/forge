export type OpenAiCompatPath = 'chat/completions' | 'embeddings' | 'messages';

export function openAiCompatUrl(base: string, path: OpenAiCompatPath): string {
  const host = base.replace(/\/+$/, '').replace(/\/v1$/, '');
  return `${host}/v1/${path}`;
}
