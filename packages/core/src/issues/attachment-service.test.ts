import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
    UPLOADS_MAX_BYTES: 10 * 1024 * 1024,
  },
}));

const storagePut = vi.fn(async (key: string, bytes: Buffer, _mime: string) => ({
  path: `local:${key}`,
  size: bytes.byteLength,
}));
const storageDelete = vi.fn(async (_path: string) => undefined);
vi.mock('../storage/index.js', () => ({
  getStorage: () => ({
    put: storagePut,
    get: vi.fn(),
    delete: storageDelete,
  }),
  isEnoent: () => false,
}));

const insertReturning = vi.fn();
const insertValues = vi.fn(() => ({ returning: insertReturning }));
const selectWhere = vi.fn(async () => [] as Array<{ id: string; path: string }>);
// cm:why `where()` must stay lazy: the discard lookup awaits it while the ISS-963 name lookup chains .orderBy().limit(), and calling selectWhere eagerly would burn one mockResolvedValueOnce per chained call
const selectNameLimit = vi.fn(async () => [] as unknown[]);
const selectChain = (...args: unknown[]) => ({
  orderBy: () => ({ limit: selectNameLimit }),
  then: (ok: (v: unknown) => unknown, no: (e: unknown) => unknown) =>
    selectWhere(...(args as [])).then(ok, no),
});
const deleteWhere = vi.fn(async () => undefined);
vi.mock('../db/client.js', () => ({
  db: {
    insert: vi.fn(() => ({ values: insertValues })),
    select: vi.fn(() => ({ from: () => ({ where: selectChain }) })),
    delete: vi.fn(() => ({ where: deleteWhere })),
  },
}));

const safeRecordActivity = vi.fn();
vi.mock('../pipeline/activity.js', () => ({
  safeRecordActivity,
  recordActivityTx: vi.fn(),
}));

const {
  AttachmentError,
  decodeAndValidateAttachments,
  persistIssueAttachment,
  persistDecodedIssueAttachments,
} = await import('./attachment-service.js');

const ISSUE_ID = '22222222-2222-4222-8222-222222222222';
const ATTACHMENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UPLOADER_ID = '33333333-3333-4333-8333-333333333333';

const TINY_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const TINY_B64 = TINY_BYTES.toString('base64');

function makeAttachmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ATTACHMENT_ID,
    issueId: ISSUE_ID,
    uploaderId: UPLOADER_ID,
    uploaderAgency: 'human',
    name: 'tiny.png',
    mime: 'image/png',
    size: TINY_BYTES.byteLength,
    createdAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('decodeAndValidateAttachments', () => {
  it('decodes valid base64 input', () => {
    const result = decodeAndValidateAttachments([
      { name: 'a.png', mime: 'image/png', dataBase64: TINY_B64 },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.bytes.equals(TINY_BYTES)).toBe(true);
    expect(result[0]?.name).toBe('a.png');
    expect(result[0]?.mime).toBe('image/png');
  });

  it('returns empty array for empty input', () => {
    expect(decodeAndValidateAttachments([])).toEqual([]);
  });

  it('throws INVALID_BASE64 for malformed input', () => {
    expect(() =>
      decodeAndValidateAttachments([
        { name: 'a.png', mime: 'image/png', dataBase64: '!!!not-base64!!!' },
      ]),
    ).toThrow(AttachmentError);
    try {
      decodeAndValidateAttachments([
        { name: 'a.png', mime: 'image/png', dataBase64: '!!!not-base64!!!' },
      ]);
    } catch (err) {
      expect((err as InstanceType<typeof AttachmentError>).code).toBe('INVALID_BASE64');
    }
  });

  it('throws PAYLOAD_TOO_LARGE when total exceeds cap', () => {
    const fourMb = Buffer.alloc(4 * 1024 * 1024, 7);
    const b64 = fourMb.toString('base64');
    try {
      decodeAndValidateAttachments([
        { name: 'a.png', mime: 'image/png', dataBase64: b64 },
        { name: 'b.png', mime: 'image/png', dataBase64: b64 },
        { name: 'c.png', mime: 'image/png', dataBase64: b64 },
      ]);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AttachmentError);
      expect((err as InstanceType<typeof AttachmentError>).code).toBe('PAYLOAD_TOO_LARGE');
    }
  });

  it('throws PAYLOAD_TOO_LARGE when a single entry exceeds the cap', () => {
    const elevenMb = Buffer.alloc(11 * 1024 * 1024, 7);
    const b64 = elevenMb.toString('base64');
    try {
      decodeAndValidateAttachments([{ name: 'a.png', mime: 'image/png', dataBase64: b64 }]);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as InstanceType<typeof AttachmentError>).code).toBe('PAYLOAD_TOO_LARGE');
    }
  });
});

