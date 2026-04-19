/**
 * One-time migration: re-embed all issues, comments, chat sessions, and skills into Qdrant.
 * Checks each source type independently — only backfills types that are underrepresented.
 */
import { getQdrantClient } from '../../services/embeddings/qdrant';
import { upsertEmbedding, sanitizeContent } from '../../services/embeddings';

const COLLECTION_NAME = 'forge_embeddings';
const BATCH_SIZE = 10;

export async function reindexEmbeddings(strapi: any): Promise<void> {
  const qdrant = getQdrantClient();
  if (!qdrant) return;

  // Count points by source_type to decide what needs backfilling
  const typeCounts = await countBySourceType(qdrant);
  strapi.log.info(`[reindex] Current points: ${JSON.stringify(typeCounts)}`);

  const results: string[] = [];

  // Only backfill if <50% of DB records are embedded
  if ((typeCounts.comment || 0) < 100) {
    const count = await reindexComments(strapi);
    results.push(`${count} comments`);
  } else {
    results.push(`comments: skip (${typeCounts.comment} exist)`);
  }

  if ((typeCounts.chat_session || 0) < 20) {
    const count = await reindexChatSessions(strapi);
    results.push(`${count} chat sessions`);
  } else {
    results.push(`chat_sessions: skip (${typeCounts.chat_session} exist)`);
  }

  if ((typeCounts.issue || 0) < 100) {
    const count = await reindexIssues(strapi);
    results.push(`${count} issues`);
  } else {
    results.push(`issues: skip (${typeCounts.issue} exist)`);
  }

  if ((typeCounts.skill || 0) < 5) {
    const count = await reindexSkills(strapi);
    results.push(`${count} skills`);
  } else {
    results.push(`skills: skip (${typeCounts.skill} exist)`);
  }

  strapi.log.info(`[reindex] Complete: ${results.join(', ')}`);
}

async function countBySourceType(qdrant: any): Promise<Record<string, number>> {
  const types: Record<string, number> = {};
  let offset: any = undefined;
  let total = 0;
  while (total < 5000) { // cap at 5000 to avoid long scroll
    const body: any = { limit: 100, with_payload: { include: ['source_type'] } };
    if (offset !== undefined) body.offset = offset;
    const result = await qdrant.scroll(COLLECTION_NAME, body);
    const points = result.points || [];
    if (!points.length) break;
    for (const p of points) {
      const st = (p.payload as any)?.source_type || '?';
      types[st] = (types[st] || 0) + 1;
      total++;
    }
    offset = result.next_page_offset;
    if (offset === undefined || offset === null) break;
  }
  return types;
}

async function reindexIssues(strapi: any): Promise<number> {
  let count = 0;
  let page = 1;
  while (true) {
    const issues = await strapi.documents('api::issue.issue').findMany({
      limit: BATCH_SIZE,
      start: (page - 1) * BATCH_SIZE,
      fields: ['documentId', 'title', 'description', 'status', 'priority', 'category', 'acceptanceCriteria', 'suggestedSolution', 'updatedAt'],
      populate: { project: { fields: ['documentId', 'name'] } },
    });
    if (!issues?.length) break;

    for (const issue of issues) {
      const projectId = issue.project?.documentId;
      if (!projectId) continue;
      const text = sanitizeContent(
        [issue.title, issue.description, issue.acceptanceCriteria, issue.suggestedSolution].filter(Boolean).join('\n\n'),
      );
      if (!text || text.length < 10) continue;
      try {
        await upsertEmbedding({
          project_id: projectId, source_type: 'issue', source_id: issue.documentId, text,
          metadata: { title: issue.title, status: issue.status, priority: issue.priority,
            category: issue.category, projectName: issue.project?.name,
            hasAC: !!issue.acceptanceCriteria, updatedAt: issue.updatedAt },
        });
        count++;
      } catch (err: any) {
        strapi.log.warn(`[reindex] Issue ${issue.documentId}: ${err.message}`);
      }
    }
    if (issues.length < BATCH_SIZE) break;
    page++;
    if (count % 100 === 0 && count > 0) strapi.log.info(`[reindex] Issues: ${count}...`);
  }
  strapi.log.info(`[reindex] Issues done: ${count}`);
  return count;
}

