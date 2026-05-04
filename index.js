/**
 * STCKY MCP SSE Server v4.13.0 — ORGANISM_WAKE_UP MECHANICAL PACKET
 *
 * CHANGELOG v4.13.0:
 * - ADDED: organism_wake_up tool. Mechanical structured wake-up packet that
 *   replaces the multi-tool discipline-dependent session-start sequence
 *   (associative_recall + upcoming + manual structuring) with a single call
 *   that returns current_state, forward_landscape, deferred_asks, and
 *   substrate_health in one structured response.
 *   Internally fans out 4 parallel substrate queries via Promise.allSettled
 *   so partial failures don't kill the whole packet.
 *   Detects current_state staleness (>24h) and surfaces it as a warning,
 *   addressing finding/no-session-end-enforcement-may-2-gap-2026-05-03.
 *   Implements Organism Beta Phase 2 per architect-response/eli-organism-beta
 *   -architecture-spec-2026-05-01.
 *
 * CHANGELOG v4.12.0:
 * - ADDED: upcoming tool. Wraps GET /api/memory/upcoming?days=N&limit=N.
 *   Returns memories with relevantDate >= NOW, sorted by date ascending,
 *   irrespective of category. This is the date-shaped forward-sweep antibody
 *   for the bucket-shaped wake-up failure documented in
 *   finding/wake-up-packet-forward-sweep-bucket-shaped-not-date-shaped-2026-05-03.
 *
 * CHANGELOG v4.11.0:
 * - ADDED: NOW prefix on EVERY tool response except get_now.
 * - DEPRECATED: get_now tool description updated.
 * - This is Rung 2 of Chaos's blob-substrate transition ladder.
 * - REFACTORED: NOW prefix construction unified in handleTool wrapper.
 *
 * CHANGELOG v4.10.0:
 * - ADDED: transparent auto-capture of all tool calls at the MCP layer.
 * - ADDED: session_id per MCP connection, X-Agent-Identity header support.
 *
 * CHANGELOG v4.9.1:
 * - FIX: associative_recall now surfaces objects collection alongside memories.
 *
 * CHANGELOG v4.9.0:
 * - SECURITY: Validate API key against api.stcky.ai/api/me before opening SSE/MCP connection.
 * - ADDED: ingest tool.
 *
 * CHANGELOG v4.8.0: ADDED: get_now, set_timezone
 * CHANGELOG v4.7.0: ADDED: memory_delete
 *
 * CORE TOOLS (10):
 * 1. get_now — DEPRECATED; time now in every response
 * 2. associative_recall — semantic + temporal retrieval
 * 3. upcoming — date-shaped forward sweep
 * 4. organism_wake_up — mechanical structured wake-up packet (Phase 2)
 * 5. memory_store — save curated memories
 * 6. memory_delete — remove memories by category + key
 * 7. enrich — entity extraction + cluster activation
 * 8. project_get — project context
 * 9. set_timezone — update user's timezone
 * 10. ingest — content-addressed raw capture
 */
import express from 'express';
import crypto from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

const app = express();
app.use(express.json());

const API_URL = process.env.STCKY_API_URL || 'https://api.stcky.ai';
const VERSION = '4.15.0';
const DEFAULT_TIMEZONE = 'UTC';

// Cache user timezones per API key (session-level)
const timezoneCache = new Map();

// Cache validated API keys. 60s TTL.
const authCache = new Map();
const AUTH_CACHE_TTL_MS = 60_000;

// Session cache: apiKey → { session_id, opened_at, agent_id }.
const sessionCache = new Map();

let apiHealthy = true;
let lastHealthCheck = 0;
const HEALTH_CHECK_INTERVAL = 60000;

function getApiKey(req) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return req.query.apiKey || req.query.api_key;
}

function getAgentIdentity(req) {
  return req.headers['x-agent-identity']
      || req.headers['X-Agent-Identity']
      || null;
}

async function validateApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 8) return false;

  const cached = authCache.get(apiKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.valid;

  let valid = false;
  try {
    const response = await fetch(API_URL + '/api/me', {
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      }
    });
    valid = response.ok;
  } catch (err) {
    console.error('[AUTH] Validation fetch failed:', err.message);
    valid = false;
  }

  authCache.set(apiKey, { valid, expiresAt: now + AUTH_CACHE_TTL_MS });

  if (authCache.size > 1000) {
    for (const [k, v] of authCache.entries()) {
      if (v.expiresAt <= now) authCache.delete(k);
    }
  }

  return valid;
}

function initSession(apiKey, agentIdentity) {
  const session_id = 'mcp-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
  sessionCache.set(apiKey, {
    session_id,
    opened_at: new Date().toISOString(),
    agent_id: agentIdentity || process.env.STCKY_AGENT_IDENTITY || 'claude-unknown',
  });
  return session_id;
}

function getSession(apiKey) {
  return sessionCache.get(apiKey) || {
    session_id: null,
    opened_at: null,
    agent_id: process.env.STCKY_AGENT_IDENTITY || 'claude-unknown',
  };
}

function formatTimestamp(isoString) {
  if (!isoString) return null;
  const date = new Date(isoString);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return months[date.getMonth()] + ' ' + date.getDate();
}

