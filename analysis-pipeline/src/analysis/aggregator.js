/**
 * Aggregator
 * 
 * Thematic aggregation from micro-summaries with LLM-based semantic grouping.
 */

import { HybridRetriever } from '../retrieval/hybrid-retriever.js';
import { OpenAIClientWrapper, getComplexityConfig } from '../utils/openai-client.js';
import { getResponseFormat } from '../utils/json-schemas.js';
import { EmbeddingClusterer } from './embedding-clusterer.js';
import { ObjectExtractor } from './object-extractor.js';
import { getBatchSizeForStep } from '../utils/batch-calculator.js';
import { limitConcurrency } from '../utils/concurrency.js';
import { DanishNumberFormatter } from '../utils/danish-number-formatter.js';
import { DynamicParameterCalculator } from '../utils/dynamic-parameter-calculator.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../../config/.env') });

/**
 * Intelligently truncate text at word boundaries to avoid cutting mid-word.
 * @param {string} text - Text to truncate
 * @param {number} maxLength - Maximum length
 * @returns {string} Truncated text
 */
function smartTruncate(text, maxLength) {
  if (!text || text.length <= maxLength) return text;

  // Find last space within maxLength
  const truncated = text.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');

  // If we have a good break point (at least 60% into the text), use it
  if (lastSpace > maxLength * 0.6) {
    return truncated.slice(0, lastSpace);
  }

  // Otherwise just return the truncated text (better than cutting mid-word most of the time)
  return truncated;
}

export class Aggregator {
  constructor(options = {}) {
    this.retriever = new HybridRetriever(options);
    this.conflictRule = options.conflictRule !== false;
    this.useLLMGrouping = options.useLLMGrouping !== false;
    this.useEmbeddingClustering = options.useEmbeddingClustering !== false; // Enable embedding pre-clustering

    // Dynamic batching parameters (will be set per hearing via setDynamicParameters)
    this.dynamicBatchSize = options.batchSize || 20; // Default fallback
    this.noBatching = options.noBatching || false;
    
    // Theme-level concurrency for embedding operations (prevents connection saturation)
    // Default to 3 - conservative to avoid "Connection error" / timeouts
    this.themeLevelConcurrency = options.themeLevelConcurrency || 3;

    // Initialize embedding clusterer for fast pre-clustering
    this.embeddingClusterer = new EmbeddingClusterer(options);

    // Initialize object extractor for object-aware grouping
    this.objectExtractor = new ObjectExtractor(options);

    // RAG-based substance selection (optional - for enhanced context)
    this.embeddedSubstance = null;
    this.substanceEmbedder = null;
    this.useRAGSubstance = false;

    // Initialize LLM clients for semantic grouping - Use MEDIUM complexity with LOW reasoning
    // OPTIMIZATION: Low reasoning to avoid timeout issues while maintaining grouping quality
    try {
      const complexityConfig = getComplexityConfig(options.complexityLevel || 'medium');
      this.client = new OpenAIClientWrapper({
        model: options.model || complexityConfig.model,
        verbosity: options.verbosity || complexityConfig.verbosity,
        // IMPORTANT: Use LOW reasoning to prevent timeout (grouping doesn't need deep reasoning)
        reasoningEffort: options.reasoningEffort || 'low',
        timeout: options.timeout || 300000 // 300 second timeout (increased from 180s)
      });

      // Create light client for simple clusters (cost optimization)
      const lightConfig = getComplexityConfig('light');
      this.lightClient = new OpenAIClientWrapper({
        model: lightConfig.model,
        verbosity: lightConfig.verbosity,
        reasoningEffort: lightConfig.reasoningEffort,
        timeout: 90000 // 90 second timeout for simple cases (increased from 60s)
      });
      
      // Log actual models being used (from env config)
      console.log(`[Aggregator] Initialized with MEDIUM=${this.client.model} (reasoning: low), LIGHT=${this.lightClient.model}`);
    } catch (error) {
      console.warn('[Aggregator] Failed to initialize LLM client, falling back to rule-based grouping:', error.message);
      this.client = null;
      this.lightClient = null;
      this.useLLMGrouping = false;
    }

    // Load aggregation prompt template
    try {
      const promptPath = join(__dirname, '../../prompts/aggregation-prompt.md');
      this.promptTemplate = readFileSync(promptPath, 'utf-8');
    } catch (error) {
      console.warn('[Aggregator] Could not load aggregation prompt template');
      this.promptTemplate = null;
    }

    // Load discovery prompt for large-scale processing
    try {
      const discoveryPath = join(__dirname, '../../prompts/aggregate-discovery-prompt.md');
      this.discoveryPromptTemplate = readFileSync(discoveryPath, 'utf-8');
    } catch (error) {
      console.warn('[Aggregator] Could not load discovery prompt template');
      this.discoveryPromptTemplate = null;
    }

    // Load attribution prompt for large-scale LLM attribution
    try {
      const attributionPath = join(__dirname, '../../prompts/aggregate-attribution-prompt.md');
      this.attributionPromptTemplate = readFileSync(attributionPath, 'utf-8');
    } catch (error) {
      console.warn('[Aggregator] Could not load attribution prompt template');
      this.attributionPromptTemplate = null;
    }
  }

  /**
   * Set Job ID for tracing
   */
  setJobId(jobId) {
    if (this.client) this.client.setJobId(jobId);
    if (this.lightClient) this.lightClient.setJobId(jobId);
  }

  /**
   * Set callback for incremental theme saving.
   * Called after each theme is completed with { completedThemes, themeName, themeResult }
   * @param {Function} callback - Async function(partialState) to save state
   */
  setIncrementalSaveCallback(callback) {
    this.incrementalSaveCallback = callback;
  }

  /**
   * Load partial aggregate state to resume from.
   * Themes in this state will be skipped during aggregation.
   * @param {Object} partialState - { completedThemes: { themeName: themeResult, ... } }
   */
  loadPartialState(partialState) {
    this.partialState = partialState;
    if (partialState?.completedThemes) {
      const count = Object.keys(partialState.completedThemes).length;
      console.log(`[Aggregator] 📦 Loaded partial state with ${count} completed themes`);
    }
  }

  /**
   * Set embedded substance for RAG-based context selection
   * @param {Array} embeddedItems - Substance items with embeddings
   * @param {SubstanceEmbedder} embedder - Embedder for query embedding
   */
  setEmbeddedSubstance(embeddedItems, embedder) {
    this.embeddedSubstance = embeddedItems;
    this.substanceEmbedder = embedder;
    this.useRAGSubstance = embeddedItems && embeddedItems.length > 0 && embedder;

    if (this.useRAGSubstance) {
      console.log(`[Aggregator] RAG mode enabled: ${embeddedItems.length} substance items available`);
    }
  }

  /**
   * Set feedback context for re-analysis runs
   * This context will be injected into aggregation to address user corrections
   * @param {Object} feedbackContext - Context from FeedbackOrchestrator
   */
  setFeedbackContext(feedbackContext) {
    this.feedbackContext = feedbackContext;
    const structureChanges = feedbackContext.structureChanges?.length || 0;
    const highlightedContent = feedbackContext.highlightedContent?.length || 0;
    if (structureChanges > 0 || highlightedContent > 0) {
      console.log(`[Aggregator] Feedback context set: ${structureChanges} structure changes, ${highlightedContent} highlighted content items`);
    }
  }

  /**
   * Set copy/paste groups for enhanced response attribution
   * Enables expanding positions to include all members of detected copy/paste groups
   * @param {Array} copyPasteGroups - Groups from CopyPasteDetector
   */
  setCopyPasteGroups(copyPasteGroups) {
    this.copyPasteGroups = copyPasteGroups || [];
    if (this.copyPasteGroups.length > 0) {
      const totalGroupedResponses = this.copyPasteGroups.reduce(
        (sum, g) => sum + g.responseNumbers.length, 0
      );
      console.log(`[Aggregator] Copy/paste groups set: ${this.copyPasteGroups.length} groups covering ${totalGroupedResponses} responses`);
    }
  }

  /**
   * Build feedback section for aggregation prompt injection
   * @returns {string} Formatted feedback section for prompt
   * @private
   */
  buildFeedbackSection() {
    if (!this.feedbackContext) return '';

    const sections = [];

    // Add structure changes (theme merging, splitting, etc.)
    const structureChanges = this.feedbackContext.structureChanges || [];
    if (structureChanges.length > 0) {
      sections.push(`\n## Strukturelle ændringer fra bruger\nFølgende ændringer skal implementeres:\n${
        structureChanges.map(change => `- ${change.text}`).join('\n')
      }`);
    }

    // Add highlighted content that might affect aggregation
    const highlighted = this.feedbackContext.highlightedContent || [];
    if (highlighted.length > 0) {
      sections.push(`\n## Vigtigt indhold fremhævet af bruger\nFølgende passager er markeret som vigtige og skal placeres korrekt:\n${
        highlighted.map(h => `- Svar ${h.responseNumber}: "${h.text}"`).join('\n')
      }`);
    }

    return sections.join('\n');
  }

