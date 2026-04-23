/**
 * STCKY MCP SSE Server v4.10.0 — RUNG 1 TRANSPARENT AUTO-CAPTURE
 *
 * CHANGELOG v4.10.0:
 * - ADDED: transparent auto-capture of all tool calls at the MCP layer. Every
 *   tool invocation fires a start event + completion event (or failure event)
 *   to /api/ingest, linked by call_id, fire-and-forget. Claude no longer has
 *   to consciously call ingest for tool interactions; the substrate sees them
 *   automatically. This is Rung 1 of Chaos's blob-substrate transition ladder.
 * - ADDED: session_id per MCP connection. Generated at connection open,
 *   keyed by apiKey in sessionCache. Resets on reconnect.
 * - ADDED: X-Agent-Identity header support at connection open. Clients may
 *   identify themselves (e.g. "claude-opus-4.7", "claude-ipad",
 *   "chatgpt-gpt-stcky-memory"). Unknown clients tagged "claude-unknown".
 * - ADDED: event fingerprint (sha256 prefix of tool+normalized-args) for
 *   dedupe analytics without collapsing repeated real actions.
 * - NOTE: 'ingest' tool itself is excluded from auto-capture (avoids recursion).
 * - NOTE: get_now is captured but flagged noisy=true so retrieval can
 *   downrank activity-heartbeat events by default.
 *
 * CHANGELOG v4.9.1:
 * - FIX: associative_recall now surfaces objects collection alongside memories.
 *
 * CHANGELOG v4.9.0:
 * - SECURITY: Validate API key against api.stcky.ai/api/me before opening SSE/MCP
 *   connection. Closes Apr 18 P0 bug.
 * - ADDED: ingest — POST to /api/ingest for content-addressed immutable capture.
 * - CHANGED: Default API_URL fallback is now https://api.stcky.ai (canonical).
 *
 * CHANGELOG v4.8.0:
 * - ADDED: get_now, set_timezone
 *
 * CHANGELOG v4.7.0:
 * - ADDED: memory_delete
 *
 * CORE TOOLS (8):
 * 1. get_now — current time awareness
 * 2. associative_recall — semantic + temporal retrieval (PRIMARY)
 * 3. memory_store — save curated memories
 * 4. memory_delete — remove memories by category + key
 * 5. enrich — entity extraction + cluster activation
 * 6. project_get — project context
 * 7. set_timezone — update user's timezone
 * 8. ingest — content-addressed raw capture (autonomic at MCP layer as of v4.10.0)
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
const VERSION = '4.10.0';
const DEFAULT_TIMEZONE = 'UTC';

// Cache user timezones per API key (session-level)
const timezoneCache = new Map();

// Cache validated API keys. 60s TTL.
const authCache = new Map();
const AUTH_CACHE_TTL_MS = 60_000;

// Session cache: apiKey → { session_id, opened_at, agent_id }.
// Populated at connection open (GET /sse, POST /mcp, POST /sse).
// Used by handleTool to tag auto-capture events with session + agent identity.
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
  // Case-insensitive header lookup. Express lowercases by default, but be safe.
  return req.headers['x-agent-identity']
      || req.headers['X-Agent-Identity']
      || null;
}

/**
 * Validate an API key by calling api.stcky.ai/api/me.
 */
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

/**
 * Initialize or refresh a session entry for a connection. Called at connection
 * open by each entrypoint. Replaces any prior session under the same apiKey
 * (last-connection-wins for multi-client scenarios — acceptable for v0.1).
 */
function initSession(apiKey, agentIdentity) {
  const session_id = 'mcp-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
  sessionCache.set(apiKey, {
    session_id,
    opened_at: new Date().toISOString(),
    agent_id: agentIdentity || 'claude-unknown',
  });
  return session_id;
}

function getSession(apiKey) {
  return sessionCache.get(apiKey) || {
    session_id: null,
    opened_at: null,
    agent_id: 'claude-unknown',
  };
}

function formatTimestamp(isoString) {
  if (!isoString) return null;
  const date = new Date(isoString);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return months[date.getMonth()] + ' ' + date.getDate();
}

// =============================================================================
// TEMPORAL AWARENESS — v4.8.0
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

