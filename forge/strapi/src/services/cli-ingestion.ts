import { readdir, readFile } from 'fs/promises';
import { join, sep } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import { estimateCost } from './pricing';

interface JsonlMessage {
  type?: string;
  message?: {
    role?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  model?: string;
  timestamp?: string;
}

const FILE_CONCURRENCY = 20;

async function findJsonlFiles(baseDir: string): Promise<string[]> {
  try {
    const entries = await readdir(baseDir, { withFileTypes: true, recursive: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
      .map((e) => join((e as { parentPath: string }).parentPath, e.name));
  } catch {
    return [];
  }
}

function parseSessionFile(content: string, sessionId: string, projectName: string) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let requestCount = 0;
  let model = 'unknown';
  let firstTimestamp = '';
  let lastMsgId: string | undefined;

  for (const line of content.split('\n')) {
    if (!line || !line.includes('"assistant"')) continue;
    let parsed: JsonlMessage;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.type !== 'assistant') continue;
    const usage = parsed.message?.usage;
    if (!usage) continue;

    // Claude CLI emits multiple entries per API turn (same message.id).
    // Deduplicate to avoid overcounting.
    const msgId = (parsed.message as any)?.id;
    if (msgId && msgId === lastMsgId) continue;
    lastMsgId = msgId;

    inputTokens += usage.input_tokens || 0;
    outputTokens += usage.output_tokens || 0;
    cacheReadTokens += usage.cache_read_input_tokens || 0;
    cacheCreationTokens += usage.cache_creation_input_tokens || 0;
    requestCount++;
    if (parsed.model) model = parsed.model;
    if (!firstTimestamp && parsed.timestamp) firstTimestamp = parsed.timestamp;
  }

  if (requestCount === 0) return null;

  const now = new Date().toISOString();
  return {
    document_id: randomBytes(16).toString('hex').slice(0, 24),
    source: 'cli',
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_creation_tokens: cacheCreationTokens,
    estimated_cost: estimateCost(model, inputTokens, outputTokens),
    request_count: requestCount,
    session_id: sessionId,
    project_name: projectName,
    recorded_at: firstTimestamp || now,
    created_at: now,
    updated_at: now,
    published_at: now,
  };
}

export async function ingestCliUsage(strapi: any): Promise<{ ingested: number; scanned: number }> {
  const claudeDir = join(homedir(), '.claude', 'projects');
  const jsonlFiles = await findJsonlFiles(claudeDir);

  if (jsonlFiles.length === 0) return { ingested: 0, scanned: 0 };

  // Fetch existing session IDs for dedup
  const knex = strapi.db.connection;
  const existingRows: { session_id: string }[] = await knex('usage_records')
    .where('source', 'cli')
    .whereNotNull('session_id')
    .select('session_id');
  const existingSessions = new Set(existingRows.map((r) => r.session_id));

  // Process files concurrently in batches
  const records: ReturnType<typeof parseSessionFile>[] = [];
  for (let i = 0; i < jsonlFiles.length; i += FILE_CONCURRENCY) {
    const batch = jsonlFiles.slice(i, i + FILE_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (file) => {
        const relativePath = file.slice(claudeDir.length);
        const pathParts = relativePath.split(sep).filter(Boolean);
        const sessionId = pathParts[pathParts.length - 1]?.replace('.jsonl', '') || 'unknown';
        if (existingSessions.has(sessionId)) return null;
        const projectName = pathParts.length > 1 ? pathParts.slice(0, -1).join('/') : 'unknown';
        const content = await readFile(file, 'utf-8');
        return parseSessionFile(content, sessionId, projectName);
      }),
    );
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        records.push(result.value);
      }
    }
  }

  if (records.length === 0) return { ingested: 0, scanned: jsonlFiles.length };

  // Batch insert
  const BATCH_SIZE = 500;
  let ingested = 0;
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    await knex('usage_records').insert(batch);
    ingested += batch.length;
  }

  return { ingested, scanned: jsonlFiles.length };
}