  /**
   * Get relevant substance for a theme using RAG
   * @param {string} themeQuery - Theme name and description
   * @param {number} topK - Number of items to return
   * @returns {Promise<string|null>} Formatted substance text or null
   */
  async getRelevantSubstanceForTheme(themeQuery, topK = 10) {
    if (!this.useRAGSubstance || !this.substanceEmbedder) {
      return null;
    }

    try {
      const relevantItems = await this.substanceEmbedder.retrieveRelevant(
        themeQuery,
        this.embeddedSubstance,
        { topK, minScore: 0.3 }
      );
      
      if (!relevantItems || relevantItems.length === 0) {
        return null;
      }
      
      return this.substanceEmbedder.formatForPrompt(relevantItems);
    } catch (error) {
      console.warn(`[Aggregator] RAG retrieval failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Set dynamic parameters for this hearing
   * Called by pipeline orchestrator with hearing-specific parameters
   */
  setDynamicParameters(params) {
    if (params.aggregation) {
      this.dynamicBatchSize = params.aggregation.batchSize;
      this.noBatching = params.aggregation.noBatching;
      console.log(`[Aggregator] Dynamic parameters set: batchSize=${this.dynamicBatchSize}, noBatching=${this.noBatching}`);
    }

    // CRITICAL: Theme-level concurrency for embedding operations
    // This limits how many themes can do embedding work simultaneously
    // Prevents "Connection error" / timeouts from concurrent embedding floods
    if (params.embedding?.themeLevelConcurrency) {
      this.themeLevelConcurrency = params.embedding.themeLevelConcurrency;
      console.log(`[Aggregator] Theme-level embedding concurrency set to ${this.themeLevelConcurrency}`);
    } else {
      this.themeLevelConcurrency = 3; // Conservative default
    }

    // Pass dynamic parameters to embedding clusterer for semantic diversity adjustment
    if (this.embeddingClusterer && params) {
      this.embeddingClusterer.setDynamicParameters(params);
    }

    // Pass dynamic parameters to retriever for adaptive topK and reranking
    if (this.retriever && params) {
      this.retriever.setDynamicParameters(params);
    }
  }

  /**
   * Aggregate arguments by theme with LLM-based semantic grouping
   * @param {Object} themeMapping - Theme mapping from ThemeMapper
   * @param {Array} chunks - All chunks for RAG retrieval
   * @param {Array} materials - Hearing materials
   * @param {Array} responses - All responses (for respondent breakdown)
   * @returns {Promise<Array>} Aggregated themes with positions
   */
  async aggregate(themeMapping, chunks, materials, responses = []) {
    // NOTE: "No comments" responses are handled later by validateRespondentCoverage
    // which adds them to "Ingen holdning fundet" position. We no longer create
    // synthetic arguments here, as that caused them to be incorrectly grouped
    // with substantive positions.
    // Now using "Andre emner" as the sole catch-all theme (replacing "Generelt")
    const andreEmnerTheme = themeMapping.themes.find(te => te.name === 'Andre emner');
    if (andreEmnerTheme && andreEmnerTheme.summaries) {
      const noCommentsSummaries = andreEmnerTheme.summaries.filter(s => s.isNoComments);
      if (noCommentsSummaries.length > 0) {
        console.log(`[Aggregator] Found ${noCommentsSummaries.length} "no comments" responses - will be added to "Ingen holdning fundet" by coverage validation`);
      }
    }

    // =========================================================================
    // SCALE-AWARE AGGREGATION: Determine tier based on actual argument counts
    // Calculated at runtime to preserve checkpoint compatibility
    // =========================================================================
    const totalArguments = themeMapping.themes.reduce((sum, t) => sum + (t.arguments?.length || 0), 0);
    const themeCount = themeMapping.themes.filter(t => t.arguments?.length > 0).length;
    const avgArgsPerTheme = themeCount > 0 ? Math.ceil(totalArguments / themeCount) : 0;

    // Get tier configuration (small/medium/large)
    this.tierConfig = DynamicParameterCalculator.getAggregationTierConfig({
      argumentCount: totalArguments,
      themeCount,
      responseCount: responses.length
    });

    console.log(`[Aggregator] Scale tier: ${this.tierConfig.tier.toUpperCase()} (${totalArguments} args across ${themeCount} themes, avg ${avgArgsPerTheme}/theme)`);

    // Process themes with CONTROLLED parallelism (prevents embedding connection saturation)
    const themesWithArguments = themeMapping.themes.filter(te => te.arguments.length > 0);

    // CRITICAL FIX: Use dynamic theme-level concurrency instead of unbounded parallelism
    // This prevents "Connection error" / timeouts from too many concurrent embedding requests
    const themeConcurrency = this.themeLevelConcurrency || 3;
    console.log(`[Aggregator] Processing ${themesWithArguments.length} themes with concurrency=${themeConcurrency}`);

    // Initialize completedThemes from partial state if available
    const completedThemes = this.partialState?.completedThemes
      ? { ...this.partialState.completedThemes }
      : {};

    // Create async functions for each theme (to be executed with limited concurrency)
    const themeProcessors = themesWithArguments.map((themeEntry) => async () => {
      // INCREMENTAL RESUME: Skip themes already in partial state
      if (completedThemes[themeEntry.name]) {
        console.log(`[Aggregator] ⏩ Skipping completed theme "${themeEntry.name}" (from partial state)`);
        return { themeEntry, positionGroups: completedThemes[themeEntry.name].positionGroups, fromPartialState: true };
      }

      const themeStart = Date.now();
      console.log(`[Aggregator] Starting theme "${themeEntry.name}" with ${themeEntry.arguments.length} arguments`);

      try {
        let positionGroups;

        // =========================================================================
        // UNIFIED DISCOVERY+ATTRIBUTION FLOW
        // All themes ≥15 args use: discovery (LLM finds positions) + attribution (LLM assigns args)
        // Themes <15 args use: direct LLM grouping (unchanged)
        // Direction separation is handled by discovery prompt + directionsCompatible() constraint
        // =========================================================================
        const useDiscoveryAttribution = themeEntry.arguments.length >= 15;

        if (useDiscoveryAttribution) {
          console.log(`[Aggregator] 🔄 UNIFIED: Theme "${themeEntry.name}" has ${themeEntry.arguments.length} arguments - using discovery+attribution`);

          // Determine sampling based on size
          let sampleSize;
          if (themeEntry.arguments.length <= 100) {
            sampleSize = themeEntry.arguments.length; // Use ALL args for small themes
          } else if (themeEntry.arguments.length <= 500) {
            sampleSize = Math.min(100, Math.max(50, Math.ceil(themeEntry.arguments.length * 0.15)));
          } else {
            sampleSize = Math.min(200, Math.ceil(themeEntry.arguments.length * 0.1));
          }

          const themeTierConfig = {
            sampleSize,
            attributionThreshold: 0.70,
            attributionFloor: 0.55,
            respectDirectionInAttribution: true
          };

          positionGroups = await this.processThemeLargeScale(
            themeEntry.arguments,
            themeEntry.name,
            responses,
            themeEntry.description || '',
            themeTierConfig
          );
          console.log(`[Aggregator] ✅ UNIFIED complete: ${positionGroups.length} positions from ${themeEntry.arguments.length} arguments`);
        }
        // Direct LLM grouping for small themes (<15 args)
        else if (!positionGroups && this.useLLMGrouping && this.client && this.promptTemplate) {
          // For small themes, keep direction separation (LLM handles <15 args well)
          const taggedArgs = this.tagArgumentsWithDirection(themeEntry.arguments);
          const { supportArgs, opposeArgs, neutralArgs } = this.separateByDirection(taggedArgs);
          const hasSupportAndOppose = supportArgs.length > 0 && (opposeArgs.length > 0 || neutralArgs.length > 0);

          if (hasSupportAndOppose) {
            console.log(`[Aggregator] Small theme direction split: ${supportArgs.length} support + ${opposeArgs.length + neutralArgs.length} oppose/neutral`);
            const allArgs = [...opposeArgs, ...neutralArgs];
            const client = this.selectClientForCluster(allArgs);
            positionGroups = await this.groupWithLLMClient(allArgs, themeEntry.name, responses, client, themeEntry.description || '');

            // Add support args as separate position(s)
            if (supportArgs.length > 0) {
              const firstWhat = supportArgs[0]?.what;
              const dynamicTitle = firstWhat
                ? `Støtte: ${smartTruncate(firstWhat, 80)}`
                : 'Støtte til projektet';
              positionGroups.push({
                args: supportArgs,
                title: dynamicTitle,
                summary: '',
                responseNumbers: [...new Set(supportArgs.map(a => a.responseNumber))],
                citationMap: [],
                _directionGroup: 'support'
              });
            }
          } else {
            console.log(`[Aggregator] Theme "${themeEntry.name}" has ${themeEntry.arguments.length} arguments - processing with LLM (no pre-clustering needed)`);
            const client = this.selectClientForCluster(themeEntry.arguments);
            positionGroups = await this.groupWithLLMClient(themeEntry.arguments, themeEntry.name, responses, client, themeEntry.description || '');
          }
        } else if (!positionGroups) {
          // Fallback to rule-based grouping
          positionGroups = this.groupByConsequence(themeEntry.arguments);
        }

        const themeDuration = ((Date.now() - themeStart) / 1000).toFixed(1);
        console.log(`[Aggregator] ✅ Completed theme "${themeEntry.name}" in ${themeDuration}s`);

        // INCREMENTAL SAVE: Store completed theme and call save callback
        completedThemes[themeEntry.name] = { positionGroups, duration: parseFloat(themeDuration) };
        if (this.incrementalSaveCallback) {
          try {
            await this.incrementalSaveCallback({
              completedThemes,
              lastCompletedTheme: themeEntry.name,
              totalThemes: themesWithArguments.length,
              completedCount: Object.keys(completedThemes).length
            });
            console.log(`[Aggregator] 💾 Saved incremental state (${Object.keys(completedThemes).length}/${themesWithArguments.length} themes)`);
          } catch (saveError) {
            console.warn(`[Aggregator] ⚠️ Failed to save incremental state:`, saveError.message);
          }
        }

        return { themeEntry, positionGroups };
      } catch (error) {
        console.error(`[Aggregator] ❌ Failed theme "${themeEntry.name}":`, error.message);
        throw error;
      }
    });

    // CRITICAL FIX: Use limitConcurrency instead of unbounded Promise.all
    // This prevents embedding connection saturation by limiting how many themes
    // can do embedding work simultaneously
    const groupingResults = await limitConcurrency(themeProcessors, themeConcurrency);

    // Now aggregate positions for each theme (also parallelized)
    // NOTE: splitLargePosition removed - large positions (e.g. "Bevar Palads" with 800 respondents)
    // are correct semantics. extract-sub-positions downstream handles internal structure.
    const aggregationPromises = groupingResults.map(async ({ themeEntry, positionGroups }) => {
      // Parallelize position aggregation within each theme
      const positionPromises = positionGroups.map(group =>
        this.aggregatePosition(group, themeEntry.name, chunks, materials, responses)
      );
      const positions = await Promise.all(positionPromises);

      return {
        name: themeEntry.name,
        positions: positions
      };
    });

    const aggregatedThemes = await Promise.all(aggregationPromises);

    // Add themes with no arguments (preserve order)
    const themesWithoutArguments = themeMapping.themes.filter(te => te.arguments.length === 0);
    let allThemes = [...aggregatedThemes, ...themesWithoutArguments.map(te => ({
      name: te.name,
      positions: []
    }))];

    // CRITICAL: Ensure ALL responses from theme mapping are included in at least one position
    const originalResponseNumbers = new Set();
    themeMapping.themes.forEach(te => {
      te.arguments?.forEach(arg => {
        if (arg.responseNumber) {
          originalResponseNumbers.add(arg.responseNumber);
        }
      });
    });

    const includedResponseNumbers = new Set();
    allThemes.forEach(theme => {
      theme.positions?.forEach(position => {
        position.responseNumbers?.forEach(num => includedResponseNumbers.add(num));
      });
    });

    const missingResponseNumbers = Array.from(originalResponseNumbers)
      .filter(num => !includedResponseNumbers.has(num));

    if (missingResponseNumbers.length > 0) {
      // Summarize lost responses warning (truncate list if too long)
      const displayIds = missingResponseNumbers.length <= 10
        ? missingResponseNumbers.join(', ')
        : `${missingResponseNumbers.slice(0, 10).join(', ')} (+${missingResponseNumbers.length - 10} more)`;
      console.warn(`[Aggregator] ⚠️ ${missingResponseNumbers.length} responses were lost during grouping: ${displayIds}`);
      console.log(`[Aggregator] Recovering lost responses by adding them to their original themes...`);

      // Collect recovery info for summary instead of logging each one
      const recoveryByTheme = {};

      // For each missing response, find its arguments and add them to a position
      missingResponseNumbers.forEach(responseNumber => {
        // Find the theme(s) this response was mapped to
        themeMapping.themes.forEach(themeEntry => {
          const responseArgs = themeEntry.arguments?.filter(arg => arg.responseNumber === responseNumber) || [];

          if (responseArgs.length > 0) {
            // Track for summary
            if (!recoveryByTheme[themeEntry.name]) {
              recoveryByTheme[themeEntry.name] = [];
            }
            recoveryByTheme[themeEntry.name].push(responseNumber);

            // Find or create the theme in allThemes
            let theme = allThemes.find(t => t.name === themeEntry.name);
            if (!theme) {
              theme = { name: themeEntry.name, positions: [] };
              allThemes.push(theme);
            }

            // Create a standalone position for this response
            const position = {
              title: responseArgs[0].consequence || responseArgs[0].coreContent || 'Holdning',
              responseNumbers: [responseNumber],
              summary: this.buildSummary(responseArgs, [responseNumber], responses),
              materialReferences: this.extractMaterialReferences(responseArgs),
              respondentBreakdown: this.buildRespondentBreakdown(responseArgs, [responseNumber], responses),
              citationMap: [],
              citations: []
            };

            theme.positions.push(position);
          }
        });
      });

      // Log summarized recovery info
      const themeNames = Object.keys(recoveryByTheme);
      if (themeNames.length > 0) {
        console.log(`[Aggregator] Recovery summary: ${themeNames.length} themes affected`);
        themeNames.forEach(theme => {
          const ids = recoveryByTheme[theme];
          const displayRecovered = ids.length <= 5 ? ids.join(', ') : `${ids.slice(0, 5).join(', ')} (+${ids.length - 5} more)`;
          console.log(`  - "${theme}": ${ids.length} responses (${displayRecovered})`);
        });
      }
      console.log(`[Aggregator] ✅ Recovered all ${missingResponseNumbers.length} lost responses`);
    }

    // QUALITY FIX: Detect prominent out-of-scope topics that might be underrepresented
    // This helps ensure important concerns under "Andre emner" get visibility
    this.detectProminentOutOfScopeTopics(allThemes, responses);

    return allThemes;
  }

  /**
   * Recursively process a cluster of arguments
   * Handles large clusters by sub-clustering or splitting
   * @param {Array} cluster - Arguments in this cluster
   * @param {string} themeName - Theme name
   * @param {Array} responses - All responses for respondent info
   * @param {string} themeDescription - Theme description with legal context
   * @private
   */
  async processCluster(cluster, themeName, responses, themeDescription = '') {
    // RECURSIVE AGGREGATION: Handle still-large clusters by recursively sub-clustering
    // If a cluster is > 40 items, K-means probably grouped distinct things together due to density
    if (cluster.length > 40) {
      console.log(`[Aggregator] Cluster is too large (${cluster.length} items) - running recursive sub-clustering...`);

      // Recursively cluster this specific group
      const subClusters = await this.embeddingClusterer.clusterArguments(cluster, themeName);
      console.log(`[Aggregator] Recursive clustering split ${cluster.length} items into ${subClusters.length} sub-clusters`);

      const subResults = [];
      for (const subCluster of subClusters) {
        // RECURSIVE CALL: Process each sub-cluster (which might still be large!)
        const groups = await this.processCluster(subCluster, themeName, responses, themeDescription);
        subResults.push(...groups);
      }
      return subResults;
    }

    // SAFETY: Still split if marginally large (but not huge) to prevent hanging
    else if (cluster.length > 25) {
      console.warn(`[Aggregator] Cluster has ${cluster.length} args - splitting linearly to prevent hanging`);
      const subClusters = [];
      for (let j = 0; j < cluster.length; j += 15) {
        subClusters.push(cluster.slice(j, j + 15));
      }

      const subResults = [];
      for (const subCluster of subClusters) {
        // RECURSIVE CALL: Process each linear chunk
        const groups = await this.processCluster(subCluster, themeName, responses, themeDescription);
        subResults.push(...groups);
      }
      return subResults;
    }

    // Normal processing for optimally sized clusters
    else {
      const client = this.selectClientForCluster(cluster);
      const groups = await this.groupWithLLMClient(cluster, themeName, responses, client, themeDescription);
      return groups;
    }
  }

  /**
   * Split position if it exceeds max respondents to maintain quality and nuance
   * QUALITY FIX: Now splits at 300 respondents - positions >300 lose nuance
   * @private
   */
  splitLargePosition(positionGroup, themeName, maxRespondentsPerPosition = 300) {
    const uniqueResponseNumbers = [...new Set(positionGroup.args.map(arg => arg.responseNumber))];

    if (uniqueResponseNumbers.length <= maxRespondentsPerPosition) {
      return [positionGroup];
    }

    console.log(`[Aggregator] QUALITY SPLIT: Position in theme "${themeName}" has ${uniqueResponseNumbers.length} respondents - splitting into sub-positions (max ${maxRespondentsPerPosition} each)`);

    // Split arguments by response number into chunks
    const chunks = [];
    const argsByResponse = new Map();

    positionGroup.args.forEach(arg => {
      if (!argsByResponse.has(arg.responseNumber)) {
        argsByResponse.set(arg.responseNumber, []);
      }
      argsByResponse.get(arg.responseNumber).push(arg);
    });

    const responseNumbers = Array.from(argsByResponse.keys());
    for (let i = 0; i < responseNumbers.length; i += maxRespondentsPerPosition) {
      const chunkResponses = responseNumbers.slice(i, i + maxRespondentsPerPosition);
      const chunkArgs = [];

      chunkResponses.forEach(respNum => {
        chunkArgs.push(...argsByResponse.get(respNum));
      });

      chunks.push({
        args: chunkArgs,
        title: positionGroup.title, // Preserve the quality title from LLM
        partIndex: Math.floor(i / maxRespondentsPerPosition) + 1,
        totalParts: Math.ceil(responseNumbers.length / maxRespondentsPerPosition),
        _splitFrom: positionGroup.title || 'Large position' // Track origin
      });
    }

    console.log(`[Aggregator] ✂️  Split into ${chunks.length} sub-positions (${Math.ceil(uniqueResponseNumbers.length / maxRespondentsPerPosition)} parts total)`);
    return chunks;
  }

  /**
   * Calculate total character count for a cluster of arguments
   * @param {Array} args - Arguments in the cluster
   * @returns {number} Total character count
   * @private
   */
  calculateClusterCharCount(args) {
    let totalChars = 0;

    args.forEach(arg => {
      // Sum up all text fields in the argument
      totalChars += (arg.what || arg.coreContent || '').length;
      totalChars += (arg.why || '').length;
      totalChars += (arg.how || arg.desiredAction || '').length;
      totalChars += (arg.concern || '').length;
      totalChars += (arg.consequence || '').length;
    });

    return totalChars;
  }

  /**
   * OPTIMIZATION: Select LLM client based on cluster complexity (CONTENT-AWARE)
   * Uses character count instead of just item count to determine complexity
   * @private
   */
  selectClientForCluster(args) {
    const clusterSize = Array.isArray(args) ? args.length : 0;

    // If args is just a number (legacy call), use simple threshold
    if (typeof args === 'number') {
      const size = args;
      if (size <= 10) return this.lightClient || this.client;
      if (size <= 15) return this.lightClient || this.client;
      console.warn(`[Aggregator] Large cluster size ${size} - using full model, may be slow`);
      return this.client;
    }

    // CONTENT-AWARE: Calculate total character volume
    const totalChars = this.calculateClusterCharCount(args);

    // THRESHOLDS:
    // Low volume: < 3000 chars → Use light client (faster, cheaper)
    // High volume: >= 3000 chars → Use heavy client (better nuance)

    if (totalChars < 3000) {
      const selectedClient = this.lightClient || this.client;
      console.log(`[Aggregator] Cluster: ${clusterSize} args, ${totalChars} chars → LIGHT (${selectedClient.model})`);
      return selectedClient;
    } else {
      console.log(`[Aggregator] Cluster: ${clusterSize} args, ${totalChars} chars → HEAVY (${this.client.model})`);
      return this.client;
    }
  }

  /**
   * Group arguments using LLM for semantic understanding (legacy wrapper)
   * @deprecated Use groupWithLLMClient for tiered model selection
   * NOTE: With embedding-first clustering, this is only called on small pre-clustered groups
   */
  async groupWithLLM(args, themeName, allResponses = [], themeDescription = '') {
    return this.groupWithLLMClient(args, themeName, allResponses, this.client, themeDescription);
  }

  /**
   * Group arguments using LLM for semantic understanding with specific client
   * NOTE: With embedding-first clustering, this is only called on small pre-clustered groups
   * @param {Array} args - Arguments to group
   * @param {string} themeName - Theme name
   * @param {Array} allResponses - All responses for respondent info
   * @param {Object} client - LLM client to use
   * @param {string} themeDescription - Theme description with legal context (§-references, etc.)
   */
  async groupWithLLMClient(args, themeName, allResponses = [], client, themeDescription = '') {
    if (args.length === 0) return [];

    // CRITICAL FIX: Remove "no comments" arguments BEFORE LLM grouping
    // These respondents should NOT be included in any position - they have no substantive content
    // They will be handled by validateRespondentCoverage which adds them to "Ingen holdning fundet"
    const noCommentsArgs = args.filter(arg => arg.isNoComments);
    const substantiveArgs = args.filter(arg => !arg.isNoComments);
    
    // If there are "no comments" arguments, log and exclude them
    if (noCommentsArgs.length > 0) {
      console.log(`[Aggregator] Excluding ${noCommentsArgs.length} "no comments" arguments from "${themeName}" - respondents [${noCommentsArgs.map(a => a.responseNumber).join(', ')}] will be added to "Ingen holdning fundet"`);
    }
    
    // If no substantive arguments remain, return empty (no position to create)
    if (substantiveArgs.length === 0) {
      return [];
    }
    
    // Continue with substantive arguments only
    args = substantiveArgs;
    
    // Results array for any additional groups (currently unused, but kept for potential future use)
    const results = [];

    // With embedding clustering, we shouldn't need recursive batching anymore
    // Each call should already be a reasonably-sized pre-cluster
    if (args.length > 30) {
      console.warn(`[Aggregator] WARNING: groupWithLLM called with ${args.length} arguments - this suggests embedding clustering didn't work`);
    }

    // NEW: Extract primary objects from arguments for object-aware grouping
    const objects = await this.objectExtractor.extractObjects(args);

    // Prepare arguments for LLM - include all key data for rich synthesis + OBJECT + QUOTES
    // We need to preserve sourceQuoteRef or sourceQuote for citation generation later
    const argumentsText = args.map((arg, idx) => {
      const response = allResponses.find(r => r.id === arg.responseNumber);
      const respondentName = response?.respondentName || `Henvendelse ${arg.responseNumber}`;
      const respondentType = response?.respondentType || 'Borger';
      const object = objects[idx];

      // Include coreContent, concern, desiredAction + OBJECT for synthesis
      const parts = [];
      parts.push(`[${idx}] ${respondentName} (${respondentType})`);
      if (object) parts.push(`Objekt: ${object}`);
      if (arg.coreContent) parts.push(`Kerne: ${arg.coreContent}`);
      if (arg.concern) parts.push(`Bekymring: ${arg.concern}`);
      if (arg.desiredAction) parts.push(`Ønske: ${arg.desiredAction}`);

      return parts.join(' | ');
    }).join('\n\n');

    // Prepare responses summary for LLM - only include relevant responses
    const relevantResponseIds = new Set(args.map(a => a.responseNumber));
    const responsesSummary = allResponses
      .filter(r => relevantResponseIds.has(r.id))
      .map(r => ({
        id: r.id,
        name: r.respondentName || `Henvendelse ${r.id}`,
        type: r.respondentType || 'Borger'
      }));

    // Build object-aware grouping guidance
    const objectGuidance = this.buildObjectGuidance(objects);

    // Extract valid responseNumbers and argument indices for validation guidance
    const validResponseNumbers = [...new Set(args.map(a => a.responseNumber))].sort((a, b) => a - b);
    const argumentIndicesList = args.map((_, idx) => idx);

    // Build validation reminder to inject into prompt
    const validationReminder = `
**KRITISK VALIDERINGS-INFO (LÆS DETTE!):**
- Du har modtaget ${args.length} argumenter med indices: [${argumentIndicesList.join(', ')}]
- ALLE disse indices SKAL inkluderes i præcis én gruppe
- Gyldige responseNumbers for denne gruppe: [${validResponseNumbers.join(', ')}]
- citationMap må KUN bruge disse responseNumbers: [${validResponseNumbers.join(', ')}]
- Hvis du skriver "to borgere", SKAL der være præcis 2 responseNumbers`;

    const prompt = this.promptTemplate
      .replace('{themeName}', themeName)
      .replace('{themeDescription}', themeDescription || 'Ingen beskrivelse tilgængelig')
      .replace('{arguments}', argumentsText)
      .replace('{allResponses}', JSON.stringify(responsesSummary, null, 2))
      + `\n\n**VIGTIGT - Objektbaseret gruppering:**\n${objectGuidance}`
      + validationReminder;

    try {
      console.log(`[Aggregator] Calling LLM (${client.model}) for theme "${themeName}" with ${args.length} arguments...`);

      // Create a timeout promise (fails after 3 minutes)
      const timeoutMs = 180000;
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`LLM call timed out after ${timeoutMs / 1000}s`)), timeoutMs);
      });

      const response = await Promise.race([
        client.createCompletion({
          messages: [
            {
              role: 'system',
              content: 'Du er en specialist i at gruppere og opsummere høringssvar.'
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          response_format: getResponseFormat('aggregatorPositions')
        }),
        timeoutPromise
      ]);

      console.log(`[Aggregator] LLM responded for theme "${themeName}"`);

      let content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No content in completion');
      }

      // Clean content: remove markdown code blocks if present
      content = content.trim();
      if (content.startsWith('```json')) {
        content = content.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
      } else if (content.startsWith('```')) {
        content = content.replace(/^```\s*/i, '').replace(/\s*```$/i, '');
      }
      content = content.trim();

      // Try to extract JSON if wrapped in other text
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        content = jsonMatch[0];
      }

      // Clean control characters that break JSON parsing
      content = content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

      const parsed = JSON.parse(content);

      // Convert LLM groups back to argument groups
      const groups = [];
      const usedIndices = new Set();
      
      if (parsed.groups && Array.isArray(parsed.groups)) {
        for (const group of parsed.groups) {
          if (group.argumentIndices && Array.isArray(group.argumentIndices)) {
            const groupArgs = group.argumentIndices
              .map(idx => args[idx])
              .filter(arg => arg !== undefined);

            // Track which indices were used
            group.argumentIndices.forEach(idx => {
              if (idx >= 0 && idx < args.length) {
                usedIndices.add(idx);
              }
            });

            if (groupArgs.length > 0) {
              // Generate title from first argument's consequence (LLM no longer generates titles)
              const firstArg = groupArgs[0];
              const generatedTitle = firstArg?.consequence || firstArg?.coreContent || firstArg?.what || 'Holdning';

              // Determine direction from argument majority with confidence scoring
              const directions = groupArgs.map(a => a._direction || a.direction).filter(Boolean);
              const opposeCount = directions.filter(d => ['oppose', 'pro_status_quo', 'against'].includes(d)).length;
              const supportCount = directions.filter(d => ['support', 'pro_change'].includes(d)).length;

              // Calculate confidence (how dominant is the majority direction)
              const totalDirectioned = opposeCount + supportCount;
              const majorityCount = Math.max(opposeCount, supportCount);
              const directionConfidence = totalDirectioned > 0 ? majorityCount / totalDirectioned : 0;

              // Require 1.5x majority for strong direction classification
              let directionGroup = 'neutral'; // Default to neutral, NOT null
              if (opposeCount > supportCount * 1.5) directionGroup = 'against';
              else if (supportCount > opposeCount * 1.5) directionGroup = 'support';

              // Log warning for weak direction confidence (may cause contamination in mega-merge)
              if (directionConfidence > 0 && directionConfidence < 0.6) {
                console.warn(`[Aggregator] ⚠️ Weak direction confidence (${(directionConfidence * 100).toFixed(0)}%) for "${generatedTitle?.slice(0, 50)}..." - may cause contamination`);
              }

              groups.push({
                args: groupArgs, // This preserves the original argument objects with sourceQuoteRef/sourceQuote
                summary: group.summary || '',
                title: generatedTitle,
                responseNumbers: group.responseNumbers || groupArgs.map(a => a.responseNumber),
                respondentBreakdown: group.respondentBreakdown || null,
                citationMap: group.citationMap || [], // LLM-specified citation mappings
                _directionGroup: directionGroup,
                _directionConfidence: directionConfidence
              });
            }
          }
        }
      }

      // VALIDATION: Ensure all argument indices are included (prevent lost responses)
      const missingIndices = [];
      for (let i = 0; i < args.length; i++) {
        if (!usedIndices.has(i)) {
          missingIndices.push(i);
        }
      }

      if (missingIndices.length > 0) {
        console.warn(`[Aggregator] LLM missed ${missingIndices.length} arguments: indices [${missingIndices.join(', ')}]. Auto-assigning to best matching group.`);
        
        // Get the missing arguments
        const missingArgs = missingIndices.map(idx => args[idx]).filter(Boolean);
        
        if (missingArgs.length > 0) {
          if (groups.length === 0) {
            // No groups at all - create a catch-all group
            // Generate title from first orphaned argument's consequence
            const firstOrphan = missingArgs[0];
            const orphanTitle = firstOrphan?.consequence || firstOrphan?.coreContent || 'Andre bemærkninger';

            // Determine direction from orphan arguments with confidence scoring
            const orphanDirections = missingArgs.map(a => a._direction || a.direction).filter(Boolean);
            const orphanOpposeCount = orphanDirections.filter(d => ['oppose', 'pro_status_quo', 'against'].includes(d)).length;
            const orphanSupportCount = orphanDirections.filter(d => ['support', 'pro_change'].includes(d)).length;

            // Calculate confidence for orphan group
            const orphanTotalDirectioned = orphanOpposeCount + orphanSupportCount;
            const orphanMajorityCount = Math.max(orphanOpposeCount, orphanSupportCount);
            const orphanDirectionConfidence = orphanTotalDirectioned > 0 ? orphanMajorityCount / orphanTotalDirectioned : 0;

            // Require 1.5x majority for strong direction classification
            let orphanDirectionGroup = 'neutral'; // Default to neutral, NOT null
            if (orphanOpposeCount > orphanSupportCount * 1.5) orphanDirectionGroup = 'against';
            else if (orphanSupportCount > orphanOpposeCount * 1.5) orphanDirectionGroup = 'support';

            groups.push({
              args: missingArgs,
              summary: '',
              title: orphanTitle,
              responseNumbers: missingArgs.map(a => a.responseNumber),
              respondentBreakdown: null,
              citationMap: [],
              _directionGroup: orphanDirectionGroup,
              _directionConfidence: orphanDirectionConfidence
            });
            console.log(`[Aggregator] Created catch-all group for ${missingArgs.length} orphaned arguments`);
          } else {
            // IMPROVED: Find best matching group for each orphaned argument
            for (const orphanArg of missingArgs) {
              const bestGroup = this.findBestMatchingGroup(orphanArg, groups);
              bestGroup.args.push(orphanArg);
              
              // Update responseNumbers to include the new argument
              const newResponseNumbers = [...new Set([
                ...bestGroup.responseNumbers,
                orphanArg.responseNumber
              ])].sort((a, b) => a - b);
              bestGroup.responseNumbers = newResponseNumbers;
            }
            
            // Log which groups received orphaned arguments
            const groupsWithOrphans = new Map();
            for (const orphanArg of missingArgs) {
              for (const group of groups) {
                if (group.args.includes(orphanArg)) {
                  const count = groupsWithOrphans.get(group.title) || 0;
                  groupsWithOrphans.set(group.title, count + 1);
                  break;
                }
              }
            }
            for (const [title, count] of groupsWithOrphans.entries()) {
              console.log(`[Aggregator] Added ${count} orphaned argument(s) to group "${title}"`);
            }
          }
        }
      }

      // If LLM didn't return valid groups, fall back to rule-based
      if (groups.length === 0) {
        console.warn('[Aggregator] LLM grouping returned no groups, falling back to rule-based');
        return [...results, ...this.groupByConsequence(args)];
      }

      // Title is now generated from argument consequence - no validation needed
      // position-title-generator will generate final titles for output

      // Merge "no comments" groups (if any) with substantive groups
      return [...results, ...groups];
    } catch (error) {
      console.warn(`[Aggregator] LLM grouping failed: ${error.message}, falling back to embedding-based clustering`);
      
      // NEW: Use embedding-based clustering as fallback instead of rule-based
      // This produces much better groupings than groupByConsequence
      if (this.embeddingClusterer && args.length > 3) {
        try {
          console.log(`[Aggregator] Attempting embedding-based fallback for ${args.length} arguments...`);
          const clusters = await this.embeddingClusterer.clusterArguments(args, themeName);
          console.log(`[Aggregator] Embedding fallback created ${clusters.length} clusters`);
          
          // Convert clusters to position groups
          const clusterGroups = clusters.map(cluster => ({
            args: cluster,
            title: this.buildTitle(cluster, cluster.map(a => a.responseNumber)),
            summary: '',
            responseNumbers: [...new Set(cluster.map(a => a.responseNumber))],
            citationMap: []
          }));
          return [...results, ...clusterGroups];
        } catch (embeddingError) {
          console.warn(`[Aggregator] Embedding fallback also failed: ${embeddingError.message}, using rule-based`);
          return [...results, ...this.groupByConsequence(args)];
        }
      }
      
      return [...results, ...this.groupByConsequence(args)];
    }
  }

  /**
   * Group arguments by consequence (conflict rule: opposing consequences → separate groups)
   * Fallback method when LLM is not available
   */
  groupByConsequence(args) {
    // Check if all arguments are "no comments" - group them together
    const allNoComments = args.every(arg => arg.isNoComments);
    if (allNoComments) {
      return [{
        args: args,
        isNoCommentsGroup: true
      }];
    }

    if (!this.conflictRule) {
      // No conflict rule: all arguments in one group
      return [{ args }];
    }

    const groups = [];
    const consequenceMap = new Map();

    args.forEach(arg => {
      const consequence = this.extractConsequence(arg.consequence || '');
      const key = consequence.type || 'unknown';

      if (!consequenceMap.has(key)) {
        consequenceMap.set(key, []);
      }

      consequenceMap.get(key).push({
        ...arg,
        consequenceType: consequence.type,
        consequenceDirection: consequence.direction
      });
    });

    // Check for conflicts within same type
    consequenceMap.forEach((args, type) => {
      const directions = new Set(args.map(a => a.consequenceDirection));

      if (directions.size > 1) {
        // Conflicting directions: separate groups
        const positiveGroup = args.filter(a => a.consequenceDirection === 'positive');
        const negativeGroup = args.filter(a => a.consequenceDirection === 'negative');
        const neutralGroup = args.filter(a => a.consequenceDirection === 'neutral');

        if (positiveGroup.length > 0) groups.push({ args: positiveGroup });
        if (negativeGroup.length > 0) groups.push({ args: negativeGroup });
        if (neutralGroup.length > 0) groups.push({ args: neutralGroup });
      } else {
        // Same direction: one group
        groups.push({ args });
      }
    });

    return groups;
  }

  /**
   * Extract consequence type and direction
   */
  extractConsequence(consequenceText) {
    const lower = (consequenceText || '').toLowerCase();

    // Determine direction
    let direction = 'neutral';
    if (lower.includes('ønsk') || lower.includes('støtt') || lower.includes('krav om')) {
      direction = 'positive';
    } else if (lower.includes('modstand') || lower.includes('bekymr') || lower.includes('kritik')) {
      direction = 'negative';
    }

    // Extract type (what is being requested/opposed)
    const typeMatch = lower.match(/(?:ønsk|krav|modstand|bekymr).*?(?:om|mod|vedr\.?)\s*(.+?)(?:\.|$)/);
    const type = typeMatch ? typeMatch[1].trim() : 'general';

    return { type, direction };
  }

  /**
   * CRITICAL FIX: Detect direction from argument content at micro-summary level.
   * This separates project-supporters from preservation-supporters BEFORE clustering.
   *
   * Returns:
   * - 'support': Argument explicitly supports the project/development
   * - 'oppose': Argument explicitly opposes the project/wants preservation
   * - 'neutral': Direction is unclear
   *
   * @param {Object} arg - Argument object from micro-summary
   * @returns {string} 'support', 'oppose', or 'neutral'
   */
  detectDirectionFromArgument(arg) {
    // Check if argument has explicit direction from micro-summarizer
    // The micro-summarizer has PROPOSAL CONTEXT and is more accurate than pattern detection
    if (arg.direction && arg.direction !== 'neutral') {
      // Map micro-summary direction values to our direction values
      let msDirection;
      if (arg.direction === 'pro_change') {
        msDirection = 'support';
      } else if (arg.direction === 'pro_status_quo') {
        msDirection = 'oppose';
      }

      if (msDirection) {
        // Log for debugging, but TRUST the LLM direction
        // The LLM has proposal context and understands that "bevares" can mean SUPPORT
        // for a project that is about preservation/modernization
        return msDirection;
      }
    }

    // No micro-summary direction - return neutral
    // REMOVED: Pattern-based detection with hardcoded SUPPORT_PATTERNS/OPPOSE_PATTERNS
    // Direction must come from LLM semantic understanding, not keyword matching
    return 'neutral';
  }

  /**
   * Tag all arguments with their detected direction.
   * Used before clustering to ensure direction separation.
   *
   * @param {Array} arguments - Array of argument objects
   * @returns {Array} Arguments with _direction tag added
   */
  tagArgumentsWithDirection(args) {
    let supportCount = 0;
    let opposeCount = 0;
    let neutralCount = 0;

    const tagged = args.map(arg => {
      const direction = this.detectDirectionFromArgument(arg);
      if (direction === 'support') supportCount++;
      else if (direction === 'oppose') opposeCount++;
      else neutralCount++;

      return {
        ...arg,
        _direction: direction
      };
    });

    if (supportCount > 0 || opposeCount > 0) {
      console.log(`[Aggregator] Direction tagging: ${supportCount} support, ${opposeCount} oppose, ${neutralCount} neutral`);
    }

    return tagged;
  }

  /**
   * Separate arguments by direction for direction-aware processing.
   * Project supporters and preservation supporters should be processed separately.
   *
   * @param {Array} args - Tagged arguments with _direction
   * @returns {Object} { supportArgs, opposeArgs, neutralArgs }
   */
  separateByDirection(args) {
    const supportArgs = args.filter(a => a._direction === 'support');
    const opposeArgs = args.filter(a => a._direction === 'oppose');
    const neutralArgs = args.filter(a => a._direction === 'neutral');

    return { supportArgs, opposeArgs, neutralArgs };
  }

  /**
   * Aggregate a position group
   */
  async aggregatePosition(group, themeName, chunks, materials, allResponses = []) {
    const args = group.args || group;
    const responseNumbers = [...new Set(args.map(a => a.responseNumber))].sort((a, b) => a - b);

    // Use LLM-generated summary if available, otherwise build one
    let summary;
    let title;
    let citationMap;

    if (group.summary && group.title) {
      // Use LLM-generated content
      summary = group.summary;
      title = group.title;
      citationMap = group.citationMap || [];
    } else {
      // FIX: Generate summary via LLM instead of rule-based fallback
      // This produces flowing prose instead of fragmented "En borger krav om..." text
      const generated = await this.generatePositionSummaryWithLLM({
        args, responseNumbers, allResponses, themeName
      });
      summary = generated.summary;
      title = generated.title || group.title || this.buildTitle(args, responseNumbers);
      citationMap = [];
    }

    // FIX: ALTID genberegn respondentBreakdown fra faktiske responseNumbers
    // LLM'en genererer ofte inkonsistent data (fx "2 borgere" men kun 1 responseNumber)
    const respondentBreakdown = this.buildRespondentBreakdown(args, responseNumbers, allResponses);

    // FIX: Valider og fix citationMap - fjern responseNumbers der ikke er i position
    const validatedCitationMap = this.validateCitationMap(citationMap, responseNumbers);

    // NOTE: Previously retrieved relevantChunks here but it was never used.
    // Removed to eliminate hundreds of unnecessary embedding API calls during aggregation.
    // If chunk retrieval is needed in the future, use pre-embedding batch approach.

    // Extract material references
    const materialReferences = this.extractMaterialReferences(args);

    // FIX: Preserve specific argument references so position-writer knows EXACTLY 
    // which arguments belong to this position (not all arguments from a response)
    // This prevents summary/citation mismatch when a response has multiple arguments
    const sourceArgumentRefs = args.map(arg => ({
      responseNumber: arg.responseNumber,
      sourceQuoteRef: arg.sourceQuoteRef || null,
      // Fallback: include what/coreContent for matching if no citation ref
      what: arg.what || arg.coreContent || null,
      // STANCE FIX: Preserve direction for stance-conflict detection in quality validator
      direction: arg.direction || arg._direction || null
    }));

    // ENHANCED ATTRIBUTION: Expand responseNumbers with copy/paste group members
    // This ensures all respondents who submitted similar text are attributed
    const expandedResponseNumbers = this.expandWithCopyPasteGroups(
      responseNumbers,
      themeName,
      allResponses
    );

    // Recalculate respondentBreakdown if we expanded
    const finalRespondentBreakdown = expandedResponseNumbers.length > responseNumbers.length
      ? this.buildRespondentBreakdown(args, expandedResponseNumbers, allResponses)
      : respondentBreakdown;

    // DIRECTION-FIRST FIX: Propagate direction from group to position
    // This prevents consolidation from mixing opposite-direction respondents
    const positionDirection = this.determinePositionDirection(group, sourceArgumentRefs);

    return {
      title: title,
      responseNumbers: expandedResponseNumbers,
      summary: summary,
      materialReferences: materialReferences,
      respondentBreakdown: finalRespondentBreakdown,
      citationMap: validatedCitationMap,
      citations: [],
      subPositions: group.subPositions || [],
      sourceArgumentRefs: sourceArgumentRefs,
      _expandedViaCopyPaste: expandedResponseNumbers.length > responseNumbers.length,
      _originalResponseNumbers: responseNumbers.length !== expandedResponseNumbers.length ? responseNumbers : undefined,
      // DIRECTION-FIRST: Position-level direction markers
      _direction: positionDirection,
      _immutableDirection: positionDirection !== null // If we have a direction, it's immutable
    };
  }

  /**
   * Determine position's direction from group metadata or argument directions.
   * Returns 'pro_change', 'pro_status_quo', 'neutral', or null if mixed/unknown.
   * @private
   */
  determinePositionDirection(group, sourceArgumentRefs) {
    // PRIORITY 1: Use explicit _directionGroup from direction-aware separation
    if (group._directionGroup) {
      // Map internal labels to standard direction values
      const directionMap = {
        'support': 'pro_change',
        'oppose': 'pro_status_quo',
        'neutral': 'neutral'
      };
      return directionMap[group._directionGroup] || group._directionGroup;
    }

    // PRIORITY 2: Calculate from argument directions (majority vote)
    if (sourceArgumentRefs && sourceArgumentRefs.length > 0) {
      const directionCounts = { pro_change: 0, pro_status_quo: 0, neutral: 0 };

      for (const ref of sourceArgumentRefs) {
        const dir = ref.direction;
        if (dir === 'pro_change' || dir === 'support') {
          directionCounts.pro_change++;
        } else if (dir === 'pro_status_quo' || dir === 'oppose') {
          directionCounts.pro_status_quo++;
        } else {
          directionCounts.neutral++;
        }
      }

      const total = sourceArgumentRefs.length;
      const dominant = Object.entries(directionCounts).sort((a, b) => b[1] - a[1])[0];

      // Only assign direction if >60% agree (clear majority)
      if (dominant[1] / total > 0.6) {
        return dominant[0];
      }
    }

    return null; // Mixed or unknown - don't lock direction
  }

  /**
   * Expand responseNumbers with copy/paste group members
   * Uses safety check to avoid including respondents who expressed different opinions in same theme
   *
   * @param {Array<number>} responseNumbers - Original response numbers
   * @param {string} themeName - Current theme name (for conflict detection)
   * @param {Array} allResponses - All responses (for _copyPasteGroup annotations)
   * @returns {Array<number>} Expanded response numbers
   */
  expandWithCopyPasteGroups(responseNumbers, themeName, allResponses = []) {
    if (!this.copyPasteGroups || this.copyPasteGroups.length === 0) {
      return responseNumbers;
    }

    const expandedNumbers = new Set(responseNumbers);
    let addedCount = 0;

    for (const rn of responseNumbers) {
      // Find the copy/paste group this response belongs to
      const group = this.copyPasteGroups.find(g => g.responseNumbers.includes(rn));

      if (group) {
        for (const groupMember of group.responseNumbers) {
          if (!expandedNumbers.has(groupMember)) {
            // SAFETY CHECK: Check if this respondent already has arguments in THIS theme
            // If they do, they may have made meaningful variations we shouldn't override
            const response = allResponses.find(r => (r.id || r.responseNumber) === groupMember);
            const hasExistingArgumentsInTheme = response?._themeArguments?.[themeName]?.length > 0;

            if (!hasExistingArgumentsInTheme) {
              expandedNumbers.add(groupMember);
              addedCount++;
            } else {
              console.log(`[Aggregator] Skipping copy/paste expansion: response ${groupMember} already has arguments in theme "${themeName}"`);
            }
          }
        }
      }
    }

    if (addedCount > 0) {
      console.log(`[Aggregator] Expanded position in "${themeName}" from ${responseNumbers.length} to ${expandedNumbers.size} via copy/paste groups (+${addedCount})`);
    }

    return [...expandedNumbers].sort((a, b) => a - b);
  }

  /**
   * Validate and fix citationMap to only contain responseNumbers from the position
   * LLM often hallucinates responseNumbers that don't belong to the position
   * Also validates that count words in text match the number of responseNumbers
   * @private
   */
  validateCitationMap(citationMap, validResponseNumbers) {
    if (!citationMap || !Array.isArray(citationMap)) {
      return [];
    }

    const validSet = new Set(validResponseNumbers);
    const validated = [];
    let removedCount = 0;
    let countMismatchCount = 0;

    // Danish number words to check for count validation (1-20)
    // After 20, we expect digits like "21 borgere" not "enogtyve borgere"
    const numberWords = {
      'en borger': 1, 'én borger': 1,
      'to borgere': 2,
      'tre borgere': 3,
      'fire borgere': 4,
      'fem borgere': 5,
      'seks borgere': 6,
      'syv borgere': 7,
      'otte borgere': 8,
      'ni borgere': 9,
      'ti borgere': 10,
      'elleve borgere': 11,
      'tolv borgere': 12,
      'tretten borgere': 13,
      'fjorten borgere': 14,
      'femten borgere': 15,
      'seksten borgere': 16,
      'sytten borgere': 17,
      'atten borgere': 18,
      'nitten borgere': 19,
      'tyve borgere': 20
    };

    // Helper: extract expected count from highlight text
    // Matches longest Danish number word first, then falls back to numeric patterns
    function extractExpectedCount(highlightLower) {
      // Sort by word length descending to match longest first (e.g. "tretten" before "tre")
      const sortedEntries = Object.entries(numberWords).sort((a, b) => b[0].length - a[0].length);
      
      for (const [word, count] of sortedEntries) {
        // Use word boundary check: must be at start or after non-letter
        const pattern = new RegExp(`(?:^|[^\\p{L}])${word.replace(/\s+/g, '\\s+')}(?:[^\\p{L}]|$)`, 'u');
        if (pattern.test(highlightLower)) {
          return count;
        }
      }
      
      // Check for numeric pattern: "21 borgere", "35 borgere" etc.
      const numericMatch = highlightLower.match(/(?:^|[^\d])(\d+)\s+borgere?(?:[^\p{L}]|$)/u);
      if (numericMatch) {
        return parseInt(numericMatch[1], 10);
      }

      return null;
    }

    // Helper: correct the count word in a highlight to match actual count
    function correctLabelCount(highlight, actualCount, numberWordsMap) {
      // Build reverse map: count → [word patterns]
      const countToWords = {};
      for (const [word, count] of Object.entries(numberWordsMap)) {
        if (!countToWords[count]) countToWords[count] = [];
        countToWords[count].push(word);
      }

      // Generate the correct Danish label using DanishNumberFormatter
      const correctLabel = DanishNumberFormatter.formatWithNoun(actualCount, 'borger');

      // Try to find and replace existing number patterns
      let result = highlight;

      // 1. Try to replace Danish number word patterns (e.g., "to borgere" → "tre borgere")
      for (const [word] of Object.entries(numberWordsMap)) {
        // Create case-insensitive pattern that preserves surrounding text
        const escapedWord = word.replace(/\s+/g, '\\s+');
        const pattern = new RegExp(`(^|[^\\p{L}])(${escapedWord})([^\\p{L}]|$)`, 'ui');

        if (pattern.test(result)) {
          result = result.replace(pattern, (match, before, _, after) => {
            return before + correctLabel + after;
          });
          return result.trim();
        }
      }

      // 2. Try to replace numeric patterns (e.g., "21 borgere" → "15 borgere")
      const numericPattern = /(\d+)\s+(borgere?)/i;
      if (numericPattern.test(result)) {
        result = result.replace(numericPattern, correctLabel);
        return result.trim();
      }

      // 3. Could not find a pattern to replace - return original
      return highlight;
    }

    for (const entry of citationMap) {
      if (!entry.highlight || !entry.responseNumbers) continue;

      // Filter to only valid responseNumbers (remove duplicates too)
      const uniqueResponseNumbers = [...new Set(entry.responseNumbers)];
      const filteredResponseNumbers = uniqueResponseNumbers.filter(num => validSet.has(num));

      if (filteredResponseNumbers.length > 0) {
        // Check if highlight contains a number word and validate count
        const highlightLower = entry.highlight.toLowerCase();
        const expectedCount = extractExpectedCount(highlightLower);

        // If we found a number word, validate the count matches
        let correctedHighlight = entry.highlight;
        if (expectedCount !== null && filteredResponseNumbers.length !== expectedCount) {
          countMismatchCount++;

          // AUTO-CORRECT: Replace the count word in the highlight with the correct count
          const actualCount = filteredResponseNumbers.length;
          correctedHighlight = correctLabelCount(entry.highlight, actualCount, numberWords);

          if (correctedHighlight !== entry.highlight) {
            console.log(`[Aggregator] 🔧 Auto-corrected label: "${entry.highlight}" → "${correctedHighlight}" (was ${expectedCount}, now ${actualCount})`);
          } else if (countMismatchCount <= 3 || process.env.DEBUG) {
            // Could not auto-correct, log warning
            console.warn(`[Aggregator] citationMap count mismatch: "${entry.highlight}" implies ${expectedCount} but has ${actualCount} responseNumbers [${filteredResponseNumbers}]`);
          }
        }

        validated.push({
          highlight: correctedHighlight,
          responseNumbers: filteredResponseNumbers
        });
      } else {
        // Only log details for first 3 removals to reduce noise
        if (removedCount < 3 || process.env.DEBUG) {
          console.warn(`[Aggregator] Removed invalid citationMap entry "${entry.highlight}" - none of [${entry.responseNumbers}] are in position [${validResponseNumbers}]`);
        }
        removedCount++;
      }
    }

    // Log summary if any entries were removed
    if (removedCount > 0) {
      console.warn(`[Aggregator] Removed ${removedCount} invalid citationMap entries total (LLM hallucinated responseNumbers)`);
    }

    // Log summary of count mismatches
    if (countMismatchCount > 0) {
      console.warn(`[Aggregator] Found ${countMismatchCount} citationMap entries with count mismatches (text says X borgere but has Y responseNumbers)`);
    }

    return validated;
  }

  /**
   * Build query for position retrieval
   */
  buildQueryForPosition(args, themeName) {
    const coreContents = args
      .map(a => a.coreContent || a.concern || '')
      .filter(c => c.length > 0)
      .slice(0, 3)
      .join(' ');

    return `${themeName} ${coreContents}`.slice(0, 200);
  }

  /**
   * Build summary text with better formatting
   */
  buildSummary(args, responseNumbers, allResponses = []) {
    // Group by consequence
    const consequences = new Map();
    args.forEach(arg => {
      const cons = arg.consequence || 'Generel holdning';
      if (!consequences.has(cons)) {
        consequences.set(cons, []);
      }
      consequences.get(cons).push(arg);
    });

    const summaryParts = [];
    consequences.forEach((argGroup, consequence) => {
      const breakdown = this.buildRespondentBreakdown(argGroup,
        [...new Set(argGroup.map(a => a.responseNumber))],
        allResponses);

      // Build respondent reference
      let respondentRef = '';
      if (breakdown.localCommittees.length > 0) {
        respondentRef = breakdown.localCommittees.join(' og ');
        if (breakdown.citizens > 0) {
          respondentRef += ` og ${breakdown.citizens} ${breakdown.citizens === 1 ? 'borger' : 'borgere'}`;
        }
      } else if (breakdown.publicAuthorities.length > 0) {
        respondentRef = breakdown.publicAuthorities.join(' og ');
        if (breakdown.citizens > 0) {
          respondentRef += ` og ${breakdown.citizens} ${breakdown.citizens === 1 ? 'borger' : 'borgere'}`;
        }
      } else if (breakdown.organizations.length > 0) {
        respondentRef = breakdown.organizations.join(' og ');
        if (breakdown.citizens > 0) {
          respondentRef += ` og ${breakdown.citizens} ${breakdown.citizens === 1 ? 'borger' : 'borgere'}`;
        }
      } else if (breakdown.citizens > 0) {
        if (breakdown.citizens === 1) {
          respondentRef = 'En borger';
        } else {
          respondentRef = `${breakdown.citizens} borgere`;
        }
      } else {
        respondentRef = 'Respondenterne';
      }

      summaryParts.push(`${respondentRef} ${consequence.toLowerCase()}`);
    });

    return summaryParts.join('. ') + '.';
  }

  /**
   * Generate flowing prose summary via LLM when aggregation didn't produce one.
   * Uses light complexity for cost efficiency while ensuring proper Danish grammar.
   *
   * @param {Object} params - Parameters
   * @param {Array} params.args - Arguments to summarize
   * @param {Array} params.responseNumbers - Response numbers
   * @param {Array} params.allResponses - All responses for respondent info
   * @param {string} params.themeName - Theme name for context
   * @returns {Object} { summary, title }
   */
  async generatePositionSummaryWithLLM({ args, responseNumbers, allResponses, themeName }) {
    const breakdown = this.buildRespondentBreakdown(args, responseNumbers, allResponses);

    // Build respondent label
    let respondentLabel;
    if (breakdown.localCommittees.length > 0) {
      respondentLabel = breakdown.localCommittees.join(' og ');
      if (breakdown.citizens > 0) {
        respondentLabel += ` og ${breakdown.citizens} ${breakdown.citizens === 1 ? 'borger' : 'borgere'}`;
      }
    } else if (breakdown.organizations.length > 0) {
      respondentLabel = breakdown.organizations.join(' og ');
      if (breakdown.citizens > 0) {
        respondentLabel += ` og ${breakdown.citizens} ${breakdown.citizens === 1 ? 'borger' : 'borgere'}`;
      }
    } else if (breakdown.citizens === 1) {
      respondentLabel = 'Én borger';
    } else {
      respondentLabel = `${breakdown.citizens} borgere`;
    }

    const input = {
      theme: themeName,
      respondentLabel,
      respondentCount: responseNumbers.length,
      arguments: args.slice(0, 8).map(a => ({
        what: a.what || a.coreContent || '',
        why: a.concern || a.why || '',
        consequence: a.consequence || ''
      }))
    };

    const prompt = `Skriv en kort, flydende forvaltningsprosa-opsummering (2-4 sætninger) for denne position:

Tema: ${input.theme}
Respondenter: ${input.respondentLabel}

Argumenter:
${input.arguments.map((a, i) => `${i + 1}. ${a.what}${a.why ? ` (Bekymring: ${a.why})` : ''}`).join('\n')}

Krav:
- Brug aktive verber: "anfører", "vurderer", "påpeger", "fremhæver", "udtrykker"
- Start med respondent-label: "${input.respondentLabel} anfører..." eller "${input.respondentLabel} udtrykker..."
- Administrativ tone, ingen følelsesladet sprog
- Hvis flere argumenter, syntetiser dem til en sammenhængende tekst
- Returnér JSON: { "summary": "...", "title": "..." }

Titel skal være en holdning, fx "Ønske om bevaring af..." eller "Bekymring for..."`;

    try {
      const client = this.lightClient || this.client;
      const result = await client.createCompletion({
        messages: [
          { role: 'system', content: 'Du er en specialist i at skrive præcise, administrative opsummeringer af høringssvar. Returnér altid valid JSON.' },
          { role: 'user', content: prompt }
        ],
        response_format: { type: 'json_object' }
      });

      const content = result.choices?.[0]?.message?.content || result.content;
      const parsed = JSON.parse(content);
      console.log(`[Aggregator] Generated LLM summary for "${themeName}" with ${responseNumbers.length} respondents`);
      return {
        summary: parsed.summary || this.buildSummary(args, responseNumbers, allResponses),
        title: parsed.title || null
      };
    } catch (error) {
      console.warn(`[Aggregator] LLM summary generation failed: ${error.message}, using rule-based fallback`);
      return {
        summary: this.buildSummary(args, responseNumbers, allResponses),
        title: null
      };
    }
  }

  /**
   * Extract key objects/entities from text for validation
   * @private
   */
  extractKeyObjects(text) {
    // Common words to exclude
    const stopWords = new Set([
      'i', 'og', 'af', 'til', 'en', 'et', 'den', 'det', 'de', 'som', 'for', 'med', 'på',
      'om', 'er', 'vil', 'kan', 'skal', 'har', 'være', 'der', 'at', 'ikke', 'fra',
      'ønske', 'krav', 'modstand', 'bekymring', 'forslag', 'støtte', 'holdning',
      'høringssvar', 'høringssvarene', 'respondent', 'borger', 'borgere'
    ]);
    
    // Extract words > 4 chars that aren't stopwords
    const words = text.toLowerCase()
      .split(/[\s,.\-:;()"']+/)
      .filter(w => w.length > 4 && !stopWords.has(w));
    
    // Return unique keywords
    return [...new Set(words)].slice(0, 10);
  }

  /**
   * Build respondent breakdown
   */
  buildRespondentBreakdown(args, responseNumbers, allResponses = []) {
    const breakdown = {
      localCommittees: [],
      publicAuthorities: [],
      organizations: [],
      citizens: 0,
      total: responseNumbers.length
    };

    // Map response numbers to actual responses
    responseNumbers.forEach(responseNumber => {
      const response = allResponses.find(r => r.id === responseNumber);
      if (!response) {
        breakdown.citizens++;
        return;
      }

      const respondentType = (response.respondentType || '').toLowerCase();
      const respondentName = response.respondentName || '';

      // Check for Local Committee (Lokaludvalg)
      if (respondentType.includes('lokaludvalg') ||
        respondentName.toLowerCase().includes('lokaludvalg')) {
        const name = respondentName || `Henvendelse ${responseNumber}`;
        if (!breakdown.localCommittees.includes(name)) {
          breakdown.localCommittees.push(name);
        }
      }
      // Check for Organization (based on respondentType and name)
      else if (respondentType.includes('organisation') ||
        (respondentName &&
          !respondentType.includes('borger') &&
          !respondentType.includes('privat') &&
          !respondentType.includes('myndighed'))) {
        if (respondentName && !breakdown.organizations.includes(respondentName)) {
          breakdown.organizations.push(respondentName);
        }
      }
      // Check for Public Authority
      else if (respondentType.includes('myndighed') ||
        respondentType.includes('forvaltning') ||
        respondentName.toLowerCase().includes('kommune') ||
        respondentName.toLowerCase().includes('ministerium')) {
        const name = respondentName || `Henvendelse ${responseNumber}`;
        if (!breakdown.publicAuthorities.includes(name)) {
          breakdown.publicAuthorities.push(name);
        }
      }
      // Default to citizen
      else {
        breakdown.citizens++;
      }
    });

    return breakdown;
  }

  /**
   * Build title - just return the consequence text, prefix is added by output formatter
   */
  buildTitle(args, responseNumbers) {
    // Extract consequence from first argument
    const consequence = args[0]?.consequence || args[0]?.coreContent || args[0]?.concern || 'Holdning';

    // Clean up consequence to be a proper title
    let title = consequence.trim();

    // Capitalize first letter
    if (title.length > 0) {
      title = title.charAt(0).toUpperCase() + title.slice(1);
    }

    return title;
  }

  /**
   * Extract material references from arguments
   */
  extractMaterialReferences(args) {
    const references = [];
    const seen = new Set();

    args.forEach(arg => {
      (arg.materialReferences || []).forEach(ref => {
        const key = `${ref.type}:${ref.reference}`;
        if (!seen.has(key)) {
          seen.add(key);
          references.push(ref);
        }
      });
    });

    return references;
  }

  /**
   * Find the best matching group for an orphaned argument
   * Uses text similarity to find the most semantically similar group
   * @param {Object} orphanArg - The orphaned argument to place
   * @param {Array} groups - Available groups to choose from
   * @returns {Object} The best matching group
   * @private
   */
  findBestMatchingGroup(orphanArg, groups) {
    if (groups.length === 0) return null;
    if (groups.length === 1) return groups[0];

    // Create a text representation of the orphan argument
    const orphanText = this.getArgumentText(orphanArg).toLowerCase();
    
    let bestGroup = groups[0];
    let bestScore = -1;

    for (const group of groups) {
      // Calculate similarity score based on:
      // 1. Title similarity
      // 2. Average argument content similarity
      // 3. Same consequence type bonus
      
      let score = 0;
      
      // Title similarity (simple word overlap)
      const titleWords = new Set((group.title || '').toLowerCase().split(/\s+/));
      const orphanWords = orphanText.split(/\s+/);
      const titleOverlap = orphanWords.filter(w => w.length > 3 && titleWords.has(w)).length;
      score += titleOverlap * 2;

      // Content similarity with existing arguments
      let contentScore = 0;
      for (const existingArg of group.args) {
        const existingText = this.getArgumentText(existingArg).toLowerCase();
        const existingWords = new Set(existingText.split(/\s+/).filter(w => w.length > 3));
        const matchingWords = orphanWords.filter(w => w.length > 3 && existingWords.has(w)).length;
        contentScore += matchingWords;
      }
      score += contentScore / Math.max(group.args.length, 1);

      // Bonus for same consequence type
      const orphanConsequence = (orphanArg.consequence || '').toLowerCase();
      const groupConsequence = (group.args[0]?.consequence || '').toLowerCase();
      if (orphanConsequence && groupConsequence) {
        // Check for same direction (Modstand, Ønske, Støtte, etc.)
        const directions = ['modstand', 'ønske', 'støtte', 'bekymring', 'forslag'];
        for (const dir of directions) {
          if (orphanConsequence.includes(dir) && groupConsequence.includes(dir)) {
            score += 3;
            break;
          }
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestGroup = group;
      }
    }

    return bestGroup;
  }

  /**
   * Get text representation of an argument for similarity comparison
   * @private
   */
  getArgumentText(arg) {
    const parts = [];
    if (arg.coreContent) parts.push(arg.coreContent);
    if (arg.concern) parts.push(arg.concern);
    if (arg.desiredAction) parts.push(arg.desiredAction);
    if (arg.consequence) parts.push(arg.consequence);
    return parts.join(' ');
  }

  /**
   * Build object-aware grouping guidance for LLM
   * @param {Array} objects - Extracted objects for each argument
   * @returns {string} Guidance text for LLM
   */
  buildObjectGuidance(objects) {
    const objectCounts = new Map();
    const nullCount = objects.filter(o => !o).length;

    objects.forEach(obj => {
      if (obj) {
        objectCounts.set(obj, (objectCounts.get(obj) || 0) + 1);
      }
    });

    if (objectCounts.size === 0) {
      return 'Ingen specifik objekt-information tilgængelig. Grupper baseret på semantisk lighed.';
    }

    const objectList = Array.from(objectCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([obj, count]) => `  - "${obj}" (${count} argument${count > 1 ? 'er' : ''})`)
      .join('\n');

    const guidance = `Argumenterne refererer til følgende objekter:
${objectList}
${nullCount > 0 ? `  - Ingen specifikt objekt (${nullCount} argument${nullCount > 1 ? 'er' : ''})` : ''}

**GRUPPERINGS-REGLER:**
✅ GRUPPER SAMMEN hvis:
  - SAMME objekt + forskellige aspekter (fx "Palads facaden" + "Palads foyer" → samme gruppe)
  - SAMME objekt + forskellige bekymringer (fx "Bygning A højde" + "Bygning A skygge" → samme gruppe)
  - Objekt-navne er synonymer eller tæt relaterede (fx "Palads" = "Biografen" = "Bygningen")
  - Argumenter uden objekt kan grupperes med hvilken som helst anden relevant gruppe

❌ HOLD SEPARAT hvis:
  - Objekterne er TYDELIGT FORSKELLIGE og geografisk adskilte (fx "støj fra Gammel Køge Landevej" ≠ "støj fra boldbane")
  - Det handler om helt forskellige bygninger/områder (fx "Bygning A" ≠ "Bygning B")

Når du grupperer, FOKUSER PÅ GRUNDHOLDNINGEN. Hvis to borgere mener det samme, skal de være i samme gruppe, medmindre de taler om helt forskellige steder.`;

    return guidance;
  }

  /**
   * QUALITY FIX: Detect prominent out-of-scope topics that might be underrepresented
   * Topics in "Andre emner" that affect 10%+ of respondents should be flagged
   *
   * @param {Array} themes - All aggregated themes
   * @param {Array} allResponses - All responses for total count
   */
  detectProminentOutOfScopeTopics(themes, allResponses) {
    const andreEmner = themes.find(t => t.name === 'Andre emner' || t.name === 'Generelt');
    if (!andreEmner || !andreEmner.positions?.length) {
      return;
    }

    const totalResponses = allResponses?.length || 0;
    if (totalResponses === 0) return;

    const prominenceThreshold = totalResponses * 0.10; // 10% threshold

    // Check each position in "Andre emner" for prominence
    const prominentTopics = [];

    for (const position of andreEmner.positions) {
      const respondentCount = position.responseNumbers?.length || 0;

      if (respondentCount >= prominenceThreshold) {
        // Extract key topics from title/summary
        const keywords = this.extractKeyTopics(position.title, position.summary || '');

        prominentTopics.push({
          title: position.title,
          respondentCount,
          percentage: ((respondentCount / totalResponses) * 100).toFixed(1),
          keywords
        });
      }
    }

    if (prominentTopics.length > 0) {
      console.log(`[Aggregator] ⚠️ PROMINENT OUT-OF-SCOPE TOPICS DETECTED (≥10% respondents):`);
      for (const topic of prominentTopics) {
        console.log(`  - "${topic.title?.slice(0, 60)}..." (${topic.respondentCount} respondenter, ${topic.percentage}%)`);
        if (topic.keywords.length > 0) {
          console.log(`    Keywords: ${topic.keywords.join(', ')}`);
        }
      }
      console.log(`[Aggregator] These topics under "Andre emner" have significant respondent support and should remain visible.`);

      // Add metadata to the theme for downstream processing
      andreEmner._prominentTopics = prominentTopics;
    }
  }

  /**
   * Extract key topics/keywords from position text
   * @private
   */
  extractKeyTopics(title, summary) {
    const text = `${title} ${summary}`.toLowerCase();

    // Danish stop words to exclude
    const stopWords = new Set([
      'og', 'i', 'at', 'det', 'er', 'en', 'et', 'den', 'til', 'på', 'med', 'for',
      'som', 'af', 'de', 'om', 'har', 'vil', 'kan', 'skal', 'ikke', 'der', 'være',
      'fra', 'eller', 'ved', 'efter', 'over', 'også', 'men', 'sig', 'så', 'blev',
      'bliver', 'hele', 'alle', 'mange', 'flere', 'andre', 'hver', 'dette', 'denne'
    ]);

    // Extract meaningful words (>4 chars, not stop words)
    const words = text
      .split(/[\s,.\-:;()"']+/)
      .filter(w => w.length > 4 && !stopWords.has(w))
      .reduce((acc, word) => {
        acc.set(word, (acc.get(word) || 0) + 1);
        return acc;
      }, new Map());

    // Return top 5 most frequent keywords
    return Array.from(words.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);
  }

  /**
   * Get reasoning dimensions configuration.
   * These are GENERIC categories that apply to ANY hearing type - not case-specific.
   *
   * CRITICAL: These dimensions enable nuance-aware grouping - arguments with different
   * reasoning (climate vs heritage vs aesthetics) should become SEPARATE positions,
   * not one mega-position.
   *
   * The keywords are general Danish terms that indicate reasoning types,
   * NOT specific objects or places from any particular hearing.
   *
   * @returns {Object} Reasoning dimensions with labels and keywords
   */
  getReasoningDimensions() {
    return {
      // === GENERISKE BEGRUNDELSESTYPER (gælder alle høringer) ===
      klima: {
        label: 'Klima/miljø',
        keywords: ['co2', 'klima', 'klimaaftryk', 'bæredygtighed', 'miljø', 'genbrug', 'ressourceforbrug', 'cirkulær', 'udledning', 'affald', 'energi']
      },
      kulturarv: {
        label: 'Kulturarv/historie',
        keywords: ['kulturhistorisk', 'kulturarv', 'historisk', 'bevaringsværdig', 'kulturhistorie', 'fredning', 'kulturminde', 'fortidsminde']
      },
      æstetik: {
        label: 'Æstetik/arkitektur',
        keywords: ['arkitektur', 'udseende', 'visuelt', 'æstetisk', 'facade', 'design', 'stil', 'smuk', 'grim']
      },
      identitet: {
        label: 'Identitet/lokalområde',
        keywords: ['vartegn', 'landmærke', 'symbol', 'identitet', 'tilhørsforhold', 'karakter', 'sjæl', 'særpræg']
      },
      funktion: {
        label: 'Funktion/anvendelse',
        keywords: ['anvendelse', 'funktion', 'brug', 'formål', 'aktivitet', 'institution', 'offentlig']
      },
      demokrati: {
        label: 'Demokrati/proces',
        keywords: ['borgerinddragelse', 'høring', 'transparens', 'proces', 'beslutning', 'demokrati', 'inddragelse', 'dialog']
      },
      økonomi: {
        label: 'Økonomi/ressourcer',
        keywords: ['økonomi', 'pris', 'budget', 'investering', 'finansiering', 'værdi', 'profit', 'omkostning']
      },
      natur: {
        label: 'Natur/grønne områder',
        keywords: ['træ', 'træer', 'grøn', 'natur', 'planter', 'park', 'biodiversitet', 'dyreliv', 'vegetation']
      },
      trafik: {
        label: 'Trafik/infrastruktur',
        keywords: ['parkering', 'trafik', 'vej', 'cykel', 'støj', 'adgang', 'infrastruktur', 'transport']
      },
      social: {
        label: 'Sociale forhold',
        keywords: ['bolig', 'boliger', 'beboer', 'nabo', 'fællesskab', 'trivsel', 'tryghed', 'livskvalitet']
      }
    };
  }

  /**
   * Split arguments by reasoning dimension BEFORE embedding clustering.
   *
   * This ensures that arguments with different reasoning (climate, heritage, aesthetics)
   * are processed separately and don't end up in one mega-position.
   *
   * CRITICAL: This runs AFTER direction-splitting but BEFORE embedding clustering.
   *
   * @param {Array} args - Arguments to split (already direction-filtered)
   * @returns {Object} { dimensionGroups: { [key]: args[] }, unclassified: args[] }
   */
  splitByReasoningDimension(args) {
    const reasoningDimensions = this.getReasoningDimensions();

    // Initialize dimension groups
    const dimensionGroups = {};
    for (const key of Object.keys(reasoningDimensions)) {
      dimensionGroups[key] = [];
    }

    const unclassified = [];
    const classifiedIds = new Set(); // Track which args have been classified

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      // Build text to search from all argument fields
      const searchText = [
        arg.what || arg.coreContent || '',
        arg.why || arg.concern || '',
        arg.how || arg.desiredAction || '',
        arg.consequence || ''
      ].join(' ').toLowerCase();

      // Find which dimensions match
      const matchedDimensions = [];
      for (const [dimKey, dimConfig] of Object.entries(reasoningDimensions)) {
        if (dimConfig.keywords.some(kw => searchText.includes(kw.toLowerCase()))) {
          matchedDimensions.push(dimKey);
        }
      }

      if (matchedDimensions.length === 0) {
        // No dimension match - goes to unclassified
        unclassified.push(arg);
      } else if (matchedDimensions.length === 1) {
        // Single dimension - clear classification
        dimensionGroups[matchedDimensions[0]].push(arg);
        classifiedIds.add(i);
        arg._reasoningDimension = matchedDimensions[0];
      } else {
        // Multiple dimensions - assign to FIRST matched (primary dimension)
        // This prevents duplication while preserving main reasoning
        dimensionGroups[matchedDimensions[0]].push(arg);
        classifiedIds.add(i);
        arg._reasoningDimension = matchedDimensions[0];
        arg._multiDimensional = matchedDimensions;
      }
    }

    // Log dimension distribution
    const distribution = Object.entries(dimensionGroups)
      .filter(([_, group]) => group.length > 0)
      .map(([key, group]) => `${reasoningDimensions[key].label}: ${group.length}`);

    if (distribution.length > 0) {
      console.log(`[Aggregator] Reasoning dimension split: ${distribution.join(', ')}, unclassified: ${unclassified.length}`);
    }

    return { dimensionGroups, unclassified, reasoningDimensions };
  }

  /**
   * Process dimension groups into position groups.
   * Each dimension becomes its own cluster that is processed separately.
   *
   * @param {Object} splitResult - Result from splitByReasoningDimension
   * @param {string} themeName - Theme name for logging
   * @param {Array} responses - All responses
   * @param {string} themeDescription - Theme description
   * @returns {Promise<Array>} Position groups from all dimensions
   */
  async processReasoningDimensionGroups(splitResult, themeName, responses, themeDescription) {
    const { dimensionGroups, unclassified, reasoningDimensions } = splitResult;

    const allPositionGroups = [];

    // Process each dimension group separately
    for (const [dimKey, args] of Object.entries(dimensionGroups)) {
      if (args.length === 0) continue;

      const dimLabel = reasoningDimensions[dimKey].label;
      console.log(`[Aggregator] Processing dimension "${dimLabel}" with ${args.length} arguments`);

      // For small groups, create single position
      if (args.length <= 3) {
        allPositionGroups.push({
          args,
          title: '', // Will be generated by LLM or rule-based
          summary: '',
          responseNumbers: [...new Set(args.map(a => a.responseNumber))],
          citationMap: [],
          _reasoningDimension: dimKey,
          _dimensionLabel: dimLabel
        });
        continue;
      }

      // For larger groups, use LLM grouping or embedding clustering
      if (args.length > 10 && this.useEmbeddingClustering) {
        // Use embedding clustering within this dimension
        const preClusters = await this.embeddingClusterer.clusterArguments(args, `${themeName} - ${dimLabel}`);

        // Process each cluster using processCluster() for batch-size safety
        for (const cluster of preClusters) {
          if (this.useLLMGrouping && this.client && this.promptTemplate) {
            // Use LLM grouping directly - processCluster caused over-fragmentation
            const client = this.selectClientForCluster(cluster);
            const groups = await this.groupWithLLMClient(cluster, themeName, responses, client, themeDescription);
            // Tag groups with dimension info
            groups.forEach(g => {
              g._reasoningDimension = dimKey;
              g._dimensionLabel = dimLabel;
            });
            allPositionGroups.push(...groups);
          } else {
            allPositionGroups.push({
              args: cluster,
              _reasoningDimension: dimKey,
              _dimensionLabel: dimLabel
            });
          }
        }
      } else if (this.useLLMGrouping && this.client && this.promptTemplate) {
        // Use LLM grouping directly
        const client = this.selectClientForCluster(args);
        const groups = await this.groupWithLLMClient(args, themeName, responses, client, themeDescription);
        // Tag groups with dimension info
        groups.forEach(g => {
          g._reasoningDimension = dimKey;
          g._dimensionLabel = dimLabel;
        });
        allPositionGroups.push(...groups);
      } else {
        // Fallback
        allPositionGroups.push({
          args,
          _reasoningDimension: dimKey,
          _dimensionLabel: dimLabel
        });
      }
    }

    // Process unclassified arguments
    if (unclassified.length > 0) {
      console.log(`[Aggregator] Processing ${unclassified.length} unclassified arguments`);

      if (unclassified.length > 10 && this.useEmbeddingClustering) {
        const preClusters = await this.embeddingClusterer.clusterArguments(unclassified, `${themeName} - Øvrige`);

        for (const cluster of preClusters) {
          if (this.useLLMGrouping && this.client && this.promptTemplate) {
            // Use LLM grouping directly - processCluster caused over-fragmentation
            const client = this.selectClientForCluster(cluster);
            const groups = await this.groupWithLLMClient(cluster, themeName, responses, client, themeDescription);
            groups.forEach(g => {
              g._reasoningDimension = 'other';
              g._dimensionLabel = 'Øvrige argumenter';
            });
            allPositionGroups.push(...groups);
          } else {
            allPositionGroups.push({
              args: cluster,
              _reasoningDimension: 'other',
              _dimensionLabel: 'Øvrige argumenter'
            });
          }
        }
      } else if (unclassified.length > 0) {
        if (this.useLLMGrouping && this.client && this.promptTemplate) {
          const client = this.selectClientForCluster(unclassified);
          const groups = await this.groupWithLLMClient(unclassified, themeName, responses, client, themeDescription);
          groups.forEach(g => {
            g._reasoningDimension = 'other';
            g._dimensionLabel = 'Øvrige argumenter';
          });
          allPositionGroups.push(...groups);
        } else {
          allPositionGroups.push({
            args: unclassified,
            _reasoningDimension: 'other',
            _dimensionLabel: 'Øvrige argumenter'
          });
        }
      }
    }

    console.log(`[Aggregator] Dimension-aware processing complete: ${allPositionGroups.length} position groups`);
    return allPositionGroups;
  }

  // =========================================================================
  // LARGE SCALE PROCESSING: Sampling + Skeleton + Attribution
  // For themes with 500+ arguments
  // =========================================================================

  /**
   * Process a large-scale theme using hierarchical sampling + attribution.
   *
   * Phase 1: Stratified sampling (N=min(200, 10%))
   * Phase 2: Build skeleton positions from sample using standard clustering
   * Phase 3: Attribute remaining arguments via embedding similarity
   *
   * @param {Array} args - All arguments for this theme
   * @param {string} themeName - Theme name
   * @param {Array} responses - All responses
   * @param {string} themeDescription - Theme description
   * @param {Object} tierConfig - Large tier configuration
   * @returns {Promise<Array>} Position groups
   */
  async processThemeLargeScale(args, themeName, responses, themeDescription, tierConfig) {
    const startTime = Date.now();
    const sampleSize = tierConfig.sampleSize || Math.min(200, Math.ceil(args.length * 0.1));
    const attributionThreshold = tierConfig.attributionThreshold || 0.70;

    console.log(`[Aggregator] UNIFIED: Sampling ${sampleSize} from ${args.length} arguments`);

    // Phase 1: Stratified sampling (or use all if sampleSize >= args.length)
    let sample;
    if (sampleSize >= args.length) {
      sample = args;
      console.log(`[Aggregator] Phase 1: Using ALL ${sample.length} arguments for discovery`);
    } else {
      sample = this.stratifiedSample(args, sampleSize);
    }

    console.log(`[Aggregator] Phase 1: Sampled ${sample.length} from ${args.length} arguments`);

    // Phase 2: LLM Position Discovery (ikke embedding clustering)
    console.log(`[Aggregator] Phase 2: Discovering positions via LLM...`);
    let skeletonPositions;

    // Use LLM to discover distinct positions from sample
    if (this.discoveryPromptTemplate && this.client) {
      skeletonPositions = await this.discoverSkeletonPositions(sample, themeName, themeDescription, args.length);
    } else {
      // Fallback to old method if discovery prompt not available
      console.warn('[Aggregator] Discovery prompt not available, falling back to embedding clustering');
      if (sample.length > 10 && this.useEmbeddingClustering) {
        const preClusters = await this.embeddingClusterer.clusterArguments(sample, themeName);
        console.log(`[Aggregator] Skeleton: ${preClusters.length} clusters from ${sample.length} sample args`);

        if (this.useLLMGrouping && this.client && this.promptTemplate) {
          const clusterTasks = preClusters.map((cluster, i) => async () => {
            const client = this.selectClientForCluster(cluster);
            return this.groupWithLLMClient(cluster, themeName, responses, client, themeDescription);
          });
          const refinedGroups = await limitConcurrency(clusterTasks, 10);
          skeletonPositions = refinedGroups.flat();
        } else {
          skeletonPositions = preClusters.map(cluster => ({
            args: cluster,
            title: this.buildTitle(cluster, cluster.map(a => a.responseNumber)),
            summary: '',
            responseNumbers: [...new Set(cluster.map(a => a.responseNumber))],
            citationMap: []
          }));
        }
      } else if (this.useLLMGrouping && this.client && this.promptTemplate) {
        const client = this.selectClientForCluster(sample);
        skeletonPositions = await this.groupWithLLMClient(sample, themeName, responses, client, themeDescription);
      } else {
        skeletonPositions = [{ args: sample }];
      }
    }

    console.log(`[Aggregator] Phase 2 complete: ${skeletonPositions.length} skeleton positions`);

    // Phase 3: Attribute ALL arguments not already placed in skeleton positions
    // This includes both non-sampled args AND sampled args that weren't in exampleIds
    const placedArgs = new Set();
    for (const pos of skeletonPositions) {
      for (const arg of (pos.args || [])) {
        placedArgs.add(arg);
      }
    }
    const remaining = args.filter(a => !placedArgs.has(a));

    console.log(`[Aggregator] Phase 3: Attributing ${remaining.length} remaining arguments via LLM (${placedArgs.size} already placed)...`);

    let allPositions = skeletonPositions;
    let unmatchedPositions = [];

    if (remaining.length > 0) {
      // Use LLM to attribute remaining args to skeleton positions
      const { attributedPositions, unmatched } = await this.attributeWithLLM(
        remaining,
        skeletonPositions,
        themeName
      );

      allPositions = attributedPositions;

      // Phase 4: Handle unmatched arguments with relative thresholds
      if (unmatched.length > 0) {
        console.log(`[Aggregator] Phase 4: Handling ${unmatched.length} unmatched arguments...`);
        unmatchedPositions = await this.handleUnmatchedArguments(
          unmatched,
          themeName,
          skeletonPositions.length,
          args.length  // Total args in theme for relative threshold calculation
        );
      }
    }

    // Combine attributed positions with any new positions from unmatched handling
    const finalPositions = [...allPositions, ...unmatchedPositions];

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Aggregator] UNIFIED complete in ${duration}s: ${skeletonPositions.length} discovered + ${unmatchedPositions.length} from unmatched = ${finalPositions.length} positions`);

    return finalPositions;
  }

  /**
   * Stratified sampling without hardcoding categories.
   * Uses only LLM-classified or structural dimensions:
   * - direction (from micro-summary)
   * - substanceRefs (from LLM extraction)
   * - length bucket (structural)
   *
   * @param {Array} args - All arguments
   * @param {number} targetSize - Target sample size
   * @returns {Array} Sampled arguments
   */
  stratifiedSample(args, targetSize) {
    const strata = {};

    for (const arg of args) {
      // ALL dimensions are LLM-classified or structural - NO hardcoding
      const direction = arg.direction || arg._direction || 'neutral';
      const substanceKey = (arg.substanceRefs || []).slice(0, 2).join('_') || 'general';

      // Length bucket is structural (not content-based)
      const textLength = [arg.what, arg.why, arg.how].filter(Boolean).join('').length;
      const lengthBucket = textLength < 200 ? 'short' : textLength < 500 ? 'medium' : 'long';

      const key = `${direction}_${substanceKey}_${lengthBucket}`;
      if (!strata[key]) strata[key] = [];
      strata[key].push(arg);
    }

    // Sample proportionally from each stratum
    const sample = [];
    const total = Object.values(strata).reduce((sum, arr) => sum + arr.length, 0);

    for (const [key, stratumArgs] of Object.entries(strata)) {
      const proportion = stratumArgs.length / total;
      const stratumSize = Math.max(1, Math.round(targetSize * proportion));

      // Shuffle and take
      const shuffled = [...stratumArgs].sort(() => Math.random() - 0.5);
      sample.push(...shuffled.slice(0, stratumSize));
    }

    console.log(`[Aggregator] Stratified sampling: ${Object.keys(strata).length} strata → ${sample.length} samples`);
    return sample;
  }

  /**
   * Discover positions using LLM semantic understanding.
   * Replaces embedding clustering for skeleton building in large-scale processing.
   *
   * @param {Array} sample - Stratified sample of arguments
   * @param {string} themeName - Theme name
   * @param {string} themeDescription - Optional theme description
   * @param {number} totalArgsInTheme - Total arguments in theme (not just sample)
   * @returns {Promise<Array>} Skeleton positions with pre-computed centroids
   */
  async discoverSkeletonPositions(sample, themeName, themeDescription, totalArgsInTheme = 0) {
    // Cap based on TOTAL args in theme (not sample size)
    // Produces 3-8 positions per theme, encouraging broad grouping
    const totalArgs = totalArgsInTheme || sample.length;
    const maxPositions = Math.min(8, Math.max(3, Math.ceil(totalArgs / 150)));

    // Build sample text for prompt
    const sampleText = sample.map(arg => {
      const direction = arg.direction || arg._direction || 'neutral';
      let text = `[${arg.responseNumber}] ${direction}: ${arg.what || ''}`;
      if (arg.why) text += `\nBegrundelse: ${arg.why}`;
      return text;
    }).join('\n---\n');

    // Build prompt from template
    const prompt = this.discoveryPromptTemplate
      .replace('{{themeName}}', themeName)
      .replace('{{themeDescription}}', themeDescription || 'Ingen beskrivelse tilgængelig')
      .replace('{{sampleSize}}', String(sample.length))
      .replace('{{maxPositions}}', String(maxPositions))
      .replace('{{samples}}', sampleText);

    console.log(`[Aggregator] Discovering positions via LLM for "${themeName}" (max ${maxPositions} positions)...`);

    try {
      const response = await this.client.createCompletion({
        messages: [
          {
            role: 'system',
            content: 'Du er en specialist i at identificere distinkte holdninger i høringssvar. Output valid JSON.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        response_format: { type: 'json_object' }
      });

      let content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No content in LLM response');
      }

      // Parse JSON response
      const parsed = JSON.parse(content);
      const positions = parsed.positions || [];

      if (positions.length === 0) {
        console.warn(`[Aggregator] LLM discovered 0 positions for "${themeName}", falling back to single position`);
        return [{
          args: sample,
          title: themeName,
          summary: themeDescription || '',
          _directionGroup: 'neutral',
          _discoveredPosition: true,
          _centroid: null
        }];
      }

      console.log(`[Aggregator] LLM discovered ${positions.length} positions for "${themeName}"`);

      // Match sample args to discovered positions for better centroid calculation
      // Build a lookup from responseNumber to sample arg
      const sampleByResponse = new Map();
      for (const arg of sample) {
        sampleByResponse.set(arg.responseNumber, arg);
      }

      // Assign sample args to positions based on exampleIds (if provided) or direction match
      const sampleArgsPerPosition = positions.map(() => []);
      const usedSamples = new Set();

      // First pass: use exampleIds from LLM response
      positions.forEach((p, i) => {
        if (p.exampleIds && Array.isArray(p.exampleIds)) {
          for (const respNum of p.exampleIds) {
            const arg = sampleByResponse.get(respNum);
            if (arg && !usedSamples.has(respNum)) {
              sampleArgsPerPosition[i].push(arg);
              usedSamples.add(respNum);
            }
          }
        }
      });

      // Second pass: assign remaining samples by direction match
      for (const arg of sample) {
        if (usedSamples.has(arg.responseNumber)) continue;
        const argDirection = arg.direction || arg._direction || 'neutral';
        // Find first position with matching direction
        const matchIdx = positions.findIndex((p, i) =>
          (p.direction || 'neutral') === argDirection && sampleArgsPerPosition[i].length < 10
        );
        if (matchIdx >= 0) {
          sampleArgsPerPosition[matchIdx].push(arg);
          usedSamples.add(arg.responseNumber);
        }
      }

      // Pre-compute embeddings: include sample args text for better matching
      const positionTexts = positions.map((p, i) => {
        const sampleTexts = sampleArgsPerPosition[i]
          .slice(0, 5)  // Max 5 samples per position to avoid token limits
          .map(a => a.what || '')
          .filter(t => t.length > 0)
          .join(' | ');
        // Combine: position description + sample argument texts
        return `${p.title}. ${p.description}${sampleTexts ? '. Eksempler: ' + sampleTexts : ''}`;
      });

      console.log(`[Aggregator] Computing centroids with sample args: ${sampleArgsPerPosition.map(a => a.length).join(', ')} args per position`);
      const embeddings = await this.embeddingClusterer.embedder.embedBatch(positionTexts);

      // Build skeleton positions with pre-computed centroids AND matched sample args
      return positions.map((p, i) => ({
        args: sampleArgsPerPosition[i],  // Include matched sample args
        title: p.title,
        summary: p.description,
        _directionGroup: p.direction || 'neutral',
        _discoveredPosition: true,
        _centroid: embeddings[i]  // Centroid based on description + samples
      }));

    } catch (error) {
      console.error(`[Aggregator] Error in discoverSkeletonPositions: ${error.message}`);
      // Fallback: return single position with all sample args
      return [{
        args: sample,
        title: themeName,
        summary: themeDescription || '',
        _directionGroup: 'neutral',
        _discoveredPosition: true,
        _centroid: null
      }];
    }
  }

  // =========================================================================
  // LLM-BASED ATTRIBUTION: Attribute remaining args to discovered positions
  // Replaces embedding-based attribution which had ~12% match rate
  // =========================================================================

  /**
   * Attribute remaining arguments to skeleton positions using LLM understanding.
   * Processes in batches with parallel execution for efficiency.
   *
   * @param {Array} remaining - Arguments not in sample
   * @param {Array} skeletonPositions - Discovered positions from Phase 2
   * @param {string} themeName - Theme name
   * @returns {Promise<{attributedPositions: Array, unmatched: Array}>}
   */
  async attributeWithLLM(remaining, skeletonPositions, themeName) {
    if (remaining.length === 0) {
      return { attributedPositions: skeletonPositions, unmatched: [] };
    }

    if (!this.attributionPromptTemplate || !this.lightClient) {
      console.warn('[Aggregator] Attribution prompt or client not available, falling back to embedding');
      return { attributedPositions: skeletonPositions, unmatched: remaining };
    }

    const batchSize = 75;  // Args per LLM call (fits ~10k tokens)
    const concurrency = 8; // Parallel calls

    // Build compact position list for prompt
    const positionList = skeletonPositions.map((p, i) => ({
      id: `P${i}`,
      title: p.title,
      direction: p._directionGroup || 'neutral',
      description: p.summary || ''
    }));

    const positionListText = positionList.map(p =>
      `**${p.id}** [${p.direction}]: ${p.title}${p.description ? ' - ' + p.description : ''}`
    ).join('\n');

    // Split remaining into batches
    const batches = [];
    for (let i = 0; i < remaining.length; i += batchSize) {
      batches.push(remaining.slice(i, i + batchSize));
    }

    console.log(`[Aggregator] LLM Attribution: ${remaining.length} args → ${batches.length} batches (${concurrency} concurrent)`);

    // Process batches in parallel
    const batchTasks = batches.map((batch, batchIdx) => async () => {
      return this.processAttributionBatch(batch, positionListText, themeName, batchIdx);
    });

    const batchResults = await limitConcurrency(batchTasks, concurrency);

    // Aggregate results
    const allAttributions = batchResults.flat();

    // Build position index for O(1) lookup
    const positionIdxMap = new Map(skeletonPositions.map((p, i) => [`P${i}`, i]));

    // Initialize attributed positions with existing args
    const attributedPositions = skeletonPositions.map(p => ({
      ...p,
      args: [...(p.args || [])],
      _attributedCount: 0
    }));

    const unmatched = [];
    let matchedCount = 0;

    // Apply attributions
    for (const attr of allAttributions) {
      if (!attr) continue;

      const { arg, positionId, confidence } = attr;

      if (positionId === 'unmatched' || !positionIdxMap.has(positionId)) {
        unmatched.push(arg);
        continue;
      }

      // Verify direction constraint
      const posIdx = positionIdxMap.get(positionId);
      const posDirection = skeletonPositions[posIdx]._directionGroup || 'neutral';
      const argDirection = arg.direction || arg._direction || 'neutral';

      if (this.directionsCompatible(posDirection, argDirection)) {
        attributedPositions[posIdx].args.push(arg);
        attributedPositions[posIdx]._attributedCount++;
        matchedCount++;
      } else {
        // Direction mismatch - treat as unmatched
        unmatched.push(arg);
      }
    }

    // Detect args that were silently dropped (LLM skipped their argIndex)
    const processedArgs = new Set(allAttributions.filter(a => a).map(a => a.arg));
    const skippedArgs = remaining.filter(a => !processedArgs.has(a));
    if (skippedArgs.length > 0) {
      console.warn(`[Aggregator] ⚠️ ${skippedArgs.length} args were skipped by LLM attribution (no argIndex returned) - treating as unmatched`);
      unmatched.push(...skippedArgs);
    }

    const matchRate = ((matchedCount / remaining.length) * 100).toFixed(1);
    console.log(`[Aggregator] LLM Attribution complete: ${matchedCount}/${remaining.length} matched (${matchRate}%), ${unmatched.length} unmatched`);

    return { attributedPositions, unmatched };
  }

  /**
   * Process a single batch of arguments for LLM attribution.
   *
   * @param {Array} batch - Arguments to attribute
   * @param {string} positionListText - Formatted position list
   * @param {string} themeName - Theme name
   * @param {number} batchIdx - Batch index for logging
   * @returns {Promise<Array>} Attribution results
   */
  async processAttributionBatch(batch, positionListText, themeName, batchIdx) {
    // Build argument text for prompt
    const argumentText = batch.map((arg, i) => {
      const direction = arg.direction || arg._direction || 'neutral';
      let text = `[${i}] (${direction}) ${arg.what || ''}`;
      if (arg.why) text += ` | Begrundelse: ${smartTruncate(arg.why, 200)}`;
      return text;
    }).join('\n');

    // Build prompt
    const prompt = this.attributionPromptTemplate
      .replace('{{themeName}}', themeName)
      .replace('{{positionList}}', positionListText)
      .replace('{{argumentBatch}}', argumentText);

    try {
      const response = await this.lightClient.createCompletion({
        messages: [
          {
            role: 'system',
            content: 'Du er en specialist i at matche argumenter til holdninger. Output valid JSON.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        response_format: { type: 'json_object' }
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        console.warn(`[Aggregator] Batch ${batchIdx}: Empty LLM response`);
        return batch.map(arg => ({ arg, positionId: 'unmatched', confidence: 'low' }));
      }

      const parsed = JSON.parse(content);
      const attributions = parsed.attributions || [];

      // Map attributions back to args
      return attributions.map(attr => {
        const argIdx = attr.argIndex;
        if (argIdx < 0 || argIdx >= batch.length) return null;
        return {
          arg: batch[argIdx],
          positionId: attr.positionId,
          confidence: attr.confidence || 'medium'
        };
      }).filter(Boolean);

    } catch (error) {
      console.error(`[Aggregator] Batch ${batchIdx} error: ${error.message}`);
      // On error, mark all as unmatched
      return batch.map(arg => ({ arg, positionId: 'unmatched', confidence: 'low' }));
    }
  }

  /**
   * Normalize direction value to canonical form (support/against/neutral).
   * Micro-summaries use various direction terms that need normalization.
   * @param {string} direction - Raw direction value
   * @returns {string} Normalized direction: 'support', 'against', or 'neutral'
   */
  normalizeDirection(direction) {
    if (!direction) return 'neutral';
    const d = direction.toLowerCase();

    // Against the proposal (wants to preserve status quo, opposes change)
    if (d === 'against' || d === 'oppose' || d === 'pro_status_quo' ||
        d === 'anti_proposal' || d === 'contra') {
      return 'against';
    }

    // Supports the proposal (wants the change)
    if (d === 'support' || d === 'for' || d === 'pro_proposal' ||
        d === 'pro_change' || d === 'pro') {
      return 'support';
    }

    return 'neutral';
  }

  /**
   * Check if argument direction is compatible with position direction.
   * @param {string} posDirection - Position direction
   * @param {string} argDirection - Argument direction
   * @returns {boolean} True if compatible
   */
  directionsCompatible(posDirection, argDirection) {
    // Normalize both directions
    const normalizedPos = this.normalizeDirection(posDirection);
    const normalizedArg = this.normalizeDirection(argDirection);

    // Neutral is compatible with everything
    if (normalizedPos === 'neutral' || normalizedArg === 'neutral') return true;

    // Support/against must match
    return normalizedPos === normalizedArg;
  }

  /**
   * Handle unmatched arguments with relative thresholds.
   * Strategy varies based on unmatched count relative to total.
   *
   * @param {Array} unmatched - Unmatched arguments
   * @param {string} themeName - Theme name
   * @param {number} existingPositionCount - Number of existing positions
   * @param {number} totalArgsInTheme - Total args in this theme
   * @returns {Promise<Array>} Additional position groups
   */
  async handleUnmatchedArguments(unmatched, themeName, existingPositionCount, totalArgsInTheme) {
    const total = unmatched.length;

    if (total === 0) return [];

    const unmatchedPct = (total / totalArgsInTheme) * 100;
    console.log(`[Aggregator] Handling ${total} unmatched arguments (${unmatchedPct.toFixed(1)}% of theme)`);

    if (unmatchedPct > 20) {
      console.warn(`[Aggregator] ⚠️ HIGH UNMATCHED RATE: ${unmatchedPct.toFixed(1)}% of theme "${themeName}" unmatched - discovery cap may be too low`);
    }

    // Default: single "Øvrige synspunkter" bucket
    if (total <= 30 || unmatchedPct <= 15) {
      console.log(`[Aggregator] Creating single 'Øvrige synspunkter' bucket for ${total} args`);
      return [this.createOthersBucket(unmatched, themeName)];
    }

    // Fallback: unmatched >15% AND >30 args → mini-discovery with max 3 positions
    console.log(`[Aggregator] Mini-discovery on ${total} unmatched (>15% and >30 args, max 3 new positions)`);
    return this.discoverWithCap(unmatched, themeName, 3);
  }

  /**
   * Create a simple "Øvrige synspunkter" bucket position.
   */
  createOthersBucket(args, themeName) {
    // Group by direction
    const byDirection = { support: [], against: [], neutral: [] };
    for (const arg of args) {
      const dir = arg.direction || arg._direction || 'neutral';
      (byDirection[dir] || byDirection.neutral).push(arg);
    }

    // Determine dominant direction
    const dominant = Object.entries(byDirection)
      .sort((a, b) => b[1].length - a[1].length)[0];

    return {
      args,
      title: `Øvrige synspunkter om ${themeName}`,
      summary: '',
      responseNumbers: [...new Set(args.map(a => a.responseNumber))],
      citationMap: [],
      _directionGroup: dominant[0],
      _isUnmatched: true
    };
  }

  /**
   * Sub-cluster unmatched arguments into a fixed number of groups.
   */
  async subClusterUnmatched(unmatched, themeName, maxGroups) {
    // IMPORTANT: Do NOT use embeddingClusterer here - it does substanceRef splits
    // that create many more clusters than requested. Use simple direction-based grouping.

    console.log(`[Aggregator] Grouping ${unmatched.length} unmatched args by direction (max ${maxGroups} groups)`);

    // Group by direction first (creates at most 3 groups)
    const byDirection = { support: [], against: [], neutral: [] };
    for (const arg of unmatched) {
      const dir = this.normalizeDirection(arg.direction || arg._direction || 'neutral');
      byDirection[dir].push(arg);
    }

    // Build clusters from non-empty direction groups
    const clusters = Object.entries(byDirection)
      .filter(([_, args]) => args.length > 0)
      .map(([direction, args]) => ({ direction, args }));

    console.log(`[Aggregator] Direction-grouped into ${clusters.length} groups: ${clusters.map(c => `${c.direction}(${c.args.length})`).join(', ')}`);

    // Create one position per direction group
    return clusters.map(({ direction, args }) => ({
      args,
      title: this.buildTitle(args, args.map(a => a.responseNumber)),
      summary: '',
      responseNumbers: [...new Set(args.map(a => a.responseNumber))],
      citationMap: [],
      _directionGroup: direction,
      _isUnmatched: true
    }));
  }

  /**
   * Run discovery on unmatched with a cap on new positions.
   */
  async discoverWithCap(unmatched, themeName, maxNewPositions) {
    if (!this.discoveryPromptTemplate || !this.client) {
      console.warn('[Aggregator] Discovery not available for unmatched, using sub-clustering');
      return this.subClusterUnmatched(unmatched, themeName, maxNewPositions);
    }

    // Sample if unmatched is very large
    const sampleSize = Math.min(unmatched.length, 200);
    const sample = sampleSize < unmatched.length
      ? this.stratifiedSample(unmatched, sampleSize)
      : unmatched;

    // Run discovery with explicit max
    const sampleText = sample.map(arg => {
      const direction = arg.direction || arg._direction || 'neutral';
      let text = `[${arg.responseNumber}] ${direction}: ${arg.what || ''}`;
      if (arg.why) text += `\nBegrundelse: ${arg.why}`;
      return text;
    }).join('\n---\n');

    const prompt = this.discoveryPromptTemplate
      .replace('{{themeName}}', themeName)
      .replace('{{themeDescription}}', 'Øvrige synspunkter der ikke matchede hovedpositioner')
      .replace('{{sampleSize}}', String(sample.length))
      .replace('{{maxPositions}}', String(maxNewPositions))
      .replace('{{samples}}', sampleText);

    try {
      const response = await this.client.createCompletion({
        messages: [
          {
            role: 'system',
            content: 'Du er en specialist i at identificere distinkte holdninger i høringssvar. Output valid JSON.'
          },
          { role: 'user', content: prompt }
        ],
        response_format: { type: 'json_object' }
      });

      const content = response.choices[0]?.message?.content;
      const parsed = JSON.parse(content);
      const positions = parsed.positions || [];

      console.log(`[Aggregator] Discovered ${positions.length} positions from unmatched (cap was ${maxNewPositions})`);

      if (positions.length === 0) {
        return [this.createOthersBucket(unmatched, themeName)];
      }

      // Now attribute all unmatched to these new positions via LLM
      const { attributedPositions, unmatched: stillUnmatched } = await this.attributeWithLLM(
        unmatched,
        positions.map(p => ({
          args: [],
          title: p.title,
          summary: p.description,
          _directionGroup: p.direction || 'neutral',
          _isUnmatched: true
        })),
        themeName
      );

      // Handle any still-unmatched
      if (stillUnmatched.length > 0) {
        attributedPositions.push(this.createOthersBucket(stillUnmatched, themeName));
      }

      return attributedPositions.filter(p => p.args && p.args.length > 0);

    } catch (error) {
      console.error(`[Aggregator] Discovery on unmatched failed: ${error.message}`);
      return [this.createOthersBucket(unmatched, themeName)];
    }
  }

  /**
   * Attribute remaining arguments to skeleton positions using embedding similarity.
   *
   * @param {Array} remainingArgs - Arguments not in the sample
   * @param {Array} skeletonPositions - Position groups from sample processing
   * @param {number} threshold - Similarity threshold for attribution
   * @param {number} floor - Minimum similarity (below this → secondary pass)
   * @param {boolean} respectDirection - Hard constraint on direction matching
   * @returns {Promise<Array>} Position groups with attributed arguments
   */
  async attributeToSkeletonPositions(remainingArgs, skeletonPositions, threshold, floor, respectDirection) {
    if (remainingArgs.length === 0) {
      return skeletonPositions;
    }

    // Compute centroid embeddings for each skeleton position
    const centroids = await Promise.all(
      skeletonPositions.map(async (pos) => {
        // Use pre-computed centroid from LLM discovery if available
        if (pos._centroid && Array.isArray(pos._centroid) && pos._centroid.length > 0) {
          return pos._centroid;
        }

        // Fallback: compute centroid from args
        const posArgs = pos.args || [];
        if (posArgs.length === 0) return null;

        // Get or compute embeddings for position arguments
        const embeddings = await this.getArgumentEmbeddings(posArgs);
        if (embeddings.length === 0) return null;

        // Compute centroid (average of embeddings)
        return this.computeCentroid(embeddings);
      })
    );

    // Get embeddings for remaining arguments
    const remainingEmbeddings = await this.getArgumentEmbeddings(remainingArgs);

    // Initialize attributed positions
    const attributed = skeletonPositions.map(pos => ({
      ...pos,
      args: [...(pos.args || [])],
      _attributedCount: 0
    }));

    const unmatched = [];

    // Attribute each remaining argument
    for (let i = 0; i < remainingArgs.length; i++) {
      const arg = remainingArgs[i];
      const embedding = remainingEmbeddings[i];

      if (!embedding) {
        unmatched.push(arg);
        continue;
      }

      let bestIdx = -1;
      let bestSim = floor;

      for (let j = 0; j < centroids.length; j++) {
        if (!centroids[j]) continue;

        // Direction constraint
        if (respectDirection) {
          const posDirection = skeletonPositions[j]._directionGroup || 'neutral';
          const argDirection = arg.direction || arg._direction || 'neutral';

          // Don't attribute support args to against positions and vice versa
          if ((posDirection === 'support' && argDirection === 'against') ||
              (posDirection === 'against' && argDirection === 'support')) {
            continue;
          }
        }

        const sim = this.cosineSimilarity(embedding, centroids[j]);
        if (sim > bestSim) {
          bestSim = sim;
          bestIdx = j;
        }
      }

      if (bestIdx >= 0 && bestSim >= threshold) {
        attributed[bestIdx].args.push(arg);
        attributed[bestIdx]._attributedCount++;

        // Update response numbers
        if (!attributed[bestIdx].responseNumbers) {
          attributed[bestIdx].responseNumbers = [];
        }
        if (arg.responseNumber && !attributed[bestIdx].responseNumbers.includes(arg.responseNumber)) {
          attributed[bestIdx].responseNumbers.push(arg.responseNumber);
        }
      } else {
        unmatched.push(arg);
      }
    }

    // Log attribution stats
    const totalAttributed = attributed.reduce((sum, p) => sum + (p._attributedCount || 0), 0);
    console.log(`[Aggregator] Attribution: ${totalAttributed} attributed, ${unmatched.length} unmatched`);

    // Process unmatched with secondary LLM pass if significant
    if (unmatched.length > 5) {
      console.log(`[Aggregator] Secondary pass for ${unmatched.length} unmatched arguments...`);

      // Use standard processing for unmatched (they are diverse by definition)
      const unmatchedPositions = await this.processUnmatchedArguments(unmatched, attributed[0]?.title ? attributed[0].title.split(':')[0] : 'Øvrige');
      attributed.push(...unmatchedPositions);
    } else if (unmatched.length > 0) {
      // Add small unmatched to a single "Other" position
      attributed.push({
        args: unmatched,
        title: 'Øvrige synspunkter',
        summary: '',
        responseNumbers: [...new Set(unmatched.map(a => a.responseNumber))],
        citationMap: [],
        _isUnmatched: true
      });
    }

    return attributed;
  }

  /**
   * Get or compute embeddings for arguments.
   * Uses cached embeddings if available.
   *
   * @param {Array} args - Arguments to embed
   * @returns {Promise<Array>} Embeddings
   */
  async getArgumentEmbeddings(args) {
    const embeddings = [];
    const needsEmbedding = [];
    const needsEmbeddingIndices = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg._embedding) {
        embeddings[i] = arg._embedding;
      } else {
        needsEmbedding.push(arg);
        needsEmbeddingIndices.push(i);
      }
    }

    if (needsEmbedding.length > 0 && this.embeddingClusterer?.embedder) {
      // Batch embed
      const texts = needsEmbedding.map(a =>
        [a.what, a.why, a.how].filter(Boolean).join(' ')
      );

      const newEmbeddings = await this.embeddingClusterer.embedder.embedBatch(texts);

      for (let i = 0; i < needsEmbeddingIndices.length; i++) {
        const idx = needsEmbeddingIndices[i];
        embeddings[idx] = newEmbeddings[i];
        // Cache on the argument
        args[idx]._embedding = newEmbeddings[i];
      }
    }

    return embeddings;
  }

  /**
   * Compute centroid (average) of embeddings.
   *
   * @param {Array} embeddings - Array of embedding vectors
   * @returns {Array} Centroid vector
   */
  computeCentroid(embeddings) {
    if (embeddings.length === 0) return null;
    if (embeddings.length === 1) return embeddings[0];

    const dim = embeddings[0].length;
    const centroid = new Array(dim).fill(0);

    for (const emb of embeddings) {
      for (let i = 0; i < dim; i++) {
        centroid[i] += emb[i];
      }
    }

    for (let i = 0; i < dim; i++) {
      centroid[i] /= embeddings.length;
    }

    return centroid;
  }

  /**
   * Compute cosine similarity between two vectors.
   *
   * @param {Array} a - First vector
   * @param {Array} b - Second vector
   * @returns {number} Cosine similarity (0-1)
   */
  cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dotProduct / denom;
  }

  /**
   * Process unmatched arguments from attribution.
   * Uses embedding clustering + LLM refinement.
   *
   * @param {Array} args - Unmatched arguments
   * @param {string} themeName - Theme name for context
   * @returns {Promise<Array>} Position groups
   */
  async processUnmatchedArguments(args, themeName) {
    if (args.length <= 10) {
      // Small set - single LLM pass
      if (this.useLLMGrouping && this.client && this.promptTemplate) {
        const client = this.selectClientForCluster(args);
        return this.groupWithLLMClient(args, themeName, [], client, '');
      }
      return [{
        args,
        title: `Øvrige synspunkter om ${themeName}`,
        summary: '',
        responseNumbers: [...new Set(args.map(a => a.responseNumber))],
        citationMap: [],
        _isUnmatched: true
      }];
    }

    // Larger set - use embedding clustering
    const clusters = await this.embeddingClusterer.clusterArguments(args, themeName);

    if (this.useLLMGrouping && this.client && this.promptTemplate) {
      const tasks = clusters.map(cluster => async () => {
        const client = this.selectClientForCluster(cluster);
        const groups = await this.groupWithLLMClient(cluster, themeName, [], client, '');
        groups.forEach(g => g._isUnmatched = true);
        return groups;
      });
      const results = await limitConcurrency(tasks, 5);
      return results.flat();
    }

    return clusters.map(cluster => ({
      args: cluster,
      title: this.buildTitle(cluster, cluster.map(a => a.responseNumber)),
      summary: '',
      responseNumbers: [...new Set(cluster.map(a => a.responseNumber))],
      citationMap: [],
      _isUnmatched: true
    }));
  }
}
