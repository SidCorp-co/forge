import { describe, expect, it } from 'vitest';
import { readDocumentText } from './document-text.js';

/** A one-page PDF whose page draws `text`, or nothing where it is null — a scan has no text layer. */
function pdf(text: string | null): Buffer {
  const content = text === null ? '' : `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  return Buffer.from(
    [
      '%PDF-1.4',
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
      `4 0 obj<</Length ${content.length}>>stream`,
      content,
      'endstream endobj',
      '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
      'trailer<</Root 1 0 R>>',
      '%%EOF',
    ].join('\n'),
  );
}

// a planted token in the shape GitHub mints, never a real one
const PLANTED = `ghp_${'a1B2c3D4e5'.repeat(3)}abcdef`;

describe('a document read as text', () => {
  it('scrubs a planted token out of a markdown file, and says it did', async () => {
    const read = await readDocumentText(
      Buffer.from(`# Deploy notes\n\n- Use GITHUB_TOKEN=${PLANTED} to push.\n- Keep this line.\n`),
      'text/markdown',
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.text).not.toContain(PLANTED);
    expect(read.text).toContain('[Filtered]');
    expect(read.text).toContain('- Keep this line.');
    expect(read.redacted).toBe(true);
  });

  it('leaves a file with no secret exactly as written', async () => {
    const md = '# Criteria\n\n- The list shows 25 rows — A→Z, café.\n';
    expect(await readDocumentText(Buffer.from(md), 'text/markdown')).toEqual({
      ok: true,
      text: md,
      redacted: false,
    });
  });

  it('reads a Windows-1252 CSV out of Excel, which no UTF-8 decode takes', async () => {
    const read = await readDocumentText(
      Buffer.from('name,city\nZo\xeb,Z\xfcrich\n', 'latin1'),
      'text/csv',
    );
    expect(read).toMatchObject({ ok: true, text: 'name,city\nZo\u00eb,Z\u00fcrich\n' });
  });

  it('extracts the text a PDF page draws', async () => {
    expect(
      await readDocumentText(pdf('Criteria list for the panel'), 'application/pdf'),
    ).toMatchObject({
      ok: true,
      text: 'Criteria list for the panel',
    });
  });

  it('refuses a PDF with no text layer by name, rather than reading it as empty', async () => {
    const read = await readDocumentText(pdf(null), 'application/pdf');
    expect(read).toMatchObject({ ok: false });
    expect(!read.ok && read.reason).toContain('holds no text, only pictures of its pages');
  });

  it('refuses bytes that are not the PDF or Word file they claim to be', async () => {
    const notPdf = await readDocumentText(Buffer.from('%PDF-garbage'), 'application/pdf');
    expect(!notPdf.ok && notPdf.reason).toContain('not a PDF its reader could open');
    const notDocx = await readDocumentText(
      Buffer.from('plain text'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(!notDocx.ok && notDocx.reason).toContain('not a Word (.docx) document');
  });

  it('refuses a picture, which is shown to the model and never read as text', async () => {
    const read = await readDocumentText(Buffer.from([0x89, 0x50]), 'image/png');
    expect(!read.ok && read.reason).toContain('image/png is not a document type');
  });
});
