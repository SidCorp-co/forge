/**
 * Dream Memory Consolidation — LLM consolidation and action execution
 */

import {
  addMemory,
  updateMemoryContent,
  removeMemory,
  listMemories,
  type MemoryRole,
  type MemoryVisibility,
  type MemoryEntry,
} from '../agent/memory';
import {
  runningProjects,
  POLL_INTERVAL_MS,
  MAX_CREATES,
  MAX_UPDATES,
  MAX_PROMOTES,
  MAX_PRUNES,
  MAX_MEMORIES_FOR_PROMPT,
  type DreamActions,
  type DreamResult,
} from './types';
import { gatherDreamSignal, groupMemoriesByRole, logDreamActivity } from './signal';

// ─── Phase 1 + 3: Consolidate ───────────────────────────────────────────────

const CONSOLIDATION_PROMPT = `You are a memory consolidation agent for a software project management AI pipeline.

## Your Task
Review existing memories and recent pipeline activity, then output consolidation actions.

## Current Memories (grouped by role)
{memories_by_role}

## Recent Agent Comments (last 24h)
{recent_comments}

## Recent Status Changes (last 24h)
{status_changes}

## Reopen Cycles (pipeline failures — highest-value signal)
{reopen_cycles}

## Actions You Can Take

1. **CREATE** — New pattern discovered from comments that isn't captured in existing memories
   - Only create if genuinely new and reusable across future issues
   - Assign appropriate role and visibility:
     - CEO decisions → role: ceo, visibility: down
     - TechLead conventions → role: techlead, visibility: down
     - Dev corrections → role: dev, visibility: same
     - QA patterns → role: qa, visibility: same
   - Categories: preference, correction, convention, tool_pattern

2. **UPDATE** — Merge duplicate/overlapping memories into one cleaner version
   - Use when two memories say the same thing differently
   - Keep the most specific, actionable version

3. **PROMOTE** — Elevate a dev-level correction to a higher role convention
   - Only promote patterns that appeared in 3+ different issues
   - Typically: dev correction → techlead convention (visibility: down)

4. **PRUNE** — Remove memories that are:
   - About specific closed issues (not reusable patterns)
   - Contradicted by newer information
   - One-time fixes with no reusable insight
   - Duplicate of another memory (after merging via UPDATE)

5. **SKIP** — If nothing qualifies for any action, return empty arrays

## Rules
- Max 5 creates, 5 updates, 3 promotes, 10 prunes per run
- Preserve the original language (Vietnamese facts stay Vietnamese)
- Convert relative dates to absolute (e.g., "yesterday" → actual date)
- Be conservative — only act when the signal is clear
- Prune aggressively for issue-specific memories about closed issues

## Output JSON only (no markdown, no explanation):
{
  "create": [{ "content": "...", "role": "dev|techlead|qa|ceo|cto|pm|po|devops", "visibility": "all|down|same|up", "category": "preference|correction|convention|tool_pattern", "scope": "project" }],
  "update": [{ "sourceId": "mem_...", "newContent": "..." }],
  "promote": [{ "sourceId": "mem_...", "newRole": "techlead", "newVisibility": "down", "content": "..." }],
  "prune": ["mem_...", "mem_..."],
  "summary": "one-line summary of what changed"
}`;