// =============================================================================
// TRANSPARENT AUTO-CAPTURE — v4.10.0 (Rung 1)
// =============================================================================

/**
 * Deterministic fingerprint: sha256 of tool_name + normalized JSON args.
 * Same tool + same args = same fingerprint regardless of call_id.
 * Lets retrieval collapse obvious duplicates for analytics without losing
 * the underlying distinct call_ids (which preserve real repeated behavior).
 */
function computeFingerprint(toolName, args) {
  const sortedKeys = args ? Object.keys(args).sort() : [];
  const normalized = JSON.stringify(args || {}, sortedKeys);
  return crypto.createHash('sha256').update(toolName + '|' + normalized).digest('hex').slice(0, 16);
}

/**
 * Render an auto-capture event as human-readable text for semantic search.
 * Machine-readable structured data goes in metadata; this is what embedding
 * sees, so it should be descriptive.
 */
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

/**
 * Fire-and-forget auto-capture. Never blocks the tool call. Failures log
 * but do not propagate to the caller.
 */
function fireAutoCaptureEvent(apiKey, evt) {
  // Recursion guard — never auto-capture an ingest call.
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

  // Intentionally not awaited. Failures logged, never thrown.
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
    description: 'Get current time in user\'s timezone. Call this to know what time it is NOW. Essential for temporal awareness.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'associative_recall',
    description: 'PRIMARY RECALL MECHANISM. Semantic search with temporal NOW scoring — vector similarity + recency + urgency combined. Memories closer to NOW score higher. Returns both curated memories and raw ingested objects (conversation turns, documents, tool events).',
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
    name: 'memory_store',
    description: 'Save a curated fact to persistent memory (memories collection). For raw turn-by-turn capture, use "ingest" instead. Include relevantDate for time-sensitive memories. Use domain + anchor=true for dormant facts.',
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
    description: 'Delete a memory by category and key.',
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
    description: 'Extract entities and retrieve relevant memory clusters. Detects domain context and surfaces dormant anchors.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'The message to analyze' } },
      required: ['message']
    }
  },
  {
    name: 'project_get',
    description: 'Get full details for a specific project by name.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Project name' } },
      required: ['name']
    }
  },
  {
    name: 'set_timezone',
    description: 'Update user\'s timezone preference. Use IANA timezone names (e.g., America/Los_Angeles).',
    inputSchema: {
      type: 'object',
      properties: { timezone: { type: 'string', description: 'IANA timezone name' } },
      required: ['timezone']
    }
  },
  {
    name: 'ingest',
    description: 'Capture raw content into content-addressed immutable storage. As of v4.10.0, the MCP server ALSO auto-captures every tool call as a tool_event — manual ingest is still available for conversation turns (user utterance + assistant response) which do not pass through MCP, but it is no longer required for tool activity.',
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
// TOOL HANDLERS (with transparent auto-capture wrapper)
// =============================================================================
async function handleTool(apiKey, name, args) {
  checkApiHealth(apiKey);

  // Rung 1: transparent auto-capture. Generate call_id, fire start event.
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
        const timezone = await getUserTimezone(apiKey);
        const now = getNow(timezone);

        result = await apiCall(apiKey, 'POST', '/api/associative', { query, limit });

        let output = `NOW: ${now.short} (${now.timezone})\n\n`;

        const hasMemories = result.memories && result.memories.length > 0;
        const hasObjects  = result.objects  && result.objects.length  > 0;

        if (!hasMemories && !hasObjects) {
          resultText = output + 'No related memories or objects found.';
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
        // NOTE: ingest is excluded from auto-capture above to prevent recursion.
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

    return degradedResponse(name, error.message);
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
    brain: 'RUNG 1 TRANSPARENT AUTO-CAPTURE',
    now: now.short,
    timezone: now.timezone,
    apiHealthy,
    sessions: sessionCache.size,
  });
});

// GET /sse — SSE entrypoint. Seeds sessionCache + captures agent identity.
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
app.listen(PORT, () => console.log('STCKY MCP SSE v' + VERSION + ' — RUNG 1 TRANSPARENT AUTO-CAPTURE — on port ' + PORT));

export default app;
