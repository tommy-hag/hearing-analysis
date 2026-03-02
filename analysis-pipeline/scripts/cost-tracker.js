#!/usr/bin/env node

/**
 * Cost Tracker Utility
 * 
 * Estimates API costs based on token usage patterns.
 * Note: This is an estimation tool - actual costs depend on OpenAI API pricing.
 */

// Model pricing (as of 2024, approximate - update as needed)
const MODEL_PRICING = {
  'gpt-5-mini': {
    input: 0.15 / 1000000,  // $0.15 per 1M tokens
    output: 0.60 / 1000000   // $0.60 per 1M tokens
  },
  'gpt-5': {
    input: 2.50 / 1000000,   // $2.50 per 1M tokens
    output: 10.00 / 1000000  // $10.00 per 1M tokens
  },
  'gpt-4': {
    input: 30.00 / 1000000,  // $30.00 per 1M tokens
    output: 60.00 / 1000000  // $60.00 per 1M tokens
  },
  'text-embedding-3-large': {
    input: 0.13 / 1000000    // $0.13 per 1M tokens
  }
};

/**
 * Estimate tokens from text (rough approximation)
 */
function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  // Rough estimate: 1 token ≈ 4 characters for English/Danish
  return Math.ceil(text.length / 4);
}

/**
 * Estimate cost for a model call
 */
function estimateCost(model, inputTokens, outputTokens = 0) {
  const pricing = MODEL_PRICING[model];
  if (!pricing) {
    console.warn(`Unknown model pricing for: ${model}`);
    return 0;
  }

  const inputCost = (inputTokens || 0) * (pricing.input || 0);
  const outputCost = (outputTokens || 0) * (pricing.output || 0);
  
  return inputCost + outputCost;
}

/**
 * Track costs from pipeline artifacts
 */
function estimatePipelineCosts(artifacts) {
  const costs = {
    embedding: 0,
    microSummarize: 0,
    themeMapping: 0,
    aggregate: 0,
    positionWriting: 0,
    considerations: 0,
    total: 0
  };

  // Embedding costs
  if (artifacts.chunking) {
    const totalChunks = Array.isArray(artifacts.chunking) ? artifacts.chunking.length : 0;
    // Estimate average chunk size
    let totalChars = 0;
    artifacts.chunking.forEach(chunk => {
      if (chunk.content) totalChars += chunk.content.length;
    });
    const avgChunkSize = totalChunks > 0 ? totalChars / totalChunks : 0;
    const estimatedTokens = Math.ceil(avgChunkSize / 4) * totalChunks;
    costs.embedding = estimateCost('text-embedding-3-large', estimatedTokens);
  }

  // Micro-summarize costs (gpt-5-mini)
  if (artifacts.microSummaries) {
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    
    artifacts.microSummaries.forEach(ms => {
      // Estimate input (response content)
      if (ms.responseContent) {
        totalInputTokens += estimateTokens(ms.responseContent);
      }
      // Estimate output (summary)
      if (ms.summary) {
        totalOutputTokens += estimateTokens(ms.summary);
      }
    });
    
    costs.microSummarize = estimateCost('gpt-5-mini', totalInputTokens, totalOutputTokens);
  }

  // Position writing costs (gpt-5-mini)
  if (artifacts.writtenPositions) {
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    
    artifacts.writtenPositions.forEach(pos => {
      // Estimate input (arguments)
      if (pos.inputArguments) {
        totalInputTokens += estimateTokens(JSON.stringify(pos.inputArguments));
      }
      // Estimate output (summary)
      if (pos.summary) {
        totalOutputTokens += estimateTokens(pos.summary);
      }
    });
    
    costs.positionWriting = estimateCost('gpt-5-mini', totalInputTokens, totalOutputTokens);
  }

  // Calculate total
  costs.total = Object.values(costs).reduce((sum, cost) => sum + (typeof cost === 'number' ? cost : 0), 0);

  return costs;
}

/**
 * Format cost report
 */
function formatCostReport(costs, timings) {
  const lines = [];
  lines.push('# Cost Estimation Report');
  lines.push('');
  lines.push('**Note:** These are rough estimates based on token approximations.');
  lines.push('Actual costs may vary based on OpenAI API pricing and actual token usage.');
  lines.push('');
  
  lines.push('## Cost Breakdown');
  lines.push('');
  lines.push('| Component | Estimated Cost (USD) |');
  lines.push('|-----------|---------------------|');
  lines.push(`| Embedding | $${costs.embedding.toFixed(4)} |`);
  lines.push(`| Micro-summarize | $${costs.microSummarize.toFixed(4)} |`);
  lines.push(`| Position Writing | $${costs.positionWriting.toFixed(4)} |`);
  lines.push(`| **Total** | **$${costs.total.toFixed(4)}** |`);
  lines.push('');
  
  if (timings) {
    lines.push('## Efficiency Metrics');
    lines.push('');
    const totalMinutes = timings.totalDurationMinutes || 0;
    if (totalMinutes > 0) {
      lines.push(`- **Total Time:** ${totalMinutes.toFixed(1)} minutes`);
      lines.push(`- **Cost per Minute:** $${(costs.total / totalMinutes).toFixed(6)}`);
      lines.push(`- **Estimated Cost per Hour:** $${(costs.total / totalMinutes * 60).toFixed(2)}`);
    }
    lines.push('');
  }
  
  lines.push('## Model Pricing Reference');
  lines.push('');
  lines.push('Current estimates based on:');
  lines.push('- `gpt-5-mini`: $0.15/$0.60 per 1M tokens (input/output)');
  lines.push('- `text-embedding-3-large`: $0.13 per 1M tokens');
  lines.push('');
  lines.push('*Update pricing in `scripts/cost-tracker.js` if needed.*');
  lines.push('');
  
  return lines.join('\n');
}

// Export for use in other scripts
export { estimateTokens, estimateCost, estimatePipelineCosts, formatCostReport };

