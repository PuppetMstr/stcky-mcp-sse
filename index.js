/**
 * STCKY MCP SSE Server v4.23.0 — ONE DOOR IN, ONE DOOR OUT (NAMED)
 *
 * CHANGELOG v4.23.0:
 * - RENAMED: associative_recall → search. The OUT door now matches the
 *   name Chaos's federation Action uses. One protocol, both surfaces.
 *   Per May 8 canon: "ideally there'll only be one thing you need to be
 *   able to do." That door is search.
 * - DEFAULT BEHAVIOR CHANGED: search with no query → NOW-anchored corpus
 *   read. Fans out to /api/memory/recent + /api/objects/recent in parallel,
 *   merges time-descending. No semantic ranker. The "look closest to NOW"
 *   move is the default; ranker is opt-in.
 * - QUERY NOW OPTIONAL: with query, search calls /api/associative as
 *   before (semantic + temporal scoring). Without query, structural
 *   recent-corpus pull. Same tool, two modes.
 * - RATIONALE: associative_recall's semantic-first default kept biasing
 *   reads toward what's similar-to-keywords over what's closest-to-NOW.
 *   The trip kept happening. Renaming is half the fix; redefaulting is
 *   the other half. Both ship together so the new name forces the new
 *   habit instead of muscle-memory carrying old behavior.
 * - PARAMETERS: query (optional), hours (default 24), limit (default 30),
 *   include ('both' | 'curated' | 'raw', default 'both').
 * - PRESERVED: get_now description still mentions associative_recall as
 *   well — kept for one cycle in case any external client still calls
 *   the old name. Will deprecate next version.
 *
 * CHANGELOG v4.22.0:
 * - REMOVED: organism_wake_up tool case (~180 lines of slice-machinery
 *   dead code) from handleTool. The tool was unregistered from TOOLS in
 *   v4.21.1 but the case branch lingered. Deleted now.
 * - REMOVED: triggerAutoStore function and all call sites. Was no-op'd
 *   in v4.21.0; deletion completes the cleanup.
 * - REMOVED: organism_wake_up from READ_ONLY_TOOLS skip set and from
 *   degradedResponse messages map (tool no longer reachable).
 * - FIXED: /health endpoint missing comma after brain field (would have
 *   broken the server on next restart).
 * - LABEL: brain string now reads "one door in, one door out" — Steven's
 *   May 8 verbatim canon. Startup log matches.
 *
 * CHANGELOG v4.21.1:
 * - REMOVED: organism_wake_up tool registration from TOOLS array.
 *   Wake-up is now search of recent NOW, not a packet fetch. Both Eli
 *   and Chaos open sessions by searching the blob; no per-vendor packet
 *   tool needed.
 *
 * CHANGELOG v4.21.0:
 * - DROPPED: read-side auto-capture. fireAutoCaptureEvent now skips
 *   ingest, get_now, associative_recall, upcoming, enrich, project_get.
 *   Reads are not substrate. Per May 8 vision: blob holds what goes IN;
 *   reads are ephemeral.
 * - DISABLED: triggerAutoStore (legacy curated capture path) — no-op'd
 *   to avoid duplicating raw capture. (Deleted entirely in v4.22.0.)
 *
 * CHANGELOG v4.20.0:
 * - ADDED: RECENT RAW slice in organism_wake_up packet. (Removed in v4.22.0.)
 *
 * CHANGELOG v4.18.0:
 * - REPLACED: CURRENT STATE slice → RECENT SUBSTRATE slice. (Removed in v4.22.0.)
 *
 * CHANGELOG v4.17.0:
 * - ADDED: RECENT ARCHITECT-RESPONSES slice. (Removed in v4.22.0.)
 *
 * CHANGELOG v4.16.0:
 * - ADDED: identity_anchor slice. (Removed in v4.22.0.)
 *
 * CHANGELOG v4.13.0:
 * - ADDED: organism_wake_up tool. (Removed in v4.21.1/v4.22.0.)
 *
 * CHANGELOG v4.12.0:
 * - ADDED: upcoming tool.
 *
 * CHANGELOG v4.11.0:
 * - ADDED: NOW prefix on every tool response except get_now.
 *
 * CHANGELOG v4.10.0:
 * - ADDED: transparent auto-capture of all tool calls at the MCP layer.
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
 * CORE TOOLS (9):
 * 1. get_now — DEPRECATED; time now in every response
 * 2. search — NOW-anchored corpus by default; semantic mode with query (the read door)
 * 3. upcoming — date-shaped forward sweep
 * 4. memory_store — save curated memories
 * 5. memory_delete — remove memories by category + key
 * 6. enrich — entity extraction + cluster activation
 * 7. project_get — project context
 * 8. set_timezone — update user's timezone
 * 9. ingest — content-addressed raw capture (the write door)
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
const VERSION = '4.23.0';
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
// TRANSPARENT AUTO-CAPTURE — v4.10.0 (Rung 1), v4.21.0 read-side dropped
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
  // Reads are not substrate. Only writes and metadata-changing operations
  // become tool_event records. Per May 8 vision: blob holds what goes IN
  // through ingest; reads through search are ephemeral.
  const READ_ONLY_TOOLS = new Set([
    'ingest',              // recursion guard
    'get_now',             // deprecated, pure read
    'search',              // primary read path - ephemeral
    'upcoming',            // forward sweep read - ephemeral
    'enrich',              // entity extraction read - ephemeral
    'project_get',         // project lookup read - ephemeral
  ]);
  if (READ_ONLY_TOOLS.has(evt.tool_name)) return;

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

function degradedResponse(toolName, error) {
  const messages = {
    search: '⚠️ Memory service temporarily unavailable. Error: ' + error,
    upcoming: '⚠️ Upcoming-items lookup unavailable. Error: ' + error,
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
    description: 'DEPRECATED as of v4.11.0 — every tool response now carries NOW time automatically. Kept for backward compatibility. Prefer calling search or any other tool instead; time comes free with every response.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'search',
    description: 'PRIMARY READ DOOR. Two modes, one tool. WITHOUT query: NOW-anchored corpus read — fans out to /api/memory/recent (curated) and /api/objects/recent (raw conversation turns + tool events) in parallel, merges time-descending. This is the default and the one to reach for first when you want to see what is closest to NOW. WITH query: semantic + temporal scoring (vector similarity + recency + urgency) via /api/associative — opt in only when you need targeted by-name lookup. Returns memories and raw objects together, time-descending in corpus mode, ranked in semantic mode. Response includes current time at the top.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional natural language query. Omit for NOW-anchored corpus read; include only for targeted semantic lookup.' },
        hours: { type: 'number', description: 'Corpus mode only: window backward from NOW in hours (default 24)' },
        limit: { type: 'number', description: 'Max results total (default 30 in corpus mode, 10 in semantic mode)' },
        include: { type: 'string', description: "Corpus mode only: 'both' (default), 'curated', or 'raw'" }
      },
      required: []
    }
  },
  {
    name: 'upcoming',
    description: 'DATE-SHAPED FORWARD SWEEP. Returns memories with relevantDate from NOW forward, sorted by date ascending, regardless of category — appointments, deadlines, hearings, calls, scheduled events, anything with a future date. Defaults: days=30, limit=20.',
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
    description: 'Capture raw content into content-addressed immutable storage. As of v4.21.0, the MCP server auto-captures only writes (memory_store, memory_delete, set_timezone) as tool_events; reads are ephemeral. Manual ingest is for conversation turns and other content that does not pass through MCP. Response includes current time.',
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

  // Rung 1: transparent auto-capture (writes only, per v4.21.0).
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

      case 'search': {
        const query = (args && typeof args.query === 'string' && args.query.trim()) ? args.query.trim() : null;

        // ────────────────────────────────────────────────────────────────
        // SEMANTIC MODE — query present. Existing /api/associative path.
        // ────────────────────────────────────────────────────────────────
        if (query) {
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
          break;
        }

        // ────────────────────────────────────────────────────────────────
        // CORPUS MODE — no query. NOW-anchored, time-descending, structural.
        // Fans out to /api/memory/recent + /api/objects/recent in parallel.
        // ────────────────────────────────────────────────────────────────
        const hours = (args && typeof args.hours === 'number' && args.hours > 0) ? args.hours : 24;
        const totalLimit = (args && typeof args.limit === 'number' && args.limit > 0) ? args.limit : 30;
        const include = (args && typeof args.include === 'string') ? args.include : 'both';
        const wantCurated = (include === 'both' || include === 'curated');
        const wantRaw     = (include === 'both' || include === 'raw');

        // Per-side fetch caps — overshoot a bit, then trim by total limit after merge.
        const perSideLimit = Math.min(totalLimit + 10, 100);

        const memoryEndpoint  = '/api/memory/recent?hours='   + encodeURIComponent(hours) + '&limit=' + encodeURIComponent(perSideLimit);
        const objectsEndpoint = '/api/objects/recent?windowHours=' + encodeURIComponent(hours) + '&limit=' + encodeURIComponent(perSideLimit);

        const [memResult, objResult] = await Promise.allSettled([
          wantCurated ? apiCall(apiKey, 'GET', memoryEndpoint)  : Promise.resolve({ memories: [] }),
          wantRaw     ? apiCall(apiKey, 'GET', objectsEndpoint) : Promise.resolve({ objects:  [] }),
        ]);

        const memErr = (memResult.status === 'rejected') ? String(memResult.reason && memResult.reason.message || memResult.reason) : null;
        const objErr = (objResult.status === 'rejected') ? String(objResult.reason && objResult.reason.message || objResult.reason) : null;
        const memories = (memResult.status === 'fulfilled' && memResult.value && Array.isArray(memResult.value.memories)) ? memResult.value.memories : [];
        const objects  = (objResult.status === 'fulfilled' && objResult.value && Array.isArray(objResult.value.objects )) ? objResult.value.objects  : [];

        // Merge into a unified time-descending list. Each item carries its own layer tag.
        const items = [];
        memories.forEach(m => {
          const t = m.updatedAt || m.createdAt;
          items.push({ layer: 'curated', ts: t, sortKey: new Date(t || 0).getTime(), data: m });
        });
        objects.forEach(o => {
          const t = o.ingested_at || o.timestamp;
          items.push({ layer: 'raw', ts: t, sortKey: new Date(t || 0).getTime(), data: o });
        });
        items.sort((a, b) => b.sortKey - a.sortKey);
        const trimmed = items.slice(0, totalLimit);

        if (trimmed.length === 0) {
          let msg = 'No substrate activity in the last ' + hours + 'h';
          if (memErr || objErr) {
            msg += ' (note: ';
            if (memErr) msg += 'curated fetch failed: ' + memErr + (objErr ? '; ' : '');
            if (objErr) msg += 'raw fetch failed: ' + objErr;
            msg += ')';
          }
          msg += '.';
          resultText = msg;
        } else {
          let output = 'RECENT SUBSTRATE — last ' + hours + 'h, ' + trimmed.length + ' item' + (trimmed.length === 1 ? '' : 's') + ', time-descending';
          if (include !== 'both') output += ' (' + include + ' only)';
          output += ':\n\n';

          trimmed.forEach((it, i) => {
            const ts = formatTimestamp(it.ts);
            if (it.layer === 'curated') {
              const m = it.data;
              const rd = m.relevantDate ? ' [due: ' + new Date(m.relevantDate).toLocaleDateString() + ']' : '';
              const anchor = m.anchor ? ' ⚓' : '';
              const domain = m.domain ? ' [' + m.domain + ']' : '';
              output += (i + 1) + '. [curated:' + m.category + '] ' + m.key + (ts ? ' (' + ts + ')' : '') + rd + domain + anchor + '\n';
              const snippet = (m.value || '').slice(0, 500);
              output += '   ' + snippet + (m.value && m.value.length > 500 ? '...' : '') + '\n\n';
            } else {
              const o = it.data;
              const src = o.source ? ' [' + o.source + ']' : '';
              const spk = o.speaker ? ' (' + o.speaker + ')' : '';
              const turn = (o.turn_index !== null && o.turn_index !== undefined) ? ' turn ' + o.turn_index : '';
              output += (i + 1) + '. [raw:' + (o.source_type || 'object') + ']' + src + spk + turn + (ts ? ' (' + ts + ')' : '') + '\n';
              const content = o.content || o.content_snippet || '';
              const snippet = content.slice(0, 500);
              output += '   ' + snippet + (content.length > 500 ? '...' : '') + '\n\n';
            }
          });

          if (memErr || objErr) {
            output += '⚠️ Partial result — ';
            if (memErr) output += 'curated fetch failed: ' + memErr;
            if (memErr && objErr) output += '; ';
            if (objErr) output += 'raw fetch failed: ' + objErr;
            output += '\n';
          }

          resultText = output;
        }
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
    brain: 'one door in, one door out',
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
app.listen(PORT, () => console.log('STCKY MCP SSE v' + VERSION + ' — one door in, one door out — on port ' + PORT));

export default app;