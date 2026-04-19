/**
 * Simulated user agent — has a goal per conversation and drives toward it,
 * reacting to bot replies naturally. Uses LLM as a mini-agent with persona.
 */
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const STRAPI = process.env.STRAPI_URL ?? 'http://localhost:1337';
const API_KEY = process.env.FORGE_API_KEY;
if (!API_KEY) {
  throw new Error('FORGE_API_KEY env var required');
}

async function chat(slug: string, sid: string | null, msg: string): Promise<{ sid: string; reply: string; tools: string[] }> {
  const resp = await fetch(`${STRAPI}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forge-API-Key': API_KEY },
    body: JSON.stringify({ projectSlug: slug, message: msg, ...(sid && { sessionId: sid }) }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const d = ((await resp.json()) as any).data;
  return {
    sid: d.sessionId,
    reply: d.reply || '',
    tools: (d.toolCalls || []).map((t: any) => t.name),
  };
}

function say(label: string, msg: string) {
  console.log(`  ${label}: ${msg.slice(0, 300).replace(/\n/g, ' | ')}`);
}

interface Persona {
  goal: string;       // what this user wants to accomplish
  style: string;      // how they talk
  language: string;   // en, vi, or mixed
}

async function agentFollowUp(
  persona: Persona,
  history: { role: string; content: string }[],
  turnNum: number,
  totalTurns: number,
): Promise<string> {
  const apiUrl = process.env.LITELLM_API_URL;
  const apiKey = process.env.LITELLM_API_KEY;
  if (!apiUrl) throw new Error('LITELLM_API_URL not set');

  const isLast = turnNum >= totalTurns;

  const systemMsg = `You are a user talking to a project management chatbot. You have a specific goal and personality.

YOUR GOAL: ${persona.goal}
YOUR STYLE: ${persona.style}
LANGUAGE: ${persona.language}
TURN: ${turnNum}/${totalTurns}${isLast ? ' (FINAL — say thanks/bye)' : ''}

Based on the bot's last reply, write your NEXT message. You must:
- React to what the bot actually said (reference specific issues, names, details it mentioned)
- Progress toward your goal (don't repeat yourself or stall)
- Be concise: 3-15 words max
- Sound like a real person typing in a chat, not a formal request
- Use pronouns naturally ("that one", "it", "the first one") when referring to things the bot just mentioned
- NEVER quote, copy, or repeat the bot's text
- NEVER use markdown, asterisks, or formatting
- Output ONLY your message, nothing else`;

  // Summarize bot replies to prevent copying — wrap in [Bot: ...] to make clear it's a summary
  const msgs = history.slice(-6).map(h => {
    if (h.role === 'assistant') {
      const clean = h.content
        .replace(/\*\*/g, '')
        .replace(/[*|#\[\]\n]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 150);
      return { role: 'assistant' as const, content: `[Bot said: ${clean}]` };
    }
    return { role: 'user' as const, content: h.content };
  });

  const resp = await fetch(`${apiUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(apiKey && { Authorization: `Bearer ${apiKey}` }) },
    body: JSON.stringify({
      model: process.env.LITELLM_MODEL || 'gemini-2.0-flash',
      messages: [{ role: 'system', content: systemMsg }, ...msgs],
      max_tokens: 30,
      temperature: 0.7,
    }),
  });
  if (!resp.ok) throw new Error(`LLM ${resp.status}`);
  const data = (await resp.json()) as any;
  const raw = (data.choices?.[0]?.message?.content || '').trim();
  // Strip quotes/markdown, take only first line, cap at 80 chars
  const firstLine = raw.split('\n')[0].replace(/^["'`]|["'`]$/g, '').replace(/[*#|]/g, '').trim();
  return firstLine.slice(0, 80);
}

interface ConvConfig {
  slug: string;
  name: string;
  opener: string;
  turns: number;
  persona: Persona;
}

async function runConversation(cfg: ConvConfig) {
  console.log(`\n${'━'.repeat(60)}`);
  console.log(`${cfg.name} (${cfg.slug}) — ${cfg.turns} turns`);
  console.log(`  Goal: ${cfg.persona.goal}`);
  console.log('━'.repeat(60));

  let sid: string | null = null;
  const history: { role: string; content: string }[] = [];

  // Turn 1: fixed opener
  say('YOU', cfg.opener);
  const r1 = await chat(cfg.slug, sid, cfg.opener);
  sid = r1.sid;
  say('BOT', r1.reply);
  if (r1.tools.length) console.log(`  TOOLS: ${r1.tools.join(', ')}`);
  history.push({ role: 'user', content: cfg.opener });
  history.push({ role: 'assistant', content: r1.reply });

  // Turns 2+: agent-driven
  for (let t = 2; t <= cfg.turns; t++) {
    let userMsg = await agentFollowUp(cfg.persona, history, t, cfg.turns);
    if (!userMsg || userMsg.length < 3) {
      const fallbacks = ['what about that?', 'any details?', 'go on', 'and then?', 'what else?'];
      userMsg = fallbacks[t % fallbacks.length];
    }
    say('YOU', userMsg);

    const r = await chat(cfg.slug, sid, userMsg);
    sid = r.sid;
    say('BOT', r.reply);
    if (r.tools.length) console.log(`  TOOLS: ${r.tools.join(', ')}`);
    history.push({ role: 'user', content: userMsg });
    history.push({ role: 'assistant', content: r.reply });
  }
}

const conversations: ConvConfig[] = [
  {
    slug: 'forge-agents',
    name: 'Conv 1: Bug hunter',
    opener: 'show me open bugs',
    turns: 5,
    persona: {
      goal: 'Find the most critical open bug, understand its impact, then ask to create a fix task for it',
      style: 'Direct developer, uses short sentences, refers to issues by name or pronoun',
      language: 'en',
    },
  },
  {
    slug: 'hrm',
    name: 'Conv 2: HR staff (Vietnamese)',
    opener: 'vấn đề chấm công',
    turns: 4,
    persona: {
      goal: 'Find attendance tracking issues, pick the most urgent one, ask for details',
      style: 'Polite Vietnamese office worker, asks follow-up questions',
      language: 'vi',
    },
  },
  {
    slug: 'forge-agents',
    name: 'Conv 3: PM checking status',
    opener: 'project status?',
    turns: 4,
    persona: {
      goal: 'Get project overview, then drill into blockers and ask about their priority',
      style: 'Busy PM, terse messages, wants quick answers',
      language: 'en',
    },
  },
  {
    slug: 'forge-agents',
    name: 'Conv 4: WebSocket investigator',
    opener: 'any issues with WebSocket?',
    turns: 5,
    persona: {
      goal: 'Investigate WebSocket problems, find related issues, then switch to asking about auth issues too',
      style: 'Senior dev debugging production, asks pointed questions',
      language: 'en',
    },
  },
  {
    slug: 'forge-agents',
    name: 'Conv 5: New team member',
    opener: 'hello',
    turns: 5,
    persona: {
      goal: 'Introduce yourself, ask what the project is about, then ask about open issues you could help with',
      style: 'Friendly new joiner, curious, asks broad then specific questions',
      language: 'en',
    },
  },
  {
    slug: 'hrm',
    name: 'Conv 6: Leave report (Vietnamese)',
    opener: 'báo cáo nghỉ phép',
    turns: 4,
    persona: {
      goal: 'Find leave-related issues, understand the leave calendar feature request, suggest creating a new issue for leave approval workflow',
      style: 'HR manager, formal Vietnamese, wants actionable results',
      language: 'vi',
    },
  },
  {
    slug: 'forge-agents',
    name: 'Conv 7: Issue creator',
    opener: 'I found a bug in the login page',
    turns: 4,
    persona: {
      goal: 'Report a login redirect bug, provide details when asked, confirm issue creation',
      style: 'QA tester filing a bug, provides details proactively',
      language: 'en',
    },
  },
  {
    slug: 'forge-agents',
    name: 'Conv 8: Mixed language dev',
    opener: 'login page issues',
    turns: 4,
    persona: {
      goal: 'Find login issues, switch to Vietnamese mid-conversation to ask about severity, then create an issue in mixed language',
      style: 'Bilingual dev who mixes EN and VI naturally',
      language: 'mixed en/vi',
    },
  },
];

async function run() {
  for (const conv of conversations) {
    await runConversation(conv);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('All conversations completed. Check server logs for [rag] pipeline output.');
  console.log('═'.repeat(60));
}

run().catch(e => { console.error('FATAL:', e); process.exit(1); });
