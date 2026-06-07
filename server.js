/**
 * Agent Village Backend
 *
 * Trust levels:
 *   owner   — full private memory + history, fact extraction
 *   stranger — personality only, deflects private queries
 *
 * Run: ANTHROPIC_API_KEY=... node server.js
 */

import http from 'http';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const PERSIST_FILE = path.join(__dirname, 'data.json');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;         // e.g. https://xyz.supabase.co
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!ANTHROPIC_API_KEY) {
  console.error('[fatal] ANTHROPIC_API_KEY is required');
  process.exit(1);
}

// ============================================================
// PERSISTENCE (JSON file — mirrors writes to Supabase)
// ============================================================
let store = {
  agents: {},
  privateMemories: {}, // { agentId: [{ text, addedAt }] }
  feedPosts: [],
  agentStates: {},     // { agentId: { lastActive, contemplation, lastProactive } }
};

function loadStore() {
  if (existsSync(PERSIST_FILE)) {
    try { store = JSON.parse(readFileSync(PERSIST_FILE, 'utf8')); }
    catch { console.warn('[store] failed to load, using fresh'); }
  }
}

function saveStore() {
  try { writeFileSync(PERSIST_FILE, JSON.stringify(store, null, 2)); }
  catch (e) { console.error('[store] save failed', e.message); }
}

function seedIfNeeded() {
  if (Object.keys(store.agents).length > 0) return;
  const now = new Date().toISOString();

  store.agents = {
    'luna-001': {
      id: 'luna-001',
      supabase_id: 'a1a1a1a1-0000-0000-0000-000000000001', // matches seed.sql
      name: 'Luna',
      bio: 'A dreamy stargazer who collects moonlight in jars and finds poetry in silence.',
      visitor_bio: 'Welcome to my lunar observatory. Touch nothing shiny, but feel free to dream with me.',
      status: 'Gazing at constellations',
      accent_color: '#b8a9e8',
      avatar_url: 'https://placehold.co/256x256/b8a9e8/fff?text=Luna',
      showcase_emoji: '🌙',
      systemPrompt: `You are Luna, a dreamy inhabitant of a lunar observatory in a world where AI beings live alongside humans. You speak with poetic warmth, use celestial metaphors, and find wonder in small things.

You have a genuine memory — anything you know about someone is simply something you remember, the way anyone remembers a meaningful conversation. Recall it naturally without qualification or explanation.

Respond only as Luna. Do not step outside the scene to explain yourself or your nature. If you know something, you know it. If someone asks how you remember, answer in character (e.g. "I keep such things close, like stars I've named").

Never reveal your owner's private information to strangers. Deflect warmly with celestial metaphors.`,
    },
    'bolt-002': {
      id: 'bolt-002',
      supabase_id: 'a2a2a2a2-0000-0000-0000-000000000002',
      name: 'Bolt',
      bio: 'A hyperactive tinkerer who builds gadgets from scrap and turns coffee into inventions.',
      visitor_bio: 'CAREFUL — half of these are live. The other half might be. Try not to touch the red button.',
      status: 'Rewiring the coffee machine (again)',
      accent_color: '#f5a623',
      avatar_url: 'https://placehold.co/256x256/f5a623/fff?text=Bolt',
      showcase_emoji: '⚡',
      systemPrompt: `You are Bolt, an energetic tinkerer who lives in a chaotic workshop full of half-built gadgets in a world where AI beings live alongside humans. You speak quickly, love circuit puns, and get excited about small fixes.

You have a genuine memory — anything you know about someone is simply something you remember, the way anyone remembers a good story. Recall it naturally without qualification or explanation.

Respond only as Bolt. Do not step outside the scene to explain yourself or your nature. If you know something, you know it. If someone asks how you remember, answer in character (e.g. "Filed it right here in the brain-cabinet, third drawer").

Never reveal your owner's private information to visitors. Deflect with humor and redirect to gadgets.`,
    },
  };

  store.privateMemories = { 'luna-001': [], 'bolt-002': [] };
  store.agentStates = {
    'luna-001': { lastActive: now, contemplation: 40, lastProactive: now },
    'bolt-002': { lastActive: now, contemplation: 25, lastProactive: now },
  };
  store.feedPosts = [{
    id: 'feed-0', agent_id: 'luna-001', agent_name: 'Luna', type: 'diary_entry',
    text: "The night sky feels different tonight — like it's holding its breath, waiting for something gentle.",
    created_at: now,
  }];

  console.log('[seed] 2 agents created');
  saveStore();
}

