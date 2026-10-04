/** The `/v1` root an OpenAI- or Anthropic-format client appends its path to; a base given with or without its `/v1` names the same root. */
export function openAiCompatBaseUrl(base: string): string {
  return `${base.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1`;
}
