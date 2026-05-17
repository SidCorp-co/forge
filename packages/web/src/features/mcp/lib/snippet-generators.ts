/**
 * Per-client MCP config snippet generators (ISS-161).
 *
 * Each generator takes the MCP URL, the selected project slug and either the
 * raw PAT plaintext (only available immediately after creation, see
 * `features/token/lib/plaintext-store`) or `null`. When `tokenPlaintext` is
 * null we substitute the literal `<YOUR_TOKEN_HERE>` placeholder so users
 * still get a copy-pasteable snippet — the matching UI shows a rotate hint.
 */

export type ClientKind = 'claude-cli' | 'cursor' | 'cline' | 'zed' | 'generic';

export interface SnippetInput {
  tokenPlaintext: string | null;
  projectSlug: string;
  mcpUrl: string;
}

export interface Snippet {
  filePath: string;
  fileName: string;
  content: string;
  /** True when the snippet uses the `<YOUR_TOKEN_HERE>` placeholder. */
  placeholderToken: boolean;
}

export const TOKEN_PLACEHOLDER = '<YOUR_TOKEN_HERE>';

export const PLACEHOLDER_NOTE =
  'Plaintext is only available immediately after creation. To get a usable snippet, rotate this token (Tokens tab) and come back, OR create a new token.';

export const CLIENTS: ReadonlyArray<{ kind: ClientKind; label: string }> = [
  { kind: 'claude-cli', label: 'Claude CLI' },
  { kind: 'cursor', label: 'Cursor' },
  { kind: 'cline', label: 'Cline' },
  { kind: 'zed', label: 'Zed' },
  { kind: 'generic', label: 'Generic' },
];

function resolveToken(token: string | null): { value: string; placeholder: boolean } {
  if (token && token.length > 0) return { value: token, placeholder: false };
  return { value: TOKEN_PLACEHOLDER, placeholder: true };
}

function mcpServersFragment(token: string, projectSlug: string, mcpUrl: string) {
  return {
    mcpServers: {
      forge: {
        url: mcpUrl,
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Forge-Project-Slug': projectSlug,
        },
      },
    },
  };
}

function format(obj: unknown): string {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

export function generateSnippet(kind: ClientKind, input: SnippetInput): Snippet {
  const { value, placeholder } = resolveToken(input.tokenPlaintext);

  switch (kind) {
    case 'claude-cli':
      return {
        filePath: '~/.claude/settings.json',
        fileName: 'claude-settings.json',
        content: format(mcpServersFragment(value, input.projectSlug, input.mcpUrl)),
        placeholderToken: placeholder,
      };
    case 'cursor':
      return {
        filePath: '.cursor/mcp.json',
        fileName: 'cursor-mcp.json',
        content: format(mcpServersFragment(value, input.projectSlug, input.mcpUrl)),
        placeholderToken: placeholder,
      };
    case 'cline':
      return {
        filePath: 'cline_mcp_settings.json',
        fileName: 'cline_mcp_settings.json',
        content: format(mcpServersFragment(value, input.projectSlug, input.mcpUrl)),
        placeholderToken: placeholder,
      };
    case 'zed':
      return {
        filePath: '~/.config/zed/settings.json',
        fileName: 'zed-settings.json',
        content: format({
          context_servers: {
            forge: {
              command: { url: input.mcpUrl },
              headers: {
                Authorization: `Bearer ${value}`,
                'X-Forge-Project-Slug': input.projectSlug,
              },
            },
          },
        }),
        placeholderToken: placeholder,
      };
    case 'generic':
      return {
        filePath: 'mcp.json',
        fileName: 'mcp.json',
        content: format(mcpServersFragment(value, input.projectSlug, input.mcpUrl)),
        placeholderToken: placeholder,
      };
  }
}

export function getMcpUrl(): string {
  const base = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api';
  return base.replace(/\/api\/?$/, '') + '/mcp';
}