export async function runDreamConsolidation(
  strapi: any,
  projectDocId: string,
): Promise<DreamResult> {
  if (runningProjects.has(projectDocId)) {
    return { summary: 'Dream already running for this project', actions: { created: 0, updated: 0, promoted: 0, pruned: 0 } };
  }
  runningProjects.add(projectDocId);

  try {
    const log = strapi.log;
    const since = new Date(Date.now() - POLL_INTERVAL_MS);

    // Phase 2: Gather signal
    const signal = await gatherDreamSignal(strapi, projectDocId, since);

    if (signal.comments.length === 0 && signal.statusChanges.length === 0) {
      log.info(`[dream] No recent signal for project ${projectDocId}`);
      return { summary: 'No recent signal to consolidate', actions: { created: 0, updated: 0, promoted: 0, pruned: 0 } };
    }

    // Phase 1: Orient — get all existing memories
    const allMemories = await listMemories(projectDocId, `project:${projectDocId}`);

    // Group by role for the prompt
    const memoriesByRole = groupMemoriesByRole(allMemories);

    // Truncate if too large
    let memoriesStr = memoriesByRole;
    let truncated = false;
    if (allMemories.length > MAX_MEMORIES_FOR_PROMPT) {
      const important = allMemories.filter((m) => m.retrievalCount > 5);
      const recent = allMemories
        .filter((m) => !important.includes(m))
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
        .slice(0, 100);
      memoriesStr = groupMemoriesByRole([...important, ...recent]);
      truncated = true;
    }

    // Build prompt
    const commentsStr = signal.comments.length > 0
      ? signal.comments.map((c) => `- [${c.author}] ${c.issueTitle}: ${c.body}`).join('\n')
      : 'None';

    const statusStr = signal.statusChanges.length > 0
      ? signal.statusChanges.map((sc) => `- ${sc.issueTitle}: ${sc.from} → ${sc.to}`).join('\n')
      : 'None';

    const reopenStr = signal.reopenCycles.length > 0
      ? signal.reopenCycles.map((rc) => `- ${rc.issueTitle}: ${rc.comment}`).join('\n')
      : 'None';

    let prompt = CONSOLIDATION_PROMPT
      .replace('{memories_by_role}', memoriesStr + (truncated ? '\n(Truncated — showing most important and recent)' : ''))
      .replace('{recent_comments}', commentsStr)
      .replace('{status_changes}', statusStr)
      .replace('{reopen_cycles}', reopenStr);

    // Phase 3: LLM consolidation
    const apiUrl = process.env.LITELLM_API_URL;
    const apiKey = process.env.LITELLM_API_KEY;
    if (!apiUrl) {
      log.warn('[dream] LITELLM_API_URL not configured');
      return { summary: 'LLM not configured', actions: { created: 0, updated: 0, promoted: 0, pruned: 0 } };
    }

    const model = process.env.LITELLM_MODEL || 'gemini-pro';

    const response = await fetch(`${apiUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000,
        temperature: 0,
      }),
    });

    if (!response.ok) {
      log.warn(`[dream] LLM call failed: ${response.status}`);
      return { summary: `LLM call failed: ${response.status}`, actions: { created: 0, updated: 0, promoted: 0, pruned: 0 } };
    }

    const data = (await response.json()) as any;
    const raw = (data.choices?.[0]?.message?.content || '').trim();
    if (!raw) {
      return { summary: 'LLM returned empty response', actions: { created: 0, updated: 0, promoted: 0, pruned: 0 } };
    }

    // Parse JSON response
    let actions: DreamActions;
    try {
      const jsonStr = raw.replace(/^```json?\s*/, '').replace(/\s*```$/, '');
      actions = JSON.parse(jsonStr);
    } catch {
      log.warn(`[dream] Parse failed: ${raw.slice(0, 200)}`);
      return { summary: 'Failed to parse LLM response', actions: { created: 0, updated: 0, promoted: 0, pruned: 0 } };
    }

    // Phase 4: Execute actions
    const result = await executeDreamActions(strapi, projectDocId, actions, allMemories);

    // Log activity
    await logDreamActivity(strapi, projectDocId, result);

    log.info(`[dream] Consolidation complete for ${projectDocId}: ${result.summary}`);
    return result;
  } finally {
    runningProjects.delete(projectDocId);
  }
}

// ─── Phase 4: Execute Actions ────────────────────────────────────────────────

async function executeDreamActions(
  strapi: any,
  projectDocId: string,
  actions: DreamActions,
  existingMemories: MemoryEntry[],
): Promise<DreamResult> {
  const log = strapi.log;
  const validSourceIds = new Set(existingMemories.map((m) => m.sourceId));

  let created = 0;
  let updated = 0;
  let promoted = 0;
  let pruned = 0;

  const validRoles: MemoryRole[] = ['ceo', 'cto', 'pm', 'po', 'techlead', 'dev', 'qa', 'devops'];
  const validVisibilities: MemoryVisibility[] = ['down', 'same', 'up', 'all'];
  const validCategories = ['preference', 'correction', 'convention', 'tool_pattern'];

  // CREATE
  const creates = Array.isArray(actions.create) ? actions.create.slice(0, MAX_CREATES) : [];
  for (const item of creates) {
    if (!item.content || typeof item.content !== 'string' || item.content.length < 5) continue;
    const role = validRoles.includes(item.role) ? item.role : 'dev';
    const visibility = validVisibilities.includes(item.visibility) ? item.visibility : 'all';
    const category = validCategories.includes(item.category) ? item.category : 'convention';
    const scope = item.scope === 'global' ? 'global' : 'project';

    try {
      await addMemory(projectDocId, '__dream__', category, item.content, scope, 'dream', undefined, role, visibility);
      created++;
      log.debug(`[dream] Created: "${item.content.slice(0, 60)}"`);
    } catch (err) {
      log.warn(`[dream] Create failed: ${err}`);
    }
  }

  // UPDATE
  const updates = Array.isArray(actions.update) ? actions.update.slice(0, MAX_UPDATES) : [];
  for (const item of updates) {
    if (!item.sourceId || !item.newContent) continue;
    if (!validSourceIds.has(item.sourceId)) {
      log.debug(`[dream] Skipping update for invalid sourceId: ${item.sourceId}`);
      continue;
    }
    try {
      const ok = await updateMemoryContent(projectDocId, item.sourceId, item.newContent);
      if (ok) updated++;
      else log.debug(`[dream] Update failed for ${item.sourceId} — not found in Qdrant`);
    } catch (err) {
      log.warn(`[dream] Update failed: ${err}`);
    }
  }

  // PROMOTE
  const promotes = Array.isArray(actions.promote) ? actions.promote.slice(0, MAX_PROMOTES) : [];
  for (const item of promotes) {
    if (!item.sourceId || !item.content) continue;
    if (!validSourceIds.has(item.sourceId)) {
      log.debug(`[dream] Skipping promote for invalid sourceId: ${item.sourceId}`);
      continue;
    }
    const newRole = validRoles.includes(item.newRole) ? item.newRole : 'techlead';
    const newVisibility = validVisibilities.includes(item.newVisibility) ? item.newVisibility : 'down';
    try {
      const ok = await updateMemoryContent(projectDocId, item.sourceId, item.content, {
        role: newRole,
        visibility: newVisibility,
      });
      if (ok) promoted++;
    } catch (err) {
      log.warn(`[dream] Promote failed: ${err}`);
    }
  }

  // PRUNE
  const prunes = Array.isArray(actions.prune) ? actions.prune.slice(0, MAX_PRUNES) : [];
  for (const sourceId of prunes) {
    if (typeof sourceId !== 'string' || !sourceId) continue;
    if (!validSourceIds.has(sourceId)) {
      log.debug(`[dream] Skipping prune for invalid sourceId: ${sourceId}`);
      continue;
    }
    try {
      const ok = await removeMemory(sourceId);
      if (ok) pruned++;
    } catch (err) {
      log.warn(`[dream] Prune failed: ${err}`);
    }
  }

  const summary = actions.summary || `Created ${created}, updated ${updated}, promoted ${promoted}, pruned ${pruned}`;
  return { summary, actions: { created, updated, promoted, pruned } };
}
