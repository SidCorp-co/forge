/**
 * ISS-588 — the Tier-2 parent's end-to-end pass, at the seam none of its three children owned.
 *
 * ISS-593 proved the module taxonomy against Postgres through REST, ISS-594 proved the web-v2
 * surfaces, ISS-595 proved the taxonomy reaching an agent's prompt. What no test reached is
 * `forge_issues` — the surface the issue's own acceptance names — where the filter and the
 * primary-module designation are hand-copied from the MCP boundary into the service call. A
 * mapping is exactly the thing a unit suite agrees with itself about: `complexity` reached all
 * three projections and the strict schema with no way to filter on it, and every unit test was
 * green throughout (ISS-912).
 *
 * The cross-surface direction is the other half: a taxonomy an admin defines through
 * `labels/routes.ts` (what project-settings drives) being consumed by an agent through MCP. Both
 * halves of that handshake live in different packages and neither child's suite crosses it.
 *
 * Two inner suites, over one fixture in `tests/helpers/module-axis-fixture.ts`: what a write does,
 * and what `filters.module` narrows to. The fixture is installed once, at the outer suite — the
 * `db` export is a module singleton built from `DATABASE_URL`, so two installations in one file
 * leave the second suite talking to the first one's torn-down container.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createTestProject, createTestUser } from '../helpers/index.js';
import { installModuleAxisFixture } from '../helpers/module-axis-fixture.js';

describe('ISS-588 · the module axis through forge_issues', () => {
  const fx = installModuleAxisFixture();

  describe('writing a module attribution', () => {
    it('carries a taxonomy defined through REST into an attribution written through MCP', async () => {
      const parent = await fx.defineModule('platform');
      const child = await fx.defineModule('platform/labels', { parentId: parent.id });
      const issueId = await fx.createIssue('an issue against the labels module');

      const res = await fx.setLabels(issueId, [{ labelId: child.name, isPrimary: true }]);
      expect((res as { isError?: boolean }).isError ?? false).toBe(false);

      expect(await fx.junction(issueId)).toEqual([{ label_id: child.id, is_primary: true }]);
      expect(await fx.labelsOf(issueId)).toEqual([
        expect.objectContaining({ id: child.id, kind: 'module', isPrimary: true }),
      ]);
    });

    it('keeps exactly one primary when a set carries a primary and a secondary', async () => {
      const primary = await fx.defineModule('core');
      const secondary = await fx.defineModule('web');
      const issueId = await fx.createIssue('cross-cutting work');

      await fx.setLabels(issueId, [{ labelId: primary.name, isPrimary: true }, secondary.name]);

      const rows = await fx.junction(issueId);
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => r.is_primary)).toEqual([
        { label_id: primary.id, is_primary: true },
      ]);
    });

    // cm:guard the assertion is that the junction is UNCHANGED, not merely that the call errored — the refusal happens outside the transaction in `resolveLabelIdsForWrite`, and a version that refused after opening one would leave the issue holding a set nobody asked for while still answering with an error.
    it('refuses a second primary in one set through MCP, and writes nothing', async () => {
      const first = await fx.defineModule('core');
      const second = await fx.defineModule('web');
      const issueId = await fx.createIssue('two primaries');
      await fx.setLabels(issueId, [{ labelId: first.name, isPrimary: true }]);

      const res = await fx.setLabels(issueId, [
        { labelId: first.name, isPrimary: true },
        { labelId: second.name, isPrimary: true },
      ]);

      expect(fx.refusalText(res)).toContain('MULTIPLE_PRIMARY');
      expect(await fx.junction(issueId)).toEqual([{ label_id: first.id, is_primary: true }]);
    });

    it('refuses a plain label marked primary through MCP, and writes nothing', async () => {
      const plain = await fx.defineLabel({ name: 'bug', color: '#ff0000' });
      const module = await fx.defineModule('core');
      const issueId = await fx.createIssue('a plain label cannot be primary');
      // cm:guard the issue starts with a NON-EMPTY set, deliberately — from an empty junction `toEqual([])` reads identically whether the refusal wrote nothing or cleared the set and then errored, and only one of those is the contract, so the preimage is what gives this assertion a way to go red (ISS-587).
      await fx.setLabels(issueId, [{ labelId: module.name, isPrimary: true }, plain.name]);
      const preimage = await fx.junction(issueId);
      expect(preimage).toHaveLength(2);

      const res = await fx.setLabels(issueId, [{ labelId: plain.name, isPrimary: true }]);

      expect(fx.refusalText(res)).toContain('PRIMARY_NOT_MODULE');
      expect(await fx.junction(issueId)).toEqual(preimage);
    });
  });

  describe('narrowing by module', () => {
    // cm:guard assert the OTHER issue is ABSENT, not merely that the wanted one is present. `filters.module` is hand-copied into the search params in `mcp/tools/forge-issues.ts`; a mapping that drops it returns EVERY issue in the project, which an assertion that only looks for its own issue passes against just as happily.
    it('narrows the list to the module and leaves the others out', async () => {
      const wanted = await fx.defineModule('core');
      const other = await fx.defineModule('web');
      const tagged = await fx.createIssue('against core');
      const untagged = await fx.createIssue('against web');
      await fx.setLabels(tagged, [{ labelId: wanted.name, isPrimary: true }]);
      await fx.setLabels(untagged, [{ labelId: other.name, isPrimary: true }]);

      const ids = await fx.listIds({ module: wanted.name });

      expect(ids).toContain(tagged);
      expect(ids).not.toContain(untagged);
    });

    it('narrows by module uuid exactly as it does by name', async () => {
      const wanted = await fx.defineModule('core');
      const other = await fx.defineModule('web');
      const tagged = await fx.createIssue('against core');
      const untagged = await fx.createIssue('against web');
      await fx.setLabels(tagged, [{ labelId: wanted.name, isPrimary: true }]);
      await fx.setLabels(untagged, [{ labelId: other.name, isPrimary: true }]);

      const ids = await fx.listIds({ module: wanted.id });

      expect(ids).toContain(tagged);
      expect(ids).not.toContain(untagged);
    });

    it('matches nothing for the name of a plain label, rather than behaving as filters.label', async () => {
      const plain = await fx.defineLabel({ name: 'bug', color: '#ff0000' });
      const issueId = await fx.createIssue('carries a plain label');
      await fx.setLabels(issueId, [plain.name]);

      expect(await fx.listIds({ module: plain.name })).toEqual([]);
    });

    it('matches nothing for a module no project defines', async () => {
      await fx.defineModule('core');
      const issueId = await fx.createIssue('against core');
      await fx.setLabels(issueId, ['core']);

      expect(await fx.listIds({ module: 'a-module-nobody-defined' })).toEqual([]);
    });

    it('leaves filters.label answering as it did before the module axis existed', async () => {
      const plain = await fx.defineLabel({ name: 'bug', color: '#ff0000' });
      const module = await fx.defineModule('core');
      const tagged = await fx.createIssue('carries the plain label');
      const untagged = await fx.createIssue('carries only a module');
      await fx.setLabels(tagged, [plain.name]);
      await fx.setLabels(untagged, [{ labelId: module.name, isPrimary: true }]);

      const ids = await fx.listIds({ label: plain.name });

      expect(ids).toContain(tagged);
      expect(ids).not.toContain(untagged);
    });

    // cm:guard a LOCAL issue must carry the FOREIGN label id, planted through SQL — `resolveModuleIdsTolerant` narrows on `eq(labels.projectId, projectId)`, and with no local issue holding the foreign label the filter answers `[]` whether that predicate is there or not, so the only fixture this assertion can fail against is the junction row the predicate exists to keep out of the answer (ISS-587).
    it('does not narrow to another project’s module of the same name', async () => {
      const db = fx.db().db;
      const otherOwner = await createTestUser(db);
      const otherProject = await createTestProject(db, otherOwner.id);
      const foreignId = randomUUID();
      await db.execute(sql`
      INSERT INTO labels (id, project_id, name, color, kind, slug)
      VALUES (${foreignId}, ${otherProject.id}, 'core', '#123456', 'module', 'core')
    `);
      const issueId = await fx.createIssue('this project has no module called core');
      await db.execute(sql`
      INSERT INTO issue_labels (issue_id, label_id, is_primary)
      VALUES (${issueId}, ${foreignId}, true)
    `);

      expect(await fx.listIds({ module: 'core' })).toEqual([]);
    });
  });
});