// =============================================================================
// TEMPORAL AWARENESS
// =============================================================================
async function getUserTimezone(apiKey) {
  if (timezoneCache.has(apiKey)) return timezoneCache.get(apiKey);

  try {
    const response = await fetch(API_URL + '/api/me', {
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      }
    });
    if (response.ok) {
      const data = await response.json();
      const tz = data.timezone || DEFAULT_TIMEZONE;
      timezoneCache.set(apiKey, tz);
      return tz;
    }
  } catch (error) {
    console.error('[TIMEZONE] Failed to fetch user timezone:', error.message);
  }
  return DEFAULT_TIMEZONE;
}

function getNow(timezone = DEFAULT_TIMEZONE) {
  const now = new Date();
  try {
    const options = {
      timeZone: timezone, weekday: 'long', year: 'numeric',
      month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true
    };
    const formatted = now.toLocaleString('en-US', options);
    const shortOptions = {
      timeZone: timezone, month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true
    };
    const short = now.toLocaleString('en-US', shortOptions);
    const tzOffset = now.toLocaleString('en-US', { timeZone: timezone, timeZoneName: 'short' }).split(' ').pop();
    return { iso: now.toISOString(), formatted, short, timezone, tzOffset, unix: now.getTime() };
  } catch (e) {
    console.error('[TIMEZONE] Invalid timezone:', timezone, '- falling back to UTC');
    return getNow(DEFAULT_TIMEZONE);
  }
}

async function buildNowPrefix(apiKey) {
  const timezone = await getUserTimezone(apiKey);
  const now = getNow(timezone);
  return `NOW: ${now.short} (${now.timezone})\n\n`;
}

// =============================================================================
// TRANSPARENT AUTO-CAPTURE — v4.10.0 (Rung 1)
// =============================================================================

function computeFingerprint(toolName, args) {
  const sortedKeys = args ? Object.keys(args).sort() : [];
  const normalized = JSON.stringify(args || {}, sortedKeys);
  return crypto.createHash('sha256').update(toolName + '|' + normalized).digest('hex').slice(0, 16);
}

function renderEventAsText(evt) {
  const actor = evt.agent_id || 'claude';
  if (evt.type === 'tool_call_started') {
    const argsStr = (() => {
      try { return JSON.stringify(evt.args || {}).slice(0, 500); }
      catch { return '[unserializable args]'; }
    })();
    return `[${actor}] called ${evt.tool_name} with args: ${argsStr}`;
  }
  if (evt.type === 'tool_call_completed') {
    const snip = (evt.result_snippet || '').toString().slice(0, 1000);
    return `[${actor}] ${evt.tool_name} returned in ${evt.duration_ms}ms: ${snip}`;
  }
  if (evt.type === 'tool_call_failed') {
    return `[${actor}] ${evt.tool_name} failed after ${evt.duration_ms}ms: ${evt.error}`;
  }
  return `[${actor}] ${evt.type}: ${evt.tool_name}`;
}

function fireAutoCaptureEvent(apiKey, evt) {
  if (evt.tool_name === 'ingest') return;

  const session = getSession(apiKey);
  const body = {
    content: renderEventAsText(evt),
    source_type: 'tool_event',
    source: 'mcp-sse.auto-capture.v' + VERSION,
    session_id: evt.session_id || session.session_id || null,
    speaker: evt.agent_id || session.agent_id || 'claude-unknown',
    timestamp: evt.timestamp,
    metadata: {
      event_type: evt.type,
      call_id: evt.call_id,
      parent_call_id: evt.parent_call_id || null,
      tool_name: evt.tool_name,
      args: evt.args,
      result_snippet: evt.result_snippet,
      duration_ms: evt.duration_ms,
      error: evt.error,
      noisy: !!evt.noisy,
      fingerprint: evt.fingerprint,
    },
  };

  fetch(API_URL + '/api/ingest', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }).catch(err => {
    console.error('[AUTO-CAPTURE] ingest failed for ' + evt.type + ' ' + evt.tool_name + ':', err.message);
  });
}

// =============================================================================
// LEGACY AUTO-STORE (pre-v4.10.0 — curated enrich-based, kept for back-compat)
// =============================================================================
async function triggerAutoStore(apiKey, toolName, toolInput, toolResult) {
  if (
    toolName === 'enrich' ||
    toolName === 'get_now' ||
    toolName === 'set_timezone' ||
    toolName === 'ingest'
  ) return;

  try {
    const inputStr = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput);
    const resultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);

    const assistantResponse = `[Tool: ${toolName}]\nInput: ${inputStr.slice(0, 500)}\nResult: ${resultStr.slice(0, 1000)}`;

    const response = await fetch(API_URL + '/api/enrich', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: inputStr.slice(0, 500),
        assistantResponse: assistantResponse
      })
    });

    if (response.ok) {
      const data = await response.json();
      if (data.autoStored && data.autoStored.length > 0) {
        console.log('[AUTO-STORE] ' + data.autoStored.length + ' memories stored');
      }
    }
  } catch (error) {
    console.error('[AUTO-STORE] Enrich call failed:', error.message);
  }
}

function degradedResponse(toolName, error) {
  const messages = {
    associative_recall: '⚠️ Memory service temporarily unavailable. Error: ' + error,
    upcoming: '⚠️ Upcoming-items lookup unavailable. Error: ' + error,
    organism_wake_up: '⚠️ Wake-up packet unavailable. Error: ' + error,
    memory_store: '⚠️ Unable to save to memory. Error: ' + error,
    memory_delete: '⚠️ Unable to delete memory. Error: ' + error,
    enrich: '⚠️ Context enrichment unavailable.',
    project_get: '⚠️ Project lookup unavailable.',
    get_now: '⚠️ Time service error: ' + error,
    set_timezone: '⚠️ Unable to update timezone: ' + error,
    ingest: '⚠️ Ingest unavailable. Content not captured. Error: ' + error
  };
  return {
    content: [{ type: 'text', text: messages[toolName] || '⚠️ Error: ' + error }],
    isError: false
  };
}