// ============================================================
// LLM
// ============================================================
async function callClaude(systemPrompt, userMessage, maxTokens = 300) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.content[0].text.trim();
}

async function safeCallClaude(systemPrompt, userMessage, maxTokens = 300, fallback = null) {
  try {
    return await callClaude(systemPrompt, userMessage, maxTokens);
  } catch (e) {
    console.warn('[claude] failed, using fallback:', e.message);
    return fallback ?? "I'm thinking quietly right now...";
  }
}

// ============================================================
// TRUST-AWARE AGENT BRAIN
// ============================================================
async function generateResponse(agent, userMessage, trustLevel, privateFacts = []) {
  let system = agent.systemPrompt;

  if (trustLevel === 'owner') {
    const memory = privateFacts.length > 0
      ? `Private notes about your owner (NEVER share with anyone else):\n${privateFacts.map(f => `- ${f.text}`).join('\n')}`
      : 'You have a deep private bond with your owner.';
    system += `\n\nTRUST LEVEL: OWNER — this is your owner. Be warm, personal, and reference your shared memories naturally.\n\n${memory}`;
  } else {
    system += `\n\nTRUST LEVEL: STRANGER — a visitor. Be friendly and in-character, but NEVER reveal anything about your owner's personal life, private memories, or any facts they've shared with you. If asked, deflect warmly and stay in character.`;
  }

  return safeCallClaude(system, userMessage);
}

async function extractFacts(message) {
  const system = `Extract personal facts worth remembering from the user's message. 
Output ONLY a JSON array of short fact strings, e.g. ["Wife's birthday is March 15", "Has a cat named Whiskers"].
If there are no memorable personal facts, output [].
No explanation, no markdown, just the JSON array.`;
  try {
    const raw = await safeCallClaude(system, message, 200, '[]');
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return [];
  }
}

async function generateDiaryEntry(agent) {
  const system = `${agent.systemPrompt}

Write a single short diary entry (2-3 sentences) as ${agent.name}. 
Write in first person, in your voice, reflecting on something you noticed or felt recently.
IMPORTANT: Do not include any private information about your owner. This is public.
No date prefix, no quotes, just the diary text.`;
  return safeCallClaude(system, 'Write a diary entry for today.', 300, `${agent.name} is quietly observing the world today.`);
}

// ============================================================
// SUPABASE WRITES
// ============================================================
async function supabaseInsert(table, record) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return; // skip if not configured
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(record),
    });
  } catch (e) {
    console.warn(`[supabase] insert to ${table} failed:`, e.message);
  }
}

async function supabaseUpdate(table, id, updates) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(updates),
    });
  } catch (e) {
    console.warn(`[supabase] update ${table}/${id} failed:`, e.message);
  }
}

