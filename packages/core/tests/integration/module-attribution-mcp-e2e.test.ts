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

    it('refuses a second primary in one set through MCP, and writes nothing', async () => {
      const first = await fx.defineModule('core');
      const second = await fx.defineModule('web');
      const issueId = await fx.createIssue('two primaries');
      await fx.setLabels(issueId, [{ labelId: first.name, isPrimary: true }]);

      const res = await fx.setLabels(issueId, [
        { labelId: first.name, isPrimary: true },
        { labelId: second.name, isPrimary: true },
      ]);

      expect(fx.refusalCode(res)).toBe('MULTIPLE_PRIMARY');
      expect(await fx.junction(issueId)).toEqual([{ label_id: first.id, is_primary: true }]);
    });

    it('refuses a plain label marked primary through MCP, and writes nothing', async () => {
      const plain = await fx.defineLabel({ name: 'bug', color: '#ff0000' });
      const module = await fx.defineModule('core');
      const issueId = await fx.createIssue('a plain label cannot be primary');
      await fx.setLabels(issueId, [{ labelId: module.name, isPrimary: true }, plain.name]);
      const preimage = await fx.junction(issueId);
      expect(preimage).toHaveLength(2);

      const res = await fx.setLabels(issueId, [{ labelId: plain.name, isPrimary: true }]);

      expect(fx.refusalCode(res)).toBe('PRIMARY_NOT_MODULE');
      expect(fx.refusalText(res)).toContain(plain.name);
      expect(await fx.junction(issueId)).toEqual(preimage);
    });
  });

  describe('narrowing by module', () => {
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
