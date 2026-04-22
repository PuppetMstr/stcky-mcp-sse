/**
 * STCKY MCP SSE Server v4.9.0 — INGEST + AUTH HARDENING
 *
 * CHANGELOG v4.9.0:
 * - SECURITY: Validate API key against api.stcky.ai/api/me before opening SSE/MCP
 *   connection. Closes Apr 18 P0 bug where any non-empty string passed auth.
 *   Validation cached for 60s per key to avoid hammering the upstream API.
 * - ADDED: ingest — POST to /api/ingest for content-addressed immutable capture.
 *   This is the cross-platform primitive that makes auto-capture possible.
 * - CHANGED: Default API_URL fallback is now https://api.stcky.ai (canonical).
 *   STCKY_API_URL env var still overrides if set.
 *
 * CHANGELOG v4.8.0:
 * - ADDED: get_now — returns current time in user's timezone
 * - ADDED: set_timezone — update user's timezone preference
 *
 * CHANGELOG v4.7.0:
 * - ADDED: memory_delete — remove memories by category + key
 *
 * CORE TOOLS (8):
 * 1. get_now — current time awareness (CALL FIRST)
 * 2. associative_recall — semantic + temporal retrieval (PRIMARY)
 * 3. memory_store — save curated memories
 * 4. memory_delete — remove memories by category + key
 * 5. enrich — entity extraction + cluster activation
 * 6. project_get — project context
 * 7. set_timezone — update user's timezone
 * 8. ingest — content-addressed raw capture (auto-capture primitive, v4.9.0)
 */
import express from 'express';
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
const VERSION = '4.9.0';
const DEFAULT_TIMEZONE = 'UTC';

// Cache user timezones per API key (session-level)
const timezoneCache = new Map();

// Cache validated API keys. Map<apiKey, { valid: boolean, expiresAt: number }>.
// 60s TTL — short enough that revoked keys are locked out quickly, long enough
// to keep per-request overhead off the hot path.
const authCache = new Map();
const AUTH_CACHE_TTL_MS = 60_000;

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

/**
 * Validate an API key by calling api.stcky.ai/api/me.
 * Returns true if the upstream returns 200 (key is valid), false otherwise.
 * Cached for 60s per key.
 */
async function validateApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 8) return false;

  const cached = authCache.get(apiKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.valid;
  }

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
    // On network failure we deliberately fail-closed. Better a false negative
    // (user retries) than a false positive (unauth'd connection).
    valid = false;
  }

  authCache.set(apiKey, { valid, expiresAt: now + AUTH_CACHE_TTL_MS });

  // Opportunistic cache cleanup so the Map doesn't grow unbounded in long-running processes.
  if (authCache.size > 1000) {
    for (const [k, v] of authCache.entries()) {
      if (v.expiresAt <= now) authCache.delete(k);
    }
  }

  return valid;
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
  if (timezoneCache.has(apiKey)) {
    return timezoneCache.get(apiKey);
  }

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
      timeZone: timezone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    };

    const formatted = now.toLocaleString('en-US', options);

    const shortOptions = {
      timeZone: timezone,
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    };
    const short = now.toLocaleString('en-US', shortOptions);

    const tzOffset = now.toLocaleString('en-US', { timeZone: timezone, timeZoneName: 'short' }).split(' ').pop();

    return {
      iso: now.toISOString(),
      formatted,
      short,
      timezone,
      tzOffset,
      unix: now.getTime()
    };
  } catch (e) {
    console.error('[TIMEZONE] Invalid timezone:', timezone, '- falling back to UTC');
    return getNow(DEFAULT_TIMEZONE);
  }
}

// =============================================================================
// AUTO-STORE ENFORCEMENT
// =============================================================================
async function triggerAutoStore(apiKey, toolName, toolInput, toolResult) {
  // Skip tools that don't produce memory-worthy content, and skip ingest itself
  // (it's already the auto-capture primitive — routing its own calls back through
  // enrich would create a feedback loop).
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
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'associative_recall',
    description: 'PRIMARY RECALL MECHANISM. Semantic search with temporal NOW scoring — vector similarity + recency + urgency combined. Memories closer to NOW score higher.',
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
      properties: {
        message: { type: 'string', description: 'The message to analyze' }
      },
      required: ['message']
    }
  },
  {
    name: 'project_get',
    description: 'Get full details for a specific project by name.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name' }
      },
      required: ['name']
    }
  },
  {
    name: 'set_timezone',
    description: 'Update user\'s timezone preference. Use IANA timezone names (e.g., America/Los_Angeles, Europe/London, Asia/Tokyo).',
    inputSchema: {
      type: 'object',
      properties: {
        timezone: { type: 'string', description: 'IANA timezone name' }
      },
      required: ['timezone']
    }
  },
  {
    name: 'ingest',
    description: 'Capture raw content into content-addressed immutable storage. This is the auto-capture primitive — call at the end of every substantive conversation turn with a concatenation of the user message, assistant response, and brief tool summary. One object per turn. Same content posted twice is deduplicated (idempotent via SHA-256). Unlike memory_store, ingest does not require curation — it is the raw ledger.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Raw content to store. Required, non-empty.' },
        source_type: { type: 'string', description: 'Content classification: conversation | document | email | audio_transcript | file_upload | extracted_statement' },
        source: { type: 'string', description: 'Optional. provider.interface.conversation_id format, e.g. "claude.web.stcky-build-2026-04-22"' },
        speaker: { type: 'string', description: 'Optional. Who authored the turn: "steven", "claude", "chaos", etc.' },
        session_id: { type: 'string', description: 'Optional. Session identifier for grouping related turns.' },
        turn_index: { type: 'number', description: 'Optional. Incrementing integer within a session, starting at 1.' },
        timestamp: { type: 'string', description: 'Optional ISO timestamp for when the content was authored. Defaults to server now.' },
        client: { type: 'string', description: 'Optional interface tag: "web" | "ios" | "ipad" | "desktop" | "api"' },
        metadata: { type: 'object', description: 'Optional free-form metadata. Stored but not indexed in v0.1.' }
      },
      required: ['content', 'source_type']
    }
  }
];

