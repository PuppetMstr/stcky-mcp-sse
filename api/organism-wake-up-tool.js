// stcky-mcp-sse organism wake-up tool
// ORGANISM BETA Phase 2: Wake-up enforcement via MCP tool
//
// Returns structured packet: {now_state, deferred_asks, active_episodes, substrate_health}
// Replaces discipline-dependent "startup now recent" query with mechanical wake-up delivery.
//
// Usage: Call organism_wake_up() at session start instead of associative_recall("startup now recent")

async function organism_wake_up(args) {
  const { user_id } = args;
  
  if (!user_id) {
    throw new Error('user_id required for organism wake-up');
  }
  
  try {
    // Parallel queries to gather all wake-up components
    const [nowStateResult, deferredAsksResult, substrateHealthResult] = await Promise.all([
      // Get current now/state (most recent)
      associative_recall({
        query: 'now state canonical first read',
        limit: 1,
        user_id
      }),
      
      // Get unfulfilled deferred asks
      associative_recall({
        query: 'deferred ask unfulfilled pending',
        limit: 10,
        user_id
      }),
      
      // Get substrate health indicators  
      associative_recall({
        query: 'substrate health heartbeat capture working',
        limit: 5,
        user_id
      })
    ]);
    
    // Extract the most recent now/state
    let current_state = null;
    if (nowStateResult && nowStateResult.candidates && nowStateResult.candidates.length > 0) {
      const nowCandidate = nowStateResult.candidates.find(c => c.kind === 'now_state');
      if (nowCandidate) {
        current_state = {
          key: nowCandidate.meta.legacy_fields.key,
          ts_human: nowCandidate.ts_human,
          summary: nowCandidate.summary,
          payload: nowCandidate.payload
        };
      }
    }
    
    // Extract deferred asks (look for category=deferred-ask)
    const deferred_asks = [];
    if (deferredAsksResult && deferredAsksResult.candidates) {
      for (const candidate of deferredAsksResult.candidates) {
        if (candidate.meta.legacy_fields.category === 'deferred-ask') {
          deferred_asks.push({
            key: candidate.meta.legacy_fields.key,
            ts_human: candidate.ts_human,
            summary: candidate.summary,
            age_days: Math.floor((Date.now() - new Date(candidate.ts_human)) / (1000 * 60 * 60 * 24))
          });
        }
      }
    }
    
    // Extract active episodes from now/state payload if available
    let active_episodes = [];
    if (current_state && current_state.payload) {
      // Parse active episodes section from now/state
      const lines = current_state.payload.split('\n');
      let inActiveEpisodes = false;
      for (const line of lines) {
        if (line.includes('ACTIVE EPISODES')) {
          inActiveEpisodes = true;
          continue;
        }
        if (inActiveEpisodes && line.startsWith('═══')) {
          break;
        }
        if (inActiveEpisodes && line.trim() && line.startsWith('-')) {
          const match = line.match(/^- @([^—]+)(?:—(.+))?/);
          if (match) {
            active_episodes.push({
              handle: match[1].trim(),
              status: match[2] ? match[2].trim() : 'active'
            });
          }
        }
      }
    }
    
    // Gather substrate health status
    const substrate_health = {
      capture_status: 'unknown',
      recall_status: 'working', // If we got this far, recall is working
      correction_resolver_status: 'unknown',
      last_health_check: new Date().toISOString()
    };
    
    // Look for recent substrate health indicators
    if (substrateHealthResult && substrateHealthResult.candidates) {
      for (const candidate of substrateHealthResult.candidates) {
        if (candidate.meta.legacy_fields.category === 'substrate-health') {
          substrate_health.capture_status = 'working';
          substrate_health.last_health_check = candidate.ts_human;
          break;
        }
        if (candidate.payload && candidate.payload.includes('capture')) {
          if (candidate.payload.includes('working') || candidate.payload.includes('verified')) {
            substrate_health.capture_status = 'working';
          } else if (candidate.payload.includes('broken') || candidate.payload.includes('failed')) {
            substrate_health.capture_status = 'degraded';
          }
        }
      }
    }
    
    // Return structured wake-up packet
    return {
      wake_up_timestamp: new Date().toISOString(),
      current_state,
      deferred_asks,
      deferred_asks_count: deferred_asks.length,
      active_episodes,
      substrate_health,
      
      // Instructions for session start
      instructions: {
        priority_items: deferred_asks.filter(ask => ask.age_days > 1),
        next_actions: [
          current_state ? "Review current state" : "Create new now/state", 
          deferred_asks.length > 0 ? `Address ${deferred_asks.length} deferred asks` : "No pending asks",
          active_episodes.length > 0 ? `Continue ${active_episodes.length} active episodes` : "No active episodes"
        ]
      }
    };
    
  } catch (error) {
    console.error('Organism wake-up failed:', error);
    return {
      error: 'Wake-up failed',
      error_message: error.message,
      wake_up_timestamp: new Date().toISOString(),
      fallback_instructions: [
        'Run manual wake-up: associative_recall("startup now recent")',
        'Check substrate health manually',
        'Verify capture is working'
      ]
    };
  }
}

module.exports = {
  organism_wake_up
};