describe('persistIssueAttachment', () => {
  it('persists bytes and returns row with download url', async () => {
    insertReturning.mockResolvedValueOnce([makeAttachmentRow()]);

    const result = await persistIssueAttachment({
      issueId: ISSUE_ID,
      name: 'tiny.png',
      mime: 'image/png',
      bytes: TINY_BYTES,
      uploaderId: UPLOADER_ID,
      uploaderAgency: 'human',
    });

    expect(result.id).toBe(ATTACHMENT_ID);
    expect(result.url).toBe(`/api/attachments/${ATTACHMENT_ID}/download`);
    expect(storagePut).toHaveBeenCalledTimes(1);
    const putKey = storagePut.mock.calls[0]?.[0] ?? '';
    expect(putKey).toMatch(new RegExp(`^issues/${ISSUE_ID}/\\d+-tiny\\.png$`));
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: ISSUE_ID,
        uploaderId: UPLOADER_ID,
        mime: 'image/png',
        size: TINY_BYTES.byteLength,
      }),
    );
    expect(safeRecordActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: ISSUE_ID,
        action: 'issue.attachment.uploaded',
      }),
    );
  });

  it('persists office/data MIME types (csv, docx, xls, xlsx)', async () => {
    const cases = [
      { mime: 'text/csv', bytes: Buffer.from('a,b\n1,2\n') },
      {
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: TINY_BYTES,
      },
      { mime: 'application/vnd.ms-excel', bytes: TINY_BYTES },
      {
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        bytes: TINY_BYTES,
      },
    ];
    for (const { mime, bytes } of cases) {
      insertReturning.mockResolvedValueOnce([makeAttachmentRow({ name: 'doc', mime })]);
      const result = await persistIssueAttachment({
        issueId: ISSUE_ID,
        name: 'doc',
        mime,
        bytes,
        uploaderId: UPLOADER_ID,
        uploaderAgency: 'human',
      });
      expect(result.mime).toBe(mime);
    }
    expect(storagePut).toHaveBeenCalledTimes(cases.length);
  });

  it('stores a plain-text .log as text/plain, whatever the extension table knows', async () => {
    insertReturning.mockResolvedValueOnce([
      makeAttachmentRow({ name: 'gate.log', mime: 'text/plain' }),
    ]);
    const result = await persistIssueAttachment({
      issueId: ISSUE_ID,
      name: 'gate.log',
      mime: 'application/octet-stream',
      bytes: Buffer.from('vitest run\n480 files passed\n'),
      uploaderId: UPLOADER_ID,
      uploaderAgency: 'human',
    });
    expect(result.mime).toBe('text/plain');
    expect(storagePut).toHaveBeenCalledWith(expect.any(String), expect.any(Buffer), 'text/plain');
  });

  it('stores a plain-text .sql as text/plain', async () => {
    insertReturning.mockResolvedValueOnce([
      makeAttachmentRow({ name: 'schema.sql', mime: 'text/plain' }),
    ]);
    const result = await persistIssueAttachment({
      issueId: ISSUE_ID,
      name: 'schema.sql',
      mime: 'application/octet-stream',
      bytes: Buffer.from('ALTER TABLE issues ADD COLUMN merged_at timestamptz;\n'),
      uploaderId: UPLOADER_ID,
      uploaderAgency: 'human',
    });
    expect(result.mime).toBe('text/plain');
  });

  it('refuses a .log whose bytes are binary, naming the allowed set', async () => {
    await expect(
      persistIssueAttachment({
        issueId: ISSUE_ID,
        name: 'core.log',
        mime: 'text/plain',
        bytes: Buffer.from([0x00, 0x01, 0x02, 0x03]),
        uploaderId: UPLOADER_ID,
        uploaderAgency: 'human',
      }),
    ).rejects.toMatchObject({
      code: 'MIME_NOT_ALLOWED',
      details: {
        reason: 'not-text',
        allowed: {
          mimes: expect.arrayContaining(['text/plain', 'image/png']),
          extensions: expect.arrayContaining(['.txt', '.png']),
        },
      },
    });
    expect(storagePut).not.toHaveBeenCalled();
  });

  it('throws EMPTY_FILE for zero-byte input', async () => {
    await expect(
      persistIssueAttachment({
        issueId: ISSUE_ID,
        name: 'empty.png',
        mime: 'image/png',
        bytes: Buffer.alloc(0),
        uploaderId: UPLOADER_ID,
        uploaderAgency: 'human',
      }),
    ).rejects.toMatchObject({ code: 'EMPTY_FILE' });
    expect(storagePut).not.toHaveBeenCalled();
  });

  it('throws MIME_NOT_ALLOWED for unsupported types', async () => {
    await expect(
      persistIssueAttachment({
        issueId: ISSUE_ID,
        name: 'bad.exe',
        mime: 'application/x-msdownload',
        bytes: TINY_BYTES,
        uploaderId: UPLOADER_ID,
        uploaderAgency: 'human',
      }),
    ).rejects.toMatchObject({ code: 'MIME_NOT_ALLOWED' });
    expect(storagePut).not.toHaveBeenCalled();
  });

  it('throws FILE_TOO_LARGE for oversized bytes', async () => {
    const oversized = Buffer.alloc(11 * 1024 * 1024, 7);
    await expect(
      persistIssueAttachment({
        issueId: ISSUE_ID,
        name: 'big.png',
        mime: 'image/png',
        bytes: oversized,
        uploaderId: UPLOADER_ID,
        uploaderAgency: 'human',
      }),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(storagePut).not.toHaveBeenCalled();
  });
});