async function reindexComments(strapi: any): Promise<number> {
  let count = 0;
  let page = 1;
  while (true) {
    const comments = await strapi.documents('api::comment.comment').findMany({
      limit: BATCH_SIZE,
      start: (page - 1) * BATCH_SIZE,
      fields: ['documentId', 'body', 'author', 'updatedAt'],
      populate: {
        issue: { fields: ['documentId', 'title'], populate: { project: { fields: ['documentId'] } } },
      },
    });
    if (!comments?.length) break;

    for (const comment of comments) {
      const projectId = comment.issue?.project?.documentId;
      if (!projectId) continue;
      const text = sanitizeContent(comment.body || '');
      if (!text || text.length < 10) continue;
      try {
        await upsertEmbedding({
          project_id: projectId, source_type: 'comment', source_id: comment.documentId, text,
          metadata: { issueTitle: comment.issue?.title, author: comment.author, updatedAt: comment.updatedAt },
        });
        count++;
      } catch (err: any) {
        strapi.log.warn(`[reindex] Comment ${comment.documentId}: ${err.message}`);
      }
    }
    if (comments.length < BATCH_SIZE) break;
    page++;
    if (count % 200 === 0 && count > 0) strapi.log.info(`[reindex] Comments: ${count}...`);
  }
  strapi.log.info(`[reindex] Comments done: ${count}`);
  return count;
}

async function reindexChatSessions(strapi: any): Promise<number> {
  let count = 0;
  let page = 1;
  while (true) {
    const sessions = await strapi.documents('api::chat-session.chat-session').findMany({
      limit: BATCH_SIZE,
      start: (page - 1) * BATCH_SIZE,
      fields: ['documentId', 'title', 'summary', 'messages', 'updatedAt'],
      populate: { project: { fields: ['documentId'] } },
    });
    if (!sessions?.length) break;

    for (const session of sessions) {
      const projectId = session.project?.documentId;
      if (!projectId) continue;

      // Use summary if available, otherwise extract user messages
      let text = session.summary || '';
      if (!text && session.messages) {
        const msgs = Array.isArray(session.messages) ? session.messages : [];
        text = msgs
          .filter((m: any) => m.role === 'user' && typeof m.content === 'string')
          .map((m: any) => m.content)
          .join('\n');
      }
      text = sanitizeContent(text);
      if (!text || text.length < 20) continue;

      try {
        await upsertEmbedding({
          project_id: projectId, source_type: 'chat_session', source_id: session.documentId, text,
          metadata: { title: session.title, updatedAt: session.updatedAt },
        });
        count++;
      } catch (err: any) {
        strapi.log.warn(`[reindex] Chat ${session.documentId}: ${err.message}`);
      }
    }
    if (sessions.length < BATCH_SIZE) break;
    page++;
    if (count % 50 === 0 && count > 0) strapi.log.info(`[reindex] Chat sessions: ${count}...`);
  }
  strapi.log.info(`[reindex] Chat sessions done: ${count}`);
  return count;
}

async function reindexSkills(strapi: any): Promise<number> {
  let count = 0;
  let page = 1;
  while (true) {
    const skills = await strapi.documents('api::skill.skill').findMany({
      limit: BATCH_SIZE,
      start: (page - 1) * BATCH_SIZE,
      fields: ['documentId', 'name', 'content', 'updatedAt'],
      populate: { project: { fields: ['documentId'] } },
    });
    if (!skills?.length) break;

    for (const skill of skills) {
      const projectId = skill.project?.documentId;
      if (!projectId) continue;
      const text = sanitizeContent([skill.name, skill.content].filter(Boolean).join('\n\n'));
      if (!text || text.length < 10) continue;
      try {
        await upsertEmbedding({
          project_id: projectId, source_type: 'skill', source_id: skill.documentId, text,
          metadata: { name: skill.name, updatedAt: skill.updatedAt },
        });
        count++;
      } catch (err: any) {
        strapi.log.warn(`[reindex] Skill ${skill.documentId}: ${err.message}`);
      }
    }
    if (skills.length < BATCH_SIZE) break;
    page++;
  }
  strapi.log.info(`[reindex] Skills done: ${count}`);
  return count;
}
