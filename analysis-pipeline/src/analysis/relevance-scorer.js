/**
 * RelevanceScorer
 * 
 * Scores extracted arguments against hearing material/themes to filter out
 * tangential or irrelevant content. Uses OpenAI embeddings for semantic 
 * relevance scoring via cosine similarity.
 * 
 * Purpose: Prevent "noise flooding" in large hearings by filtering out
 * arguments that are not genuinely relevant to the hearing topic.
 * 
 * Example: 
 * - "I walked there and it was cold" → Low relevance (tangential)
 * - "The trees should be preserved" → High relevance (actual stance)
 */

import { OpenAIReranker } from '../retrieval/openai-reranker.js';
import { DynamicParameterCalculator } from '../utils/dynamic-parameter-calculator.js';
import { limitConcurrency } from '../utils/concurrency.js';

// Concurrency for processing micro-summaries in relevance scoring
// Lower = more stable but slower, higher = faster but may hit rate limits
const RELEVANCE_SCORER_CONCURRENCY = parseInt(process.env.RELEVANCE_SCORER_CONCURRENCY || '10', 10);

export class RelevanceScorer {
  constructor(options = {}) {
    this.reranker = new OpenAIReranker({
      enabled: true,
      ...options
    });
    
    this.enabled = options.enabled !== false;
    this.batchSize = options.batchSize || 10; // Process arguments in batches
    this.verbose = options.verbose || false;
  }

  /**
   * Set Job ID for tracing
   */
  setJobId(jobId) {
    this.jobId = jobId;
  }

  /**
   * Build hearing context string from material summary and themes.
   * This is what arguments are scored against.
   * 
   * @param {string} materialSummary - Summary of hearing material
   * @param {Array} themes - Array of theme objects with name, description, regulates
   * @returns {string} Combined hearing context
   */
  buildHearingContext(materialSummary, themes) {
    const parts = [];
    
    // Add material summary
    if (materialSummary) {
      parts.push(`Høringsmateriale: ${materialSummary}`);
    }
    
    // Add theme information
    if (themes && themes.length > 0) {
      const themeDescriptions = themes
        .filter(t => t.name && t.name !== 'Andre emner')
        .map(t => {
          let desc = t.name;
          if (t.description) desc += `: ${t.description}`;
          if (t.regulates && t.regulates.length > 0) {
            desc += ` (regulerer: ${t.regulates.join(', ')})`;
          }
          return desc;
        })
        .join('; ');
      
      if (themeDescriptions) {
        parts.push(`Temaer: ${themeDescriptions}`);
      }
    }
    
    return parts.join('\n\n');
  }

  /**
   * Score a single argument against hearing context.
   * 
   * @param {Object} argument - Argument object with what, why, concern, etc.
   * @param {string} hearingContext - Combined hearing context string
   * @returns {Promise<number>} Relevance score (0-1)
   */
  async scoreArgument(argument, hearingContext) {
    if (!argument || !hearingContext) return 0;
    
    // Build argument text from key fields
    const argParts = [];
    if (argument.what) argParts.push(argument.what);
    if (argument.why) argParts.push(argument.why);
    if (argument.concern) argParts.push(argument.concern);
    if (argument.desiredAction) argParts.push(argument.desiredAction);
    if (argument.consequence) argParts.push(argument.consequence);
    
    const argText = argParts.join(' ').trim();
    
    if (!argText || argText.length < 10) {
      return 0; // Too short to meaningfully score
    }
    
    try {
      const result = await this.reranker.rerank(hearingContext, [{ content: argText }]);
      return result[0]?.rerankScore || 0;
    } catch (error) {
      console.warn(`[RelevanceScorer] Failed to score argument: ${error.message}`);
      return 0.5; // Return neutral score on error
    }
  }

  /**
   * Score multiple arguments against hearing context.
   * Processes in batches for efficiency.
   * 
   * @param {Array} arguments - Array of argument objects
   * @param {string} hearingContext - Combined hearing context string
   * @returns {Promise<Array>} Arguments with added relevanceScore field
   */
  async scoreArguments(args, hearingContext) {
    if (!this.enabled || !args || args.length === 0) {
      return args;
    }
    
    if (!hearingContext) {
      console.warn('[RelevanceScorer] No hearing context provided, skipping scoring');
      return args.map(arg => ({ ...arg, relevanceScore: 1.0 }));
    }

    console.log(`[RelevanceScorer] Scoring ${args.length} arguments against hearing context`);

    const scoredArgs = [];
    
    // Process in batches to avoid overwhelming the reranker
    for (let i = 0; i < args.length; i += this.batchSize) {
      const batch = args.slice(i, i + this.batchSize);
      
      // Build argument texts for batch
      const argTexts = batch.map(arg => {
        const parts = [];
        if (arg.what) parts.push(arg.what);
        if (arg.why) parts.push(arg.why);
        if (arg.concern) parts.push(arg.concern);
        return parts.join(' ').trim() || 'N/A';
      });
      
      try {
        // Score all arguments in batch
        const chunks = argTexts.map(text => ({ content: text }));
        const results = await this.reranker.rerank(hearingContext, chunks);
        
        // Combine with original arguments
        batch.forEach((arg, idx) => {
          scoredArgs.push({
            ...arg,
            relevanceScore: results[idx]?.rerankScore || 0
          });
        });
      } catch (error) {
        console.warn(`[RelevanceScorer] Batch scoring failed: ${error.message}`);
        // Add neutral scores on error
        batch.forEach(arg => {
          scoredArgs.push({ ...arg, relevanceScore: 0.5 });
        });
      }
    }
    
    return scoredArgs;
  }