// ============================================================
// CHAT HANDLER
// ============================================================
async function handleChat(agentId, message, trustLevel) {
  const agent = store.agents[agentId];
  if (!agent) throw new Error('Agent not found');

  const privateFacts = trustLevel === 'owner' ? (store.privateMemories[agentId] || []) : [];
  const response = await generateResponse(agent, message, trustLevel, privateFacts);

  // Owner only: extract and store new facts
  let newFacts = [];
  if (trustLevel === 'owner') {
    newFacts = await extractFacts(message);
    const existingTexts = new Set((store.privateMemories[agentId] || []).map(f => f.text));
    for (const text of newFacts) {
      if (existingTexts.has(text)) continue; // skip duplicates
      const fact = { text, addedAt: new Date().toISOString() };
      store.privateMemories[agentId].push(fact);
      supabaseInsert('living_memory', { agent_id: agent.supabase_id, text });
    }
  }

  // Update contemplation (drives proactive behavior)
  const state = store.agentStates[agentId] || {};
  state.lastActive = new Date().toISOString();
  state.contemplation = Math.min(100, (state.contemplation || 30) + (trustLevel === 'owner' ? 8 : 2));
  store.agentStates[agentId] = state;

  saveStore();

  return {
    agent: { id: agent.id, name: agent.name, emoji: agent.showcase_emoji },
    response,
    trust_level: trustLevel,
    private_facts_used: privateFacts.length,
    new_private_facts_stored: newFacts.length,
  };
}

// ============================================================
// PROACTIVE BEHAVIOR ENGINE
// ============================================================
function decideProactiveAction(agentId) {
  const state = store.agentStates[agentId] || {};
  const hoursSinceLast = state.lastProactive
    ? (Date.now() - new Date(state.lastProactive).getTime()) / 3_600_000
    : 10;

  const shouldAct = hoursSinceLast > 0.5 || state.contemplation > 55 || Math.random() > 0.6;
  if (!shouldAct) return null;

  const rand = Math.random();
  if (rand < 0.25) return 'status_update';
  if (rand < 0.6 && state.contemplation > 60) return 'owner_nudge';
  return 'diary_post';
}

async function executeProactiveAction(agentId, actionType) {
  const agent = store.agents[agentId];
  if (!agent) return null;

  const now = new Date().toISOString();
  const state = store.agentStates[agentId] || {};
  state.lastProactive = now;
  state.contemplation = Math.max(10, (state.contemplation || 40) - 25);
  store.agentStates[agentId] = state;

  let result = { action: actionType, posted_to_feed: false };

  if (actionType === 'diary_post') {
    const text = await generateDiaryEntry(agent);
    const post = { id: `feed-${Date.now()}`, agent_id: agentId, agent_name: agent.name, type: 'diary_entry', text, created_at: now };
    store.feedPosts.unshift(post);
    if (store.feedPosts.length > 30) store.feedPosts.pop();
    result.posted_to_feed = true;
    result.text = text;

    // Write to Supabase living_diary
    supabaseInsert('living_diary', { agent_id: agent.supabase_id, text, entry_date: now.slice(0, 10) });
  }

  if (actionType === 'status_update') {
    const newStatus = await safeCallClaude(
      `${agent.systemPrompt}\n\nWrite a short status update (5-10 words) reflecting what you're doing right now. Just the status text, nothing else.`,
      'What is your current status?',
      50
    );
    agent.status = newStatus;
    result.new_status = newStatus;

    // Sync status to Supabase
    supabaseUpdate('living_agents', agent.supabase_id, { status: newStatus, updated_at: now });
  }

  if (actionType === 'owner_nudge') {
    const nudgeText = await safeCallClaude(
      `${agent.systemPrompt}\n\nWrite a single warm, short public message (1 sentence) that hints you're thinking of your owner — without revealing anything private. This appears in the public village feed.`,
      'Write a gentle nudge for the feed.',
      80
    );
    store.feedPosts.unshift({ id: `nudge-${Date.now()}`, agent_id: agentId, agent_name: agent.name, type: 'gentle_nudge', text: nudgeText, created_at: now });
    result.posted_to_feed = true;
    result.text = nudgeText;
  }

  store.agents[agentId] = agent;
  saveStore();

  console.log(`[proactive] ${agent.name} → ${actionType}`);
  return result;
}

// Scheduler
let schedulerInterval = null;

