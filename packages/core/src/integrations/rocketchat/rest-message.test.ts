import { describe, expect, it } from 'vitest';
import { extractMessageImages } from './rest-message.js';

const BASE = 'https://chat.test';

/** One screenshot as Rocket.Chat records an upload with its thumbnail: the upload and its
 *  `thumb-` copy on `files`, and an attachment whose `image_url` is the thumbnail's id under the
 *  original name, `encodeURI`d rather than `encodeURIComponent`d. */
function screenshot(id: string, thumbId: string, name: string) {
  const file = { _id: id, name, type: 'image/png' };
  return {
    file,
    files: [file, { _id: thumbId, name: `thumb-${name}`, type: 'image/jpeg' }],
    attachments: [
      {
        title: name,
        title_link: `/file-upload/${id}/${encodeURI(name)}`,
        image_url: `/file-upload/${thumbId}/${encodeURI(name)}`,
        image_type: 'image/jpeg',
      },
    ],
  };
}

describe('extractMessageImages', () => {
  it('reads one screenshot as one picture, the upload, never its thumbnail or the attachment copy', () => {
    const refs = extractMessageImages(screenshot('U1', 'T1', 'Screen Shot (1).png'), BASE);
    expect(refs).toEqual([
      {
        name: 'Screen Shot (1).png',
        mime: 'image/png',
        ref: `${BASE}/file-upload/U1/${encodeURIComponent('Screen Shot (1).png')}`,
      },
    ]);
  });

  it('keeps two distinct screenshots in one message as two pictures', () => {
    const a = screenshot('U1', 'T1', 'a.png');
    const b = screenshot('U2', 'T2', 'b.png');
    const refs = extractMessageImages(
      { file: a.file, files: [...a.files, ...b.files], attachments: [...a.attachments, ...b.attachments] },
      BASE,
    );
    expect(refs.map((r) => r.ref)).toEqual([
      `${BASE}/file-upload/U1/a.png`,
      `${BASE}/file-upload/U2/b.png`,
    ]);
  });

  it('keeps an upload whose own name starts thumb- when no original of that name is on the message', () => {
    const refs = extractMessageImages(
      { files: [{ _id: 'U1', name: 'thumb-nail.png', type: 'image/png' }] },
      BASE,
    );
    expect(refs.map((r) => r.ref)).toEqual([`${BASE}/file-upload/U1/thumb-nail.png`]);
  });

  it('keeps a picture linked only by an attachment, on another host', () => {
    const refs = extractMessageImages(
      { attachments: [{ title: 'x', image_url: 'https://img.test/x.png', image_type: 'image/png' }] },
      BASE,
    );
    expect(refs).toEqual([{ name: 'x', mime: 'image/png', ref: 'https://img.test/x.png' }]);
  });
});