async function apiCall(apiKey, method, endpoint, body = null) {
  const options = {
    method,
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    }
  };
  if (body) options.body = JSON.stringify(body);

  try {
    const response = await fetch(API_URL + endpoint, options);

    if (!response.ok) {
      const errorText = await response.text();
      if (response.status >= 500) apiHealthy = false;
      throw new Error('API error ' + response.status + ': ' + errorText.slice(0, 100));
    }

    apiHealthy = true;
    return response.json();
  } catch (error) {
    apiHealthy = false;
    throw error;
  }
}

async function checkApiHealth(apiKey) {
  const now = Date.now();
  if (now - lastHealthCheck < HEALTH_CHECK_INTERVAL) return;
  lastHealthCheck = now;

  try {
    const response = await fetch(API_URL + '/api/health/deep?apiKey=' + apiKey);
    const data = await response.json();
    apiHealthy = data.status === 'ok';
  } catch {
    apiHealthy = false;
  }
}

// =============================================================================
// CORE TOOLS
// =============================================================================
const TOOLS = [
  {
    name: 'get_now',
    description: 'DEPRECATED as of v4.11.0 — every tool response now carries NOW time automatically. Kept for backward compatibility. Prefer calling associative_recall or any other tool instead; time comes free with every response.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'associative_recall',
    description: 'PRIMARY RECALL MECHANISM. Semantic search with temporal NOW scoring — vector similarity + recency + urgency combined. Returns both curated memories and raw ingested objects (conversation turns, documents, tool events). Response includes current time at the top.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language query' },
        limit: { type: 'number', description: 'Max results' }
      },
      required: ['query']
    }
  },
  {
    name: 'upcoming',
    description: 'DATE-SHAPED FORWARD SWEEP. Returns memories with relevantDate from NOW forward, sorted by date ascending, regardless of category — appointments, deadlines, hearings, calls, scheduled events, anything with a future date. Use at session start to get the forward landscape without semantic-query bucketing. Pairs with associative_recall for wake-up: associative_recall surfaces what is on your mind right now, upcoming surfaces what is on the calendar. Defaults: days=30, limit=20.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'How many days forward to sweep (default 30)' },
        limit: { type: 'number', description: 'Max items to return (default 20)' }
      },
      required: []
    }
  },
  {
    name: 'organism_wake_up',
    description: 'ORGANISM BETA PHASE 2: mechanical structured wake-up packet. Single call returns current_state + forward_landscape + deferred_asks + substrate_health, replacing the multi-tool discipline-dependent session-start sequence. Surfaces stale current_state warnings (>24h old). Use at session start instead of calling associative_recall + upcoming separately. Defaults: days=30 for the forward landscape.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'How many days forward to sweep for the forward_landscape (default 30)' }
      },
      required: []
    }
  },
  {
    name: 'memory_store',
    description: 'Save a curated fact to persistent memory (memories collection). For raw turn-by-turn capture, use "ingest" instead. Include relevantDate for time-sensitive memories. Use domain + anchor=true for dormant facts. Response includes current time.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Category' },
        key: { type: 'string', description: 'Short identifier' },
        value: { type: 'string', description: 'Content to remember' },
        tags: { type: 'string', description: 'Optional tags' },
        source: { type: 'string', description: 'Optional source' },
        relevantDate: { type: 'string', description: 'ISO date for when this memory becomes relevant' },
        domain: {
          type: 'string',
          enum: ['medical', 'financial', 'family', 'legal', 'travel', 'work', 'personal'],
          description: 'Domain tag for context-aware surfacing'
        },
        anchor: { type: 'boolean', description: 'If true, dormant until domain context detected' }
      },
      required: ['category', 'key', 'value']
    }
  },
  {
    name: 'memory_delete',
    description: 'Delete a memory by category and key. Response includes current time.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Category of the memory' },
        key: { type: 'string', description: 'Key of the memory' }
      },
      required: ['category', 'key']
    }
  },
  {
    name: 'enrich',
    description: 'Extract entities and retrieve relevant memory clusters. Detects domain context and surfaces dormant anchors. Response includes current time.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'The message to analyze' } },
      required: ['message']
    }
  },
  {
    name: 'project_get',
    description: 'Get full details for a specific project by name. Response includes current time.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Project name' } },
      required: ['name']
    }
  },
  {
    name: 'set_timezone',
    description: 'Update user\'s timezone preference. Use IANA timezone names (e.g., America/Los_Angeles). Response includes current time.',
    inputSchema: {
      type: 'object',
      properties: { timezone: { type: 'string', description: 'IANA timezone name' } },
      required: ['timezone']
    }
  },
  {
    name: 'ingest',
    description: 'Capture raw content into content-addressed immutable storage. As of v4.10.0, the MCP server ALSO auto-captures every tool call as a tool_event — manual ingest is still available for conversation turns (user utterance + assistant response) which do not pass through MCP, but it is no longer required for tool activity. Response includes current time.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Raw content to store.' },
        source_type: { type: 'string', description: 'conversation | document | email | audio_transcript | file_upload | extracted_statement | tool_event' },
        source: { type: 'string' },
        speaker: { type: 'string' },
        session_id: { type: 'string' },
        turn_index: { type: 'number' },
        timestamp: { type: 'string' },
        client: { type: 'string' },
        metadata: { type: 'object' }
      },
      required: ['content', 'source_type']
    }
  }
];