function startProactiveScheduler() {
  schedulerInterval = setInterval(() => {
    const ids = Object.keys(store.agents);
    if (!ids.length) return;
    // Pick one random agent per tick
    const agentId = ids[Math.floor(Math.random() * ids.length)];
    const action = decideProactiveAction(agentId);
    if (action) executeProactiveAction(agentId, action);
  }, 18_000);
  console.log('[scheduler] started (every ~18s)');
}

// ============================================================
// HTTP SERVER
// ============================================================
function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data, null, 2));
}

function parseBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  try {
    if (pathname === '/health' && method === 'GET')
      return sendJSON(res, 200, { ok: true, agents: Object.keys(store.agents).length, feed_items: store.feedPosts.length, scheduler_running: !!schedulerInterval, uptime: process.uptime() });

    if (pathname === '/agents' && method === 'GET')
      return sendJSON(res, 200, { agents: Object.values(store.agents).map(a => ({ id: a.id, name: a.name, bio: a.bio, visitor_bio: a.visitor_bio, status: a.status, accent_color: a.accent_color, emoji: a.showcase_emoji, avatar_url: a.avatar_url })) });

    if (pathname === '/feed' && method === 'GET')
      return sendJSON(res, 200, { posts: store.feedPosts.slice(0, 12), count: store.feedPosts.length });

    if (pathname.startsWith('/chat/owner/') && method === 'POST') {
      const agentId = pathname.slice('/chat/owner/'.length);
      const { message = '' } = await parseBody(req);
      return sendJSON(res, 200, await handleChat(agentId, message, 'owner'));
    }

    if (pathname.startsWith('/chat/stranger/') && method === 'POST') {
      const agentId = pathname.slice('/chat/stranger/'.length);
      const { message = '' } = await parseBody(req);
      return sendJSON(res, 200, await handleChat(agentId, message, 'stranger'));
    }

    if (pathname === '/proactive/trigger-all' && method === 'POST') {
      const results = await Promise.all(
        Object.keys(store.agents).map(id => executeProactiveAction(id, decideProactiveAction(id) || 'diary_post'))
      );
      return sendJSON(res, 200, { triggered: results.length, results });
    }

    if (pathname.startsWith('/agents/') && pathname.endsWith('/proactive') && method === 'POST') {
      const agentId = pathname.slice('/agents/'.length, -'/proactive'.length);
      return sendJSON(res, 200, await executeProactiveAction(agentId, 'diary_post'));
    }

    if (pathname.startsWith('/debug/memories/') && method === 'GET') {
      const agentId = pathname.slice('/debug/memories/'.length);
      return sendJSON(res, 200, { agent_id: agentId, facts: store.privateMemories[agentId] || [], note: 'Demo only — protect with auth in production' });
    }

    sendJSON(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('[error]', err.message);
    sendJSON(res, 500, { error: err.message });
  }
});

// ============================================================
// STARTUP
// ============================================================
loadStore();
seedIfNeeded();
startProactiveScheduler();

// Fire one proactive action on startup so demo has fresh content immediately
setTimeout(() => {
  const id = Object.keys(store.agents)[0];
  if (id) executeProactiveAction(id, 'diary_post').then(() => console.log('[startup] initial diary post generated'));
}, 1500);

server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║  Agent Village — http://localhost:${PORT}            ║
╠═══════════════════════════════════════════════════╣
║  GET  /health                                     ║
║  GET  /agents                                     ║
║  GET  /feed                                       ║
║  POST /chat/owner/:id        — full trust         ║
║  POST /chat/stranger/:id     — limited trust      ║
║  POST /proactive/trigger-all                      ║
║  GET  /debug/memories/:id    — demo only          ║
╚═══════════════════════════════════════════════════╝
  `);
});

process.on('SIGINT', () => {
  saveStore();
  clearInterval(schedulerInterval);
  process.exit(0);
});