  /**
   * Filter arguments below relevance threshold.
   * 
   * @param {Array} scoredArguments - Arguments with relevanceScore field
   * @param {number} threshold - Minimum relevance score to keep
   * @param {Object} options - Additional options
   * @param {number} options.minToKeep - Minimum number of arguments to keep per response
   * @returns {Object} { kept: Array, filtered: Array, stats: Object }
   */
  filterByRelevance(scoredArguments, threshold, options = {}) {
    if (!scoredArguments || scoredArguments.length === 0) {
      return { kept: [], filtered: [], stats: { total: 0, kept: 0, filtered: 0 } };
    }
    
    const { minToKeep = 1 } = options;
    
    // Sort by relevance score descending
    const sorted = [...scoredArguments].sort((a, b) => 
      (b.relevanceScore || 0) - (a.relevanceScore || 0)
    );
    
    // Determine how many to keep
    const aboveThreshold = sorted.filter(arg => (arg.relevanceScore || 0) >= threshold);
    const belowThreshold = sorted.filter(arg => (arg.relevanceScore || 0) < threshold);
    
    // Ensure we keep at least minToKeep arguments
    let kept, filtered;
    if (aboveThreshold.length >= minToKeep) {
      kept = aboveThreshold;
      filtered = belowThreshold;
    } else {
      // Not enough above threshold - keep top minToKeep regardless
      kept = sorted.slice(0, Math.max(minToKeep, aboveThreshold.length));
      filtered = sorted.slice(kept.length);
    }
    
    const stats = {
      total: scoredArguments.length,
      kept: kept.length,
      filtered: filtered.length,
      threshold,
      avgKeptScore: kept.length > 0 
        ? kept.reduce((sum, a) => sum + (a.relevanceScore || 0), 0) / kept.length 
        : 0,
      avgFilteredScore: filtered.length > 0 
        ? filtered.reduce((sum, a) => sum + (a.relevanceScore || 0), 0) / filtered.length 
        : 0
    };
    
    // Log filtering results
    if (filtered.length > 0) {
      console.log(`[RelevanceScorer] Filtered ${filtered.length}/${stats.total} low-relevance arguments (threshold: ${threshold.toFixed(3)})`);
      if (this.verbose) {
        filtered.forEach(arg => {
          const preview = (arg.what || '').slice(0, 60);
          console.log(`  - "${preview}..." (score: ${(arg.relevanceScore || 0).toFixed(3)})`);
        });
      }
    }
    
    return { kept, filtered, stats };
  }

  /**
   * Score and filter arguments for a batch of micro-summaries.
   * 
   * @param {Array} microSummaries - Array of micro-summary objects with arguments
   * @param {string} hearingContext - Combined hearing context
   * @param {Object} params - Dynamic parameters with relevance settings
   * @returns {Promise<Object>} { summaries: Array, totalFiltered: number, totalKept: number }
   */
  async scoreAndFilterSummaries(microSummaries, hearingContext, params) {
    if (!this.enabled || !microSummaries || microSummaries.length === 0) {
      return { summaries: microSummaries, totalFiltered: 0, totalKept: 0 };
    }
    
    const relevanceParams = params?.relevance || { enabled: false, threshold: 0.2, minArgumentsToKeep: 1 };
    
    if (!relevanceParams.enabled) {
      console.log('[RelevanceScorer] Relevance filtering disabled for this hearing');
      return { summaries: microSummaries, totalFiltered: 0, totalKept: 0 };
    }
    
    console.log(`[RelevanceScorer] Processing ${microSummaries.length} summaries with threshold ${relevanceParams.threshold.toFixed(3)} (concurrency: ${RELEVANCE_SCORER_CONCURRENCY})`);
    
    let totalFiltered = 0;
    let totalKept = 0;
    
    // Use limitConcurrency to prevent API overload with large datasets
    // Promise.all would send all requests at once, causing timeouts
    const tasks = microSummaries.map((summary, idx) => async () => {
      if (!summary.arguments || summary.arguments.length === 0) {
        return summary;
      }
      
      // Score arguments
      const scoredArgs = await this.scoreArguments(summary.arguments, hearingContext);
      
      // Filter by relevance
      const { kept, filtered, stats } = this.filterByRelevance(
        scoredArgs,
        relevanceParams.threshold,
        { minToKeep: 1 } // Always keep at least 1 argument per response
      );
      
      // Note: these are accumulated after all tasks complete
      return {
        summary: {
          ...summary,
          arguments: kept,
          _relevanceFiltering: {
            originalCount: stats.total,
            keptCount: stats.kept,
            filteredCount: stats.filtered,
            avgScore: stats.avgKeptScore
          }
        },
        stats
      };
    });
    
    const results = await limitConcurrency(tasks, RELEVANCE_SCORER_CONCURRENCY);
    
    // Separate results and accumulate stats
    const processedSummaries = results.map(result => {
      if (result && result.stats) {
        totalFiltered += result.stats.filtered;
        totalKept += result.stats.kept;
        return result.summary;
      }
      // Summaries with no arguments return directly
      return result;
    });
    
    console.log(`[RelevanceScorer] Complete: kept ${totalKept} arguments, filtered ${totalFiltered}`);
    
    return {
      summaries: processedSummaries,
      totalFiltered,
      totalKept
    };
  }
}