describe('persistDecodedIssueAttachments', () => {
  it('refuses the whole batch when one member is unacceptable, persisting none', async () => {
    const result = await persistDecodedIssueAttachments(
      ISSUE_ID,
      [
        { name: 'good.png', mime: 'image/png', bytes: TINY_BYTES },
        { name: 'core.log', mime: 'text/plain', bytes: Buffer.from([0x00, 0x01]) },
        { name: 'notes.md', mime: 'text/markdown', bytes: Buffer.from('# hi\n') },
      ],
      UPLOADER_ID,
      'human',
    );

    expect(result.persisted).toHaveLength(0);
    expect(storagePut).not.toHaveBeenCalled();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe('MIME_NOT_ALLOWED');
    expect(result.errors[0]?.index).toBe(1);
    expect(result.errors[0]?.details).toMatchObject({ reason: 'not-text' });
  });

  it('rolls back the members that landed when a later one fails mid-persist', async () => {
    insertReturning
      .mockResolvedValueOnce([makeAttachmentRow({ name: 'first.png', mime: 'image/png' })])
      .mockRejectedValueOnce(new Error('insert exploded'));
    selectWhere.mockResolvedValueOnce([{ id: ATTACHMENT_ID, path: 'local:issues/first.png' }]);

    const result = await persistDecodedIssueAttachments(
      ISSUE_ID,
      [
        { name: 'first.png', mime: 'image/png', bytes: TINY_BYTES },
        { name: 'second.png', mime: 'image/png', bytes: TINY_BYTES },
      ],
      UPLOADER_ID,
      'human',
    );

    expect(result.persisted).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.index).toBe(1);
    expect(storageDelete).toHaveBeenCalledWith('local:issues/first.png');
    expect(deleteWhere).toHaveBeenCalledTimes(1);
  });

  it('persists every member when all of them pass', async () => {
    insertReturning
      .mockResolvedValueOnce([makeAttachmentRow({ name: 'good.png', mime: 'image/png' })])
      .mockResolvedValueOnce([makeAttachmentRow({ name: 'gate.log', mime: 'text/plain' })]);

    const result = await persistDecodedIssueAttachments(
      ISSUE_ID,
      [
        { name: 'good.png', mime: 'image/png', bytes: TINY_BYTES },
        { name: 'gate.log', mime: 'application/octet-stream', bytes: Buffer.from('ok\n') },
      ],
      UPLOADER_ID,
      'human',
    );

    expect(result.errors).toHaveLength(0);
    expect(result.persisted).toHaveLength(2);
    expect(storagePut).toHaveBeenCalledTimes(2);
  });
});

describe('decode + persist, the pair issues/create-service.ts calls', () => {
  it('runs decode + persist end to end', async () => {
    insertReturning.mockResolvedValueOnce([makeAttachmentRow()]);

    const result = await persistDecodedIssueAttachments(
      ISSUE_ID,
      decodeAndValidateAttachments([{ name: 'tiny.png', mime: 'image/png', dataBase64: TINY_B64 }]),
      UPLOADER_ID,
      'human',
    );

    expect(result.persisted).toHaveLength(1);
    expect(result.errors).toEqual([]);
  });

  it('throws INVALID_BASE64 in the decode, before persisting anything', async () => {
    expect(() =>
      decodeAndValidateAttachments([
        { name: 'a.png', mime: 'image/png', dataBase64: '!!!bad!!!' },
      ]),
    ).toThrow(expect.objectContaining({ code: 'INVALID_BASE64' }));
    expect(storagePut).not.toHaveBeenCalled();
  });
});
