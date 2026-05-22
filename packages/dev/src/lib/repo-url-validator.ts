/**
 * Validate a git remote URL. Accepts:
 *   - https://host/path(.git)
 *   - http://host/path(.git)
 *   - ssh://git@host/path
 *   - git@host:path(.git)  (scp-like syntax)
 * Rejects anything else (file://, shell metacharacters, newlines, etc.) so
 * `git clone <url>` can never inject an unintended command into the agent
 * prompt body via project.previewDeploy.repoUrl.
 */
export function isSafeRepoUrl(url: string): boolean {
  if (!url || /[\s`$|;&<>\\\n\r\0"']/.test(url)) return false;
  if (/^(https?|ssh):\/\//.test(url)) {
    try { new URL(url); return true; } catch { return false; }
  }
  // scp-style: user@host:path
  return /^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:[A-Za-z0-9_./-]+$/.test(url);
}

/** Git ref names accept letters, digits, `._-/`. Reject leading dash (could be parsed as a flag). */
export function isSafeBranch(name: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(name) && !name.startsWith('-');
}