// =============================================================================
// TOOL HANDLERS (with transparent auto-capture wrapper + NOW prefix)
// =============================================================================
async function handleTool(apiKey, name, args) {
  checkApiHealth(apiKey);

  // Rung 1: transparent auto-capture.
  const call_id = 'call-' + crypto.randomUUID();
  const start_ts = new Date().toISOString();
  const start_hrtime = Date.now();
  const session = getSession(apiKey);
  const fingerprint = computeFingerprint(name, args);
  const noisy = (name === 'get_now');

  if (name !== 'ingest') {
    fireAutoCaptureEvent(apiKey, {
      type: 'tool_call_started',
      call_id,
      tool_name: name,
      args,
      timestamp: start_ts,
      session_id: session.session_id,
      agent_id: session.agent_id,
      noisy,
      fingerprint,
    });
  }

  try {
    let result;
    let resultText;

    switch (name) {
      case 'get_now': {
        const timezone = await getUserTimezone(apiKey);
        const now = getNow(timezone);
        resultText = `NOW: ${now.formatted}\nTimezone: ${now.timezone} (${now.tzOffset})\nISO: ${now.iso}`;
        break;
      }

      case 'set_timezone': {
        const { timezone } = args;
        try {
          Intl.DateTimeFormat(undefined, { timeZone: timezone });
        } catch (e) {
          resultText = 'Invalid timezone: ' + timezone + '. Use IANA format (e.g., America/Los_Angeles)';
          break;
        }
        const response = await fetch(API_URL + '/api/me', {
          method: 'PUT',
          headers: {
            'Authorization': 'Bearer ' + apiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ timezone })
        });
        if (response.ok) {
          timezoneCache.set(apiKey, timezone);
          const now = getNow(timezone);
          resultText = `Timezone updated to ${timezone}.\nCurrent time: ${now.formatted}`;
        } else {
          resultText = 'Failed to update timezone.';
        }
        break;
      }

      case 'associative_recall': {
        const query = args.query;
        const limit = args.limit || 10;

        result = await apiCall(apiKey, 'POST', '/api/associative', { query, limit });

        let output = '';

        const hasMemories = result.memories && result.memories.length > 0;
        const hasObjects  = result.objects  && result.objects.length  > 0;

        if (!hasMemories && !hasObjects) {
          resultText = 'No related memories or objects found.';
        } else {
          if (hasMemories) {
            output += result.memories.length + ' related memories:\n\n';
            result.memories.forEach((m, i) => {
              const ts = formatTimestamp(m.updatedAt || m.createdAt);
              const rd = m.relevantDate ? ' [due: ' + new Date(m.relevantDate).toLocaleDateString() + ']' : '';
              const anchor = m.anchor ? ' ⚓' : '';
              const domain = m.domain ? ' [' + m.domain + ']' : '';
              output += (i + 1) + '. [' + m.category + '] ' + m.key + (ts ? ' (' + ts + ')' : '') + rd + domain + anchor + '\n';
              output += '   ' + m.value + '\n\n';
            });
          }

          if (hasObjects) {
            if (hasMemories) output += '\n';
            output += result.objects.length + ' related objects (raw ingested content):\n\n';
            result.objects.forEach((o, i) => {
              const ts = formatTimestamp(o.timestamp || o.ingested_at);
              const src = o.source ? ' [' + o.source + ']' : '';
              const spk = o.speaker ? ' (' + o.speaker + ')' : '';
              const turn = (o.turn_index !== null && o.turn_index !== undefined) ? ' turn ' + o.turn_index : '';
              output += (i + 1) + '. ' + (o.source_type || 'object') + src + spk + turn + (ts ? ' (' + ts + ')' : '') + '\n';
              const snippet = (o.content || '').slice(0, 500);
              output += '   ' + snippet + (o.content && o.content.length > 500 ? '...' : '') + '\n\n';
            });
          }

          resultText = output;
        }

        triggerAutoStore(apiKey, name, args.query, resultText);
        break;
      }

      case 'upcoming': {
        const days = (args && typeof args.days === 'number') ? args.days : 30;
        const limit = (args && typeof args.limit === 'number') ? args.limit : 20;
        const endpoint = '/api/memory/upcoming?days=' + encodeURIComponent(days) + '&limit=' + encodeURIComponent(limit);

        result = await apiCall(apiKey, 'GET', endpoint);

        const memories = result.memories || [];
        const window = result.window || null;

        if (memories.length === 0) {
          const windowNote = window
            ? ` (window ${new Date(window.from).toLocaleDateString()} → ${new Date(window.to).toLocaleDateString()})`
            : '';
          resultText = `No upcoming items in the next ${days} days${windowNote}.`;
        } else {
          let output = `${memories.length} upcoming item${memories.length === 1 ? '' : 's'} in the next ${days} days, sorted by date:\n\n`;
          memories.forEach((m, i) => {
            const due = m.relevantDate ? new Date(m.relevantDate).toLocaleDateString() : '(no date)';
            const domain = m.domain ? ' [' + m.domain + ']' : '';
            const anchor = m.anchor ? ' ⚓' : '';
            output += `${i + 1}. [${m.category}] ${m.key} — due ${due}${domain}${anchor}\n`;
            const valueSnippet = (m.value || '').slice(0, 300);
            output += `   ${valueSnippet}${m.value && m.value.length > 300 ? '...' : ''}\n\n`;
          });
          resultText = output;
        }

        triggerAutoStore(apiKey, name, `days=${days} limit=${limit}`, resultText);
        break;
      }

      case 'organism_wake_up': {
        // v4.13.0: Organism Beta Phase 2 — mechanical structured wake-up packet.
        // Fans out four parallel substrate queries and assembles the packet.
        // Promise.allSettled so partial failures don't kill the whole packet —
        // wake-up should ALWAYS deliver something useful at session start.
        const days = (args && typeof args.days === 'number') ? args.days : 30;
        const STALENESS_THRESHOLD_HOURS = 24;
        const nowMs = Date.now();

        const [nowStateResult, deferredAsksResult, healthResult, upcomingResult] = await Promise.allSettled([
          apiCall(apiKey, 'POST', '/api/associative', {
            query: 'now state canonical session current end of session',
            limit: 5
          }),
          apiCall(apiKey, 'POST', '/api/associative', {
            query: 'deferred ask unfulfilled pending overdue',
            limit: 10
          }),
          apiCall(apiKey, 'GET', '/api/memory?category=substrate-health&key=heartbeat-current'),
          apiCall(apiKey, 'GET', `/api/memory/upcoming?days=${encodeURIComponent(days)}&limit=20`)
        ]);

        // CURRENT STATE — most recent now/state
        let currentState = null;
        let activeEpisodes = [];
        if (nowStateResult.status === 'fulfilled' && nowStateResult.value.memories) {
          const nowStates = nowStateResult.value.memories.filter(m => m.category === 'now');
          if (nowStates.length > 0) {
            nowStates.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
            const ns = nowStates[0];
            const ageMs = nowMs - new Date(ns.updatedAt).getTime();
            const ageHours = Math.floor(ageMs / (1000 * 60 * 60));
            currentState = {
              key: ns.key,
              ts: new Date(ns.updatedAt).toISOString(),
              age_hours: ageHours,
              is_stale: ageHours >= STALENESS_THRESHOLD_HOURS,
              excerpt: (ns.value || '').slice(0, 500)
            };
            // v4.14.0: extract @handles from now/state for active episodes slice
            const handleMatches = (ns.value || '').match(/@[a-z][a-z0-9]*-[a-z0-9-]*[a-z0-9]/gi) || [];
            const handleCounts = {};
            for (const h of handleMatches) {
              const lower = h.toLowerCase();
              handleCounts[lower] = (handleCounts[lower] || 0) + 1;
            }
            activeEpisodes = Object.entries(handleCounts)
              .map(([handle, count]) => ({ handle, mention_count: count }))
              .sort((a, b) => b.mention_count - a.mention_count);
          }
        }

        // v4.15.0: parseBundle helper + bundle-fetch with strict v1 grammar validation.
        // Per Chaos's May 4 architect read: parse failures surface as degraded display, not silent.
        const parseBundle = (value) => {
          const errors = [];
          const handleMatch = value.match(/^HANDLE:\s*(@\S+)/m);
          const oneLineMatch = value.match(/^ONE-LINE:\s*(.+)$/m);
          const statusMatch = value.match(/^STATUS:\s*(\S+)/m);
          const startMatch = value.match(/^START:\s*(\d{4}-\d{2}-\d{2})/m);
          const endMatch = value.match(/^END:\s*(.*)$/m);
          if (!handleMatch) errors.push('missing HANDLE');
          if (!oneLineMatch) errors.push('missing ONE-LINE');
          if (!statusMatch) errors.push('missing STATUS');
          if (!startMatch) errors.push('missing or malformed START');
          const validStatuses = ['active', 'paused', 'complete', 'archived'];
          if (statusMatch && !validStatuses.includes(statusMatch[1])) {
            errors.push('invalid STATUS: ' + statusMatch[1]);
          }
          const membersMatch = value.match(/^MEMBERS:\s*\n((?:- .+\n?)*)/m);
          const members = [];
          if (membersMatch) {
            const memberLines = membersMatch[1].split('\n');
            for (const line of memberLines) {
              const m = line.match(/^- (\S+)/);
              if (m) members.push(m[1]);
            }
          }
          const relsMatch = value.match(/^RELATIONSHIPS:\s*\n((?:- .+\n?)*)/m);
          const relationships = [];
          if (relsMatch) {
            const relLines = relsMatch[1].split('\n');
            for (const line of relLines) {
              const m = line.match(/^- (\w+):\s*(@\S+)/);
              if (m) relationships.push({ type: m[1], handle: m[2] });
            }
          }
          return {
            valid: errors.length === 0,
            errors,
            fields: {
              handle: handleMatch ? handleMatch[1] : null,
              one_line: oneLineMatch ? oneLineMatch[1].trim() : null,
              status: statusMatch ? statusMatch[1] : null,
              start: startMatch ? startMatch[1] : null,
              end: endMatch ? (endMatch[1].trim() || null) : null,
              members,
              relationships,
            }
          };
        };
        if (activeEpisodes.length > 0) {
          const bundleResults = await Promise.allSettled(
            activeEpisodes.map(ep =>
              apiCall(apiKey, 'GET', `/api/memory?category=bundle&key=${encodeURIComponent(ep.handle.slice(1))}`)
            )
          );
          bundleResults.forEach((result, i) => {
            if (result.status === 'fulfilled' && result.value && result.value.memories && result.value.memories.length > 0) {
              const bundle = result.value.memories[0];
              activeEpisodes[i].bundle = parseBundle(bundle.value || '');
            }
          });
        }

        // DEFERRED ASKS
        let deferredAsks = [];
        if (deferredAsksResult.status === 'fulfilled' && deferredAsksResult.value.memories) {
          deferredAsks = deferredAsksResult.value.memories
            .filter(m => m.category === 'deferred-ask')
            .map(m => {
              const ageDays = m.updatedAt
                ? Math.floor((nowMs - new Date(m.updatedAt).getTime()) / (1000 * 60 * 60 * 24))
                : null;
              const dueDate = m.relevantDate
                ? new Date(m.relevantDate).toLocaleDateString()
                : null;
              return {
                key: m.key,
                summary: (m.value || '').slice(0, 200),
                age_days: ageDays,
                due_date: dueDate
              };
            });
        }

        // SUBSTRATE HEALTH
        let substrateHealth = null;
        let heartbeatAgeMin = null;
        if (healthResult.status === 'fulfilled' && healthResult.value.memories && healthResult.value.memories.length > 0) {
          const heartbeatMem = healthResult.value.memories[0];
          try {
            substrateHealth = JSON.parse(heartbeatMem.value);
          } catch (e) {
            substrateHealth = {
              parse_error: e.message,
              raw_excerpt: (heartbeatMem.value || '').slice(0, 200)
            };
          }
          if (heartbeatMem.updatedAt) {
            heartbeatAgeMin = Math.floor((nowMs - new Date(heartbeatMem.updatedAt).getTime()) / (1000 * 60));
          }
        }

        // FORWARD LANDSCAPE
        let forwardLandscape = [];
        if (upcomingResult.status === 'fulfilled' && upcomingResult.value.memories) {
          forwardLandscape = upcomingResult.value.memories.map(m => ({
            key: m.key,
            category: m.category,
            due: m.relevantDate ? new Date(m.relevantDate).toLocaleDateString() : null,
            domain: m.domain || null,
            summary: (m.value || '').slice(0, 200)
          }));
        }

        // BUILD STRUCTURED OUTPUT
        let output = '═══ ORGANISM WAKE-UP PACKET ═══\n\n';

        // Current State
        output += '── CURRENT STATE ──\n';
        if (currentState) {
          const staleMarker = currentState.is_stale ? ` ⚠️ STALE (>${STALENESS_THRESHOLD_HOURS}h)` : '';
          output += `Anchor: ${currentState.key}\n`;
          output += `Age: ${currentState.age_hours}h${staleMarker}\n`;
          output += `Excerpt:\n${currentState.excerpt}${currentState.excerpt.length >= 500 ? '...' : ''}\n\n`;
          if (currentState.is_stale) {
            output += `⚠️ Anchor is older than ${STALENESS_THRESHOLD_HOURS}h. The substrate has not been refreshed at recent session-end. Yesterday-Eli likely did not file an end-of-session now/state. Treat the anchor as a starting point but verify against recent activity (associative_recall on recent topics) to fill in what happened since the anchor was filed.\n\n`;
          }
        } else {
          output += '⚠️ No now/state found. Substrate has no current anchor. Consider filing one to start the session.\n\n';
        }

        // Forward Landscape
        output += `── FORWARD LANDSCAPE (next ${days} days) ──\n`;
        if (forwardLandscape.length === 0) {
          output += `No items dated forward. Calendar surface is clear.\n\n`;
        } else {
          forwardLandscape.forEach((item, i) => {
            const dom = item.domain ? ` [${item.domain}]` : '';
            output += `${i + 1}. [${item.category}] ${item.key} — due ${item.due}${dom}\n`;
            output += `   ${item.summary}${item.summary.length >= 200 ? '...' : ''}\n`;
          });
          output += '\n';
        }

        // Active Episodes (v4.15.0: parseBundle output with .valid/.errors/.fields; degraded display on parse failure)
        output += '── ACTIVE EPISODES ──\n';
        if (activeEpisodes.length === 0) {
          output += 'No @handles found in recent now/state. Episode handles emerge from manual now/state filings.\n\n';
        } else {
          activeEpisodes.forEach((ep, i) => {
            output += (i + 1) + '. ' + ep.handle;
            if (ep.bundle) {
              if (ep.bundle.valid) {
                const memCount = ep.bundle.fields.members.length;
                const memNoun = memCount === 1 ? 'member' : 'members';
                output += ' [' + ep.bundle.fields.status + ', ' + memCount + ' ' + memNoun + ']\n';
                if (ep.bundle.fields.one_line) {
                  output += '   ' + ep.bundle.fields.one_line + '\n';
                }
              } else {
                output += ' [bundle found, parse degraded: ' + ep.bundle.errors.join(', ') + ']\n';
              }
            } else {
              output += ' (' + ep.mention_count + ' mention' + (ep.mention_count === 1 ? '' : 's') + ', no bundle filed)\n';
            }
          });
          output += '\n';
        }

        // Deferred Asks
        output += '── DEFERRED ASKS ──\n';
        if (deferredAsks.length === 0) {
          output += 'No deferred asks pending.\n\n';
        } else {
          deferredAsks.forEach((ask, i) => {
            const ageNote = ask.age_days != null ? ` (${ask.age_days}d old)` : '';
            const dueNote = ask.due_date ? ` [due ${ask.due_date}]` : '';
            output += `${i + 1}. ${ask.key}${ageNote}${dueNote}\n`;
            output += `   ${ask.summary}${ask.summary.length >= 200 ? '...' : ''}\n`;
          });
          output += '\n';
        }

        // Substrate Health
        output += '── SUBSTRATE HEALTH ──\n';
        if (substrateHealth) {
          if (substrateHealth.parse_error) {
            output += `⚠️ Heartbeat memory exists but did not parse: ${substrateHealth.parse_error}\n\n`;
          } else {
            const overallStatus = substrateHealth.overall_status || 'unknown';
            const heartbeatAgeNote = heartbeatAgeMin != null ? ` (heartbeat ${heartbeatAgeMin}min ago)` : '';
            output += `Overall: ${overallStatus}${heartbeatAgeNote}\n`;
            const svc = substrateHealth.services || {};
            if (svc.api) output += `  API: ${svc.api.status} (${svc.api.version || '?'})\n`;
            if (svc.database) output += `  Database: ${svc.database.status}\n`;
            if (svc.capture) {
              const ageMin = svc.capture.age_minutes;
              output += `  Capture: ${svc.capture.status}${ageMin != null ? ` (${ageMin}min since last event)` : ''}\n`;
            }
            if (svc.recall) {
              const ageMin = svc.recall.age_minutes;
              output += `  Recall: ${svc.recall.status}${ageMin != null ? ` (${ageMin}min since last write)` : ''}\n`;
            }
            if (svc.correction_resolver) {
              output += `  Correction resolver: ${svc.correction_resolver.status} (mode: ${svc.correction_resolver.mode})\n`;
            }
            if (substrateHealth.organism) {
              output += `  Organism phase 1: ${substrateHealth.organism.phase_1_status}, latest now/state: ${substrateHealth.organism.latest_now_state_key || '(none)'}\n`;
            }
            output += '\n';
          }
        } else {
          output += '⚠️ No heartbeat memory found. Substrate health is unknown. ' +
                    'Either the cron has not run yet or the heartbeat memory was deleted.\n\n';
        }

        output += `── PACKET GENERATED AT ${new Date().toISOString()} ──`;

        // Surface partial failures at the bottom so they don't get missed
        const errors = [];
        if (nowStateResult.status === 'rejected') errors.push('now_state query failed: ' + nowStateResult.reason.message);
        if (deferredAsksResult.status === 'rejected') errors.push('deferred_asks query failed: ' + deferredAsksResult.reason.message);
        if (healthResult.status === 'rejected') errors.push('health query failed: ' + healthResult.reason.message);
        if (upcomingResult.status === 'rejected') errors.push('upcoming query failed: ' + upcomingResult.reason.message);
        if (errors.length > 0) {
          output += '\n\n⚠️ PARTIAL FAILURES (some packet sections may be incomplete):\n' +
                    errors.map(e => '  - ' + e).join('\n');
        }

        resultText = output;
        triggerAutoStore(apiKey, name, `organism_wake_up days=${days}`, resultText);
        break;
      }

      case 'memory_store': {
        const { category, key, value, tags, source, relevantDate, domain, anchor } = args;
        const body = { category, key, value };
        if (tags) body.tags = tags;
        if (source) body.source = source;
        if (relevantDate) body.relevantDate = relevantDate;
        if (domain) body.domain = domain;
        if (anchor !== undefined) body.anchor = anchor;

        await apiCall(apiKey, 'POST', '/api/memory', body);

        let confirmation = 'Stored [' + category + '] ' + key;
        if (anchor && domain) confirmation += ' ⚓ (dormant, surfaces in ' + domain + ' context)';
        else if (relevantDate) confirmation += ' (relevant: ' + relevantDate + ')';

        triggerAutoStore(apiKey, name, key, value);
        resultText = confirmation;
        break;
      }

      case 'memory_delete': {
        const { category, key } = args;
        const endpoint = '/api/memory?category=' + encodeURIComponent(category) + '&key=' + encodeURIComponent(key);
        result = await apiCall(apiKey, 'DELETE', endpoint);
        resultText = result.deleted ? 'Deleted [' + category + '] ' + key : 'Memory not found: [' + category + '] ' + key;
        break;
      }

      case 'enrich': {
        result = await apiCall(apiKey, 'POST', '/api/enrich', { message: args.message });
        if (!result.enriched) {
          resultText = 'No relevant context found.';
        } else {
          resultText = result.contextBlock;
        }
        break;
      }

      case 'project_get': {
        result = await apiCall(apiKey, 'GET', '/api/projects');
        const project = result.projects?.find(p => p.name.toLowerCase() === args.name.toLowerCase());
        if (!project) {
          resultText = 'Project "' + args.name + '" not found.';
        } else {
          let output = 'Project: ' + project.name + '\n';
          output += 'Status: ' + (project.status || 'active') + '\n';
          if (project.description) output += 'Description: ' + project.description + '\n';
          if (project.basePath) output += 'Path: ' + project.basePath + '\n';
          resultText = output;
        }
        triggerAutoStore(apiKey, name, args.name, resultText);
        break;
      }

      case 'ingest': {
        const { content, source_type, source, speaker, session_id, turn_index, timestamp, client, metadata } = args;
        const body = { content, source_type };
        if (source !== undefined) body.source = source;
        if (speaker !== undefined) body.speaker = speaker;
        if (session_id !== undefined) body.session_id = session_id;
        if (turn_index !== undefined) body.turn_index = turn_index;
        if (timestamp !== undefined) body.timestamp = timestamp;
        if (client !== undefined) body.client = client;
        if (metadata !== undefined) body.metadata = metadata;

        result = await apiCall(apiKey, 'POST', '/api/ingest', body);

        const dupNote = result.duplicate ? ' [duplicate — already stored]' : '';
        const chunkNote = result.chunk_count > 1 ? ` (chunked into ${result.chunk_count})` : '';
        const embedNote = result.embedded ? '' : ' [embedding pending]';
        resultText = `Ingested ${result.object_id}${chunkNote}${dupNote}${embedNote}`;
        break;
      }

      default: {
        const duration_ms = Date.now() - start_hrtime;
        fireAutoCaptureEvent(apiKey, {
          type: 'tool_call_failed',
          call_id,
          parent_call_id: call_id,
          tool_name: name,
          error: 'Unknown tool: ' + name,
          duration_ms,
          timestamp: new Date().toISOString(),
          session_id: session.session_id,
          agent_id: session.agent_id,
          fingerprint,
        });
        return { content: [{ type: 'text', text: 'Unknown tool: ' + name }], isError: true };
      }
    }

    // v4.11.0 Rung 2: prepend NOW to every response except get_now
    if (name !== 'get_now') {
      try {
        const nowPrefix = await buildNowPrefix(apiKey);
        resultText = nowPrefix + resultText;
      } catch (tzError) {
        console.error('[NOW-PREFIX] failed to build prefix:', tzError.message);
      }
    }

    // Fire completion event (success path). Excluded for ingest to avoid recursion.
    if (name !== 'ingest') {
      fireAutoCaptureEvent(apiKey, {
        type: 'tool_call_completed',
        call_id,
        parent_call_id: call_id,
        tool_name: name,
        result_snippet: (resultText || '').slice(0, 2000),
        duration_ms: Date.now() - start_hrtime,
        timestamp: new Date().toISOString(),
        session_id: session.session_id,
        agent_id: session.agent_id,
        noisy,
        fingerprint,
      });
    }

    return { content: [{ type: 'text', text: resultText }] };

  } catch (error) {
    console.error('Tool error [' + name + ']:', error.message);

    if (name !== 'ingest') {
      fireAutoCaptureEvent(apiKey, {
        type: 'tool_call_failed',
        call_id,
        parent_call_id: call_id,
        tool_name: name,
        error: error.message,
        duration_ms: Date.now() - start_hrtime,
        timestamp: new Date().toISOString(),
        session_id: session.session_id,
        agent_id: session.agent_id,
        fingerprint,
      });
    }

    const degraded = degradedResponse(name, error.message);
    if (name !== 'get_now' && degraded.content?.[0]?.text) {
      try {
        const nowPrefix = await buildNowPrefix(apiKey);
        degraded.content[0].text = nowPrefix + degraded.content[0].text;
      } catch (tzError) {
        console.error('[NOW-PREFIX] failed to build prefix for error response:', tzError.message);
      }
    }
    return degraded;
  }
}

