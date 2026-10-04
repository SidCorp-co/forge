type GitTransport = 'https' | 'ssh' | 'unknown';

export function classifyGitRemote(url: string | null | undefined): GitTransport {
  if (!url) return 'unknown';
  const u = url.trim();
  if (u.startsWith('http://') || u.startsWith('https://')) return 'https';
  if (u.startsWith('git@') || u.startsWith('ssh://')) return 'ssh';
  return 'unknown';
}
