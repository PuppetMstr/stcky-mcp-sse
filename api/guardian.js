// api/guardian.js
// Calls cleo-api the same way MCP server does

const CLEO_API = 'https://cleo-api.vercel.app';

async function fetchCategory(apiKey, category, limit) {
  try {
    const response = await fetch(CLEO_API + '/api/memory/list', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ category: category, limit: limit })
    });
    if (!response.ok) return [];
    const data = await response.json();
    return data.memories || [];
  } catch (e) {
    return [];
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.url.includes('/health')) {
    return res.status(200).json({ status: 'ok', version: '1.2.0' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header' });
  }

  const apiKey = authHeader.replace('Bearer ', '');

  try {
    if (req.method === 'GET') {
      var categories = ['person', 'preference', 'project', 'pending', 'config'];
      var limit = 10;
      
      var results = await Promise.all(
        categories.map(function(cat) { return fetchCategory(apiKey, cat, limit); })
      );
      
      var allMemories = [];
      results.forEach(function(memories) {
        memories.forEach(function(m) {
          allMemories.push({
            category: m.category,
            key: m.key,
            value: m.value,
            tags: m.tags || '',
            importance: m.importanceScore || 0.5,
            updatedAt: m.updatedAt
          });
        });
      });

      return res.status(200).json({
        success: true,
        memories: allMemories,
        count: allMemories.length
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });
    
  } catch (error) {
    console.error('Guardian API error:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
}