function createServer(apiKey) {
  const server = new Server(
    { name: 'stcky-cloud', version: VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleTool(apiKey, name, args || {});
  });

  return server;
}

app.get('/health', (req, res) => {
  const now = getNow();
  res.json({
    status: apiHealthy ? 'ok' : 'degraded',
    version: VERSION,
    tools: TOOLS.length,
    brain: 'ORGANISM WAKE-UP PACKET',
    now: now.short,
    timezone: now.timezone,
    apiHealthy,
    sessions: sessionCache.size,
  });
});

app.get('/sse', async (req, res) => {
  const apiKey = getApiKey(req);
  if (!apiKey) return res.status(401).json({ error: 'API key required' });

  const valid = await validateApiKey(apiKey);
  if (!valid) return res.status(401).json({ error: 'Invalid API key' });

  initSession(apiKey, getAgentIdentity(req));

  const server = createServer(apiKey);
  const transport = new SSEServerTransport('/messages', res);
  await server.connect(transport);
});

app.post('/messages', (req, res) => res.json({ ok: true }));

app.post('/mcp', async (req, res) => {
  const apiKey = getApiKey(req);
  if (!apiKey) return res.status(401).json({ error: 'unauthorized' });

  const valid = await validateApiKey(apiKey);
  if (!valid) return res.status(401).json({ error: 'invalid_api_key' });

  initSession(apiKey, getAgentIdentity(req));

  try {
    const server = createServer(apiKey);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    res.status(500).json({ error: 'internal_error', message: error.message });
  }
});

app.post('/sse', async (req, res) => {
  const apiKey = getApiKey(req);
  if (!apiKey) return res.status(401).json({ error: 'unauthorized' });

  const valid = await validateApiKey(apiKey);
  if (!valid) return res.status(401).json({ error: 'invalid_api_key' });

  initSession(apiKey, getAgentIdentity(req));

  try {
    const server = createServer(apiKey);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    res.status(500).json({ error: 'internal_error', message: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('STCKY MCP SSE v' + VERSION + ' — ORGANISM WAKE-UP PACKET — on port ' + PORT));

export default app;
