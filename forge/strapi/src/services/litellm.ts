/**
 * Resolve LiteLLM proxy configuration from environment variables.
 */
export function resolveLiteLLM(): { apiUrl: string; apiKey: string; model: string } | null {
  const apiUrl = process.env.LITELLM_API_URL;
  const apiKey = process.env.LITELLM_API_KEY;
  const model = process.env.LITELLM_MODEL || 'default';

  if (!apiUrl || !apiKey) return null;
  return { apiUrl, apiKey, model };
}
