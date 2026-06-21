import { describe, expect, it } from 'vitest';
import {
  type CommentAttachmentLite,
  type CommentRow,
  buildCommentTree,
  walkCommentTree,
} from './tree.js';

const issueId = '00000000-0000-0000-0000-000000000001';
const authorId = '00000000-0000-0000-0000-000000000002';

function row(id: string, parentId: string | null, body = id): CommentRow {
  return {
    id,
    issueId,
    authorId,
    body,
    parentId,
    createdAt: new Date('2026-04-26T00:00:00Z'),
    updatedAt: new Date('2026-04-26T00:00:00Z'),
  };
}

describe('buildCommentTree', () => {
  it('returns top-level comments with empty replies when no children exist', () => {
    const tree = buildCommentTree([row('a', null), row('b', null)]);
    expect(tree.map((n) => n.id)).toEqual(['a', 'b']);
    expect(tree.every((n) => n.replies.length === 0)).toBe(true);
  });

  it('nests children under their parent', () => {
    const tree = buildCommentTree([row('a', null), row('a1', 'a'), row('a2', 'a'), row('b', null)]);
    expect(tree.map((n) => n.id)).toEqual(['a', 'b']);
    const [a, b] = tree;
    expect(a?.replies.map((n) => n.id)).toEqual(['a1', 'a2']);
    expect(b?.replies).toEqual([]);
  });

  it('handles 3-level nesting (a → a1 → a1a)', () => {
    const tree = buildCommentTree([row('a', null), row('a1', 'a'), row('a1a', 'a1')]);
    expect(tree).toHaveLength(1);
    const a = tree[0];
    expect(a?.replies).toHaveLength(1);
    expect(a?.replies[0]?.replies.map((n) => n.id)).toEqual(['a1a']);
  });

  it('drops a reply whose parent is not in the input set (orphan, not promoted to root)', () => {
    const tree = buildCommentTree([row('a', null), row('orphan', 'missing-parent')]);
    expect(tree.map((n) => n.id)).toEqual(['a']);
  });

  it('preserves input order within a sibling group', () => {
    const tree = buildCommentTree([row('a', null), row('a3', 'a'), row('a1', 'a'), row('a2', 'a')]);
    expect(tree[0]?.replies.map((n) => n.id)).toEqual(['a3', 'a1', 'a2']);
  });

  it('defaults attachments to an empty array when no map is provided', () => {
    const tree = buildCommentTree([row('a', null), row('a1', 'a')]);
    expect(tree[0]?.attachments).toEqual([]);
    expect(tree[0]?.replies[0]?.attachments).toEqual([]);
  });

  it('attaches files to the matching node and leaves others empty', () => {
    const att: CommentAttachmentLite = {
      id: 'att1',
      name: 'shot.png',
      mime: 'image/png',
      size: 1234,
      url: '/api/comments/attachments/att1',
      createdAt: new Date('2026-04-26T00:00:00Z'),
    };
    const map = new Map<string, CommentAttachmentLite[]>([['a1', [att]]]);
    const tree = buildCommentTree([row('a', null), row('a1', 'a')], map);
    expect(tree[0]?.attachments).toEqual([]);
    expect(tree[0]?.replies[0]?.attachments).toEqual([att]);
  });

  it('carries authorDeviceId through to the node', () => {
    const deviceId = '00000000-0000-0000-0000-0000000000d1';
    const tree = buildCommentTree([{ ...row('a', null), authorDeviceId: deviceId }]);
    expect(tree[0]?.authorDeviceId).toBe(deviceId);
  });
});

describe('walkCommentTree', () => {
  it('visits every node depth-first across roots and nested replies', () => {
    const tree = buildCommentTree([
      row('a', null),
      row('a1', 'a'),
      row('a1a', 'a1'),
      row('b', null),
    ]);
    const seen: string[] = [];
    walkCommentTree(tree, (n) => seen.push(n.id));
    expect(seen.sort()).toEqual(['a', 'a1', 'a1a', 'b']);
  });

  it('lets the visitor mutate each node (e.g. attach a resolved author)', () => {
    const tree = buildCommentTree([row('a', null), row('a1', 'a')]);
    walkCommentTree(tree, (n) => {
      n.author = { type: 'user', id: n.authorId, displayName: 'alice@example.com', isAgent: false };
    });
    expect(tree[0]?.author?.displayName).toBe('alice@example.com');
    expect(tree[0]?.replies[0]?.author?.isAgent).toBe(false);
  });
});
