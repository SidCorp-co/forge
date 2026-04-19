import { apiUpload, strapiMediaUrl } from '@/lib/api/client';

interface UploadedFile {
  id: number;
  url: string;
  name: string;
}

/** Upload files and append markdown links to the message text. */
export async function uploadAndFormatMessage(text: string, files?: File[]): Promise<string> {
  if (!files || files.length === 0) return text;

  const uploaded: UploadedFile[] = [];
  for (const file of files) {
    try {
      const formData = new FormData();
      formData.append('files', file);
      const data = await apiUpload(formData);
      if (data[0]?.id) uploaded.push({ id: data[0].id, url: data[0].url, name: file.name });
    } catch { /* continue without this file */ }
  }

  if (uploaded.length === 0) return text;

  return `${text}\n\n[Attached files (uploaded to Strapi media): ${uploaded.map((f) => `[${f.name}](${strapiMediaUrl(f.url)}) (media ID: ${f.id})`).join(', ')}]`;
}
