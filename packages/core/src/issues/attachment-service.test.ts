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
vi.mock('../storage/index.js', () => ({
  getStorage: () => ({
    put: storagePut,
    get: vi.fn(),
    delete: vi.fn(),
  }),
  isEnoent: () => false,
}));

const insertReturning = vi.fn();
const insertValues = vi.fn(() => ({ returning: insertReturning }));
vi.mock('../db/client.js', () => ({
  db: { insert: vi.fn(() => ({ values: insertValues })) },
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
  persistIssueAttachmentsFromBase64,
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

  it('throws EMPTY_FILE for zero-byte input', async () => {
    await expect(
      persistIssueAttachment({
        issueId: ISSUE_ID,
        name: 'empty.png',
        mime: 'image/png',
        bytes: Buffer.alloc(0),
        uploaderId: UPLOADER_ID,
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
      }),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(storagePut).not.toHaveBeenCalled();
  });
});

describe('persistDecodedIssueAttachments', () => {
  it('collects MIME_NOT_ALLOWED into errors and persists the rest', async () => {
    insertReturning.mockResolvedValueOnce([makeAttachmentRow({ name: 'good.png' })]);

    const result = await persistDecodedIssueAttachments(
      ISSUE_ID,
      [
        { name: 'bad.exe', mime: 'application/x-msdownload', bytes: TINY_BYTES },
        { name: 'good.png', mime: 'image/png', bytes: TINY_BYTES },
      ],
      UPLOADER_ID,
    );

    expect(result.persisted).toHaveLength(1);
    expect(result.persisted[0]?.name).toBe('good.png');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe('MIME_NOT_ALLOWED');
    expect(result.errors[0]?.index).toBe(0);
  });
});

describe('persistIssueAttachmentsFromBase64', () => {
  it('runs decode + persist end to end', async () => {
    insertReturning.mockResolvedValueOnce([makeAttachmentRow()]);

    const result = await persistIssueAttachmentsFromBase64(
      ISSUE_ID,
      [{ name: 'tiny.png', mime: 'image/png', dataBase64: TINY_B64 }],
      UPLOADER_ID,
    );

    expect(result.persisted).toHaveLength(1);
    expect(result.errors).toEqual([]);
  });

  it('throws INVALID_BASE64 before persisting anything', async () => {
    await expect(
      persistIssueAttachmentsFromBase64(
        ISSUE_ID,
        [{ name: 'a.png', mime: 'image/png', dataBase64: '!!!bad!!!' }],
        UPLOADER_ID,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_BASE64' });
    expect(storagePut).not.toHaveBeenCalled();
  });
});