// =============================================================================
// TOOL HANDLERS
// =============================================================================
async function handleTool(apiKey, name, args) {
  checkApiHealth(apiKey);

  try {
    let result;
    let resultText;

    switch (name) {
      case 'get_now': {
        const timezone = await getUserTimezone(apiKey);
        const now = getNow(timezone);
        resultText = `NOW: ${now.formatted}\nTimezone: ${now.timezone} (${now.tzOffset})\nISO: ${now.iso}`;
        return { content: [{ type: 'text', text: resultText }] };
      }

      case 'set_timezone': {
        const { timezone } = args;

        try {
          Intl.DateTimeFormat(undefined, { timeZone: timezone });
        } catch (e) {
          return { content: [{ type: 'text', text: 'Invalid timezone: ' + timezone + '. Use IANA format (e.g., America/Los_Angeles)' }] };
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

        return { content: [{ type: 'text', text: resultText }] };
      }

      case 'associative_recall': {
        const query = args.query;
        const limit = args.limit || 10;
        const timezone = await getUserTimezone(apiKey);
        const now = getNow(timezone);

        result = await apiCall(apiKey, 'POST', '/api/associative', { query, limit });

        let output = `NOW: ${now.short} (${now.timezone})\n\n`;

        if (!result.memories || result.memories.length === 0) {
          resultText = output + 'No related memories found.';
        } else {
          output += result.memories.length + ' related memories:\n\n';
          result.memories.forEach((m, i) => {
            const ts = formatTimestamp(m.updatedAt || m.createdAt);
            const rd = m.relevantDate ? ' [due: ' + new Date(m.relevantDate).toLocaleDateString() + ']' : '';
            const anchor = m.anchor ? ' ⚓' : '';
            const domain = m.domain ? ' [' + m.domain + ']' : '';
            output += (i + 1) + '. [' + m.category + '] ' + m.key + (ts ? ' (' + ts + ')' : '') + rd + domain + anchor + '\n';
            output += '   ' + m.value + '\n\n';
          });
          resultText = output;
        }

        triggerAutoStore(apiKey, name, args.query, resultText);
        return { content: [{ type: 'text', text: resultText }] };
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
        return { content: [{ type: 'text', text: confirmation }] };
      }

      case 'memory_delete': {
        const { category, key } = args;
        const endpoint = '/api/memory?category=' + encodeURIComponent(category) + '&key=' + encodeURIComponent(key);
        result = await apiCall(apiKey, 'DELETE', endpoint);
        resultText = result.deleted ? 'Deleted [' + category + '] ' + key : 'Memory not found: [' + category + '] ' + key;
        return { content: [{ type: 'text', text: resultText }] };
      }

      case 'enrich': {
        result = await apiCall(apiKey, 'POST', '/api/enrich', { message: args.message });
        if (!result.enriched) {
          return { content: [{ type: 'text', text: 'No relevant context found.' }] };
        }
        return { content: [{ type: 'text', text: result.contextBlock }] };
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
        return { content: [{ type: 'text', text: resultText }] };
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

        // Do NOT call triggerAutoStore on ingest (skipped internally).
        return { content: [{ type: 'text', text: resultText }] };
      }

      default:
        return { content: [{ type: 'text', text: 'Unknown tool: ' + name }], isError: true };
    }
  } catch (error) {
    console.error('Tool error [' + name + ']:', error.message);
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
    brain: 'INGEST + AUTH HARDENING',
    now: now.short,
    timezone: now.timezone,
    apiHealthy
  });
});

// GET /sse — SSE connection entrypoint. v4.9.0: validates key before opening stream.
app.get('/sse', async (req, res) => {
  const apiKey = getApiKey(req);
  if (!apiKey) return res.status(401).json({ error: 'API key required' });

  const valid = await validateApiKey(apiKey);
  if (!valid) return res.status(401).json({ error: 'Invalid API key' });

  const server = createServer(apiKey);
  const transport = new SSEServerTransport('/messages', res);
  await server.connect(transport);
});

app.post('/messages', (req, res) => res.json({ ok: true }));

// POST /mcp — Streamable HTTP entrypoint. v4.9.0: validates key before creating transport.
app.post('/mcp', async (req, res) => {
  const apiKey = getApiKey(req);
  if (!apiKey) return res.status(401).json({ error: 'unauthorized' });

  const valid = await validateApiKey(apiKey);
  if (!valid) return res.status(401).json({ error: 'invalid_api_key' });

  try {
    const server = createServer(apiKey);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    res.status(500).json({ error: 'internal_error', message: error.message });
  }
});

// POST /sse — alternate Streamable HTTP entrypoint. v4.9.0: validates key.
app.post('/sse', async (req, res) => {
  const apiKey = getApiKey(req);
  if (!apiKey) return res.status(401).json({ error: 'unauthorized' });

  const valid = await validateApiKey(apiKey);
  if (!valid) return res.status(401).json({ error: 'invalid_api_key' });

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
app.listen(PORT, () => console.log('STCKY MCP SSE v' + VERSION + ' — INGEST + AUTH HARDENING — on port ' + PORT));

export default app;
