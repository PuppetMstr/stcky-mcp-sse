/**
 * STCKY MCP SSE Server v4.4.0 - RESILIENT CORE
 * 
 * CHANGELOG v4.4.0:
 * - Graceful degradation: API failures return degraded response, not crash
 * - Deep health check integration
 * - AI can continue without memory when backend is down
 * 
 * CORE TOOLS:
 * 1. associative_recall — semantic + temporal retrieval (PRIMARY)
 * 2. memory_store — save memories
 * 3. enrich — entity extraction + cluster activation
 * 4. project_get — project context (if needed)
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

const API_URL = process.env.STCKY_API_URL || 'https://cleo-api.vercel.app';
const VERSION = '4.4.0';

// Track API health state
let apiHealthy = true;
let lastHealthCheck = 0;
const HEALTH_CHECK_INTERVAL = 60000; // 1 minute

function getApiKey(req) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return req.query.apiKey || req.query.api_key;
}

function formatTimestamp(isoString) {
  if (!isoString) return null;
  const date = new Date(isoString);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return months[date.getMonth()] + ' ' + date.getDate();
}

// Degraded response when API is down
function degradedResponse(toolName, error) {
  const messages = {
    associative_recall: '⚠️ Memory service temporarily unavailable. I can still help, but I won\'t have access to our conversation history right now. The error was: ' + error,
    memory_store: '⚠️ Unable to save to memory right now. I\'ll continue without storing this. Error: ' + error,
    enrich: '⚠️ Context enrichment unavailable. Proceeding without additional context.',
    project_get: '⚠️ Project lookup unavailable. Please provide project details directly.'
  };
  return {
    content: [{ 
      type: 'text', 
      text: messages[toolName] || '⚠️ Memory service temporarily unavailable. Error: ' + error
    }],
    isError: false  // NOT marking as error — let AI continue gracefully
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
      // Track unhealthy state
      if (response.status >= 500) {
        apiHealthy = false;
      }
      throw new Error('API error ' + response.status + ': ' + errorText.slice(0, 100));
    }
    
    apiHealthy = true;
    return response.json();
  } catch (error) {
    // Network errors, timeouts, etc.
    apiHealthy = false;
    throw error;
  }
}

// Background health check
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
    name: 'associative_recall',
    description: 'PRIMARY RECALL MECHANISM. Use this first, always. Semantic search with temporal NOW scoring — vector similarity + recency + urgency combined. Memories closer to NOW score higher. Use for startup context, discovery, and any question about what is relevant. All other recall tools serve this one.',
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
    description: 'Save a fact to persistent memory. Include relevantDate (ISO string) for time-sensitive memories. Well-tagged memories with relevantDate surface correctly in associative_recall.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Category' },
        key: { type: 'string', description: 'Short identifier' },
        value: { type: 'string', description: 'Content to remember' },
        tags: { type: 'string', description: 'Optional tags' },
        source: { type: 'string', description: 'Optional source' },
        relevantDate: { type: 'string', description: 'ISO date string for when this memory becomes relevant' }
      },
      required: ['category', 'key', 'value']
    }
  },
  {
    name: 'enrich',
    description: 'Extract entities from a message and retrieve relevant memory clusters. Call on messages with proper nouns or project names to feed associative_recall with targeted context.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The user message to analyze' }
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
  }
];

// =============================================================================
// TOOL HANDLERS — with graceful degradation
// =============================================================================
async function handleTool(apiKey, name, args) {
  // Background health check
  checkApiHealth(apiKey);
  
  try {
    switch (name) {
      case 'associative_recall': {
        const query = args.query;
        const limit = args.limit || 10;
        const result = await apiCall(apiKey, 'POST', '/api/associative', { query, limit });
        if (!result.memories || result.memories.length === 0) {
          return { content: [{ type: 'text', text: 'No related memories found.' }] };
        }
        let output = result.memories.length + ' related memories:\n\n';
        result.memories.forEach((m, i) => {
          const ts = formatTimestamp(m.updatedAt || m.createdAt);
          const rd = m.relevantDate ? ' [due: ' + new Date(m.relevantDate).toLocaleDateString() + ']' : '';
          output += (i + 1) + '. [' + m.category + '] ' + m.key + (ts ? ' (' + ts + ')' : '') + rd + '\n';
          output += '   ' + m.value + '\n\n';
        });
        return { content: [{ type: 'text', text: output }] };
      }

      case 'memory_store': {
        const { category, key, value, tags, source, relevantDate } = args;
        const body = { category, key, value };
        if (tags) body.tags = tags;
        if (source) body.source = source;
        if (relevantDate) body.relevantDate = relevantDate;
        await apiCall(apiKey, 'POST', '/api/memory', body);
        return { content: [{ type: 'text', text: 'Stored [' + category + '] ' + key + (relevantDate ? ' (relevant: ' + relevantDate + ')' : '') }] };
      }

      case 'enrich': {
        const result = await apiCall(apiKey, 'POST', '/api/enrich', { message: args.message });
        if (!result.enriched) {
          return { content: [{ type: 'text', text: 'No relevant context found for: ' + result.entities.join(', ') }] };
        }
        return { content: [{ type: 'text', text: result.contextBlock }] };
      }

      case 'project_get': {
        const result = await apiCall(apiKey, 'GET', '/api/project/' + encodeURIComponent(args.name));
        if (!result.project) {
          return { content: [{ type: 'text', text: 'Project not found.' }] };
        }
        const p = result.project;
        let output = 'Project: ' + p.name + '\nStatus: ' + (p.status || 'active') + '\n';
        if (p.description) output += 'Description: ' + p.description + '\n';
        if (p.basePath) output += 'Path: ' + p.basePath + '\n';
        return { content: [{ type: 'text', text: output }] };
      }

      default:
        return { content: [{ type: 'text', text: 'Unknown tool: ' + name }], isError: true };
    }
  } catch (error) {
    // GRACEFUL DEGRADATION — don't crash, inform and continue
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

// Health check — now shows API health status
app.get('/health', (req, res) => {
  res.json({ 
    status: apiHealthy ? 'ok' : 'degraded',
    version: VERSION, 
    tools: 4, 
    brain: 'RESILIENT CORE',
    apiHealthy,
    note: apiHealthy ? 'All systems operational' : 'API degraded — graceful fallback active'
  });
});

// SSE endpoint
app.get('/sse', async (req, res) => {
  const apiKey = getApiKey(req);
  if (!apiKey) return res.status(401).json({ error: 'API key required' });
  const server = createServer(apiKey);
  const transport = new SSEServerTransport('/messages', res);
  await server.connect(transport);
});

// Message endpoint for SSE
app.post('/messages', (req, res) => res.json({ ok: true }));

// Streamable HTTP endpoint
app.post('/mcp', async (req, res) => {
  const apiKey = getApiKey(req);
  if (!apiKey) return res.status(401).json({ error: 'unauthorized' });
  try {
    const server = createServer(apiKey);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    res.status(500).json({ error: 'internal_error', message: error.message });
  }
});

// Also accept POST on /sse for streamable HTTP
app.post('/sse', async (req, res) => {
  const apiKey = getApiKey(req);
  if (!apiKey) return res.status(401).json({ error: 'unauthorized' });
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
app.listen(PORT, () => console.log('STCKY MCP SSE v' + VERSION + ' — RESILIENT CORE — on port ' + PORT));

export default app;
