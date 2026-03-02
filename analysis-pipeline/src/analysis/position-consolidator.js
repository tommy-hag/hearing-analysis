/**
 * PositionConsolidator
 * 
 * State-of-the-art semantic deduplication of aggregated positions.
 * Uses hybrid two-stage approach:
 * 1. Embedding-based similarity detection (fast, objective)
 * 2. LLM-validated merging (accurate, nuanced)
 */

import { EmbeddingService } from '../embedding/embedding-service.js';
import { OpenAIClientWrapper, getComplexityConfig } from '../utils/openai-client.js';
import { getResponseFormat } from '../utils/json-schemas.js';
import { ResponseTracker } from './response-tracker.js';
import { validateAllTitles, autoFixTitle } from '../validation/title-validator.js';
import { limitConcurrency } from '../utils/concurrency.js';

export class PositionConsolidator {
  constructor(options = {}) {
    // Initialize embedding service
    this.embedder = new EmbeddingService(options.embedding);

    // Initialize LLM client for validation (use LIGHT complexity - simple binary decision)
    try {
      const complexityConfig = getComplexityConfig(options.complexityLevel || 'light');
      this.client = new OpenAIClientWrapper({
        model: options.model || complexityConfig.model,
        verbosity: options.verbosity || complexityConfig.verbosity,
        reasoningEffort: options.reasoningEffort || complexityConfig.reasoningEffort,
        timeout: options.timeout || 30000
      });
    } catch (error) {
      console.warn('[PositionConsolidator] Failed to initialize LLM client:', error.message);
      this.client = null;
    }

    // Configuration (will be overridden by setDynamicThreshold)
    // QUALITY FIX: Lowered from 0.85 to 0.78 to preserve nuances between similar-but-distinct positions
    // At 0.85, positions like "anti-hotel" and "anti-tourism effect" were incorrectly merged
    this.similarityThreshold = options.similarityThreshold ?? 0.78;
    this.maxLLMValidations = options.maxLLMValidations ?? 100;
    this.enabled = options.enabled !== false;

    // Adaptive concurrency: Safe ceiling for concurrent LLM calls
    // OpenAI Tier 4: ~167 req/s, we use ~30% capacity as safety margin
    this.maxSafeConcurrentLLMCalls = options.maxSafeConcurrentLLMCalls || 50;

    // Debug logging
    console.log(`[PositionConsolidator] Initialized with similarityThreshold=${this.similarityThreshold}, model=${this.client?.model || 'none'} (from options: ${options.similarityThreshold})`);
  }

  /**
   * Set dynamic threshold based on complexity
   * Called before consolidation with hearing-specific threshold
   * 
   * UPDATED: Now supports separate within-theme and cross-theme thresholds
   */
  setDynamicThreshold(threshold, crossThemeThreshold = null) {
    const oldThreshold = this.similarityThreshold;
    this.similarityThreshold = threshold;
    
    // Cross-theme threshold should be HIGHER (more conservative)
    // QUALITY FIX: Lowered floor from 0.88 to 0.82 to match new within-theme threshold
    // If not provided, calculate as within-theme + 0.04 with floor of 0.82
    this.crossThemeThreshold = crossThemeThreshold || Math.max(0.82, threshold + 0.04);
    
    console.log(`[PositionConsolidator] Dynamic threshold set to ${threshold.toFixed(3)} (was ${oldThreshold.toFixed(3)})`);
    console.log(`[PositionConsolidator] Cross-theme threshold set to ${this.crossThemeThreshold.toFixed(3)}`);
  }

  /**
   * Analyze workload and calculate optimal concurrency settings
   *
   * Dynamically adjusts theme-level and LLM-validation concurrency based on:
   * - Total estimated LLM calls
   * - Number of positions per theme
   * - Largest theme size
   *
   * @param {Array} themes - Themes with positions to analyze
   * @returns {Object} Concurrency configuration { themeConcurrency, baseLLMConcurrency, perThemeConcurrency }
   */
  analyzeWorkload(themes) {
    const themeAnalysis = themes.map(theme => {
      const posCount = theme.positions?.length || 0;
      // Estimate merge candidates: O(n²) pairwise comparisons, ~30% typically pass threshold
      const estimatedCandidates = Math.min(
        Math.floor(posCount * (posCount - 1) / 2 * 0.3),
        this.maxLLMValidations
      );
      return { name: theme.name, positionCount: posCount, estimatedCandidates };
    });

    const totalEstimatedCalls = themeAnalysis.reduce((sum, t) => sum + t.estimatedCandidates, 0);
    const largestTheme = Math.max(...themeAnalysis.map(t => t.positionCount), 0);

    let themeConcurrency, baseLLMConcurrency;

    if (totalEstimatedCalls < 50) {
      // Small hearing → very aggressive
      themeConcurrency = Math.min(themes.length, 6);
      baseLLMConcurrency = 25;
    } else if (totalEstimatedCalls < 200) {
      // Medium hearing → aggressive
      themeConcurrency = Math.min(themes.length, 4);
      baseLLMConcurrency = 20;
    } else if (totalEstimatedCalls < 500) {
      // Large hearing → moderate
      themeConcurrency = 3;
      baseLLMConcurrency = 15;
    } else {
      // Very large hearing → conservative
      themeConcurrency = 2;
      baseLLMConcurrency = 10;
    }

    // Per-theme concurrency: Small themes get more, large themes get less
    const perThemeConcurrency = new Map();
    for (const t of themeAnalysis) {
      if (t.positionCount < 15) {
        perThemeConcurrency.set(t.name, Math.min(30, Math.round(baseLLMConcurrency * 1.5)));
      } else if (t.positionCount < 40) {
        perThemeConcurrency.set(t.name, baseLLMConcurrency);
      } else if (t.positionCount < 100) {
        perThemeConcurrency.set(t.name, Math.max(8, Math.round(baseLLMConcurrency * 0.7)));
      } else {
        perThemeConcurrency.set(t.name, Math.max(5, Math.round(baseLLMConcurrency * 0.5)));
      }
    }

    console.log(`[PositionConsolidator] Workload analysis:`);
    console.log(`  Total estimated LLM calls: ${totalEstimatedCalls}`);
    console.log(`  Largest theme: ${largestTheme} positions`);
    console.log(`  Theme concurrency: ${themeConcurrency}`);
    console.log(`  Base LLM concurrency: ${baseLLMConcurrency}`);

    return { themeConcurrency, baseLLMConcurrency, perThemeConcurrency, themeAnalysis };
  }

  /**
   * Normalize text via LLM so it grammatically fits after a prefix like "Støtte til".
   * Uses 'light' complexity tier for fast, cheap transformation.
   *
   * Examples:
   * - prefix="Støtte til", text="flyt boldbanen" → "flytning af boldbanen"
   * - prefix="Modstand mod", text="bevar træerne" → "bevarelse af træerne"
   * - prefix="Ønske om", text="ændre planen" → "ændring af planen"
   *
   * @param {string} text - Text to normalize
   * @param {string} prefix - "Støtte til", "Modstand mod", etc.
   * @returns {Promise<string>} Normalized text
   */
  async normalizeForTitlePrefix(text, prefix) {
    if (!text || text.length < 3) return text;

    // Quick check: If text already starts with noun pattern, skip LLM
    const nounPatterns = /^(bevaring|bevarelse|flytning|ændring|fjernelse|opførelse|nedrivning|placering|etablering|sikring|renovation|udvidelse|reduktion|forbedring|forslag|krav|ønske|modstand|bekymring|støtte)/i;
    if (nounPatterns.test(text.trim())) {
      return text;
    }

    // Quick check: If text already starts with a stance marker, skip normalization
    const stancePatterns = /^(støtte|modstand|ønske|bekymring|forslag|krav)/i;
    if (stancePatterns.test(text.trim())) {
      return text;
    }

    // Use LLM to normalize
    if (!this.client) {
      console.warn('[PositionConsolidator] No LLM client - cannot normalize title grammar');
      return text;
    }

    try {
      const prompt = `Du er en dansk grammatikekspert. Normaliser følgende tekst så den grammatisk passer efter prefixet "${prefix}".

REGLER:
- Imperativ/infinitiv → substantiv: "flyt X" → "flytning af X", "bevar X" → "bevaring af X"
- Hvis teksten allerede er grammatisk korrekt efter prefixet, returner den uændret
- Behold al information fra originalen - kun ændr grammatisk form
- TILFØJ IKKE holdningsmarkør (støtte/modstand/ønske) - returner KUN substantivformen
- Returner KUN den normaliserede tekst, ingen forklaring

INPUT: ${text}
OUTPUT:`;

      const result = await this.client.createCompletion({
        messages: [{ role: 'user', content: prompt }],
        complexityTier: 'light',
        maxTokens: 150,
        temperature: 0
      });

      let normalized = result?.choices?.[0]?.message?.content?.trim();

      // Safety check: if LLM added a stance prefix, strip it
      const stanceRegex = /^(støtte til|modstand mod|ønske om|bekymring for|forslag om|opfordring til|krav om)\s+/i;
      if (normalized && stanceRegex.test(normalized)) {
        normalized = normalized.replace(stanceRegex, '').trim();
        console.log(`[PositionConsolidator] ⚠️ Stripped stance prefix from LLM output`);
      }

      if (normalized && normalized.length > 2 && normalized.length < text.length * 3) {
        if (normalized !== text) {
          console.log(`[PositionConsolidator] 📝 Normalized title text: "${text}" → "${normalized}"`);
        }
        return normalized;
      }
      return text;
    } catch (error) {
      console.warn(`[PositionConsolidator] Failed to normalize title text: ${error.message}`);
      return text;
    }
  }

  /**
   * QUALITY FIX: Calculate dynamic threshold based on respondent concentration
   * Higher concentration = lower threshold to preserve nuances
   *
   * @param {Array} positions - Positions to analyze
   * @param {number} baseThreshold - Base similarity threshold (default 0.78)
   * @returns {number} Adjusted threshold
   */
  calculateDynamicThreshold(positions, baseThreshold = null) {
    const effectiveBase = baseThreshold ?? this.similarityThreshold;

    if (!positions || positions.length < 2) {
      return effectiveBase;
    }

    // Count respondents per position
    const respondentCounts = positions.map(p => p.responseNumbers?.length || 0);
    const maxCount = Math.max(...respondentCounts);
    const avgCount = respondentCounts.reduce((a, b) => a + b, 0) / positions.length;
    const totalRespondents = new Set(positions.flatMap(p => p.responseNumbers || [])).size;

    // High concentration = lower threshold for nuance preservation
    // If average > 5 respondents per position, it suggests many people agree on similar topics
    // but may have different nuances that should be preserved
    let adjustment = 0;
    if (avgCount > 5) {
      adjustment = Math.min(0.08, (avgCount - 5) * 0.01);
    }

    // Additional adjustment for very high total respondent count
    if (totalRespondents > 50) {
      adjustment += Math.min(0.03, (totalRespondents - 50) * 0.0005);
    }

    const dynamicThreshold = Math.max(0.70, effectiveBase - adjustment);

    if (adjustment > 0) {
      console.log(`[PositionConsolidator] Dynamic threshold adjustment: ${effectiveBase.toFixed(3)} → ${dynamicThreshold.toFixed(3)} (avgCount=${avgCount.toFixed(1)}, totalRespondents=${totalRespondents})`);
    }

    return dynamicThreshold;
  }

  /**
   * REFACTORED: No longer blocks merges based on respondent count.
   *
   * The semantic guards (direction check, embedding similarity, LLM validation)
   * are responsible for merge quality. Position size is NOT a quality indicator.
   *
   * A position with 200 respondents is fine IF they all share the same opinion.
   *
   * @param {Object} position1 - First position
   * @param {Object} position2 - Second position
   * @param {number} combinedThreshold - DEPRECATED: No longer used for blocking
   * @param {Object} context - Context information (for logging only)
   * @returns {boolean} Always true - semantic guards handle quality
   */
  shouldAllowMerge(position1, position2, combinedThreshold = 12, context = {}) {
    const count1 = position1.responseNumbers?.length || 0;
    const count2 = position2.responseNumbers?.length || 0;

    // Calculate actual combined count (deduplicated)
    const combined = new Set([
      ...(position1.responseNumbers || []),
      ...(position2.responseNumbers || [])
    ]).size;

    // Log large merges for observability (but don't block)
    if (combined > 50) {
      console.log(`[PositionConsolidator] INFO: Large merge ${count1} + ${count2} = ${combined} respondents (semantically validated)`);
    }

    // Always allow - trust semantic guards (direction, similarity, LLM validation)
    return true;
  }

  /**
   * DIRECTION-FIRST: Check if two positions can be merged based on direction.
   * Positions with immutable direction cannot merge with opposite directions.
   * This is the HARD CONSTRAINT that prevents stance contamination.
   *
   * @param {Object} posA - First position
   * @param {Object} posB - Second position
   * @returns {{allowed: boolean, reason?: string}} Merge permission
   */
  canMergeByDirection(posA, posB) {
    const dirA = posA._direction;
    const dirB = posB._direction;
    const immutableA = posA._immutableDirection;
    const immutableB = posB._immutableDirection;

    // If neither has a direction, allow merge (legacy positions)
    if (!dirA && !dirB) {
      return { allowed: true };
    }

    // If either has immutable direction, NEVER merge with opposite direction
    if (immutableA || immutableB) {
      if (dirA && dirB && dirA !== dirB) {
        console.log(`[PositionConsolidator] 🚫 DIRECTION BLOCK: Cannot merge "${posA.title?.slice(0, 40)}..." (${dirA}) with "${posB.title?.slice(0, 40)}..." (${dirB})`);
        return { allowed: false, reason: `direction mismatch: ${dirA} vs ${dirB}` };
      }
    }

    // Same direction or one is null - allow merge
    return { allowed: true };
  }

  /**
   * DIRECTION-FIRST: Get a respondent's direction from micro-summaries.
   * Used to check if a respondent matches a mega-position's direction before enrichment.
   *
   * @param {number} responseNumber - Respondent number
   * @param {Array} microSummaries - Array of micro-summaries
   * @returns {string|null} 'pro_change', 'pro_status_quo', 'neutral', or null
   */
  getRespondentDirection(responseNumber, microSummaries) {
    if (!microSummaries || !Array.isArray(microSummaries)) return null;

    const ms = microSummaries.find(m => m.responseNumber === responseNumber);
    if (!ms?.arguments?.length) return null;

    // Count directions from all arguments
    const counts = { pro_change: 0, pro_status_quo: 0, neutral: 0 };
    for (const arg of ms.arguments) {
      const dir = arg.direction;
      if (dir === 'pro_change') counts.pro_change++;
      else if (dir === 'pro_status_quo') counts.pro_status_quo++;
      else counts.neutral++;
    }

    // Return dominant direction (or null if no clear majority)
    const total = ms.arguments.length;
    if (counts.pro_change / total > 0.5) return 'pro_change';
    if (counts.pro_status_quo / total > 0.5) return 'pro_status_quo';
    if (counts.neutral / total > 0.5) return 'neutral';

    return null;
  }

  /**
   * Get effective threshold for a specific theme
   * "Andre emner" (catch-all) uses a lower threshold to preserve nuances
   *
   * @param {string} themeName - Theme name
   * @returns {number} Effective threshold for this theme
   */
  getThemeThreshold(themeName) {
    // "Andre emner" is the catch-all theme for out-of-scope concerns
    // Use lower threshold to preserve more distinct positions
    if (themeName === 'Andre emner' || themeName === 'Generelt') {
      const lowerThreshold = Math.max(0.72, this.similarityThreshold - 0.06);
      return lowerThreshold;
    }
    return this.similarityThreshold;
  }

  /**
   * Extract all substanceRefs from a position's source arguments.
   * Used for substance-anchored merging: positions responding to the same
   * substance items are candidates for merging even if embeddings differ.
   *
   * @param {Object} position - Position with sourceArgumentRefs
   * @param {Array} microSummaries - Array of micro-summaries to look up arguments
   * @returns {Set<string>} Unique substance reference IDs
   */
  extractSubstanceRefs(position, microSummaries) {
    const refs = new Set();

    if (!position?.sourceArgumentRefs || !microSummaries) {
      return refs;
    }

    // Look up each source argument in micro-summaries to get substanceRefs
    for (const argRef of position.sourceArgumentRefs) {
      const ms = microSummaries.find(m => m.responseNumber === argRef.responseNumber);
      if (!ms?.arguments) continue;

      // Find the matching argument by sourceQuoteRef or what text
      for (const arg of ms.arguments) {
        // Match by sourceQuoteRef if available
        if (argRef.sourceQuoteRef && arg.sourceQuoteRef === argRef.sourceQuoteRef) {
          if (arg.substanceRefs && Array.isArray(arg.substanceRefs)) {
            arg.substanceRefs.forEach(ref => refs.add(ref));
          }
          break;
        }
        // Fallback: match by similar what text
        if (argRef.what && arg.what && argRef.what.slice(0, 50) === arg.what.slice(0, 50)) {
          if (arg.substanceRefs && Array.isArray(arg.substanceRefs)) {
            arg.substanceRefs.forEach(ref => refs.add(ref));
          }
          break;
        }
      }
    }

    return refs;
  }

  /**
   * Find positions that share substanceRefs and are candidates for merging.
   * This catches cases where embeddings differ but positions respond to the same regulation.
   *
   * @param {Array} positions - Array of positions
   * @param {Array} microSummaries - Array of micro-summaries
   * @param {number} minSimilarity - Minimum embedding similarity to consider (filters out completely unrelated)
   * @param {Array} embeddings - Position embeddings for similarity check
   * @returns {Array} Candidates for LLM validation: {i, j, pos1, pos2, sharedRefs, similarity}
   */
  findSameSubstanceCandidates(positions, microSummaries, embeddings, minSimilarity = 0.50) {
    const candidates = [];
    const n = positions.length;

    // Extract substanceRefs for all positions
    const positionRefs = positions.map(p => this.extractSubstanceRefs(p, microSummaries));

    for (let i = 0; i < n; i++) {
      const refs1 = positionRefs[i];
      if (refs1.size === 0) continue;

      for (let j = i + 1; j < n; j++) {
        const refs2 = positionRefs[j];
        if (refs2.size === 0) continue;

        // Find shared substance refs
        const sharedRefs = [...refs1].filter(ref => refs2.has(ref));
        if (sharedRefs.length === 0) continue;

        // Calculate embedding similarity
        const sim = embeddings ? this.cosineSimilarity(embeddings[i], embeddings[j]) : 0.5;

        // Skip if already above normal threshold (will be merged by embedding-based logic)
        // Only interested in cases where embedding is below threshold but same substance
        if (sim >= 0.75) continue;

        // Skip if too dissimilar (safety check - prevents merging unrelated topics)
        if (sim < minSimilarity) continue;

        candidates.push({
          i,
          j,
          pos1: positions[i],
          pos2: positions[j],
          sharedRefs,
          similarity: sim
        });
      }
    }

    return candidates;
  }

  /**
   * Set embedded substance for RAG-based context retrieval
   * @param {Array} embeddedItems - Substance items with embeddings
   * @param {Object} embedder - Embedder for query embedding (SubstanceEmbedder)
   */
  setEmbeddedSubstance(embeddedItems, embedder) {
    this.embeddedSubstance = embeddedItems;
    this.substanceEmbedder = embedder;
    this.useRAGSubstance = embeddedItems && embeddedItems.length > 0 && embedder;
    
    if (this.useRAGSubstance) {
      console.log(`[PositionConsolidator] RAG mode enabled: ${embeddedItems.length} substance items available`);
    }
  }

  /**
   * Set pre-computed query embeddings for efficient RAG lookup
   * This eliminates individual embedding API calls during consolidation
   * 
   * @param {Map<string, Array>} embeddingsMap - Map of positionKey → embedding vector
   */
  setPreEmbeddedPositions(embeddingsMap) {
    this.preEmbeddedPositions = embeddingsMap;
    console.log(`[PositionConsolidator] Pre-embedded ${embeddingsMap.size} position queries for RAG`);
  }

  /**
   * Get relevant context for a position using RAG retrieval
   * Uses pre-embedded queries if available (fast path), otherwise embeds on-the-fly
   * 
   * @param {Object} position - Position to get context for
   * @param {number} topK - Number of items to retrieve
   * @returns {Promise<string>} Formatted context string
   */
  async getRelevantContext(position, topK = 3) {
    if (!this.useRAGSubstance || !this.substanceEmbedder) {
      return '';
    }

    try {
      // DECOUPLED FROM TITLE: Use arguments for RAG query instead of title
      const args = (position.sourceArgumentRefs || position.args || []);
      const argsText = args.slice(0, 3).map(a => a.consequence || a.what || '').filter(Boolean).join('. ');
      const query = `${argsText} ${position.summary || ''}`.slice(0, 500);
      const positionKey = this.getPositionKey(position);
      
      // OPTIMIZATION: Use pre-computed embedding if available (fast path - no API call)
      if (positionKey && this.preEmbeddedPositions && this.preEmbeddedPositions.has(positionKey)) {
        const preComputedEmbedding = this.preEmbeddedPositions.get(positionKey);
        const relevantItems = this.substanceEmbedder.retrieveRelevantWithEmbedding(
          preComputedEmbedding,
          query,
          this.embeddedSubstance,
          { topK, minScore: 0.35 }
        );
        
        if (!relevantItems || relevantItems.length === 0) {
          return '';
        }
        
        return this.substanceEmbedder.formatForPrompt(relevantItems);
      }
      
      // Fallback: compute embedding on-the-fly (slow path - makes API call)
      const relevantItems = await this.substanceEmbedder.retrieveRelevant(
        query,
        this.embeddedSubstance,
        { topK, minScore: 0.35 }
      );
      
      if (!relevantItems || relevantItems.length === 0) {
        return '';
      }
      
      return this.substanceEmbedder.formatForPrompt(relevantItems);
    } catch (error) {
      console.warn(`[PositionConsolidator] RAG retrieval failed: ${error.message}`);
      return '';
    }
  }

  /**
   * Generate a unique key for a position (for pre-embedding lookup)
   * @private
   */
  getPositionKey(position) {
    // DECOUPLED FROM TITLE: Use summary + responseNumbers as unique identifier
    // This ensures position lookups work even when titles are poor quality
    const summaryStart = (position.summary || '').slice(0, 100).replace(/\s+/g, '_').slice(0, 50);
    const respCount = (position.responseNumbers || []).length;

    if (summaryStart) {
      return `${summaryStart}_${respCount}`;
    }

    // Fallback: use arguments if no summary
    const args = (position.sourceArgumentRefs || position.args || []);
    const argsKey = args.slice(0, 2)
      .map(a => (a.consequence || a.what || '').slice(0, 30))
      .join('_')
      .replace(/\s+/g, '_');

    return argsKey || null;
  }

  /**
   * Main consolidation entry point
   * @param {Array} aggregatedThemes - Themes with positions from Aggregator
   * @param {Object} stats - Dataset statistics for logging
   * @param {boolean|string} mergeAcrossThemes - Strategy: true/'full', 'selective', false/'none'
   * @param {Array} allResponses - All responses (for recalculating breakdowns)
   * @returns {Promise<Array>} Consolidated themes
   */
  async consolidate(aggregatedThemes, stats = {}, mergeAcrossThemes = false, allResponses = [], microSummaries = []) {
    if (!this.enabled) {
      console.log('[PositionConsolidator] Consolidation disabled, skipping');
      return aggregatedThemes;
    }

    const responseCount = stats.responseCount || 0;
    const complexity = stats.complexity || 'unknown';

    // Normalize strategy to string
    let strategy = mergeAcrossThemes;
    if (typeof mergeAcrossThemes === 'boolean') {
      strategy = mergeAcrossThemes ? 'full' : 'none';
    }

    console.log(`[PositionConsolidator] Starting consolidation (${responseCount} responses, complexity: ${complexity}, strategy: ${strategy})`);

    // Store allResponses for use in mergePositions
    this.allResponses = allResponses;

    // CRITICAL: Initialize ResponseTracker to prevent data loss
    const tracker = new ResponseTracker();
    tracker.initialize(aggregatedThemes);

    // NEW STEP: Same-respondent coherence check
    // Merge positions from the SAME respondent if they are variations of the same argument
    // But keep them separate if they are substantially different topics
    let coherentThemes = await this.mergeSameRespondentVariations(aggregatedThemes, stats);

    // CRITICAL NEW STEP: Direction-based cross-theme consolidation
    // All pro_change positions across ALL themes → ONE "Støtte til projektet" position
    // All pro_status_quo positions stay in their themes but without pro_change respondents
    // This MUST run BEFORE object concentration merge to prevent stance mixing
    coherentThemes = await this.consolidateByDirection(coherentThemes, microSummaries);

    // NEW: SAME-OBJECT MEGA-MERGE for high object concentration cases
    // When arguments focus heavily on a single object (e.g., "Palads"),
    // merge all positions about that object into one mega-position with rich sub-positions
    const objectConcentration = stats.objectConcentration;
    const dominantObj = objectConcentration?.dominantObjects?.[0];
    const dominantObjPct = dominantObj ? parseFloat(dominantObj.percentage) : 0;

    // Trigger mega-merge if:
    // ONLY trigger mega-merge for TRUE mass agreement (90%+)
    // Lower thresholds destroy nuance between different concerns about same object
    // (e.g., "preserve building" vs "reduce building height" both mention the building
    // but are fundamentally different positions that should stay separate)
    const shouldMegaMerge =
      objectConcentration?.status === 'VERY_HIGH_CONCENTRATION' &&
      dominantObjPct >= 90;

    // DISABLED: Mega-merge was a workaround for the numerical merge-guard.
    // Now that shouldAllowMerge() no longer blocks based on size,
    // normal consolidation can handle all cases with proper semantic validation.
    //
    // Mega-merge had issues:
    // 1. Skipped pairwise LLM validation
    // 2. Merged entire direction-partitions at once
    // 3. Mixed FOR/AGAINST when direction classification failed
    //
    // The semantic guards (direction check, similarity, LLM validation) are sufficient.
    if (shouldMegaMerge && dominantObj) {
      console.log(`[PositionConsolidator] HIGH OBJECT CONCENTRATION detected: "${dominantObj.object}" at ${dominantObjPct.toFixed(1)}%`);
      console.log(`[PositionConsolidator] Mega-merge DISABLED - using normal consolidation with semantic validation`);
      // coherentThemes = await this.performSameObjectMegaMerge(...);  // DISABLED
    }
    this._massAgreementDetected = false;  // No longer used
    this._dominantObject = dominantObj?.object || null;

    // Choose consolidation strategy
    let consolidated;
    if (strategy === 'full') {
      consolidated = await this.consolidateAcrossThemes(coherentThemes, stats);
    } else if (strategy === 'selective') {
      consolidated = await this.consolidateSelectively(coherentThemes, stats);
    } else {
      consolidated = await this.consolidateWithinThemes(coherentThemes, stats);
    }

    // NEW: Consolidate small (1-3 respondent) positions within each theme
    // This reduces fragmentation where multiple "one citizen" positions are about the same topic
    // Pass microSummaries for substance-anchored merging
    consolidated = await this.consolidateSmallPositionsWithinThemes(consolidated, microSummaries);

    // Cross-theme stance merging: Find positions across different themes that express
    // the SAME fundamental stance (e.g. "Bevar Palads" in 5 different themes).
    // Uses embedding-based candidate detection + LLM validation with desired-outcome logic.
    consolidated = await this.mergeCrossThemeStances(consolidated);

    // VALIDATE & AUTO-RECOVER orphaned responses
    console.log('[PositionConsolidator] Validating response coverage after consolidation...');
    const validation = tracker.validate(consolidated);

    if (validation.orphanedResponses.length > 0) {
      console.warn(`[PositionConsolidator] ⚠️  VALIDATION FAILED: ${validation.orphanedResponses.length} orphaned responses detected!`);
      console.warn(`[PositionConsolidator] Orphaned response numbers: ${validation.orphanedResponses.map(o => o.responseNumber).join(', ')}`);
      console.warn(`[PositionConsolidator] Starting auto-recovery...`);

      // Auto-recover orphaned responses
      consolidated = tracker.recover(consolidated, validation.orphanedResponses, allResponses);

      // Re-validate after recovery
      const finalValidation = tracker.validate(consolidated);

      if (finalValidation.orphanedResponses.length > 0) {
        const unrecoverableNums = finalValidation.orphanedResponses.map(o => o.responseNumber).join(', ');
        console.error(`[PositionConsolidator] 🚨 CRITICAL: ${finalValidation.orphanedResponses.length} responses still orphaned after recovery!`);
        console.error(`[PositionConsolidator] Unrecoverable response numbers: ${unrecoverableNums}`);

        // Log diagnostic report
        const report = tracker.generateReport();
        console.error('[PositionConsolidator] Diagnostic report:', JSON.stringify(report, null, 2));

        throw new Error(`CRITICAL: Position consolidation lost ${finalValidation.orphanedResponses.length} responses: ${unrecoverableNums}. This should never happen!`);
      } else {
        console.log(`[PositionConsolidator] ✓ Auto-recovery successful: All ${validation.totalResponses} responses accounted for`);
      }
    } else {
      console.log(`[PositionConsolidator] ✓ Validation passed: All ${validation.totalResponses} responses preserved during consolidation`);
    }

    // TITLE VALIDATION: Check all position titles for grammatical/structural issues
    console.log('[PositionConsolidator] Validating position titles...');
    const titleValidation = validateAllTitles(consolidated);

    if (!titleValidation.valid || titleValidation.issues.length > 0) {
      const errorCount = titleValidation.issues.filter(i => i.errors.length > 0).length;
      const warningCount = titleValidation.issues.filter(i => i.warnings.length > 0 && i.errors.length === 0).length;

      if (errorCount > 0) {
        console.warn(`[PositionConsolidator] ⚠️ Title validation found ${errorCount} errors and ${warningCount} warnings`);

        // Auto-fix titles with errors
        for (const issue of titleValidation.issues) {
          if (issue.errors.length > 0) {
            console.warn(`[PositionConsolidator]   - "${issue.title?.slice(0, 50)}...": ${issue.errors.join('; ')}`);

            // Find and fix the position
            for (const theme of consolidated) {
              for (const pos of (theme.positions || [])) {
                if (pos.title === issue.title) {
                  const fixedTitle = autoFixTitle(pos.title, pos._direction);
                  if (fixedTitle !== pos.title) {
                    console.log(`[PositionConsolidator]   ✓ Auto-fixed: "${pos.title?.slice(0, 40)}..." → "${fixedTitle?.slice(0, 40)}..."`);
                    pos.title = fixedTitle;
                  }
                }
              }
            }
          }
        }
      } else if (warningCount > 0) {
        console.log(`[PositionConsolidator] Title validation: ${warningCount} warnings (no errors)`);
      }
    } else {
      console.log(`[PositionConsolidator] ✓ Title validation passed: All titles have correct format`);
    }

    return consolidated;
  }

  /**
   * Consolidate positions across ALL themes (for tiny hearings)
   * Treats all positions as candidates for merging regardless of theme
   */
  async consolidateAcrossThemes(aggregatedThemes, stats, allResponses = []) {
    // Flatten all positions from all themes
    const allPositions = [];
    const positionToThemeMap = new Map();

    for (const theme of aggregatedThemes) {
      for (const position of theme.positions || []) {
        const posIndex = allPositions.length;
        // FIX: Gem original tema DIREKTE på position (overlever merge)
        // Brug kun specifikt tema (ikke "Andre emner") hvis det ikke allerede er sat
        if (!position._originalTheme && theme.name !== 'Andre emner') {
          position._originalTheme = theme.name;
        }
        allPositions.push(position);
        positionToThemeMap.set(posIndex, theme.name);
      }
    }

    if (allPositions.length < 2) {
      console.log('[PositionConsolidator] Less than 2 positions total, nothing to consolidate');
      return aggregatedThemes;
    }

    console.log(`[PositionConsolidator] Cross-theme consolidation: ${allPositions.length} total positions across ${aggregatedThemes.length} themes`);

    // Stage 1: Find merge candidates using CROSS-THEME threshold (higher = more conservative)
    // QUALITY FIX: Lowered from 0.88 to 0.82 to preserve nuances
    const crossThemeThreshold = this.crossThemeThreshold || Math.max(0.82, this.similarityThreshold + 0.04);
    const mergeCandidates = await this.findMergeCandidates(allPositions, 'CROSS-THEME', crossThemeThreshold);
    console.log(`[PositionConsolidator] Found ${mergeCandidates.length} cross-theme merge candidates (similarity >= ${crossThemeThreshold.toFixed(3)})`);

    // Stage 2: Validate candidates with LLM using ADAPTIVE concurrency
    // CRITICAL: Always validate merges, even for full strategy, to prevent "black hole" merging
    // of distinct arguments that happen to be semantically similar (e.g. same topic).

    // Calculate adaptive concurrency based on total position count
    let crossThemeConcurrency;
    if (allPositions.length < 50) {
      crossThemeConcurrency = 25; // Small hearing → aggressive
    } else if (allPositions.length < 200) {
      crossThemeConcurrency = 15; // Medium hearing → moderate
    } else if (allPositions.length < 500) {
      crossThemeConcurrency = 10; // Large hearing → conservative
    } else {
      crossThemeConcurrency = 5;  // Very large hearing → very conservative
    }
    console.log(`[PositionConsolidator] Cross-theme validation: ${allPositions.length} positions, LLM concurrency=${crossThemeConcurrency}`);

    const validatedMerges = await this.validateMergeCandidatesAdaptive(mergeCandidates, 'CROSS-THEME', crossThemeConcurrency);
    console.log(`[PositionConsolidator] Validated ${validatedMerges.length}/${mergeCandidates.length} cross-theme merges via LLM`);

    // Stage 3: Execute merges
    const mergedPositions = this.executeMerges(allPositions, validatedMerges);
    const mergeCount = allPositions.length - mergedPositions.length;

    console.log(`[PositionConsolidator] Cross-theme consolidation: ${allPositions.length} → ${mergedPositions.length} positions (${mergeCount} merged, ${((mergeCount / allPositions.length) * 100).toFixed(1)}% reduction)`);

    // Rebuild theme structure with merged positions
    // For cross-theme consolidation: intelligently choose best theme for each merged position
    const consolidatedThemes = [];
    const themeMap = new Map(); // Track which themes get which positions

    // FIX: Gem original position counts FØR clearing arrays (bruges til scoring)
    const originalPositionCounts = new Map();
    for (const theme of aggregatedThemes) {
      originalPositionCounts.set(theme.name, theme.positions?.length || 0);
    }

    // Initialize all themes as empty
    for (const theme of aggregatedThemes) {
      themeMap.set(theme.name, []);
    }

    // For each merged position, choose the most appropriate theme
    for (const position of mergedPositions) {
      const bestTheme = this.chooseBestThemeForPosition(position, aggregatedThemes, positionToThemeMap, originalPositionCounts);
      console.log(`[PositionConsolidator] Placing position "${position.title}" in theme "${bestTheme}"`);

      if (!themeMap.has(bestTheme)) {
        // Fallback: use "Andre emner" if theme not found (the sole catch-all)
        const andreEmner = 'Andre emner';
        if (!themeMap.has(andreEmner)) {
          themeMap.set(andreEmner, []);
        }
        themeMap.get(andreEmner).push(position);
      } else {
        themeMap.get(bestTheme).push(position);
      }
    }

    // Build final theme structure
    for (const theme of aggregatedThemes) {
      const positions = themeMap.get(theme.name) || [];
      const originalCount = aggregatedThemes.find(t => t.name === theme.name)?.positions?.length || 0;

      consolidatedThemes.push({
        ...theme,
        positions,
        _consolidationMeta: {
          originalCount,
          consolidatedCount: positions.length,
          mergedCount: originalCount - positions.length,
          crossTheme: true
        }
      });
    }

    return consolidatedThemes;
  }

  /**
   * Choose the best theme for a merged position
   * Uses heuristics: original theme (highest priority), keyword matching, position counts
   * @param {Object} position - The position to place
   * @param {Array} aggregatedThemes - All themes
   * @param {Map} positionToThemeMap - Map of position index to original theme
   * @param {Map} originalPositionCounts - Map of theme name to ORIGINAL position count (before clearing)
   */
  chooseBestThemeForPosition(position, aggregatedThemes, positionToThemeMap, originalPositionCounts) {
    // FIX: HØJESTE PRIORITET - Brug original tema hvis gemt på position
    // Dette bevarer tema-tilhørsforhold gennem cross-theme consolidation
    if (position._originalTheme) {
      const originalTheme = aggregatedThemes.find(t => t.name === position._originalTheme);
      if (originalTheme) {
        console.log(`[PositionConsolidator] Using saved _originalTheme: "${position._originalTheme}"`);
        return position._originalTheme;
      }
    }

    // Fallback: match keywords in title/summary to theme names
    const positionText = `${position.title} ${position.summary || ''}`.toLowerCase();

    let bestTheme = null;
    let bestScore = -1;

    for (const theme of aggregatedThemes) {
      // Skip "Andre emner" i første pass - vi vil foretrække specifikke temaer
      if (theme.name === 'Andre emner') {
        continue;
      }

      // FIX: Brug originalPositionCounts i stedet for theme.positions.length
      const originalCount = originalPositionCounts?.get(theme.name) || 0;
      
      // Skip themes that had no positions originally
      if (originalCount === 0) {
        continue;
      }

      let score = 0;
      const themeName = theme.name.toLowerCase();
      const themeKeywords = themeName.split(/\s+/).filter(w => w.length > 3);

      // Score based on keyword matches (prioritér § numre)
      for (const keyword of themeKeywords) {
        if (positionText.includes(keyword)) {
          score += 2;
        }
      }

      // Bonus for § temaer (de er mere specifikke)
      if (theme.name.startsWith('§')) {
        score += 3;
      }

      // FIX: Brug ORIGINAL position counts til scoring
      score += originalCount * 0.5;

      if (score > bestScore) {
        bestScore = score;
        bestTheme = theme.name;
      }
    }

    // Kun brug "Andre emner" som fallback hvis intet specifikt tema matcher
    if (!bestTheme || bestScore <= 0) {
      bestTheme = aggregatedThemes.find(t => t.name === 'Andre emner')?.name || aggregatedThemes[0]?.name || 'Andre emner';
    }

    return bestTheme;
  }

  /**
   * Consolidate positions within each theme separately (for normal hearings)
   *
   * OPTIMIZED: Uses adaptive concurrency based on workload analysis.
   * - Themes are processed in parallel (up to themeConcurrency)
   * - LLM validations use per-theme concurrency limits
   * - Small hearings get aggressive parallelism, large hearings are conservative
   */
  async consolidateWithinThemes(aggregatedThemes, stats) {
    // Analyze workload and calculate optimal concurrency settings
    const workload = this.analyzeWorkload(aggregatedThemes);

    console.log(`[PositionConsolidator] Processing ${aggregatedThemes.length} themes with adaptive concurrency`);
    console.log(`[PositionConsolidator]   Theme parallelism: ${workload.themeConcurrency}, Base LLM concurrency: ${workload.baseLLMConcurrency}`);

    // Create async tasks for each theme
    const themeProcessors = aggregatedThemes.map((theme) => async () => {
      const positions = theme.positions || [];

      if (positions.length < 2) {
        // Nothing to consolidate
        return { theme, merged: 0 };
      }

      // Get theme-specific LLM concurrency
      const llmConcurrency = workload.perThemeConcurrency.get(theme.name) || workload.baseLLMConcurrency;

      console.log(`[PositionConsolidator] Theme "${theme.name}": ${positions.length} positions, LLM concurrency=${llmConcurrency}`);

      // Stage 1: Find merge candidates using embeddings
      const mergeCandidates = await this.findMergeCandidates(positions, theme.name);
      console.log(`[PositionConsolidator] Found ${mergeCandidates.length} merge candidates (similarity >= ${this.similarityThreshold})`);

      // Stage 2: Validate candidates with ADAPTIVE concurrency
      const validatedMerges = await this.validateMergeCandidatesAdaptive(mergeCandidates, theme.name, llmConcurrency);
      console.log(`[PositionConsolidator] Validated ${validatedMerges.length}/${mergeCandidates.length} merges via LLM`);

      // Stage 3: Execute merges
      const mergedPositions = this.executeMerges(positions, validatedMerges);
      const mergeCount = positions.length - mergedPositions.length;

      console.log(`[PositionConsolidator] Consolidated "${theme.name}": ${positions.length} → ${mergedPositions.length} positions (${mergeCount} merged)`);

      return {
        theme: {
          ...theme,
          positions: mergedPositions,
          _consolidationMeta: {
            originalCount: positions.length,
            consolidatedCount: mergedPositions.length,
            mergedCount: mergeCount,
            candidatesFound: mergeCandidates.length,
            candidatesValidated: validatedMerges.length
          }
        },
        merged: mergeCount
      };
    });

    // Execute themes in parallel with controlled concurrency
    const results = await limitConcurrency(themeProcessors, workload.themeConcurrency);

    // Collect results
    const consolidated = results.map(r => r.theme);
    const totalMerged = results.reduce((sum, r) => sum + r.merged, 0);

    console.log(`[PositionConsolidator] Total consolidation: ${totalMerged} positions merged across all themes`);
    return consolidated;
  }

  /**
   * NEW: Merge positions from the SAME respondent that are variations of the same argument.
   * 
   * PROBLEM: A single respondent (e.g., "Brug Folkeskolen") might have 3 arguments that are
   * all about the same topic (bridge/path to school) but end up as separate positions.
   * 
   * SOLUTION: For each respondent with multiple positions:
   * 1. Calculate pairwise similarity between their positions
   * 2. If similarity is HIGH (>0.70): They are variations → MERGE
   * 3. If similarity is LOW (<0.70): They are different topics → KEEP SEPARATE
   * 
   * This is different from general consolidation because we use a LOWER threshold
   * for same-respondent positions (they're more likely to be variations).
   */
  async mergeSameRespondentVariations(aggregatedThemes, stats) {
    // DISABLED: Same-respondent merging is now disabled.
    // When micro-summarizer extracts separate arguments, they represent DISTINCT concerns
    // that should stay separate so other respondents can join them individually.
    //
    // Example: Response 1413 has concerns about:
    //   - 34m building height (Bebyggelsens omfang og placering)
    //   - 450% building percentage (Bebyggelsens omfang og placering)
    //   - Preservation of Palads (Bebyggelsens ydre fremtræden)
    //
    // These should be 3 separate positions, even though they have high semantic similarity.
    // Other respondents might share only one of these concerns and should be able to join
    // that specific position without being merged into the others.

    console.log('[PositionConsolidator] Same-respondent merge DISABLED - respecting micro-summarizer splits');
    return aggregatedThemes;

    // Original logic below (kept for reference but never executed):
    console.log('[PositionConsolidator] Checking for same-respondent position variations...');

    // Track all positions by respondent
    const respondentToPositions = new Map(); // responseNumber -> [{position, themeIdx, posIdx}]
    
    aggregatedThemes.forEach((theme, themeIdx) => {
      (theme.positions || []).forEach((position, posIdx) => {
        // Only consider positions with exactly 1 respondent (single-respondent positions)
        // Multi-respondent positions are already aggregated
        if (position.responseNumbers?.length === 1) {
          const responseNumber = position.responseNumbers[0];
          if (!respondentToPositions.has(responseNumber)) {
            respondentToPositions.set(responseNumber, []);
          }
          respondentToPositions.get(responseNumber).push({
            position,
            themeIdx,
            posIdx,
            themeName: theme.name
          });
        }
      });
    });

    // Find respondents with multiple single-respondent positions
    const respondentsWithMultiple = Array.from(respondentToPositions.entries())
      .filter(([_, positions]) => positions.length > 1);

    if (respondentsWithMultiple.length === 0) {
      console.log('[PositionConsolidator] No respondents with multiple single-positions found');
      return aggregatedThemes;
    }

    console.log(`[PositionConsolidator] Found ${respondentsWithMultiple.length} respondents with multiple positions`);

    // Track which positions should be merged
    const mergeGroups = []; // [{responseNumber, positions: [...], merged: Position}]
    const positionsToRemove = new Set(); // "themeIdx-posIdx" keys
    
    // Use a LOWER threshold for same-respondent merging (0.70 instead of 0.85)
    // Same respondent = higher likelihood of being variations of same argument
    const sameRespondentThreshold = 0.70;

    for (const [responseNumber, positions] of respondentsWithMultiple) {
      if (positions.length < 2) continue;

      console.log(`[PositionConsolidator] Analyzing respondent ${responseNumber} with ${positions.length} positions:`);
      positions.forEach((p, i) => {
        console.log(`  [${i}] "${p.position.title?.slice(0, 60)}..." (theme: ${p.themeName})`);
      });

      // Generate embeddings for this respondent's positions
      // DECOUPLED FROM TITLE: Use arguments for same-respondent merge embeddings
      const embeddingTexts = positions.map(p => {
        const args = (p.position.sourceArgumentRefs || p.position.args || []);
        const argsText = args.slice(0, 5)
          .map(a => a.consequence || a.what || '')
          .filter(Boolean)
          .join('. ');
        const summaryPreview = (p.position.summary || '').slice(0, 600);
        return `${argsText}\n\n${summaryPreview}`;
      });

      let embeddings;
      try {
        embeddings = await this.embedder.embedBatch(embeddingTexts);
      } catch (error) {
        console.warn(`[PositionConsolidator] Failed to embed positions for respondent ${responseNumber}: ${error.message}`);
        continue;
      }

      // Calculate pairwise similarity and find merge candidates
      const shouldMerge = []; // indices of positions to merge together
      const checked = new Set();

      for (let i = 0; i < positions.length; i++) {
        if (checked.has(i)) continue;

        const mergeGroup = [i];
        checked.add(i);

        for (let j = i + 1; j < positions.length; j++) {
          if (checked.has(j)) continue;
          if (!embeddings[i] || !embeddings[j]) continue;

          // CRITICAL: Don't merge positions from DIFFERENT themes
          // Different themes = different regulatory areas (§§) - they should stay separate
          // so other respondents with the same specific concern can join them
          if (positions[i].themeName !== positions[j].themeName) {
            console.log(`[PositionConsolidator]   ❌ KEEP SEPARATE: Different themes ("${positions[i].themeName}" vs "${positions[j].themeName}")`);
            continue;
          }

          const similarity = this.cosineSimilarity(embeddings[i], embeddings[j]);

          console.log(`[PositionConsolidator]   Similarity [${i}] vs [${j}]: ${similarity.toFixed(3)}`);

          if (similarity >= sameRespondentThreshold) {
            // High similarity + same theme = variations of same argument → MERGE
            console.log(`[PositionConsolidator]   ✅ MERGE: "${positions[i].position.title?.slice(0, 40)}..." + "${positions[j].position.title?.slice(0, 40)}..." (sim=${similarity.toFixed(3)} >= ${sameRespondentThreshold})`);
            mergeGroup.push(j);
            checked.add(j);
          } else {
            // Low similarity = different topics → KEEP SEPARATE
            console.log(`[PositionConsolidator]   ❌ KEEP SEPARATE: Different topics (sim=${similarity.toFixed(3)} < ${sameRespondentThreshold})`);
          }
        }

        if (mergeGroup.length > 1) {
          shouldMerge.push(mergeGroup);
        }
      }

      // Execute merges for this respondent
      for (const mergeGroup of shouldMerge) {
        const groupPositions = mergeGroup.map(idx => positions[idx]);
        const mergedPosition = this.mergePositions(
          groupPositions.map(p => p.position),
          this.allResponses || []
        );

        // Mark merged position with metadata
        mergedPosition._sameRespondentMerge = true;
        mergedPosition._mergedVariationCount = groupPositions.length;

        mergeGroups.push({
          responseNumber,
          positions: groupPositions,
          merged: mergedPosition,
          survivorThemeIdx: groupPositions[0].themeIdx,
          survivorPosIdx: groupPositions[0].posIdx
        });

        // Mark all but first position for removal
        groupPositions.slice(1).forEach(p => {
          positionsToRemove.add(`${p.themeIdx}-${p.posIdx}`);
        });

        console.log(`[PositionConsolidator] 🔗 Merged ${groupPositions.length} positions from respondent ${responseNumber} into: "${mergedPosition.title?.slice(0, 60)}..."`);
      }
    }

    if (mergeGroups.length === 0) {
      console.log('[PositionConsolidator] No same-respondent variations found to merge');
      return aggregatedThemes;
    }

    // Rebuild themes with merged positions
    const rebuiltThemes = aggregatedThemes.map((theme, themeIdx) => {
      const newPositions = [];

      (theme.positions || []).forEach((position, posIdx) => {
        const key = `${themeIdx}-${posIdx}`;
        
        if (positionsToRemove.has(key)) {
          // This position was merged into another - skip it
          return;
        }

        // Check if this position is the survivor of a merge group
        const mergeGroup = mergeGroups.find(
          g => g.survivorThemeIdx === themeIdx && g.survivorPosIdx === posIdx
        );

        if (mergeGroup) {
          // Replace with merged position
          newPositions.push(mergeGroup.merged);
        } else {
          // Keep original
          newPositions.push(position);
        }
      });

      return {
        ...theme,
        positions: newPositions
      };
    });

    const totalMerged = mergeGroups.reduce((sum, g) => sum + g.positions.length - 1, 0);
    const totalPositionsBefore = aggregatedThemes.reduce((sum, t) => sum + (t.positions?.length || 0), 0);
    const totalPositionsAfter = rebuiltThemes.reduce((sum, t) => sum + (t.positions?.length || 0), 0);
    console.log(`[PositionConsolidator] Same-respondent merge complete: ${totalMerged} variations merged (${totalPositionsBefore} → ${totalPositionsAfter} positions)`);

    return rebuiltThemes;
  }

  /**
   * CRITICAL: Direction-based cross-theme consolidation
   *
   * This ensures that pro-project respondents (direction: pro_change) are consolidated
   * into ONE "Støtte til projektet" position across ALL themes, and are NOT mixed
   * into preservation positions (direction: pro_status_quo).
   *
   * Root cause this fixes:
   * - Aggregator splits arguments by theme, so "Støtte til projektet" appears in multiple themes
   * - Respondent 228 in "Ønske om bygningshøjde", 384/449 in "Støtte til projektet" under different themes
   * - All are pro_change but spread across themes with different titles
   * - This merger collects them ALL into one coherent "Støtte til projektet/fornyelse" position
   *
   * @param {Array} themes - Themes with positions from Aggregator
   * @param {Array} microSummaries - For direction lookup
   * @returns {Promise<Array>} Themes with direction-consolidated positions
   */
  async consolidateByDirection(themes, microSummaries = []) {
    // REFACTORED: Direction is now a BLOCKER, not a DRIVER
    //
    // OLD BEHAVIOR (problematic):
    //   - Collected ALL pro_change positions and merged them into ONE mega-position
    //   - This caused incorrect grouping when direction was misclassified
    //
    // NEW BEHAVIOR:
    //   - Direction does NOT drive grouping (embeddings do that)
    //   - Direction ONLY prevents merging of positions with opposite stances
    //   - Each position is tagged with its dominant direction for downstream use
    //
    // Why this change:
    //   Direction classification depends on understanding the specific proposal,
    //   which LLMs often misinterpret. Using embeddings for semantic similarity
    //   is more robust. Direction is used as a sanity-check blocker only.

    console.log('[PositionConsolidator] 🎯 Direction tagging (blocker mode - no mega-merge)...');

    // Build micro-summary index for direction lookup
    const microIndex = new Map();
    for (const ms of microSummaries) {
      microIndex.set(ms.responseNumber, ms);
    }

    // Tag each position with its dominant direction
    let proChangeCount = 0;
    let proStatusQuoCount = 0;
    let neutralCount = 0;

    const taggedThemes = themes.map(theme => {
      const taggedPositions = (theme.positions || []).map(position => {
        const direction = this.calculatePositionDirection(position, microIndex);

        if (direction === 'pro_change') proChangeCount++;
        else if (direction === 'pro_status_quo') proStatusQuoCount++;
        else neutralCount++;

        return {
          ...position,
          _direction: direction,
          _directionGroup: direction === 'pro_change' ? 'support' :
                           direction === 'pro_status_quo' ? 'against' : 'neutral'
        };
      });

      return {
        ...theme,
        positions: taggedPositions
      };
    });

    console.log(`[PositionConsolidator] Direction distribution: ${proChangeCount} pro_change, ${proStatusQuoCount} pro_status_quo, ${neutralCount} neutral`);
    console.log('[PositionConsolidator] ✅ Direction tagging complete (no mega-merge - using blocker mode)');

    return taggedThemes;
  }

  /**
   * Check if two positions can be merged based on direction.
   * Used as a BLOCKER to prevent merging positions with opposite stances.
   * RESTRICTIVE: Neutral only merges with non-neutral if confidence is low.
   *
   * @param {Object} posA - First position
   * @param {Object} posB - Second position
   * @returns {{allowed: boolean, reason?: string, warning?: string}} Merge permission
   */
  canMergeByDirection(posA, posB) {
    const dirA = posA._direction || 'neutral';
    const dirB = posB._direction || 'neutral';

    // Same direction can always merge
    if (dirA === dirB) {
      return { allowed: true };
    }

    // Opposite directions NEVER merge
    if ((dirA === 'pro_change' && dirB === 'pro_status_quo') ||
        (dirA === 'pro_status_quo' && dirB === 'pro_change')) {
      return { allowed: false, reason: `opposite: ${dirA} vs ${dirB}` };
    }

    // TIGHTENED: Neutral + directional positions should NOT merge.
    // This prevents contamination of directional positions with neutral content.
    // If one position has a clear direction, the other should match.
    if (dirA === 'neutral' || dirB === 'neutral') {
      const neutral = dirA === 'neutral' ? posA : posB;
      const nonNeutral = dirA === 'neutral' ? posB : posA;
      // Block ALL neutral + directional merges
      if (nonNeutral._direction && nonNeutral._direction !== 'neutral') {
        return { allowed: false, reason: `neutral cannot merge with directional: ${nonNeutral._direction}` };
      }
    }

    return { allowed: true };
  }

  /**
   * Calculate dominant direction for a position based on its arguments.
   * Uses ONLY the LLM-classified direction from micro-summaries - NO hardcoded keywords.
   */
  calculatePositionDirection(position, microIndex) {
    const args = position.sourceArgumentRefs || position.args || [];

    let proChange = 0;
    let proStatusQuo = 0;

    // First: check direction on the arguments themselves (if available)
    for (const arg of args) {
      if (arg.direction === 'pro_change') proChange++;
      else if (arg.direction === 'pro_status_quo') proStatusQuo++;
    }

    // If no direction on args, look up from micro-summaries
    if (proChange === 0 && proStatusQuo === 0) {
      for (const arg of args) {
        const dir = this.getArgumentDirection(arg.responseNumber, microIndex);
        if (dir === 'pro_change') proChange++;
        else if (dir === 'pro_status_quo') proStatusQuo++;
      }
    }

    // If still no direction data, check responseNumbers directly
    if (proChange === 0 && proStatusQuo === 0 && position.responseNumbers) {
      for (const respNum of position.responseNumbers) {
        const dir = this.getArgumentDirection(respNum, microIndex);
        if (dir === 'pro_change') proChange++;
        else if (dir === 'pro_status_quo') proStatusQuo++;
      }
    }

    if (proChange > proStatusQuo) return 'pro_change';
    if (proStatusQuo > proChange) return 'pro_status_quo';
    return 'neutral';
  }

  /**
   * Get direction for a specific respondent from micro-summary.
   * Uses ONLY LLM-classified direction - NO hardcoded keywords.
   */
  getArgumentDirection(responseNumber, microIndex) {
    const ms = microIndex.get(responseNumber);
    if (!ms?.arguments?.length) return 'neutral';

    // Count directions across all arguments for this respondent
    let proChange = 0;
    let proStatusQuo = 0;

    for (const arg of ms.arguments) {
      if (arg.direction === 'pro_change') proChange++;
      else if (arg.direction === 'pro_status_quo') proStatusQuo++;
    }

    if (proChange > proStatusQuo) return 'pro_change';
    if (proStatusQuo > proChange) return 'pro_status_quo';
    return 'neutral';
  }

  /**
   * NEW: Same-object mega-merge for high object concentration cases
   * 
   * When 60%+ of arguments focus on the same physical object (e.g., "Palads"),
   * merge ALL positions that mention this object into one mega-position.
   * The nuances will be captured by SubPositionExtractor later.
   * 
   * This is SPECIFICALLY designed for mass-agreement cases like:
   * - "Bevar Palads" (95% of respondents want to preserve the building)
   * - Each person expresses this differently but it's fundamentally the same position
   * 
   * @param {Array} themes - Aggregated themes with positions
   * @param {Object} objectConcentration - Object concentration analysis
   * @param {Object} stats - Dataset statistics
   * @returns {Promise<Array>} Themes with mega-merged positions
   */
  async performSameObjectMegaMerge(themes, objectConcentration, stats, microSummaries = []) {
    if (!objectConcentration?.dominantObjects?.length) {
      return themes;
    }

    const dominantObject = objectConcentration.dominantObjects[0];
    const objectName = dominantObject.object.toLowerCase();
    
    console.log(`[PositionConsolidator] SAME-OBJECT MEGA-MERGE: Targeting "${objectName}" (${dominantObject.percentage}% of arguments)`);

    // Build search patterns: the dominant object + contextual related words
    // When hearing is about a building (like Palads), include words that indicate
    // discussions about buildings, preservation, renovation, etc.
    const searchPatterns = this.buildObjectSearchPatterns(objectName, objectConcentration);
    console.log(`[PositionConsolidator] Search patterns: ${searchPatterns.join(', ')}`);

    // Find all positions that mention the dominant object OR related patterns
    const positionsAboutObject = [];
    const positionLocations = []; // Track where each position came from
    const unmatchedPositions = []; // For semantic fallback
    
    for (let themeIdx = 0; themeIdx < themes.length; themeIdx++) {
      const theme = themes[themeIdx];
      for (let posIdx = 0; posIdx < (theme.positions?.length || 0); posIdx++) {
        const position = theme.positions[posIdx];
        
        // Build comprehensive search text
        const searchText = [
          position.title,
          position.summary,
          ...(position._mergedFrom || []),
          ...(position.sourceArgumentRefs?.map(r => r.what) || []),
          ...(position.sourceArgumentRefs?.map(r => r.why) || [])
        ].filter(Boolean).join(' ').toLowerCase();
        
        // Check if any search pattern matches
        const matchedPattern = searchPatterns.find(pattern => searchText.includes(pattern));

        // SAFETY: Only treat a position as "about the dominant object" if it actually mentions the object
        // (or a short prefix variation). This prevents generic terms like "bevar"/"bygning" from pulling in
        // unrelated positions into the same-object mega-merge candidate set.
        const objectMentions = (() => {
          const variants = [objectName];
          if (objectName.length >= 4) {
            variants.push(objectName.slice(0, -1));
            variants.push(objectName.slice(0, -2));
          }
          return variants
            .filter(v => v && v.length >= 2)
            .some(v => searchText.includes(v));
        })();
        
        if (matchedPattern && objectMentions) {
          console.log(`[PositionConsolidator]   ✓ "${position.title?.slice(0, 50)}..." matches "${matchedPattern}"`);
          positionsAboutObject.push(position);
          positionLocations.push({ themeIdx, posIdx, themeName: theme.name });
        } else {
          unmatchedPositions.push({ position, themeIdx, posIdx, themeName: theme.name });
        }
      }
    }

    // SEMANTIC FALLBACK: Check unmatched positions for semantic similarity
    // If they are semantically very similar to the matched positions, include them
    if (positionsAboutObject.length >= 3 && unmatchedPositions.length > 0) {
      console.log(`[PositionConsolidator] Checking ${unmatchedPositions.length} unmatched positions for semantic similarity...`);
      
      const additionalMatches = await this.findSemanticMegaMergeMatches(
        positionsAboutObject,
        unmatchedPositions,
        objectName
      );
      
      for (const match of additionalMatches) {
        console.log(`[PositionConsolidator]   ✓ Semantic match: "${match.position.title?.slice(0, 50)}..." (sim=${match.similarity.toFixed(3)})`);
        positionsAboutObject.push(match.position);
        positionLocations.push({ themeIdx: match.themeIdx, posIdx: match.posIdx, themeName: match.themeName });
      }
    }

    console.log(`[PositionConsolidator] Found ${positionsAboutObject.length} positions about "${objectName}"`);

    // CRITICAL: Check if all positions are from THE SAME SINGLE RESPONDENT
    // If so, DO NOT mega-merge - their distinct concerns should stay separate
    // so other respondents can join each specific position later
    const allRespondentsInMerge = new Set();
    for (const pos of positionsAboutObject) {
      for (const respNum of (pos.responseNumbers || [])) {
        allRespondentsInMerge.add(respNum);
      }
    }

    if (allRespondentsInMerge.size === 1) {
      const singleResp = [...allRespondentsInMerge][0];
      console.log(`[PositionConsolidator] ❌ SKIP MEGA-MERGE: All ${positionsAboutObject.length} positions are from SAME SINGLE respondent (${singleResp})`);
      console.log(`[PositionConsolidator]   Reason: Single-respondent positions represent DISTINCT concerns that should stay separate`);
      console.log(`[PositionConsolidator]   This allows other respondents to join each specific position individually`);
      return themes; // Return themes unchanged
    }

    // If we have 3+ positions about the same object, merge them
    if (positionsAboutObject.length < 3) {
      console.log(`[PositionConsolidator] Not enough positions to mega-merge (need 3+)`);
      return themes;
    }

    // CRITICAL: Attach location info to each position BEFORE grouping
    // This ensures we don't lose track of positions during sentiment grouping
    for (let i = 0; i < positionsAboutObject.length; i++) {
      positionsAboutObject[i]._megaMergeLocation = positionLocations[i];
    }

    // THEME-BASED PROTECTION: Positions in topic-specific regulatory themes should NOT be absorbed
    // These themes regulate specific concerns (parking, trees, noise) that are SEPARATE from the dominant object
    // Even if they mention the object, their placement in a topic-specific theme signals they're about that topic
    const TOPIC_SPECIFIC_THEMES = new Set([
      'Bil- og cykelparkering',
      'Ubebyggede arealer',
      'Støj og anden forurening',
      'Friarealer og grønne områder',
      'Trafikale forhold',
      'Vej- og stiforhold',
      'Beplantning',
      'Klima og bæredygtighed'
    ]);

    const themeProtectedPositions = [];
    const candidatesForCoreFilter = [];

    for (const position of positionsAboutObject) {
      const themeName = position._megaMergeLocation?.themeName;

      if (TOPIC_SPECIFIC_THEMES.has(themeName)) {
        // Position is in a topic-specific regulatory theme - protect it from absorption
        position._protectedFromMegaMerge = true;
        position._protectedReason = `theme-specific: ${themeName}`;
        themeProtectedPositions.push(position);
        console.log(`[PositionConsolidator] THEME-PROTECTED: "${position.title?.slice(0, 50)}..." in "${themeName}"`);
      } else {
        candidatesForCoreFilter.push(position);
      }
    }

    if (themeProtectedPositions.length > 0) {
      console.log(`[PositionConsolidator] Theme-based protection: ${themeProtectedPositions.length} position(s) protected from mega-merge`);
    }

    // CORE POSITION FILTER: Separate "core" positions (about the object) from "peripheral" positions
    // Core: "Bevar Palads" - these get mega-merged
    // Peripheral: "Kræv miljøanalyse", "§14-godkendelse" - these stay as separate positions
    // Note: Only non-theme-protected positions go through this filter
    const { corePositions, peripheralPositions: filterPeripheralPositions } = await this.filterCorePositions(candidatesForCoreFilter, objectName);

    // Combine theme-protected positions with filter-peripheral positions
    const peripheralPositions = [...themeProtectedPositions, ...filterPeripheralPositions];

    // If we have peripheral positions, they should NOT be removed from their themes
    // They will remain as independent positions representing specific concerns
    if (peripheralPositions.length > 0) {
      console.log(`[PositionConsolidator] Preserving ${peripheralPositions.length} peripheral position(s) as independent:`);
      for (const p of peripheralPositions) {
        const loc = p._megaMergeLocation;
        console.log(`[PositionConsolidator]   → "${p.title?.slice(0, 50)}..." stays in theme "${loc?.themeName || 'unknown'}"`);
      }
    }

    // Only proceed with mega-merge if we have enough core positions
    if (corePositions.length < 3) {
      console.log(`[PositionConsolidator] Not enough core positions for mega-merge (${corePositions.length} < 3), keeping all separate`);
      return themes;
    }

    // =========================================================================
    // DIRECTION-FIRST PARTITION: Split core positions by _direction BEFORE any other grouping
    // This is the PRIMARY split - positions with different directions NEVER merge
    // =========================================================================
    const directionPartitions = {
      pro_change: corePositions.filter(p => p._direction === 'pro_change'),
      pro_status_quo: corePositions.filter(p => p._direction === 'pro_status_quo'),
      neutral: corePositions.filter(p => p._direction === 'neutral'),
      unknown: corePositions.filter(p => !p._direction)
    };

    const hasMultipleDirections = Object.values(directionPartitions).filter(arr => arr.length > 0).length > 1;

    if (hasMultipleDirections) {
      console.log(`[PositionConsolidator] 🎯 DIRECTION-FIRST PARTITION:`);
      console.log(`  - pro_change: ${directionPartitions.pro_change.length} positions`);
      console.log(`  - pro_status_quo: ${directionPartitions.pro_status_quo.length} positions`);
      console.log(`  - neutral: ${directionPartitions.neutral.length} positions`);
      console.log(`  - unknown: ${directionPartitions.unknown.length} positions`);

      // Process each direction partition SEPARATELY
      const megaPositionsCreated = [];
      const positionsToRemove = new Set();

      for (const [direction, positionsInPartition] of Object.entries(directionPartitions)) {
        // Filter out weak-direction positions to prevent contamination
        const weakDirectionPositions = positionsInPartition.filter(p =>
          (p._directionConfidence || 0) < 0.6 && (p._directionConfidence || 0) > 0
        );

        let partitionPositions = positionsInPartition;
        if (weakDirectionPositions.length > 0) {
          console.log(`[PositionConsolidator] ⚠️ ${weakDirectionPositions.length} positions have weak direction confidence - keeping separate to prevent contamination`);
          peripheralPositions.push(...weakDirectionPositions);
          partitionPositions = positionsInPartition.filter(p => (p._directionConfidence || 1) >= 0.6);
        }

        if (partitionPositions.length < 3) {
          // Not enough for mega-merge - keep as peripheral
          peripheralPositions.push(...partitionPositions);
          console.log(`[PositionConsolidator] Direction "${direction}": ${partitionPositions.length} position(s) → too few for mega-merge, keeping separate`);
          continue;
        }

        console.log(`[PositionConsolidator] Processing ${direction} partition with ${partitionPositions.length} positions...`);

        // Create mega-position for this direction partition
        const megaPosition = this.mergePositions(partitionPositions, this.allResponses || []);
        megaPosition._direction = direction;
        megaPosition._immutableDirection = true;
        megaPosition._isMegaPosition = true;
        megaPosition._dominantObject = objectName;
        megaPosition._mergedPositionCount = partitionPositions.length;
        megaPosition._detectedSentiment = direction;

        // Preserve original positions as pre-sub-positions hints
        // Sub-position extractor can use these instead of recreating from scratch
        megaPosition._originalPositions = partitionPositions.map(p => ({
          title: p.title,
          summary: p.summary,
          responseNumbers: p.responseNumbers,
          _directionGroup: p._directionGroup,
          _directionConfidence: p._directionConfidence
        }));
        megaPosition._hasPreSubPositions = true;

        // Generate appropriate title based on direction (with LLM content-based fallback)
        const generatedTitle = await this.generateContentBasedMegaTitle(objectName, direction, partitionPositions);

        // If title is null, direction was unknown - don't create mega-position, keep positions separate
        if (!generatedTitle) {
          console.warn(`[PositionConsolidator] ⚠️ Cannot create mega-position for unknown direction "${direction}" - keeping ${partitionPositions.length} positions separate`);
          peripheralPositions.push(...partitionPositions);
          continue;
        }

        megaPosition.title = generatedTitle;

        // Regenerate summary if position was created from multiple merges
        if (megaPosition._needsSummaryRegeneration) {
          const synthesizedSummary = await this.generateMegaPositionSummary(megaPosition);
          if (synthesizedSummary !== megaPosition.summary) {
            megaPosition.summary = synthesizedSummary;
            megaPosition._summaryRegenerated = true;
          }
        }

        console.log(`[PositionConsolidator] Created ${direction} mega-position: "${megaPosition.title}" (${megaPosition.responseNumbers?.length || 0} respondents${megaPosition._summaryRegenerated ? ', summary synthesized' : ''})`);

        // Track positions to remove
        for (const p of partitionPositions) {
          const loc = p._megaMergeLocation;
          if (loc) positionsToRemove.add(`${loc.themeIdx}-${loc.posIdx}`);
        }

        megaPositionsCreated.push({ megaPosition, direction, locations: partitionPositions.map(p => p._megaMergeLocation).filter(Boolean) });
      }

      // If we created mega-positions via direction-first partition, use them
      if (megaPositionsCreated.length > 0) {
        return this.applyDirectionBasedMegaMerge(themes, megaPositionsCreated, positionsToRemove, peripheralPositions, objectName, objectConcentration);
      }
    }

    // FALLBACK: If no direction info, use legacy title-based approach
    // TITLE-BASED PRE-SPLIT: Separate positions with conflicting titles BEFORE semantic grouping
    // The titles were generated by LLM and already contain the semantic stance.
    // This is more reliable than embeddings for stance detection.
    const titleBasedGroups = this.splitPositionsByTitle(corePositions);

    if (titleBasedGroups.hasConflict) {
      console.log(`[PositionConsolidator] ⚠️ TITLE-BASED CONFLICT: ${titleBasedGroups.support.length} support, ${titleBasedGroups.against.length} against, ${titleBasedGroups.neutral.length} neutral`);

      // Keep support positions as independent - they should NOT be merged with preservation positions
      if (titleBasedGroups.support.length > 0) {
        console.log(`[PositionConsolidator] Excluding ${titleBasedGroups.support.length} support position(s) from mega-merge:`);
        for (const p of titleBasedGroups.support) {
          console.log(`[PositionConsolidator]   → "${p.title?.slice(0, 50)}..." (title indicates support)`);
          peripheralPositions.push(p);
        }
      }

      // Continue with ONLY against positions - NEUTRAL should NOT be merged with AGAINST
      // NEUTRAL positions might be pro-project respondents that weren't clearly classified
      // Merging them with AGAINST causes stance conflicts in mega-positions
      corePositions.length = 0;
      corePositions.push(...titleBasedGroups.against);

      // Keep NEUTRAL positions separate (peripheral) to prevent stance mixing
      if (titleBasedGroups.neutral.length > 0) {
        console.log(`[PositionConsolidator] Excluding ${titleBasedGroups.neutral.length} neutral position(s) from mega-merge to prevent stance mixing`);
        peripheralPositions.push(...titleBasedGroups.neutral);
      }

      if (corePositions.length < 3) {
        console.log(`[PositionConsolidator] Not enough non-support positions for mega-merge (${corePositions.length} < 3), keeping all separate`);
        return themes;
      }
    }

    // Use embeddings for semantic grouping (NOT for stance detection - that was done above)
    // Positions with similar embeddings = same stance, dissimilar = opposing stances
    const semanticGroups = await this.groupPositionsBySemanticSimilarity(corePositions);
    
    console.log(`[PositionConsolidator] Semantic grouping: ${semanticGroups.groups.length} group(s) detected`);
    if (semanticGroups.hasOpposition) {
      console.log(`[PositionConsolidator] ⚠️ SEMANTIC OPPOSITION DETECTED - ${semanticGroups.oppositionReason}`);
    }

    // Determine which groups to create mega-positions for
    const megaPositionsToCreate = [];
    
    if (semanticGroups.hasOpposition && semanticGroups.groups.length >= 2) {
      // Semantic analysis found distinct groups - create separate mega-positions
      console.log(`[PositionConsolidator] Creating ${semanticGroups.groups.length} separate mega-positions based on semantic clustering`);
      
      for (const group of semanticGroups.groups) {
        if (group.positions.length >= 2) {
          megaPositionsToCreate.push({
            positions: group.positions,
            sentiment: group.label, // 'majority' or 'minority'
            locations: group.positions.map(p => p._megaMergeLocation).filter(Boolean)
          });
          console.log(`[PositionConsolidator] Group "${group.label}": ${group.positions.length} positions, ${group.respondentCount} respondents`);
        }
      }
      
      // If any group was too small (< 2), merge it with the largest group
      const smallGroups = semanticGroups.groups.filter(g => g.positions.length < 2);
      if (smallGroups.length > 0 && megaPositionsToCreate.length > 0) {
        const smallPositions = smallGroups.flatMap(g => g.positions);
        console.log(`[PositionConsolidator] Merging ${smallPositions.length} positions from small groups into largest group`);
        megaPositionsToCreate[0].positions.push(...smallPositions);
        megaPositionsToCreate[0].locations.push(...smallPositions.map(p => p._megaMergeLocation).filter(Boolean));
      }
    } else {
      // No semantic opposition - merge ALL core positions together
      // This is the expected case when everyone agrees
      megaPositionsToCreate.push({
        positions: corePositions,
        sentiment: 'unified',
        locations: corePositions.map(p => p._megaMergeLocation).filter(Boolean)
      });
    }

    // Create mega-positions
    const createdMegaPositions = [];
    const allPositionsToRemove = new Set();
    
    for (const group of megaPositionsToCreate) {
      // Calculate unique respondents for this group
      const groupResponseNumbers = new Set();
      for (const position of group.positions) {
        (position.responseNumbers || []).forEach(n => groupResponseNumbers.add(n));
      }

      console.log(`[PositionConsolidator] Creating ${group.sentiment} mega-position with ${group.positions.length} positions and ${groupResponseNumbers.size} respondents`);

      // Create mega-position by merging positions in this group
      const megaPosition = this.mergePositions(group.positions, this.allResponses || []);
      
      // Set metadata for mega-position
      megaPosition._isMegaPosition = true;
      megaPosition._dominantObject = objectName;
      megaPosition._mergedPositionCount = group.positions.length;
      megaPosition._objectConcentration = objectConcentration.concentration;
      megaPosition._detectedSentiment = group.sentiment;
      
      // Collect all original titles for sub-position extraction
      megaPosition._originalTitles = group.positions.map(p => p.title);
      megaPosition._mergedFrom = [
        ...(megaPosition._mergedFrom || []),
        ...group.positions.flatMap(p => p._mergedFrom || [p.title])
      ];
      
      // Generate intelligent title based on sentiment and content
      megaPosition.title = this.generateHoldningsTitel(objectName, { dominantSentiment: group.sentiment }, group.positions);
      console.log(`[PositionConsolidator] Generated title: "${megaPosition.title}"`);
      
      // Track positions to remove
      for (const loc of group.locations) {
        allPositionsToRemove.add(`${loc.themeIdx}-${loc.posIdx}`);
      }
      
      // Determine best theme for this mega-position
      const themePositionCounts = new Map();
      for (const loc of group.locations) {
        themePositionCounts.set(loc.themeName, (themePositionCounts.get(loc.themeName) || 0) + 1);
      }
      
      // IMPROVED: Prioritize specific themes over "Andre emner" (the catch-all)
      // Also prioritize regulation-specific themes (§-themes) for better categorization
      let bestTheme = group.locations[0]?.themeName || 'Andre emner';
      let maxCount = 0;
      let bestThemeIsSpecific = false;
      
      for (const [themeName, count] of themePositionCounts) {
        const isSpecificTheme = themeName !== 'Andre emner' && themeName !== 'Formål';
        const isRegulationTheme = themeName.startsWith('§') || themeName.includes('Bebyggelsens');
        
        // Prefer specific themes, especially regulation themes
        if (count > maxCount) {
          maxCount = count;
          bestTheme = themeName;
          bestThemeIsSpecific = isSpecificTheme;
        } else if (count === maxCount) {
          // If counts are equal, prefer specific themes over catch-all
          if (isSpecificTheme && !bestThemeIsSpecific) {
            bestTheme = themeName;
            bestThemeIsSpecific = true;
          } else if (isRegulationTheme) {
            bestTheme = themeName;
          }
        }
      }
      
      createdMegaPositions.push({ megaPosition, bestTheme });
    }

    // Build new themes, removing merged positions and adding mega-positions
    // Use unique ID (index + sentiment) to avoid collision when titles are same
    const megaPositionsAdded = new Set();
    
    const newThemes = themes.map((theme, themeIdx) => {
      const newPositions = [];
      
      (theme.positions || []).forEach((position, posIdx) => {
        const key = `${themeIdx}-${posIdx}`;
        
        if (allPositionsToRemove.has(key)) {
          // Skip - this position was merged into a mega-position
          return;
        }
        
        newPositions.push(position);
      });
      
      // Add mega-positions to their best themes
      for (let i = 0; i < createdMegaPositions.length; i++) {
        const { megaPosition, bestTheme } = createdMegaPositions[i];
        const uniqueId = `mega_${i}_${megaPosition._detectedSentiment || 'unknown'}`;
        
        if (theme.name === bestTheme && !megaPositionsAdded.has(uniqueId)) {
          newPositions.unshift(megaPosition); // Add at beginning for visibility
          megaPositionsAdded.add(uniqueId);
        }
      }
      
      return {
        ...theme,
        positions: newPositions,
        _megaMergeApplied: allPositionsToRemove.size > 0
      };
    });

    const totalBefore = themes.reduce((sum, t) => sum + (t.positions?.length || 0), 0);
    const totalAfter = newThemes.reduce((sum, t) => sum + (t.positions?.length || 0), 0);
    
    console.log(`[PositionConsolidator] Same-object mega-merge complete: ${totalBefore} → ${totalAfter} positions (${createdMegaPositions.length} mega-position(s) created)`);

    // ENRICHMENT: Find respondents in small positions that semantically belong in mega-position
    if (createdMegaPositions.length > 0 && objectName) {
      const enrichedThemes = await this.enrichMegaPositions(newThemes, createdMegaPositions, objectName, microSummaries);
      // FINAL PASS: Absorb tiny preservation-duplicate positions into the mega-position(s)
      // This catches cases where a small preservation position doesn't explicitly mention the object
      // in its title/summary (but respondents clearly discuss it), and would otherwise remain as a
      // top-level "duplicate" next to the mega-position.
      const absorbedThemes = this.absorbSmallPreservationDuplicatesIntoMega(
        enrichedThemes,
        createdMegaPositions,
        objectName,
        microSummaries
      );

      // NEW: LLM-validated merge of LARGE positions (>25 respondents)
      // that share the same grundholdning as the mega-position
      const finalThemes = await this.llmValidatedLargeMerge(
        absorbedThemes,
        createdMegaPositions,
        objectName
      );

      return finalThemes;
    }

    return newThemes;
  }

  /**
   * Consolidate small (1-3 respondent) positions WITHIN each theme
   * This helps reduce fragmentation where multiple "one citizen" positions
   * are about essentially the same topic (e.g., 4 separate tree positions)
   *
   * @param {Array} themes - Array of theme objects with positions
   * @param {Array} microSummaries - Array of micro-summaries for substance-anchored merging
   * @returns {Array} Themes with small positions consolidated
   */
  async consolidateSmallPositionsWithinThemes(themes, microSummaries = []) {
    const SMALL_POSITION_THRESHOLD = 3; // Positions with <= 3 respondents
    // QUALITY FIX: Lowered from 0.80 to 0.75 to reduce (1)-position fragmentation
    // Many single-respondent positions are about the same topic but phrased differently
    const SMALL_MERGE_SIMILARITY_THRESHOLD = 0.75;
    let totalMerged = 0;

    console.log('[PositionConsolidator] Starting small position consolidation within themes...');

    for (const theme of themes) {
      if (!theme.positions || theme.positions.length < 2) continue;

      // Find small positions that can potentially be merged
      const smallPositions = theme.positions.filter(p =>
        (p.responseNumbers?.length || 0) <= SMALL_POSITION_THRESHOLD &&
        !p._isMegaPosition &&
        !p._protectedFromMegaMerge // Protected positions can still be grouped with other protected positions
      );

      if (smallPositions.length < 2) continue;

      // CRITICAL: Check if all small positions are from THE SAME SINGLE RESPONDENT
      // If so, DO NOT merge - their distinct concerns should stay separate
      // so other respondents can join each specific position later
      const allSmallRespondents = new Set();
      for (const pos of smallPositions) {
        for (const respNum of (pos.responseNumbers || [])) {
          allSmallRespondents.add(respNum);
        }
      }

      if (allSmallRespondents.size === 1) {
        const singleResp = [...allSmallRespondents][0];
        console.log(`[PositionConsolidator] Theme "${theme.name}": Skipping small consolidation - all ${smallPositions.length} positions from SAME respondent (${singleResp})`);
        continue;
      }

      console.log(`[PositionConsolidator] Theme "${theme.name}": ${smallPositions.length} small positions to check`);

      // Embed small positions for similarity comparison
      const positionTexts = smallPositions.map(p => {
        return [p.title, p.summary?.slice(0, 300)].filter(Boolean).join(' - ');
      });

      let embeddings;
      try {
        embeddings = await this.embedder.embedBatch(positionTexts);
      } catch (error) {
        console.warn(`[PositionConsolidator] Failed to embed small positions in "${theme.name}": ${error.message}`);
        continue;
      }

      if (!embeddings || embeddings.length !== smallPositions.length) continue;

      // Find merge groups using greedy clustering
      const { groups: mergeGroups, samePrefixCandidates, merged: alreadyMergedIndices } = this.findSmallPositionMergeGroups(
        smallPositions,
        embeddings,
        SMALL_MERGE_SIMILARITY_THRESHOLD
      );

      // LLM validate same-direction candidates (positions with same stance direction but lower embedding similarity)
      if (samePrefixCandidates.length > 0 && this.client) {
        console.log(`[PositionConsolidator]   🤖 LLM validating ${samePrefixCandidates.length} same-direction candidates in "${theme.name}"...`);

        for (const candidate of samePrefixCandidates) {
          // Skip if either position was already merged
          if (alreadyMergedIndices.has(candidate.i) || alreadyMergedIndices.has(candidate.j)) {
            continue;
          }

          try {
            const shouldMerge = await this.llmValidateMerge(candidate.pos1, candidate.pos2, theme.name);
            if (shouldMerge) {
              console.log(`[PositionConsolidator]   ✅ LLM approved same-direction merge [${candidate.direction}] (sim=${candidate.similarity.toFixed(3)}): "${candidate.pos1.title?.slice(0, 40)}..." + "${candidate.pos2.title?.slice(0, 40)}..."`);
              // Add as a new merge group
              mergeGroups.push([candidate.pos1, candidate.pos2]);
              alreadyMergedIndices.add(candidate.i);
              alreadyMergedIndices.add(candidate.j);
            } else {
              console.log(`[PositionConsolidator]   ❌ LLM rejected same-direction merge [${candidate.direction}] (sim=${candidate.similarity.toFixed(3)}): "${candidate.pos1.title?.slice(0, 40)}..." + "${candidate.pos2.title?.slice(0, 40)}..."`);
            }
          } catch (error) {
            console.warn(`[PositionConsolidator]   ⚠️ LLM validation failed: ${error.message}`);
          }
        }
      }

      // SUBSTANCE-ANCHORED MERGING: Find positions that share substanceRefs
      // This catches cases where different phrasings (e.g., "vindforhold" vs "bygningshøjde")
      // respond to the same underlying regulation
      if (microSummaries.length > 0 && this.client) {
        const sameSubstanceCandidates = this.findSameSubstanceCandidates(
          smallPositions,
          microSummaries,
          embeddings,
          0.50 // Minimum similarity to avoid completely unrelated merges
        );

        if (sameSubstanceCandidates.length > 0) {
          console.log(`[PositionConsolidator]   🔗 Found ${sameSubstanceCandidates.length} same-substance candidates in "${theme.name}"`);

          for (const candidate of sameSubstanceCandidates) {
            // Skip if either position was already merged
            if (alreadyMergedIndices.has(candidate.i) || alreadyMergedIndices.has(candidate.j)) {
              continue;
            }

            try {
              const shouldMerge = await this.llmValidateMerge(candidate.pos1, candidate.pos2, theme.name);
              if (shouldMerge) {
                console.log(`[PositionConsolidator]   ✅ LLM approved same-substance merge [${candidate.sharedRefs.join(',')}] (sim=${candidate.similarity.toFixed(3)}): "${candidate.pos1.title?.slice(0, 40)}..." + "${candidate.pos2.title?.slice(0, 40)}..."`);
                mergeGroups.push([candidate.pos1, candidate.pos2]);
                alreadyMergedIndices.add(candidate.i);
                alreadyMergedIndices.add(candidate.j);
              } else {
                console.log(`[PositionConsolidator]   ❌ LLM rejected same-substance merge [${candidate.sharedRefs.join(',')}] (sim=${candidate.similarity.toFixed(3)}): "${candidate.pos1.title?.slice(0, 40)}..." + "${candidate.pos2.title?.slice(0, 40)}..."`);
              }
            } catch (error) {
              console.warn(`[PositionConsolidator]   ⚠️ Same-substance LLM validation failed: ${error.message}`);
            }
          }
        }
      }

      // Execute merges
      for (const group of mergeGroups) {
        if (group.length < 2) continue;

        // Generate a combined title that captures the theme
        const groupTitles = group.map(p => p.title).filter(Boolean);
        const newTitle = groupTitles.length > 0 ? await this.generateGroupedTitle(groupTitles) : null;

        // CRITICAL: If no clear stance can be determined, skip this merge
        // Merging positions without a coherent stance creates vague "Holdninger til X" titles
        if (!newTitle) {
          console.log(`[PositionConsolidator]   ⚠️ Skipping merge of ${group.length} positions - no clear stance determinable`);
          continue;
        }

        const merged = this.mergePositions(group, this.allResponses || []);
        merged._mergedSmallPositions = true;
        merged._smallMergeCount = group.length;
        merged.title = newTitle;

        // Remove individual positions and add merged one
        theme.positions = theme.positions.filter(p => !group.includes(p));
        theme.positions.push(merged);

        const respCount = merged.responseNumbers?.length || 0;
        console.log(`[PositionConsolidator]   ✓ Merged ${group.length} small positions → "${merged.title?.slice(0, 50)}..." (${respCount} resp)`);
        totalMerged += group.length - 1;
      }
    }

    if (totalMerged > 0) {
      console.log(`[PositionConsolidator] Small position consolidation complete: ${totalMerged} positions merged`);
    } else {
      console.log('[PositionConsolidator] No small positions merged (none similar enough)');
    }

    // POST-PROCESS: Clean colons from ALL position titles
    // This catches positions that weren't merged but still have colon patterns
    for (const theme of themes) {
      for (const position of (theme.positions || [])) {
        if (position.title && position.title.includes(':')) {
          position.title = await this.cleanColonFromTitle(position.title);
        }
      }
    }

    return themes;
  }

  /**
   * Find groups of small positions that should be merged based on embedding similarity
   * Uses greedy clustering: positions are grouped if they have high pairwise similarity
   *
   * @param {Array} positions - Small positions to cluster
   * @param {Array} embeddings - Corresponding embeddings
   * @param {number} threshold - Similarity threshold for merging
   * @returns {Array<Array>} Groups of positions to merge
   */
  findSmallPositionMergeGroups(positions, embeddings, threshold) {
    const n = positions.length;
    const merged = new Set(); // Track which positions have been merged
    const groups = [];
    const samePrefixCandidates = []; // Candidates for LLM validation

    // STANCE PREFIX RULE: Positions with same stance prefix should be merged
    // Examples: "Støtte til projektet: X" and "Støtte til projektet: Y"
    //           "Modstand mod X" and "Modstand mod Y" (same first 2-3 words)
    const stancePrefixGroups = this.groupByStancePrefix(positions);
    for (const [prefix, prefixPositions] of Object.entries(stancePrefixGroups)) {
      if (prefixPositions.length >= 2) {
        console.log(`[PositionConsolidator]   📌 Stance prefix group "${prefix}": ${prefixPositions.length} positions`);
        const indices = prefixPositions.map(p => positions.indexOf(p));
        indices.forEach(idx => merged.add(idx));
        groups.push(prefixPositions);
      }
    }

    // Calculate pairwise similarities for remaining positions
    const similarities = [];
    const SAME_PREFIX_LOWER_THRESHOLD = 0.60; // Lower threshold for same-prefix positions

    for (let i = 0; i < n; i++) {
      if (merged.has(i)) continue;
      for (let j = i + 1; j < n; j++) {
        if (merged.has(j)) continue;
        const sim = this.cosineSimilarity(embeddings[i], embeddings[j]);

        // Check for same stance direction (e.g., AGAINST: "Modstand mod" + "Bekymring for")
        const direction1 = this.extractStanceDirection(positions[i].title);
        const direction2 = this.extractStanceDirection(positions[j].title);
        const hasSameDirection = direction1 && direction2 && direction1 === direction2;

        if (sim >= threshold) {
          similarities.push({ i, j, similarity: sim });
        } else if (hasSameDirection && sim >= SAME_PREFIX_LOWER_THRESHOLD) {
          // Same stance direction but below normal threshold - candidate for LLM validation
          samePrefixCandidates.push({
            i, j, similarity: sim, direction: direction1,
            pos1: positions[i], pos2: positions[j]
          });
        }
      }
    }

    // Sort by similarity (highest first)
    similarities.sort((a, b) => b.similarity - a.similarity);

    // Greedy grouping: start with highest similarity pairs
    for (const { i, j, similarity } of similarities) {
      if (merged.has(i) || merged.has(j)) continue;

      // Start a new group with this pair
      const group = [positions[i], positions[j]];
      merged.add(i);
      merged.add(j);

      // Try to add more positions to this group
      for (let k = 0; k < n; k++) {
        if (merged.has(k)) continue;

        // Check if position k is similar to ALL positions in the group
        let similarToAll = true;
        for (const existing of group) {
          const existingIdx = positions.indexOf(existing);
          const sim = this.cosineSimilarity(embeddings[k], embeddings[existingIdx]);
          if (sim < threshold) {
            similarToAll = false;
            break;
          }
        }

        if (similarToAll) {
          group.push(positions[k]);
          merged.add(k);
        }
      }

      groups.push(group);
    }

    // Log same-direction candidates for LLM validation
    if (samePrefixCandidates.length > 0) {
      console.log(`[PositionConsolidator]   🔍 Found ${samePrefixCandidates.length} same-direction candidates for LLM validation`);
    }

    return { groups, samePrefixCandidates, merged };
  }

  /**
   * Group positions by their stance prefix.
   * Positions with the same stance prefix should be merged regardless of embedding similarity.
   *
   * Detects patterns like:
   * - "Støtte til projektet: X" → prefix "Støtte til projektet"
   * - "Modstand mod X" and "Modstand mod Y" → prefix "Modstand mod"
   * - "Bekymring for X" and "Bekymring for Y" → prefix "Bekymring for"
   *
   * @param {Array} positions - Positions to group
   * @returns {Object} Map of prefix → positions array
   */
  groupByStancePrefix(positions) {
    const prefixGroups = {};

    for (const position of positions) {
      const title = position.title || '';

      // Rule 1: Colon pattern - everything before ":" is the stance prefix
      if (title.includes(':')) {
        const prefix = title.split(':')[0].trim();
        if (prefix.length >= 5) { // Minimum length to avoid false matches
          if (!prefixGroups[prefix]) prefixGroups[prefix] = [];
          prefixGroups[prefix].push(position);
          continue;
        }
      }

      // Rule 2: Dynamic stance prefix detection (no hardcoded case-specific terms)
      // Extract first 2-3 words as potential prefix if they indicate stance
      const stanceIndicators = /^(støtte|modstand|bekymring|ønske|krav|protest|opbakning|kritik|ros|forslag)/i;
      const words = title.split(/\s+/);

      // Try 3-word, then 2-word prefix
      for (const wordCount of [3, 2]) {
        if (words.length >= wordCount) {
          const prefix = words.slice(0, wordCount).join(' ');
          // Only group if the prefix starts with a stance indicator word
          if (stanceIndicators.test(prefix)) {
            if (!prefixGroups[prefix]) prefixGroups[prefix] = [];
            prefixGroups[prefix].push(position);
            break;
          }
        }
      }
    }

    return prefixGroups;
  }

  /**
   * Stance direction groups - indicators that express the same underlying stance direction.
   * Used to identify positions that should be merged even with different wording.
   */
  static STANCE_DIRECTION_GROUPS = {
    AGAINST: ['modstand', 'bekymring', 'kritik', 'protest', 'indsigelse'],
    FOR: ['støtte', 'opbakning', 'ros', 'tilslutning'],
    WANT: ['ønske', 'krav', 'forslag', 'opfordring']
  };

  /**
   * Extract stance direction from a position title.
   * Used for identifying positions with same stance direction that may have different wording.
   *
   * Examples:
   * - "Modstand mod bygningshøjde" → AGAINST
   * - "Bekymring for højere bygninger" → AGAINST
   * - "Støtte til projektet" → FOR
   * - "Ønske om bevarelse" → WANT
   *
   * @param {string} title - Position title
   * @returns {string|null} Direction (AGAINST, FOR, WANT) or null if no stance indicator found
   */
  extractStanceDirection(title) {
    if (!title) return null;
    const firstWord = title.split(/\s+/)[0]?.toLowerCase();
    if (!firstWord) return null;

    for (const [direction, indicators] of Object.entries(PositionConsolidator.STANCE_DIRECTION_GROUPS)) {
      if (indicators.includes(firstWord)) {
        return direction;
      }
    }
    return null;
  }

  /**
   * Generate a title for a group of merged small positions
   * Uses the most representative existing title to avoid generating nonsense
   *
   * @param {Array<string>} titles - Original titles of merged positions
   * @returns {Promise<string>} Combined title
   */
  async generateGroupedTitle(titles) {
    if (titles.length === 0) return 'Grupperet holdning';
    if (titles.length === 1) {
      // Clean colon pattern from single title too
      return await this.cleanColonFromTitle(titles[0]);
    }

    // IMPROVED: Instead of constructing a new title from word fragments,
    // pick the most representative existing title (one that contains common patterns)

    // Extract the dominant action pattern from titles
    const actionPatterns = {
      bevaring: /bevar|bevaring|bevarelse/i,
      modstand: /modstand|protest|afvis/i,
      bekymring: /bekymring|bekymret/i,
      støtte: /støtte|opbakning|støtter/i,
      ønske: /ønske|ønsker|anmod/i,
      krav: /krav|kræver|forlang/i
    };

    // Find the dominant action
    const actionCounts = {};
    for (const [action, pattern] of Object.entries(actionPatterns)) {
      actionCounts[action] = titles.filter(t => pattern.test(t)).length;
    }
    const dominantAction = Object.entries(actionCounts)
      .sort((a, b) => b[1] - a[1])
      .filter(([_, count]) => count > 0)[0]?.[0];

    // Find a representative title that has the dominant action
    if (dominantAction) {
      const representativeTitle = titles.find(t =>
        actionPatterns[dominantAction].test(t)
      );
      if (representativeTitle) {
        return await this.cleanColonFromTitle(representativeTitle);
      }
    }

    // Fallback: return the shortest title (often the most generic/representative)
    const sortedByLength = [...titles].sort((a, b) => a.length - b.length);
    return await this.cleanColonFromTitle(sortedByLength[0]);
  }

  /**
   * Clean colon pattern from title when the part before colon is a redundant stance prefix.
   * Also normalizes grammar (e.g., "flyt X" → "flytning af X") when adding prefixes.
   *
   * Rules:
   * 1. "Støtte: Ønske om bevarelse..." → "Ønske om bevarelse..." (content has its own stance)
   * 2. "Støtte: flyt boldbanen..." → "Støtte til flytning af boldbanen..." (normalize + add stance)
   * 3. "Støtte" alone → keep as-is (no content to extract)
   *
   * @param {string} title - Title to clean
   * @returns {Promise<string>} Cleaned title
   */
  async cleanColonFromTitle(title) {
    if (!title || !title.includes(':')) return title;

    const colonIndex = title.indexOf(':');
    const beforeColon = title.slice(0, colonIndex).trim();
    const afterColon = title.slice(colonIndex + 1).trim();

    // Stance indicators that can appear before OR after colon
    const stancePatterns = /^(støtte|modstand|bekymring|ønske|krav|protest|opbakning|kritik|ros|forslag)\b/i;

    // Check if content after colon already has a stance indicator
    const contentHasStance = stancePatterns.test(afterColon);

    if (beforeColon.length >= 5 && stancePatterns.test(beforeColon)) {
      // The part before colon is a stance prefix
      if (afterColon.length < 5) {
        // No meaningful content after colon - keep original
        console.log(`[PositionConsolidator] ⚠️ Stance title has no descriptive content: "${title}" - keeping as-is`);
        return title;
      }

      if (contentHasStance) {
        // Content already has its own stance indicator - use it directly
        // "Støtte: Ønske om bevarelse..." → "Ønske om bevarelse..."
        console.log(`[PositionConsolidator] 🧹 Content has stance, dropping prefix: "${title}" → "${afterColon}"`);
        return afterColon;
      }

      // Content has no stance - transform the title to proper format
      // First normalize the grammar using LLM
      const stanceWord = beforeColon.toLowerCase();
      let prefix;
      let newTitle;

      if (stanceWord.includes('støtte') || stanceWord.includes('opbakning') || stanceWord.includes('ros')) {
        prefix = 'Støtte til';
        const normalized = await this.normalizeForTitlePrefix(afterColon, prefix);
        newTitle = `${prefix} ${normalized.charAt(0).toLowerCase()}${normalized.slice(1)}`;
      } else if (stanceWord.includes('modstand') || stanceWord.includes('protest') || stanceWord.includes('kritik')) {
        prefix = 'Modstand mod';
        const normalized = await this.normalizeForTitlePrefix(afterColon, prefix);
        newTitle = `${prefix} ${normalized.charAt(0).toLowerCase()}${normalized.slice(1)}`;
      } else if (stanceWord.includes('bekymring')) {
        prefix = 'Bekymring for';
        const normalized = await this.normalizeForTitlePrefix(afterColon, prefix);
        newTitle = `${prefix} ${normalized.charAt(0).toLowerCase()}${normalized.slice(1)}`;
      } else if (stanceWord.includes('ønske')) {
        prefix = 'Ønske om';
        const normalized = await this.normalizeForTitlePrefix(afterColon, prefix);
        newTitle = `${prefix} ${normalized.charAt(0).toLowerCase()}${normalized.slice(1)}`;
      } else if (stanceWord.includes('krav') || stanceWord.includes('forslag')) {
        // Keep krav/forslag as prefix
        prefix = `${beforeColon.charAt(0).toUpperCase()}${beforeColon.slice(1)} om`;
        const normalized = await this.normalizeForTitlePrefix(afterColon, prefix);
        newTitle = `${prefix} ${normalized.charAt(0).toLowerCase()}${normalized.slice(1)}`;
      } else {
        // Unknown stance - keep original
        return title;
      }

      console.log(`[PositionConsolidator] 🧹 Transformed stance title: "${title}" → "${newTitle}"`);
      return newTitle;
    }

    // Keep the whole title for cases like "§ 6: Bebyggelsens omfang"
    return title;
  }

  /**
   * Cross-theme stance merging: Find and merge positions across different themes
   * that express the SAME fundamental stance.
   *
   * Uses embedding-based candidate detection (on argument content, not titles) with
   * LLM validation via the sophisticated desired-outcome prompt (llmValidateMerge).
   *
   * Example: "Bevar Palads" appearing as separate positions in 5 themes gets merged
   * into one position placed in the theme with most respondents.
   *
   * @param {Array} themes - Consolidated themes with positions
   * @returns {Promise<Array>} Themes with cross-theme stances merged
   */
  async mergeCrossThemeStances(themes) {
    // Collect all positions with theme metadata
    const allPositions = [];
    const positionToThemeMap = new Map();

    for (let ti = 0; ti < themes.length; ti++) {
      const theme = themes[ti];
      for (const position of (theme.positions || [])) {
        const posIndex = allPositions.length;
        // Tag each position with its source theme for later placement
        if (!position._originalTheme && theme.name !== 'Andre emner') {
          position._originalTheme = theme.name;
        }
        position._crossThemeSourceTheme = theme.name;
        allPositions.push(position);
        positionToThemeMap.set(posIndex, theme.name);
      }
    }

    if (allPositions.length < 2) {
      console.log('[PositionConsolidator] Less than 2 positions, skipping cross-theme stance merging');
      return themes;
    }

    console.log(`[PositionConsolidator] Cross-theme stance merging: ${allPositions.length} positions across ${themes.length} themes`);

    // Stage 1: Generate embeddings for all positions (argument-based, not title-based)
    const embeddingTexts = allPositions.map((pos) => {
      const args = (pos.sourceArgumentRefs || pos.args || []);
      const argsText = args.slice(0, 5)
        .map(a => a.consequence || a.what || '')
        .filter(Boolean)
        .join('. ');
      const summaryPreview = (pos.summary || '').slice(0, 600);
      return `${argsText}\n\n${summaryPreview}`;
    });

    let embeddings;
    try {
      console.log(`[PositionConsolidator] Generating embeddings for ${allPositions.length} positions (cross-theme stance detection)`);
      embeddings = await this.embedder.embedBatch(embeddingTexts);
    } catch (error) {
      console.error('[PositionConsolidator] Failed to generate embeddings for cross-theme stance detection:', error.message);
      return themes;
    }

    // Stage 2: Find cross-theme candidates via pairwise embedding similarity
    // Use threshold 0.72 (lower than within-theme 0.78 because cross-theme positions
    // frame arguments differently across theme contexts, but represent the same stance)
    const crossThemeStanceThreshold = 0.72;
    const candidates = [];

    for (let i = 0; i < allPositions.length; i++) {
      for (let j = i + 1; j < allPositions.length; j++) {
        // ONLY positions from DIFFERENT themes
        const theme1 = positionToThemeMap.get(i);
        const theme2 = positionToThemeMap.get(j);
        if (theme1 === theme2) continue;

        if (!embeddings[i] || !embeddings[j]) continue;

        const similarity = this.cosineSimilarity(embeddings[i], embeddings[j]);
        if (similarity < crossThemeStanceThreshold) continue;

        // Direction check: block opposite stances
        const directionCheck = this.canMergeByDirection(allPositions[i], allPositions[j]);
        if (!directionCheck.allowed) continue;

        // Pre-compute object overlap for LLM context
        const objects1 = this.extractKeyObjects(allPositions[i].title, allPositions[i].summary || '');
        const objects2 = this.extractKeyObjects(allPositions[j].title, allPositions[j].summary || '');
        const objectOverlap = this.calculateObjectOverlap(objects1, objects2);

        candidates.push({
          idx1: i,
          idx2: j,
          position1: allPositions[i],
          position2: allPositions[j],
          similarity,
          objectOverlap,
          theme1,
          theme2
        });
      }
    }

    // Sort by similarity (highest first) for prioritized validation
    candidates.sort((a, b) => b.similarity - a.similarity);

    console.log(`[PositionConsolidator] Found ${candidates.length} cross-theme stance candidates (similarity >= ${crossThemeStanceThreshold})`);

    if (candidates.length === 0) {
      console.log('[PositionConsolidator] No cross-theme stance candidates found');
      return themes;
    }

    // Stage 3: LLM validation using the sophisticated desired-outcome prompt
    // Cap at maxLLMValidations to control cost
    const validationLimit = Math.min(candidates.length, this.maxLLMValidations);
    const llmConcurrency = allPositions.length < 100 ? 20 : 10;

    console.log(`[PositionConsolidator] Validating ${validationLimit} cross-theme stance candidates with LLM (concurrency=${llmConcurrency})`);

    const validationTasks = candidates.slice(0, validationLimit).map((candidate) => async () => {
      try {
        const shouldMerge = await this.llmValidateMerge(
          candidate.position1,
          candidate.position2,
          `CROSS-THEME (${candidate.theme1} ↔ ${candidate.theme2})`
        );

        if (shouldMerge) {
          console.log(`[PositionConsolidator] ✅ Cross-theme stance merge approved (sim=${candidate.similarity.toFixed(3)}): "${candidate.position1.title?.slice(0, 45)}" (${candidate.theme1}) ↔ "${candidate.position2.title?.slice(0, 45)}" (${candidate.theme2})`);
          return candidate;
        } else {
          console.log(`[PositionConsolidator] ❌ Cross-theme stance merge rejected (sim=${candidate.similarity.toFixed(3)}): "${candidate.position1.title?.slice(0, 40)}" ↔ "${candidate.position2.title?.slice(0, 40)}"`);
          return null;
        }
      } catch (error) {
        console.warn(`[PositionConsolidator] Cross-theme LLM validation failed:`, error.message);
        return null;
      }
    });

    const results = await limitConcurrency(validationTasks, llmConcurrency);
    const validatedMerges = results.filter(r => r !== null);

    console.log(`[PositionConsolidator] Validated ${validatedMerges.length}/${validationLimit} cross-theme stance merges via LLM`);

    if (validatedMerges.length === 0) {
      console.log('[PositionConsolidator] No cross-theme stance merges validated');
      return themes;
    }

    // Stage 4: Execute merges using union-find (transitive: A+B and B+C → A+B+C)
    const mergedPositions = this.executeMerges(allPositions, validatedMerges);
    const mergeCount = allPositions.length - mergedPositions.length;

    console.log(`[PositionConsolidator] Cross-theme stance merging: ${allPositions.length} → ${mergedPositions.length} positions (${mergeCount} merged)`);

    // Tag merged positions with cross-theme source metadata
    // and fix _originalTheme to point to theme with most respondents
    for (const pos of mergedPositions) {
      if (pos._mergedFrom && pos._mergedFrom.length > 1) {
        // Build cross-theme sources from the original positions
        const sources = [];
        for (const origTitle of pos._mergedFrom) {
          // Find original position data to get theme info
          const origPos = allPositions.find(p => p.title === origTitle);
          if (origPos) {
            sources.push({
              theme: origPos._crossThemeSourceTheme || origPos._originalTheme || 'Ukendt',
              title: origTitle,
              responseCount: origPos.responseNumbers?.length || 0
            });
          }
        }
        if (sources.length > 0) {
          pos._crossThemeSources = sources;
          // Override _originalTheme to the theme with most respondents
          // (mergePositions spreads ...bestPosition which may have wrong theme)
          const bestSource = sources.reduce((best, s) => s.responseCount > best.responseCount ? s : best);
          if (bestSource.theme !== 'Andre emner') {
            pos._originalTheme = bestSource.theme;
          } else {
            // If largest is "Andre emner", pick the largest specific theme
            const specificSources = sources.filter(s => s.theme !== 'Andre emner');
            if (specificSources.length > 0) {
              pos._originalTheme = specificSources.reduce((best, s) => s.responseCount > best.responseCount ? s : best).theme;
            }
          }
        }
      }
    }

    // Stage 5: Rebuild theme structure - place each position in best theme
    const originalPositionCounts = new Map();
    for (const theme of themes) {
      originalPositionCounts.set(theme.name, theme.positions?.length || 0);
    }

    const themeMap = new Map();
    for (const theme of themes) {
      themeMap.set(theme.name, []);
    }

    for (const position of mergedPositions) {
      const bestTheme = this.chooseBestThemeForPosition(position, themes, positionToThemeMap, originalPositionCounts);

      if (themeMap.has(bestTheme)) {
        themeMap.get(bestTheme).push(position);
      } else {
        // Fallback to "Andre emner"
        const fallback = 'Andre emner';
        if (!themeMap.has(fallback)) {
          themeMap.set(fallback, []);
        }
        themeMap.get(fallback).push(position);
      }
    }

    // Build final theme structure
    const consolidatedThemes = [];
    for (const theme of themes) {
      const positions = themeMap.get(theme.name) || [];
      consolidatedThemes.push({
        ...theme,
        positions,
        _consolidationMeta: {
          ...(theme._consolidationMeta || {}),
          crossThemeStanceMerge: true,
          originalCount: originalPositionCounts.get(theme.name) || 0,
          afterCrossThemeCount: positions.length
        }
      });
    }

    // Remove empty themes
    const nonEmptyThemes = consolidatedThemes.filter(t => (t.positions || []).length > 0);
    const removedCount = consolidatedThemes.length - nonEmptyThemes.length;
    if (removedCount > 0) {
      console.log(`[PositionConsolidator] Removed ${removedCount} empty theme(s) after cross-theme stance merge`);
    }

    return nonEmptyThemes;
  }

  /**
   * INDEPENDENT CONCERN KEYWORDS
   *
   * These keywords signal that a position is about an INDEPENDENT concern (TYPE B),
   * not a justification for the mega-position (TYPE A).
   *
   * TYPE B positions should NOT be absorbed into the mega-position because they:
   * 1. Concern a DIFFERENT object (trees, new construction, road, etc.)
   * 2. Express concerns about EFFECTS of new development (shadow, noise, traffic)
   * 3. Oppose something OTHER than lack of preservation (hotel, commercial use)
   */
  static INDEPENDENT_CONCERN_KEYWORDS = {
    // Physical effects of new construction
    physicalEffects: [
      'skygge', 'skyggegener', 'skygger', 'skyggelægning', 'lysforhold',
      'indblik', 'indbliksgener', 'udsigt', 'udsyn',
      'støj', 'støjgener', 'trafikstøj', 'byggeri-støj',
      'trafik', 'trafikgener', 'trafikbelastning', 'parkering',
      'vindforhold', 'vindturbulens'
    ],
    // Independent objects (not the mega-position's object)
    independentObjects: [
      'træ', 'træer', 'træerne', 'beplantning', 'grønne områder',
      'børneinstitution', 'institution', 'daginstitution', 'vuggestue', 'børnehave',
      'legeplads', 'skolegård',
      'cykelsti', 'gangsti', 'fortov',
      'axel torv', 'torvet'
    ],
    // New construction concerns (opposition to what's being BUILT, not what's being LOST)
    newConstructionConcerns: [
      'nybyggeri', 'nybygning', 'nybyggeriet',
      'hotel', 'hotelbyggeri', 'hoteldrift',
      'højhus', 'højhusbyggeri', 'etagehøjde', 'byggehøjde',
      'kommerciel', 'kommercielt', 'kommercialisering',
      'turisme', 'masseturisme', 'turister',
      'transformation', 'transformations'
    ],
    // Procedural/process concerns (independent of preservation)
    proceduralConcerns: [
      'borgerinddragelse', 'høring', 'høringsproces', 'demokrati',
      'lokalplan', 'lokalplanforslag', 'dispensation',
      'transparens', 'offentlighed'
    ]
  };

  /**
   * PRESERVATION JUSTIFICATION KEYWORDS
   *
   * These keywords signal that a position is a JUSTIFICATION for preservation (TYPE A).
   * TYPE A positions SHOULD be absorbed as sub-positions in the mega-position.
   */
  static PRESERVATION_JUSTIFICATION_KEYWORDS = {
    // Cultural heritage reasons
    kulturarv: ['kulturarv', 'kulturhistorisk', 'kulturhistorie', 'kulturværdi'],
    // Climate/sustainability reasons
    klima: ['klima', 'klimahensyn', 'co2', 'bæredygtighed', 'bæredygtig', 'genbrug', 'cirkulær'],
    // Aesthetic reasons
    æstetik: ['æstetik', 'æstetisk', 'arkitektur', 'arkitektonisk', 'smuk', 'visuel'],
    // Identity reasons
    identitet: ['identitet', 'vartegn', 'ikonisk', 'symbol', 'byens sjæl'],
    // Artistic reasons
    kunst: ['gernes', 'kunstner', 'kunstværk', 'udsmykning']
  };

  /**
   * Determine if a position represents an INDEPENDENT concern (TYPE B)
   * rather than a justification for the mega-position (TYPE A).
   *
   * TYPE A (Sub-position): "Bevar Palads pga. klimahensyn" → should be absorbed
   * TYPE B (Independent): "Bekymring for skygge fra nybyggeri" → should NOT be absorbed
   *
   * @param {Object} position - The position to evaluate
   * @param {Object} megaPosition - The mega-position (for context)
   * @param {string} objectName - The mega-position's object (e.g., "palads")
   * @param {Map} microIndex - Map of responseNumber → microSummary
   * @returns {Object} { isIndependent: boolean, reason: string, confidence: number }
   */
  isIndependentPosition(position, megaPosition, objectName, microIndex) {
    const posText = [
      position.title,
      position.summary,
      ...(position._mergedFrom || []),
      ...(position._originalTitles || [])
    ].filter(Boolean).join(' ').toLowerCase();

    // Collect text from microSummaries for deeper analysis
    let microText = '';
    for (const respNum of (position.responseNumbers || []).slice(0, 10)) {
      const ms = microIndex.get(respNum);
      const arg = ms?.arguments?.[0];
      if (arg) {
        microText += ` ${arg.what || ''} ${arg.why || ''} ${arg.how || ''}`;
      }
    }
    microText = microText.toLowerCase();

    const allText = `${posText} ${microText}`;

    // Count signals for TYPE B (independent)
    let independentSignals = 0;
    let independentReasons = [];

    // Check for physical effect keywords
    const physicalMatch = PositionConsolidator.INDEPENDENT_CONCERN_KEYWORDS.physicalEffects
      .filter(k => allText.includes(k));
    if (physicalMatch.length > 0) {
      independentSignals += 2; // Strong signal
      independentReasons.push(`physical-effects:${physicalMatch.slice(0, 2).join(',')}`);
    }

    // Check for independent object keywords
    const objectMatch = PositionConsolidator.INDEPENDENT_CONCERN_KEYWORDS.independentObjects
      .filter(k => allText.includes(k));
    if (objectMatch.length > 0) {
      independentSignals += 2; // Strong signal
      independentReasons.push(`independent-object:${objectMatch.slice(0, 2).join(',')}`);
    }

    // Check for new construction concern keywords
    const constructionMatch = PositionConsolidator.INDEPENDENT_CONCERN_KEYWORDS.newConstructionConcerns
      .filter(k => allText.includes(k));
    if (constructionMatch.length > 0) {
      independentSignals += 1; // Moderate signal (can co-exist with preservation)
      independentReasons.push(`new-construction:${constructionMatch.slice(0, 2).join(',')}`);
    }

    // Check for procedural concern keywords
    const proceduralMatch = PositionConsolidator.INDEPENDENT_CONCERN_KEYWORDS.proceduralConcerns
      .filter(k => allText.includes(k));
    if (proceduralMatch.length > 0 && independentSignals > 0) {
      independentSignals += 1; // Only adds if other independent signals exist
      independentReasons.push(`procedural:${proceduralMatch.slice(0, 2).join(',')}`);
    }

    // Count counter-signals for TYPE A (sub-position/justification)
    let justificationSignals = 0;

    // Check if position mentions the SAME object as mega-position
    const objectVariants = [
      objectName.toLowerCase(),
      objectName.toLowerCase().slice(0, -1),
      objectName.toLowerCase().slice(0, -2)
    ].filter(v => v && v.length >= 2);

    const mentionsMegaObject = objectVariants.some(v => posText.includes(v));
    if (mentionsMegaObject) {
      justificationSignals += 1;
    }

    // Check for preservation justification keywords
    for (const [category, keywords] of Object.entries(PositionConsolidator.PRESERVATION_JUSTIFICATION_KEYWORDS)) {
      const matches = keywords.filter(k => allText.includes(k));
      if (matches.length > 0) {
        justificationSignals += 1;
      }
    }

    // DECISION LOGIC:
    // - If independent signals dominate, it's TYPE B (don't absorb)
    // - If justification signals dominate AND mentions same object, it's TYPE A (absorb)
    // - Mixed signals: lean towards independence if physical effects or independent objects found

    const isIndependent = independentSignals >= 2 && independentSignals > justificationSignals;
    const confidence = independentSignals > 0
      ? Math.min(1, independentSignals / (independentSignals + justificationSignals + 1))
      : 0;

    return {
      isIndependent,
      reason: independentReasons.join('; ') || 'none',
      confidence,
      signals: { independent: independentSignals, justification: justificationSignals }
    };
  }

  /**
   * Absorb small preservation-focused positions into the mega-position.
   *
   * Motivation:
   * - Some tiny positions are essentially "Bevar X" variants, but titles/summaries can be generic
   *   (so they survive mega-merge). Writers may later rephrase them with the object name, making
   *   them look like duplicates in the final output.
   * - We want these to become nuance inside the mega-position (sub-positions), not separate top-level
   *   positions.
   *
   * Safety:
   * - Only absorbs SMALL positions (default <= 25 respondents)
   * - Requires preservation intent AND object mention (directly OR via microSummaries)
   * - Prefer absorbing when overlap with mega is high; still allows same-theme absorption for small
   *   preservation variants to reduce duplicates.
   */
  absorbSmallPreservationDuplicatesIntoMega(themes, createdMegaPositions, objectName, microSummaries = []) {
    try {
      if (!createdMegaPositions?.length || !objectName) return themes;

      const MAX_ABSORB_SIZE = 25;
      const OVERLAP_THRESHOLD = 0.90;

      const preservationKeywords = [
        'bevar', 'bevare', 'bevares', 'bevaring', 'bevarelse', 'bevaringsværdig',
        'nedriv', 'nedrivning', 'nedrive', 'rive ned', 'rives ned',
        'renover', 'renovering', 'restaurer', 'restaurering',
        'fred', 'fredning',
        'kulturarv', 'kulturhistorisk', 'historisk', 'ikonisk', 'vartegn'
      ];

      const objectVariants = [
        objectName.toLowerCase(),
        objectName.toLowerCase().slice(0, -1),
        objectName.toLowerCase().slice(0, -2)
      ].filter(v => v && v.length >= 2);
      if (objectName.toLowerCase() === 'palads') {
        // Common typo/variant in this dataset
        objectVariants.push('plads');
      }

      const microIndex = new Map();
      for (const ms of microSummaries || []) {
        if (ms?.responseNumber != null) microIndex.set(ms.responseNumber, ms);
      }

      // Helper: check microSummaries for object+preservation evidence
      const checkMicroEvidence = (responseNumbers, needObject, needPreservation) => {
        // Sample a few respondents (deterministic: first N)
        for (const respNum of (responseNumbers || []).slice(0, 5)) {
          const ms = microIndex.get(respNum);
          const arg = ms?.arguments?.[0];
          if (!arg) continue;
          const text = `${arg.what || ''} ${arg.why || ''} ${arg.how || ''}`.toLowerCase();
          if (needObject) {
            if (objectVariants.some(v => text.includes(v))) {
              needObject = false;
            }
          }
          if (needPreservation) {
            if (preservationKeywords.some(k => text.includes(k))) {
              needPreservation = false;
            }
          }
          if (!needObject && !needPreservation) return { mentionsObject: true, hasPreservation: true };
        }
        return { mentionsObject: !needObject, hasPreservation: !needPreservation };
      };

      // Work per mega-position (handles opposition-case too)
      let workingThemes = themes;

      for (let megaIdx = 0; megaIdx < createdMegaPositions.length; megaIdx++) {
        const { bestTheme } = createdMegaPositions[megaIdx] || {};

        // Locate mega-position object in the current themes snapshot
        let megaThemeObj = null;
        let megaPosRef = null;

        for (const theme of workingThemes) {
          if (bestTheme && theme.name !== bestTheme) continue;
          const candidates = (theme.positions || []).filter(p => p?._isMegaPosition && (p?._dominantObject === objectName || (p?.title || '').toLowerCase().includes(objectName)));
          if (candidates.length > 0) {
            // If multiple, take the largest
            megaPosRef = candidates.reduce((a, b) => ((a.responseNumbers?.length || 0) >= (b.responseNumbers?.length || 0) ? a : b));
            megaThemeObj = theme;
            break;
          }
        }

        if (!megaPosRef || !megaThemeObj) {
          continue;
        }

        const megaSet = new Set(megaPosRef.responseNumbers || []);
        const absorbed = [];

        // Rebuild themes while potentially removing absorbed positions
        workingThemes = workingThemes.map(theme => {
          const newPositions = [];

          for (const pos of (theme.positions || [])) {
            if (pos === megaPosRef) {
              newPositions.push(pos);
              continue;
            }
            if (pos?._isMegaPosition) {
              newPositions.push(pos);
              continue;
            }

            const respCount = pos?.responseNumbers?.length || 0;
            if (respCount === 0 || respCount > MAX_ABSORB_SIZE) {
              newPositions.push(pos);
              continue;
            }

            // DIRECTION-FIRST: Check direction compatibility before absorption
            // If mega-position has immutable direction, only absorb positions with compatible direction
            const megaDir = megaPosRef._direction;
            const posDir = pos._direction;
            if (megaPosRef._immutableDirection && megaDir && posDir && megaDir !== posDir) {
              console.log(`[PositionConsolidator] 🚫 DIRECTION BLOCK in absorption: "${(pos.title || '').slice(0, 40)}..." (${posDir}) cannot be absorbed into ${megaDir} mega-position`);
              newPositions.push(pos);
              continue;
            }

            const posText = [
              pos.title,
              pos.summary,
              ...(pos._mergedFrom || []),
              ...(pos._originalTitles || [])
            ].filter(Boolean).join(' ').toLowerCase();

            let mentionsObject = objectVariants.some(v => posText.includes(v));
            let hasPreservation = preservationKeywords.some(k => posText.includes(k));

            if (!mentionsObject || !hasPreservation) {
              const evidence = checkMicroEvidence(pos.responseNumbers || [], !mentionsObject, !hasPreservation);
              mentionsObject = evidence.mentionsObject;
              hasPreservation = evidence.hasPreservation;
            }

            // SPECIAL HANDLING FOR AUTHORITATIVE SOURCES (Lokaludvalg, myndigheder, etc.)
            // These are official stakeholders in the hearing who are ALWAYS discussing the 
            // same project, even if they don't explicitly mention the object name.
            // If they have preservation keywords, assume they're discussing the same object.
            const isAuthoritativeSource = posText.includes('lokaludvalg') ||
              posText.includes('myndighed') ||
              posText.includes('forvaltning') ||
              posText.includes('kommune') ||
              // Also check respondent type markers in microSummaries
              (pos.responseNumbers || []).some(n => {
                const ms = microIndex.get(n);
                const type = (ms?.respondentType || '').toLowerCase();
                return type.includes('lokal') || type.includes('myndighed') || type.includes('forvaltning');
              });
            
            // For authoritative sources with preservation keywords:
            // Assume they're discussing the same object (the hearing subject)
            if (isAuthoritativeSource && hasPreservation && !mentionsObject) {
              console.log(`[PositionConsolidator] 🏛️ Authoritative source detected: "${(pos.title || '').slice(0, 50)}..." - assuming same object`);
              mentionsObject = true; // Override for authoritative sources
            }

            if (!mentionsObject || !hasPreservation) {
              newPositions.push(pos);
              continue;
            }

            // ============================================================================
            // INDEPENDENT POSITION CHECK (v3):
            // Before absorbing, check if this position represents an INDEPENDENT concern
            // (TYPE B) rather than a justification for preservation (TYPE A).
            //
            // TYPE A (absorb): "Bevar Palads pga. klimahensyn" → sub-position
            // TYPE B (keep separate): "Bekymring for skygge fra nybyggeri" → independent
            //
            // This prevents over-absorption of distinct concerns like:
            // - Shadow/noise effects from new construction
            // - Concerns about trees, institutions, traffic
            // - Opposition to hotel/commercial development
            // ============================================================================
            const independenceCheck = this.isIndependentPosition(pos, megaPosRef, objectName, microIndex);

            if (independenceCheck.isIndependent) {
              // Apply threshold: keep as separate if EITHER:
              // - Has >= 3 respondents (absolute minimum for a meaningful position), OR
              // - Has >= 5% of mega-position's respondents (relative significance)
              // This uses OR logic so small positions with clear independence can survive
              const megaSize = megaPosRef.responseNumbers?.length || 1;
              const percentThreshold = Math.ceil(megaSize * 0.05);
              const meetsAbsoluteThreshold = respCount >= 3;
              const meetsRelativeThreshold = respCount >= percentThreshold;

              if (meetsAbsoluteThreshold || meetsRelativeThreshold) {
                console.log(`[PositionConsolidator] 🚫 SKIPPED absorption of independent position: "${(pos.title || '').slice(0, 60)}..." (n=${respCount}, reason=${independenceCheck.reason})`);
                newPositions.push(pos);
                continue;
              } else {
                console.log(`[PositionConsolidator] ℹ️ Independent position below threshold (n=${respCount}, need >= 3 or >= ${percentThreshold}): "${(pos.title || '').slice(0, 50)}..." - will be absorbed as sub-position`);
              }
            }

            const overlapCount = (pos.responseNumbers || []).reduce((sum, n) => sum + (megaSet.has(n) ? 1 : 0), 0);
            const overlapRatio = respCount > 0 ? (overlapCount / respCount) : 0;

            const sameThemeAsMega = theme.name === megaThemeObj.name;

            // ENHANCED ABSORPTION LOGIC (v3):
            // If position has BOTH preservation keywords AND mentions the object, absorb it
            // regardless of theme or overlap. This catches cross-theme preservation positions
            // that are semantically about the same thing (e.g., "Modstand mod nybyggeri og
            // bevarelse af historisk bygningsværk" should merge into "Ønske om bevaring af Palads").
            //
            // Original logic only absorbed if:
            //   - 90% overlap with mega respondents, OR
            //   - Same theme as mega
            //
            // New logic adds:
            //   - Has preservation keywords AND mentions object (cross-theme semantic absorption)
            //
            // CRITICAL: Also check for STANCE CONFLICTS. A position with support stance
            // should NEVER be absorbed into a preservation mega-position, even if it mentions
            // the same object.
            const hasSemanticPreservationMatch = mentionsObject && hasPreservation;

            // STANCE CHECK: Use TITLE-BASED detection (the title was generated by LLM and contains the semantic stance)
            // This is much more reliable than keyword patterns because the LLM already understood the stance when generating the title.
            //
            // CRITICAL: A position with a title indicating SUPPORT for change/project should NEVER be absorbed
            // into a preservation mega-position (and vice versa).
            //
            // Title-based indicators are UNIVERSAL (work across all cases):
            // - Support indicators: "Støtte til", "For ", "Pro ", "Opbakning", "Tilslutning"
            // - Against indicators: "Modstand", "Imod ", "Bevar", "Kritik af", "Bekymring"
            const megaTitle = megaPosRef.title?.toLowerCase() || '';
            const posTitle = pos.title?.toLowerCase() || '';

            // Check if positions have OPPOSITE stance based on their titles
            const supportTitleIndicators = ['støtte til', 'for ', 'pro ', 'opbakning', 'tilslutning', 'positiv'];
            const againstTitleIndicators = ['modstand', 'imod ', 'bevar', 'kritik', 'bekymring', 'ønske om bevaring', 'nej til'];
            // Keywords that indicate preservation content (even if prefixed with "støtte til")
            const preservationContentKeywords = ['bevar', 'bevaring', 'bevarelse', 'bevare', 'nedrivning'];

            const megaIsPreservation = againstTitleIndicators.some(ind => megaTitle.includes(ind));
            const posHasSupportPrefix = supportTitleIndicators.some(ind => posTitle.includes(ind));
            const posHasPreservationContent = preservationContentKeywords.some(kw => posTitle.includes(kw));
            const posIsPreservation = againstTitleIndicators.some(ind => posTitle.includes(ind));
            const megaIsSupport = supportTitleIndicators.some(ind => megaTitle.includes(ind));

            // If position has "støtte til" but ALSO mentions preservation (e.g., "Støtte til bevarelse af Palads"),
            // treat it as preservation, not support. The content (bevarelse) trumps the grammatical prefix (støtte til).
            // ALSO: if the position has semantic preservation match (mentions object + preservation keywords),
            // allow it even if the title says "støtte til" - the content trumps the title.
            const posIsActuallySupport = posHasSupportPrefix && !posHasPreservationContent && !hasSemanticPreservationMatch;

            const hasStanceConflict = (megaIsPreservation && posIsActuallySupport) || (megaIsSupport && posIsPreservation);

            if (hasStanceConflict) {
              console.log(`[PositionConsolidator] 🚫 STANCE CONFLICT (title-based): "${posTitle.slice(0, 50)}..." cannot be absorbed into "${megaTitle.slice(0, 50)}..."`);
              newPositions.push(pos);
              continue;
            }

            // Log when we include despite support title (for debugging)
            if (posHasSupportPrefix && hasSemanticPreservationMatch) {
              console.log(`[PositionConsolidator] ✓ Absorbing "${posTitle.slice(0, 50)}..." despite support title - semantic preservation match`);
            }

            const shouldAbsorb = overlapRatio >= OVERLAP_THRESHOLD || sameThemeAsMega || hasSemanticPreservationMatch;

            if (!shouldAbsorb) {
              newPositions.push(pos);
              continue;
            }

            // Absorb: ensure respondents are included in mega
            const missing = [];
            for (const n of (pos.responseNumbers || [])) {
              if (!megaSet.has(n)) {
                megaSet.add(n);
                missing.push(n);
              }
            }

            // Determine absorption reason for logging
            let absorptionReason = 'unknown';
            if (sameThemeAsMega) {
              absorptionReason = 'same-theme';
            } else if (overlapRatio >= OVERLAP_THRESHOLD) {
              absorptionReason = 'high-overlap';
            } else if (hasSemanticPreservationMatch) {
              absorptionReason = 'cross-theme-semantic';
            }

            absorbed.push({
              title: pos.title,
              theme: theme.name,
              respondentCount: respCount,
              overlapRatio: Number(overlapRatio.toFixed(3)),
              addedToMega: missing.length,
              reason: absorptionReason
            });

            // Skip adding this position => removed from top-level
          }

          return { ...theme, positions: newPositions };
        });

        if (absorbed.length > 0) {
          const crossThemeCount = absorbed.filter(a => a.reason === 'cross-theme-semantic').length;
          console.log(`[PositionConsolidator] ♻️ Absorbed ${absorbed.length} small preservation position(s) into mega-position "${megaPosRef.title}" (${crossThemeCount} cross-theme)`);
          for (const a of absorbed.slice(0, 10)) {
            console.log(`[PositionConsolidator]   → absorbed "${(a.title || '').slice(0, 60)}..." (theme="${a.theme}", n=${a.respondentCount}, reason=${a.reason})`);
          }
          if (absorbed.length > 10) {
            console.log(`[PositionConsolidator]   ... and ${absorbed.length - 10} more absorbed positions`);
          }

          // Update mega position in-place (it exists by reference inside workingThemes)
          megaPosRef.responseNumbers = Array.from(megaSet).sort((a, b) => a - b);
          megaPosRef._absorbedSmallPositions = [
            ...(megaPosRef._absorbedSmallPositions || []),
            ...absorbed
          ];
          // Preserve provenance in mergedFrom (helps downstream sub-position extraction)
          megaPosRef._mergedFrom = [
            ...(megaPosRef._mergedFrom || []),
            ...absorbed.map(a => a.title).filter(Boolean)
          ];
        }
      }

      return workingThemes;
    } catch (e) {
      console.warn('[PositionConsolidator] absorbSmallPreservationDuplicatesIntoMega failed, skipping:', e?.message || e);
      return themes;
    }
  }

  /**
   * LLM-validated merge of LARGE positions into mega-position.
   *
   * Unlike heuristic-based absorption, this uses LLM to verify that positions
   * share the SAME grundholdning before merging.
   *
   * Flow:
   * 1. Find positions that mention same object as mega-position
   * 2. Filter to positions with >25 respondents (not handled by small absorption)
   * 3. Ask LLM: "Do these have the same grundholdning?"
   * 4. Only merge if LLM confirms
   *
   * @param {Array} themes - All themes with positions
   * @param {Array} createdMegaPositions - Mega-positions created by mega-merge
   * @param {string} objectName - The dominant object (e.g., "palads")
   * @returns {Promise<Array>} Modified themes
   */
  async llmValidatedLargeMerge(themes, createdMegaPositions, objectName) {
    if (!this.client || !createdMegaPositions?.length || !objectName) {
      return themes;
    }

    const objectLower = objectName.toLowerCase();
    const objectVariants = [objectLower, objectLower.slice(0, -1)].filter(v => v.length >= 3);

    let totalMerged = 0;

    for (const theme of themes) {
      if (!theme?.positions) continue;

      // Find mega-position in this theme
      const megaPosRef = theme.positions.find(p =>
        p?._isMegaPosition &&
        (p?._dominantObject === objectName || p?.title?.toLowerCase().includes(objectLower))
      );
      if (!megaPosRef) continue;

      // Find candidate positions (>25 respondents, mentions same object)
      const candidates = theme.positions.filter(pos => {
        if (!pos || pos === megaPosRef || pos._isMegaPosition) return false;
        const respCount = pos.responseNumbers?.length || 0;
        if (respCount <= 25) return false; // Already handled by small absorption

        const titleLower = (pos.title || '').toLowerCase();
        return objectVariants.some(v => titleLower.includes(v));
      });

      if (candidates.length === 0) continue;

      console.log(`[PositionConsolidator] 🔍 LLM-validating ${candidates.length} large positions against mega "${megaPosRef.title.slice(0, 50)}..."`);

      // LLM-validate each candidate in parallel
      const validationPromises = candidates.map(async (candidate) => {
        const shouldMerge = await this.llmValidateGrundholdning(megaPosRef, candidate, objectName);
        return { candidate, shouldMerge };
      });

      const results = await Promise.all(validationPromises);
      const megaSet = new Set(megaPosRef.responseNumbers || []);
      const positionsToRemove = [];

      for (const { candidate, shouldMerge } of results) {
        if (!shouldMerge) {
          console.log(`[PositionConsolidator] ❌ LLM rejected: "${candidate.title}" (different grundholdning)`);
          continue;
        }

        // ABSORB: Add respondents to mega-position
        let addedCount = 0;
        for (const n of (candidate.responseNumbers || [])) {
          if (!megaSet.has(n)) {
            megaSet.add(n);
            addedCount++;
          }
        }

        // Add as sub-position
        if (!megaPosRef.subPositions) megaPosRef.subPositions = [];
        megaPosRef.subPositions.push({
          title: candidate.title,
          summary: candidate.summary,
          responseNumbers: candidate.responseNumbers,
          _absorbedFrom: candidate.title,
          _llmValidated: true
        });

        const idx = theme.positions.indexOf(candidate);
        if (idx !== -1) positionsToRemove.push(idx);

        console.log(`[PositionConsolidator] ✅ LLM approved merge: "${candidate.title}" (${candidate.responseNumbers?.length} resp, ${addedCount} new)`);
        totalMerged++;
      }

      // Remove absorbed positions (reverse order to preserve indices)
      for (const idx of positionsToRemove.sort((a, b) => b - a)) {
        theme.positions.splice(idx, 1);
      }

      // Update mega-position
      megaPosRef.responseNumbers = Array.from(megaSet).sort((a, b) => a - b);
    }

    if (totalMerged > 0) {
      console.log(`[PositionConsolidator] 🐘 LLM-validated merge: ${totalMerged} large position(s) absorbed into mega`);
    }

    return themes;
  }

  /**
   * Ask LLM if two positions share the same grundholdning.
   * More focused than general merge validation - specifically checks:
   * 1. Same fundamental stance (support/oppose same thing)
   * 2. Same primary object
   * 3. NOT just similar concerns but different solutions
   *
   * @param {Object} megaPosition - The mega-position
   * @param {Object} candidate - Candidate position to potentially merge
   * @param {string} objectName - The shared object name
   * @returns {Promise<boolean>} Whether positions share same grundholdning
   */
  async llmValidateGrundholdning(megaPosition, candidate, objectName) {
    const prompt = `Du er ekspert i at vurdere om to holdninger i høringssvar har SAMME GRUNDHOLDNING.

**MEGA-POSITION (hovedholdning):**
Titel: ${megaPosition.title}
Opsummering: ${(megaPosition.summary || '').slice(0, 500)}

**KANDIDAT-POSITION:**
Titel: ${candidate.title}
Opsummering: ${(candidate.summary || '').slice(0, 500)}

**FÆLLES OBJEKT:** ${objectName}

**OPGAVE:** Har disse to positioner SAMME GRUNDHOLDNING?

**DEFINITION AF "SAMME GRUNDHOLDNING":**
- SAMME primære handling (bevar/nedbryd/støt/modstå)
- SAMME primære objekt (${objectName})
- Detaljer/begrundelser kan variere, men KERNEN er identisk

**EKSEMPLER PÅ SAMME GRUNDHOLDNING:**
- "Bevar Palads" + "Støtte til bevarelse af Palads pga. kulturarv" → JA (begge vil bevare)
- "Bevar Palads" + "Ønske om renovering frem for nedrivning af Palads" → JA (begge mod nedrivning)

**EKSEMPLER PÅ FORSKELLIG GRUNDHOLDNING:**
- "Bevar Palads" + "Bekymring for trafik ved Palads" → NEJ (bevaring vs. trafikbekymring)
- "Bevar Palads" + "Støtte til lokalplanen" → NEJ (bevaring vs. planstøtte)
- "Bevar Palads" + "Modstand mod hotelbyggeri" → NEJ (bevaring vs. anti-hotel)

**SVAR KUN:** "JA" eller "NEJ" (ingen forklaring)`;

    try {
      const response = await this.client.createCompletion({
        messages: [
          {
            role: 'system',
            content: 'Du er ekspert i at vurdere holdninger i høringssvar. Svar kun med JA eller NEJ.'
          },
          { role: 'user', content: prompt }
        ],
        max_tokens: 10
      });

      const content = response.choices?.[0]?.message?.content || '';
      const answer = content.trim().toUpperCase();
      return answer === 'JA' || answer.startsWith('JA');
    } catch (error) {
      console.warn(`[PositionConsolidator] LLM grundholdning validation failed: ${error.message}`);
      return false; // Conservative: don't merge if validation fails
    }
  }

  /**
   * Enrich mega-positions by finding respondents in small positions (other themes)
   * that semantically should also be in the mega-position.
   * 
   * This catches cases where respondents with clear preservation arguments
   * were incorrectly theme-mapped to other themes.
   * 
   * @param {Array} themes - All themes after mega-merge
   * @param {Array} createdMegaPositions - The created mega-positions
   * @param {string} objectName - The object name (e.g., "palads")
   * @returns {Array} Themes with enriched mega-positions
   */
  async enrichMegaPositions(themes, createdMegaPositions, objectName, microSummaries = []) {
    const MAX_SMALL_POSITION_SIZE = 5;
    
    // Find the mega-position theme and get the mega-position itself
    const megaTheme = createdMegaPositions[0]?.bestTheme;
    const megaPosition = createdMegaPositions[0]?.megaPosition;
    if (!megaTheme || !megaPosition) return themes;
    
    // Build preservation keywords (simpler than embeddings, more reliable)
    const preservationKeywords = [
      'bevar', 'bevare', 'bevares', 'bevaring', 'bevaringsværdig',
      'nedrivning', 'nedrive', 'rive ned', 'rives ned',
      'kulturarv', 'kulturhistorisk', 'historisk bygning', 'historisk', 'smuk',
      'ikonisk', 'vartegn', 'beskyt', 'beskytte',
      'skal stå', 'skal blive', 'skal forblive', 'kulturhus'
    ];
    
    // Build object name variants (including common typos)
    const objectVariants = [
      objectName.toLowerCase(),
      objectName.toLowerCase().slice(0, -1), // Drop last char (palads -> palad)
      objectName.toLowerCase().replace('a', '').slice(0, 4) // (palads -> plds -> pld) - catch "plads" typo
    ];
    // Add "plads" as explicit variant for "palads" (common typo)
    if (objectName.toLowerCase() === 'palads') {
      objectVariants.push('plads');
    }
    
    // Collect small positions from OTHER themes
    const candidatePositions = [];
    for (const theme of themes) {
      if (theme.name === megaTheme) continue; // Skip the mega-position's theme
      
      for (const pos of (theme.positions || [])) {
        const respCount = pos.responseNumbers?.length || 0;
        if (respCount > 0 && respCount <= MAX_SMALL_POSITION_SIZE) {
          candidatePositions.push({ position: pos, theme: theme.name });
        }
      }
    }
    
    if (candidatePositions.length === 0) {
      console.log(`[PositionConsolidator] Enrichment: No small positions to scan`);
      return themes;
    }
    
    console.log(`[PositionConsolidator] Enrichment: Scanning ${candidatePositions.length} small positions for mega-position matches...`);
    
    // For each candidate, check if any respondent's argument matches the mega-position theme
    const respondentsToAdd = new Map(); // responseNumber -> { argument, sourcePosition }
    
    for (const { position, theme } of candidatePositions) {
      // Build position text from title and any available argument data
      const positionText = (position.title || '').toLowerCase();
      
      // Check each respondent in this position
      for (const respNum of (position.responseNumbers || [])) {
        // DIRECTION-FIRST: Check respondent direction BEFORE any keyword matching
        // If mega-position has immutable direction, only allow matching direction respondents
        const megaDirection = megaPosition._direction;
        if (megaPosition._immutableDirection && megaDirection) {
          const respDirection = this.getRespondentDirection(respNum, microSummaries);
          if (respDirection && respDirection !== megaDirection) {
            console.log(`[PositionConsolidator] 🚫 DIRECTION BLOCK in enrichment: #${respNum} (${respDirection}) cannot enrich ${megaDirection} mega-position`);
            continue;
          }
        }

        // Build a text representation of the respondent's argument
        let argumentText = positionText;

        // PRIMARY: Use micro-summaries passed from pipeline (most reliable)
        const microSummary = microSummaries.find(ms => ms.responseNumber === respNum);
        if (microSummary?.arguments?.[0]) {
          const arg = microSummary.arguments[0];
          argumentText += ` ${arg.what || ''} ${arg.why || ''} ${arg.how || ''}`;
        }
        
        // FALLBACK: Check if position has micro-summaries embedded
        if (position.microSummaries) {
          const ms = position.microSummaries.find(m => m.responseNumber === respNum);
          if (ms?.arguments?.[0]) {
            argumentText += ` ${ms.arguments[0].what || ''} ${ms.arguments[0].why || ''}`;
          }
        }
        
        // Check merged positions for original arguments
        if (position._mergedPositions) {
          for (const merged of position._mergedPositions) {
            if (merged.responseNumbers?.includes(respNum)) {
              argumentText += ` ${merged.title || ''}`;
            }
          }
        }
        
        argumentText = argumentText.toLowerCase();
        
        // REQUIREMENT 1: Must mention the object or a variant (e.g., "palads", "plads")
        const mentionsObject = objectVariants.some(variant => 
          argumentText.includes(variant)
        );
        
        if (!mentionsObject) {
          continue;
        }
        
        // REQUIREMENT 2: Must have preservation-related keywords
        const hasPreservationIntent = preservationKeywords.some(kw => 
          argumentText.includes(kw.toLowerCase())
        );
        
        if (!hasPreservationIntent) {
          continue;
        }

        // STANCE CHECK: The respondent's ARGUMENT already passed the preservation intent check above.
        // If their argument clearly mentions the object + preservation keywords, we should include them
        // regardless of the source position's title. The argument content trumps the position title.
        //
        // We only block if the respondent's argument is TRULY about support for change (e.g., mentions
        // "fornyelse", "modernisering", "udvikling" etc.) without any preservation context.
        const changeIndicators = ['fornyels', 'udvikl', 'ombygn', 'nybygn', 'hotel', 'udvid'];
        const hasChangeIntent = changeIndicators.some(kw => argumentText.includes(kw));

        // Block only if argument mentions change indicators AND doesn't have preservation keywords
        // hasPreservationIntent is already true at this point, so this check is just for safety
        if (hasChangeIntent && !hasPreservationIntent) {
          const positionTitle = (position.title || '').toLowerCase();
          console.log(`[PositionConsolidator] 🚫 STANCE CONFLICT in enrichment: #${respNum} from "${positionTitle.slice(0, 50)}..." - argument focuses on change not preservation`);
          continue;
        }

        // Log when we include despite support title
        const positionTitle = (position.title || '').toLowerCase();
        const hasSupportInTitle = positionTitle.includes('støtte') || positionTitle.includes('positiv');
        if (hasSupportInTitle) {
          console.log(`[PositionConsolidator] ✓ Including #${respNum} despite support title - argument has preservation intent`);
        }

        // This respondent matches! Add to enrichment list
        const matchedVariant = objectVariants.find(v => argumentText.includes(v));
        respondentsToAdd.set(respNum, {
          sourcePosition: position.title,
          sourceTheme: theme,
          matchedText: argumentText.slice(0, 100),
          matchedVariant
        });
        console.log(`[PositionConsolidator] ✓ Enrichment match: #${respNum} from "${position.title}" (mentions "${matchedVariant}" + preservation intent)`);
      }
    }
    
    if (respondentsToAdd.size === 0) {
      console.log(`[PositionConsolidator] Enrichment: No additional respondents found`);
      return themes;
    }
    
    // Add the respondents to the mega-position
    const newThemes = themes.map(theme => {
      if (theme.name !== megaTheme) return theme;
      
      return {
        ...theme,
        positions: theme.positions.map(pos => {
          // Find the mega-position (the one with most respondents)
          const isMegaPosition = pos._isMegaMerged || 
            (pos.responseNumbers?.length > 50 && pos.title?.toLowerCase().includes(objectName));
          
          if (!isMegaPosition) return pos;
          
          // Add enriched respondents
          const existingRespondents = new Set(pos.responseNumbers || []);
          const newRespondents = [];
          
          for (const [respNum, data] of respondentsToAdd) {
            if (!existingRespondents.has(respNum)) {
              newRespondents.push(respNum);
            }
          }
          
          if (newRespondents.length === 0) return pos;
          
          console.log(`[PositionConsolidator] 📥 Adding ${newRespondents.length} respondents to mega-position: ${newRespondents.join(', ')}`);
          
          return {
            ...pos,
            responseNumbers: [...pos.responseNumbers, ...newRespondents].sort((a, b) => a - b),
            _enrichedRespondents: newRespondents,
            _enrichmentSource: Object.fromEntries(
              newRespondents.map(r => [r, respondentsToAdd.get(r)])
            )
          };
        })
      };
    });
    
    return newThemes;
  }

  /**
   * Build search patterns for finding positions related to a dominant object
   * Includes the object itself plus contextual words that indicate discussions about it
   * @param {string} objectName - The dominant object name (lowercase)
   * @param {Object} objectConcentration - Full concentration analysis
   * @returns {Array<string>} Search patterns to match
   */
  buildObjectSearchPatterns(objectName, objectConcentration) {
    const patterns = [objectName];
    
    // DYNAMIC: Generate common variations/typos algorithmically
    // Instead of hardcoding "plads" for "palads", detect partial matches
    if (objectName.length >= 4) {
      // Add partial prefix matches (e.g., "rundetårn" → "rundet", "palads" → "palad")
      patterns.push(objectName.slice(0, -1)); // Drop last char
      patterns.push(objectName.slice(0, -2)); // Drop last 2 chars
    }
    
    // DYNAMIC: Physical object types that typically involve preservation discussions
    // This is a general pattern, not case-specific
    const physicalObjectTypes = [
      // Buildings
      'palads', 'rådhus', 'teater', 'biograf', 'kirke', 'slot', 'museum', 
      'bibliotek', 'station', 'skole', 'hospital', 'hal', 'arena', 'hus',
      // Landmarks
      'tårn', 'spir', 'monument', 'statue', 'fontæne', 'søjle',
      // Infrastructure
      'bro', 'tunnel', 'viadukt', 'trappe', 'passage',
      // Areas
      'park', 'plads', 'torv', 'gård', 'have', 'anlæg'
    ];
    const isPhysicalObject = physicalObjectTypes.some(type => objectName.includes(type));
    
    // When concentration is high (>60%) OR we detected a physical object,
    // add GENERIC preservation-related patterns that apply to any case
    if (isPhysicalObject || objectConcentration.concentration > 0.6) {
      // Generic preservation/discussion patterns - NOT case-specific
      const genericPreservationPatterns = [
        // Danish preservation vocabulary
        'bevar', 'bevare', 'bevaring', 'bevaringsværdig',
        'nedrivning', 'nedrive', 'rive ned',
        'kulturarv', 'kulturhistorisk', 'historisk',
        'ikonisk', 'vartegn', 'seværdighed',
        // Building-generic terms
        'bygning', 'facade', 'arkitektur', 'renovering', 'restaurering',
        // Opposition patterns
        'modstand mod', 'bekymring for', 'ødelæggelse'
      ];
      
      patterns.push(...genericPreservationPatterns);
    }
    
    // Add other dominant objects as alternatives (but filter out very short/common words)
    const skipPatterns = new Set(['å', 'a', 'i', 'og', 'en', 'et', 'af', 'til', 'på', 'med', 'for', 'den', 'det']);
    for (const obj of objectConcentration.dominantObjects.slice(1, 3)) {
      const objLower = obj.object.toLowerCase();
      // Only add if it's a meaningful word (3+ chars, not a common word)
      if (objLower.length >= 3 && !skipPatterns.has(objLower)) {
        patterns.push(objLower);
      }
    }
    
    // Filter out patterns that are too short or too common
    return patterns.filter(p => p.length >= 2 && !skipPatterns.has(p));
  }

  /**
   * Find positions that semantically belong to the mega-merge group
   * Uses embedding similarity to catch positions that discuss the same topic
   * but don't use the exact keywords
   * @param {Array} matchedPositions - Positions already matched by keywords
   * @param {Array} unmatchedCandidates - Positions to check semantically
   * @param {string} objectName - The dominant object name
   * @returns {Promise<Array>} Additional positions to include
   */
  async findSemanticMegaMergeMatches(matchedPositions, unmatchedCandidates, objectName) {
    if (unmatchedCandidates.length === 0) {
      return [];
    }

    try {
      // Create a representative text for "what positions about this object look like"
      const representativeTexts = matchedPositions.slice(0, 5).map(p => 
        `${p.title}\n${(p.summary || '').slice(0, 300)}`
      );
      
      // Embed the matched positions (use first 5 as representative)
      const matchedEmbeddings = await this.embedder.embedBatch(representativeTexts);
      
      // Calculate centroid of matched positions
      const centroid = this.calculateCentroid(matchedEmbeddings);
      
      // Embed candidate positions
      const candidateTexts = unmatchedCandidates.map(c => 
        `${c.position.title}\n${(c.position.summary || '').slice(0, 300)}`
      );
      const candidateEmbeddings = await this.embedder.embedBatch(candidateTexts);
      
      // Find candidates that are semantically similar to the matched group
      const additionalMatches = [];
      const SEMANTIC_MEGA_MERGE_THRESHOLD = 0.72; // Relatively high to avoid false positives
      
      for (let i = 0; i < unmatchedCandidates.length; i++) {
        if (!candidateEmbeddings[i]) continue;
        
        const similarity = this.cosineSimilarity(centroid, candidateEmbeddings[i]);
        
        if (similarity >= SEMANTIC_MEGA_MERGE_THRESHOLD) {
          additionalMatches.push({
            ...unmatchedCandidates[i],
            similarity
          });
        }
      }
      
      return additionalMatches;
    } catch (error) {
      console.warn(`[PositionConsolidator] Semantic mega-merge matching failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Calculate centroid (average) of embedding vectors
   * @param {Array<Array<number>>} embeddings - Array of embedding vectors
   * @returns {Array<number>} Centroid vector
   */
  calculateCentroid(embeddings) {
    const validEmbeddings = embeddings.filter(e => e && e.length > 0);
    if (validEmbeddings.length === 0) {
      return [];
    }
    
    const dimensions = validEmbeddings[0].length;
    const centroid = new Array(dimensions).fill(0);
    
    for (const embedding of validEmbeddings) {
      for (let i = 0; i < dimensions; i++) {
        centroid[i] += embedding[i];
      }
    }
    
    for (let i = 0; i < dimensions; i++) {
      centroid[i] /= validEmbeddings.length;
    }
    
    return centroid;
  }

  /**
   * Selective cross-theme consolidation (for moderate complexity hearings)
   * 1. First consolidates within each theme
   * 2. Then merges only high-similarity cross-theme duplicates (more conservative threshold)
   */
  async consolidateSelectively(aggregatedThemes, stats) {
    console.log(`[PositionConsolidator] SELECTIVE strategy: within-theme first, then cross-theme duplicates`);

    // STEP 1: Consolidate within each theme (reuse existing logic)
    const withinThemeConsolidated = await this.consolidateWithinThemes(aggregatedThemes, stats);

    // STEP 2: Find and merge cross-theme duplicates with HIGHER threshold
    const crossThemeThreshold = Math.min(0.95, this.similarityThreshold + 0.05); // More conservative
    console.log(`[PositionConsolidator] Looking for cross-theme duplicates (threshold=${crossThemeThreshold.toFixed(3)})`);

    // Flatten all positions across themes
    const allPositions = [];
    const positionToThemeMap = new Map();

    withinThemeConsolidated.forEach((theme, themeIdx) => {
      (theme.positions || []).forEach(position => {
        const posIdx = allPositions.length;
        allPositions.push(position);
        positionToThemeMap.set(posIdx, { themeName: theme.name, themeIdx });
      });
    });

    if (allPositions.length < 2) {
      console.log(`[PositionConsolidator] Less than 2 positions total, no cross-theme consolidation needed`);
      return withinThemeConsolidated;
    }

    // Find cross-theme merge candidates
    console.log(`[PositionConsolidator] Checking ${allPositions.length} positions for cross-theme duplicates...`);

    // TITLE-BASED MERGE: Positions with identical or very similar titles MUST merge
    // This catches "Støtte til projektet" appearing in multiple themes
    const titleBasedMerges = [];
    const normalizeTitle = (title) => (title || '').toLowerCase().replace(/[^a-zæøå0-9\s]/g, '').trim();

    for (let i = 0; i < allPositions.length; i++) {
      for (let j = i + 1; j < allPositions.length; j++) {
        const theme1 = positionToThemeMap.get(i).themeName;
        const theme2 = positionToThemeMap.get(j).themeName;

        // Only consider cross-theme pairs
        if (theme1 === theme2) continue;

        // CRITICAL: Don't merge cross-theme positions from the SAME SINGLE RESPONDENT
        // Even with identical titles - they were intentionally split by micro-summarizer
        const pos1Respondents = allPositions[i].responseNumbers || [];
        const pos2Respondents = allPositions[j].responseNumbers || [];
        if (pos1Respondents.length === 1 && pos2Respondents.length === 1 &&
            pos1Respondents[0] === pos2Respondents[0]) {
          continue; // Skip - same single respondent in different themes
        }

        const title1 = normalizeTitle(allPositions[i].title);
        const title2 = normalizeTitle(allPositions[j].title);

        // Identical titles - ALWAYS merge
        if (title1 === title2) {
          console.log(`[PositionConsolidator] 🔗 IDENTICAL title across themes: "${allPositions[i].title}" (${theme1} + ${theme2})`);
          titleBasedMerges.push({
            idx1: i,
            idx2: j,
            position1: allPositions[i],
            position2: allPositions[j],
            theme1,
            theme2,
            similarity: 1.0,
            _titleBased: true
          });
        }
      }
    }

    if (titleBasedMerges.length > 0) {
      console.log(`[PositionConsolidator] Found ${titleBasedMerges.length} title-based cross-theme merge candidates`);
    }

    const embeddingTexts = allPositions.map((pos) => {
      // Use more summary text for better semantic matching
      const summaryPreview = (pos.summary || '').slice(0, 800);
      // Include original merged titles for better matching
      const mergedTitles = (pos._mergedFrom || []).slice(0, 3).join(', ');
      const mergedTitlesText = mergedTitles ? `\nOprindelige titler: ${mergedTitles}` : '';
      return `${pos.title}${mergedTitlesText}\n\n${summaryPreview}`;
    });

    const embeddings = await this.embedder.embedBatch(embeddingTexts);

    // Find cross-theme pairs with high similarity
    const crossThemeCandidates = [];
    for (let i = 0; i < allPositions.length; i++) {
      for (let j = i + 1; j < allPositions.length; j++) {
        const theme1 = positionToThemeMap.get(i).themeName;
        const theme2 = positionToThemeMap.get(j).themeName;

        // Only consider cross-theme pairs
        if (theme1 === theme2) continue;

        // CRITICAL: Don't merge cross-theme positions from the SAME SINGLE RESPONDENT
        // If a single respondent has positions in different themes, they were intentionally split
        // by micro-summarizer because they address different regulatory areas (§§)
        // They should stay separate so other respondents can join them individually
        const pos1Respondents = allPositions[i].responseNumbers || [];
        const pos2Respondents = allPositions[j].responseNumbers || [];
        if (pos1Respondents.length === 1 && pos2Respondents.length === 1 &&
            pos1Respondents[0] === pos2Respondents[0]) {
          console.log(`[PositionConsolidator] ❌ SKIP cross-theme: Same single respondent (${pos1Respondents[0]}) in different themes`);
          continue;
        }

        if (!embeddings[i] || !embeddings[j]) continue;

        const similarity = this.cosineSimilarity(embeddings[i], embeddings[j]);

        if (similarity >= crossThemeThreshold) {
          crossThemeCandidates.push({
            idx1: i,
            idx2: j,
            position1: allPositions[i],
            position2: allPositions[j],
            theme1,
            theme2,
            similarity
          });
        }
      }
    }

    console.log(`[PositionConsolidator] Found ${crossThemeCandidates.length} embedding-based cross-theme duplicate candidates`);

    // Combine title-based and embedding-based candidates
    // Title-based merges are pre-validated (identical titles = definitely same position)
    const allCrossThemeCandidates = [...titleBasedMerges, ...crossThemeCandidates];

    // Remove duplicates (same pair from both title and embedding matching)
    const seenPairs = new Set();
    const uniqueCandidates = allCrossThemeCandidates.filter(c => {
      const key = `${Math.min(c.idx1, c.idx2)}-${Math.max(c.idx1, c.idx2)}`;
      if (seenPairs.has(key)) return false;
      seenPairs.add(key);
      return true;
    });

    if (uniqueCandidates.length === 0) {
      console.log(`[PositionConsolidator] No cross-theme duplicates found, returning within-theme consolidated results`);
      return withinThemeConsolidated;
    }

    console.log(`[PositionConsolidator] Total unique cross-theme candidates: ${uniqueCandidates.length} (${titleBasedMerges.length} title-based, ${crossThemeCandidates.length} embedding-based)`);

    // Title-based merges don't need LLM validation - they're pre-validated
    const preValidatedMerges = uniqueCandidates.filter(c => c._titleBased);
    const needsValidation = uniqueCandidates.filter(c => !c._titleBased);

    // Validate embedding-based merges with LLM using ADAPTIVE concurrency
    let selectiveConcurrency;
    if (allPositions.length < 50) {
      selectiveConcurrency = 25;
    } else if (allPositions.length < 200) {
      selectiveConcurrency = 15;
    } else if (allPositions.length < 500) {
      selectiveConcurrency = 10;
    } else {
      selectiveConcurrency = 5;
    }
    const validatedEmbeddingMerges = needsValidation.length > 0
      ? await this.validateMergeCandidatesAdaptive(needsValidation, 'CROSS-THEME', selectiveConcurrency)
      : [];

    const validatedCrossThemeMerges = [...preValidatedMerges, ...validatedEmbeddingMerges];
    console.log(`[PositionConsolidator] Validated ${validatedCrossThemeMerges.length} cross-theme merges (${preValidatedMerges.length} title-based auto-approved)`);

    if (validatedCrossThemeMerges.length === 0) {
      return withinThemeConsolidated;
    }

    // Execute cross-theme merges using robust group merging logic
    // This handles transitive merges correctly (A->B, B->C)
    const mergedPositions = this.executeMerges(allPositions, validatedCrossThemeMerges);

    // Map original indices to new merged positions
    // If index i was merged into group G, we need to know where G is in mergedPositions
    // But executeMerges returns a flat list of positions.
    // We need to know which themes lost positions and which kept them.

    // Strategy: Rebuild themes from mergedPositions.
    // For each merged position, if it was formed from merging multiple, keep it in the theme of the "primary" parent.
    // If it wasn't merged, it stays in its original theme.

    // Track which original positions (indices) ended up in which merged position
    const mergedToOriginalIndices = new Map(); // mergedPos -> [originalIndex, originalIndex...]

    // We need a way to trace back. executeMerges doesn't return the mapping.
    // Let's reimplement the relevant part of executeMerges here with tracking.

    const mergeGroups = this.buildMergeGroups(validatedCrossThemeMerges, allPositions.length);
    const mergedIndices = new Set();
    const replacements = new Map(); // originalIndex -> newMergedPosition

    let removedCount = 0;

    for (let i = 0; i < allPositions.length; i++) {
      if (mergedIndices.has(i)) continue;

      const group = mergeGroups.find(g => g.includes(i));

      if (group && group.length > 1) {
        // Merge all positions in this group
        const groupPositions = group.map(idx => allPositions[idx]);
        const mergedPosition = this.mergePositions(groupPositions, this.allResponses || []);

        // The first position in the group determines the "surviving" location/theme
        const survivorIndex = group[0];
        replacements.set(survivorIndex, mergedPosition);

        // Mark all others as merged/removed
        group.forEach(idx => mergedIndices.add(idx));

        removedCount += (group.length - 1);
      }
    }

    console.log(`[PositionConsolidator] SELECTIVE consolidation: ${removedCount} cross-theme duplicates removed`);

    // Reconstruct themes
    const finalConsolidated = withinThemeConsolidated.map((theme, themeIdx) => {
      const newPositions = [];
      let localRemoved = 0;

      theme.positions.forEach((pos) => {
        // Find the global index of this position
        // We need to be careful: 'allPositions' was built by iterating themes in order.
        // So we can reconstruct the index.
        // Better: use object identity if possible, but we have copies.
        // Let's use the same iteration order as when building 'allPositions'.
      });

      return theme; // placeholder
    });

    // Correct reconstruction loop
    let globalIndex = 0;
    const rebuiltThemes = withinThemeConsolidated.map((theme, themeIdx) => {
      const newPositions = [];
      let localRemoved = 0;

      theme.positions.forEach((pos) => {
        const currentGlobalIndex = globalIndex++;

        if (replacements.has(currentGlobalIndex)) {
          // This position is the "survivor" (or representative) of a merge group
          // Replace it with the fully merged result
          newPositions.push(replacements.get(currentGlobalIndex));
        } else if (!mergedIndices.has(currentGlobalIndex)) {
          // This position was not part of any merge group
          newPositions.push(pos);
        } else {
          // This position was merged into another group where it wasn't the survivor
          // It is effectively removed from this theme
          localRemoved++;
        }
      });

      return {
        ...theme,
        positions: newPositions,
        _consolidationMeta: {
          ...theme._consolidationMeta,
          crossThemeRemoved: localRemoved
        }
      };
    });

    return rebuiltThemes;
  }

  /**
   * Stage 1: Find merge candidates using embedding similarity
   * @param {Array} positions - Positions to analyze
   * @param {string} themeName - Theme name for logging
   * @param {number} overrideThreshold - Optional threshold override (for cross-theme)
   * @returns {Promise<Array>} Merge candidates with similarity scores
   */
  async findMergeCandidates(positions, themeName, overrideThreshold = null) {
    if (positions.length < 2) return [];

    // QUALITY FIX: Use theme-specific threshold if no override provided
    // "Andre emner" gets lower threshold to preserve nuances
    let threshold;
    if (overrideThreshold) {
      threshold = overrideThreshold;
    } else {
      // Get theme-specific threshold (lower for catch-all themes)
      const themeThreshold = this.getThemeThreshold(themeName);
      // Also apply dynamic adjustment based on respondent concentration
      threshold = this.calculateDynamicThreshold(positions, themeThreshold);
    }

    try {
      // Generate embeddings for all positions
      console.log(`[PositionConsolidator] Generating embeddings for ${positions.length} positions in theme "${themeName}"`);

      // DECOUPLED FROM TITLE: Use arguments (consequence-felter) as primary embedding source
      // This makes consolidation quality independent of title quality
      const embeddingTexts = positions.map((pos) => {
        // Extract consequence texts from source arguments (the actual respondent statements)
        const args = (pos.sourceArgumentRefs || pos.args || []);
        const argsText = args.slice(0, 5)
          .map(a => a.consequence || a.what || '')
          .filter(Boolean)
          .join('. ');
        const summaryPreview = (pos.summary || '').slice(0, 600);
        return `${argsText}\n\n${summaryPreview}`;
      });

      const embeddings = await this.embedder.embedBatch(embeddingTexts);

      // Compute pairwise similarities
      const candidates = [];
      for (let i = 0; i < positions.length; i++) {
        for (let j = i + 1; j < positions.length; j++) {
          if (!embeddings[i] || !embeddings[j]) {
            console.warn(`[PositionConsolidator] Missing embedding for position ${i} or ${j}, skipping pair`);
            continue;
          }

          const similarity = this.cosineSimilarity(embeddings[i], embeddings[j]);

          // QUALITY FIX: Lower threshold for single-respondent positions to reduce fragmentation
          // Many (1)-positioner der handler om det samme bør merges lettere
          const isSingleRespondent1 = (positions[i].responseNumbers?.length || 0) === 1;
          const isSingleRespondent2 = (positions[j].responseNumbers?.length || 0) === 1;
          const effectiveThreshold = (isSingleRespondent1 || isSingleRespondent2)
            ? Math.max(0.70, threshold - 0.05) // Lower threshold for single-respondent (0.73 instead of 0.78)
            : threshold;

          if (similarity >= effectiveThreshold) {
            // QUALITY FIX: Apply merge guard to prevent mega-positions
            // Block merges that would create positions with too many respondents
            if (!this.shouldAllowMerge(positions[i], positions[j])) {
              continue; // Skip this candidate - would create over-merged position
            }

            // DIRECTION-FIRST: Block merges between opposite directions
            const directionCheck = this.canMergeByDirection(positions[i], positions[j]);
            if (!directionCheck.allowed) {
              continue; // Skip this candidate - direction mismatch
            }

            // Pre-compute object overlap for LLM validation
            const objects1 = this.extractKeyObjects(positions[i].title, positions[i].summary || '');
            const objects2 = this.extractKeyObjects(positions[j].title, positions[j].summary || '');
            const objectOverlap = this.calculateObjectOverlap(objects1, objects2);

            candidates.push({
              idx1: i,
              idx2: j,
              position1: positions[i],
              position2: positions[j],
              similarity,
              objectOverlap, // Include for LLM validation
              _loweredThreshold: effectiveThreshold < threshold // Track if we used lower threshold
            });
          }
        }
      }

      // Sort by similarity (highest first) for prioritized validation
      return candidates.sort((a, b) => b.similarity - a.similarity);
    } catch (error) {
      console.error('[PositionConsolidator] Error finding merge candidates:', error);
      return [];
    }
  }

  /**
   * Stage 2: Validate merge candidates with LLM (PARALLEL for speed)
   * SMART CROSS-THEME: Allows merge when SAME physical element, blocks when DIFFERENT
   * @param {Array} candidates - Merge candidates from stage 1
   * @param {string} themeName - Theme name for context
   * @returns {Promise<Array>} Validated merge candidates
   */
  async validateMergeCandidates(candidates, themeName) {
    if (!this.client) {
      console.warn('[PositionConsolidator] LLM client not available, skipping validation');
      return candidates; // Fallback: accept all candidates if no LLM
    }

    // SMART CROSS-THEME MERGING:
    // - ALLOW merge when positions are about the SAME physical element (e.g., both about "boldbane")
    // - BLOCK merge when positions are about DIFFERENT physical elements (e.g., "boldbane" vs "bygningshøjde")
    // This enables grouping related concerns (støj fra boldbane + flytning af boldbane = same element)
    // while preventing merging unrelated topics
    if (themeName === 'CROSS-THEME') {
      const smartFilteredCandidates = candidates.filter(c => {
        const theme1 = c.position1?._originalTheme || c.theme1;
        const theme2 = c.position2?._originalTheme || c.theme2;
        
        // If same theme, always allow
        if (!theme1 || !theme2 || theme1 === theme2) {
          return true;
        }
        
        // Different themes - check if SAME physical element
        const objects1 = this.extractKeyObjects(c.position1?.title || '', c.position1?.summary || '');
        const objects2 = this.extractKeyObjects(c.position2?.title || '', c.position2?.summary || '');
        
        // Find primary physical elements (exclude generic ones like 'støj', 'trafik')
        const primaryElements1 = this.getPrimaryPhysicalElements(objects1);
        const primaryElements2 = this.getPrimaryPhysicalElements(objects2);
        
        // Check for overlap in primary elements
        const sharedElements = primaryElements1.filter(e => primaryElements2.includes(e));

        if (sharedElements.length > 0) {
          console.log(`[PositionConsolidator] ✅ ALLOWED cross-theme merge (same element: ${sharedElements.join(', ')}): "${c.position1?.title?.slice(0,35)}..." + "${c.position2?.title?.slice(0,35)}..."`);
          return true;
        } else {
          console.log(`[PositionConsolidator] ⛔ BLOCKED cross-theme merge (different elements): "${c.position1?.title?.slice(0,35)}..." (${primaryElements1.join(',') || 'generic'}) + "${c.position2?.title?.slice(0,35)}..." (${primaryElements2.join(',') || 'generic'})`);
          return false;
        }
      });
      
      const allowedCount = smartFilteredCandidates.length;
      const blockedCount = candidates.length - allowedCount;
      if (blockedCount > 0) {
        console.log(`[PositionConsolidator] 🧠 Smart cross-theme filter: ${allowedCount} ALLOWED (same element), ${blockedCount} BLOCKED (different elements)`);
      }
      
      candidates = smartFilteredCandidates;
    }

    const validated = [];
    const validationLimit = Math.min(candidates.length, this.maxLLMValidations);

    console.log(`[PositionConsolidator] Validating up to ${validationLimit} merge candidates with LLM (parallel)`);

    // Run all LLM validations in PARALLEL for massive speed improvement
    const validationPromises = candidates.slice(0, validationLimit).map(async (candidate, i) => {
      try {
        const shouldMerge = await this.llmValidateMerge(
          candidate.position1,
          candidate.position2,
          themeName
        );

        if (shouldMerge) {
          return candidate; // Return candidate if merge accepted
        } else {
          console.log(`[PositionConsolidator] LLM rejected merge (similarity=${candidate.similarity.toFixed(3)}): "${candidate.position1.title}" + "${candidate.position2.title}"`);
          return null; // Return null if merge rejected
        }
      } catch (error) {
        console.warn(`[PositionConsolidator] LLM validation failed for candidate ${i}:`, error.message);
        // Conservative: don't merge if validation fails
        return null;
      }
    });

    // Wait for all validations to complete
    const results = await Promise.all(validationPromises);

    // Filter out rejected merges (nulls)
    const validatedMerges = results.filter(result => result !== null);

    return validatedMerges;
  }

  /**
   * Stage 2 (ADAPTIVE): Validate merge candidates with controlled concurrency
   *
   * Unlike validateMergeCandidates which uses Promise.all (unbounded parallelism),
   * this version uses limitConcurrency for rate-limit-safe parallel execution.
   *
   * @param {Array} candidates - Merge candidates from stage 1
   * @param {string} themeName - Theme name for context
   * @param {number} llmConcurrency - Max concurrent LLM calls for this theme
   * @returns {Promise<Array>} Validated merge candidates
   */
  async validateMergeCandidatesAdaptive(candidates, themeName, llmConcurrency) {
    if (candidates.length === 0) {
      return [];
    }

    // SAFETY: Without LLM client, we cannot validate merges semantically.
    // Return empty to reject all candidates rather than blindly accepting.
    if (!this.client) {
      console.error('[PositionConsolidator] NO LLM CLIENT - cannot validate merges. Rejecting all candidates.');
      return [];
    }

    // Apply cross-theme filtering if applicable (same logic as validateMergeCandidates)
    if (themeName === 'CROSS-THEME') {
      candidates = candidates.filter(c => {
        const theme1 = c.position1?._originalTheme || c.theme1;
        const theme2 = c.position2?._originalTheme || c.theme2;
        if (!theme1 || !theme2 || theme1 === theme2) return true;

        const objects1 = this.extractKeyObjects(c.position1?.title || '', c.position1?.summary || '');
        const objects2 = this.extractKeyObjects(c.position2?.title || '', c.position2?.summary || '');
        const primaryElements1 = this.getPrimaryPhysicalElements(objects1);
        const primaryElements2 = this.getPrimaryPhysicalElements(objects2);
        const sharedElements = primaryElements1.filter(e => primaryElements2.includes(e));
        return sharedElements.length > 0;
      });
    }

    const validationLimit = Math.min(candidates.length, this.maxLLMValidations);
    console.log(`[PositionConsolidator] Validating ${validationLimit} candidates with adaptive concurrency=${llmConcurrency}`);

    // Create validation tasks (thunks) for limitConcurrency
    const validationTasks = candidates.slice(0, validationLimit).map((candidate, i) => async () => {
      try {
        const shouldMerge = await this.llmValidateMerge(
          candidate.position1,
          candidate.position2,
          themeName
        );

        if (shouldMerge) {
          return candidate;
        } else {
          console.log(`[PositionConsolidator] LLM rejected merge (similarity=${candidate.similarity.toFixed(3)}): "${candidate.position1.title?.slice(0, 40)}..." + "${candidate.position2.title?.slice(0, 40)}..."`);
          return null;
        }
      } catch (error) {
        console.warn(`[PositionConsolidator] LLM validation failed for candidate ${i}:`, error.message);
        return null;
      }
    });

    // Execute with controlled concurrency
    const results = await limitConcurrency(validationTasks, llmConcurrency);
    return results.filter(result => result !== null);
  }

  /**
   * Ask LLM if two positions should be merged
   * @param {Object} pos1 - First position
   * @param {Object} pos2 - Second position
   * @param {string} themeName - Theme name for context
   * @returns {Promise<boolean>} Should merge?
   */
  async llmValidateMerge(pos1, pos2, themeName) {
    // DECOUPLED FROM TITLE: Extract arguments for LLM context
    const args1 = (pos1.sourceArgumentRefs || pos1.args || []);
    const args1Text = args1.slice(0, 3).map(a => a.consequence || a.what || '').filter(Boolean).join('. ');
    const args2 = (pos2.sourceArgumentRefs || pos2.args || []);
    const args2Text = args2.slice(0, 3).map(a => a.consequence || a.what || '').filter(Boolean).join('. ');

    // Extract key objects from arguments and summary (not title)
    const objects1 = this.extractKeyObjects(args1Text, pos1.summary || '');
    const objects2 = this.extractKeyObjects(args2Text, pos2.summary || '');
    const objectOverlap = this.calculateObjectOverlap(objects1, objects2);

    // RAG: Get relevant context for both positions (if available)
    const [context1, context2] = await Promise.all([
      this.getRelevantContext(pos1, 2),
      this.getRelevantContext(pos2, 2)
    ]);
    const contextSection = (context1 || context2) ? `
**Relevant baggrund fra høringsmaterialet:**
${context1 ? `For A: ${context1}` : ''}
${context2 ? `For B: ${context2}` : ''}
` : '';

    const prompt = `Du er ekspert i at vurdere semantisk redundans i høringssvar-analyser.

**Tema:** ${themeName}

**Holdning A:**
Argumenter: ${args1Text || 'ingen'}
Opsummering: ${pos1.summary || ''}
Identificerede objekter: ${objects1.join(', ') || 'ingen specifik'}

**Holdning B:**
Argumenter: ${args2Text || 'ingen'}
Opsummering: ${pos2.summary || ''}
Identificerede objekter: ${objects2.join(', ') || 'ingen specifik'}
${contextSection}
**Objektanalyse:** ${objectOverlap.description}

**Opgave:** Vurder om disse to holdninger skal MERGES eller HOLDES SEPARATE.

**🔑 NØGLESPØRGSMÅL: Hvad skal kommunen GØR ANDERLEDES?**

Stil dette spørgsmål: "Hvis kommunen følger position A, har de så OGSÅ fulgt position B?"
- **JA → MERGE** (samme ønskede handling fra kommunen)
- **NEJ → HOLD SEPARATE** (forskellige ønskede handlinger)

**🎯 VIGTIG NUANCE: Aspekt ≠ Løsning**

Forskellige ASPEKTER/BEGRUNDELSER for SAMME ønske skal MERGES:
- "Bevar Palads pga. arkitektur" + "Bevar Palads pga. kulturhistorie" → **MERGE** (begge vil bevare)
- "Modstand mod hotel" + "Modstand mod kommerciel brug" → **MERGE** (begge vil stoppe kommerciel udvikling)
- "Bekymring for bygningshøjde" + "Bekymring for skyggevirkninger" → **MERGE** (begge vil lavere/mindre byggeri)

Forskellige LØSNINGER/HANDLINGER skal HOLDES SEPARATE:
- "Flyt boldbanen" + "Etabler støjskærme" → **SEPARATE** (to forskellige fysiske handlinger)
- "Begræns åbningstider" + "Flyt boldbanen" → **SEPARATE** (driftsbegrænsning vs. fysisk flytning)

**🔗 KOMPLEMENTÆRE POSITIONER**

Positioner der er "to sider af samme mønt" skal MERGES:
- "Støtte til bevarelse" + "Modstand mod omdannelse" → **MERGE** (begge siger: "Lad bygningen være som den er")
- "Ønske om bevaring" + "Kritik af nedrivning" → **MERGE** (begge siger: "Nedrivning er forkert")

**✅ MERGE (JA) hvis:**
- **Samme ønskede HANDLING fra kommunen** uanset formulering eller begrundelse
- **Komplementære positioner** ("støtte til X" = "modstand mod ikke-X")
- **Forskellige aspekter af SAMME ønske** (arkitektur, kultur, historie = alle vil bevare)

**EKSEMPLER PÅ KORREKT MERGE:**
- "Støtte til bevarelse af Palads' arkitektur" + "Støtte til bevarelse af Palads som kulturinstitution"
  → **JA, MERGE!** Begge vil: Bevar Palads. Forskellige begrundelser, samme handling.

- "Modstand mod hotelomdannelse" + "Modstand mod kommerciel brug"
  → **JA, MERGE!** Begge vil: Stop kommerciel udvikling. Samme handling.

- "Ønske om lavere bygningshøjde" + "Bekymring for skyggevirkninger"
  → **JA, MERGE!** Begge vil: Reducer byggeriets omfang.

**❌ HOLD SEPARATE (NEJ) hvis:**
- **FORSKELLIGE HANDLINGER** kommunen skal udføre:
  - "Flyt boldbanen" + "Etabler støjskærme" → **NEJ!** To forskellige fysiske handlinger
  - "Begræns åbningstider" + "Flyt boldbanen" → **NEJ!** Drift vs. fysisk ændring

- **FORSKELLIGE OBJEKTER** (bygning vs. vej, Palads vs. Scala)
- **MODSATRETTEDE HOLDNINGER** (støtte vs modstand til SAMME ting)

**Output:**
Returnér JSON med:
- shouldMerge (boolean) - JA hvis samme ønskede handling fra kommunen
- reasoning (kort begrundelse: hvad er den ønskede handling for hver?)
- desiredOutcomeA (string) - hvad ønsker holdning A at kommunen skal gøre?
- desiredOutcomeB (string) - hvad ønsker holdning B at kommunen skal gøre?
- sameDesiredOutcome (boolean) - ønsker de samme handling fra kommunen?
- objectsMatch (boolean) - matcher de konkrete objekter?`;

    try {
      const response = await this.client.createCompletion({
        messages: [
          {
            role: 'system',
            content: 'Du vurderer semantisk redundans i høringssvar.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        response_format: getResponseFormat('consolidatorMergeValidation')
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No content in LLM response');
      }

      const parsed = JSON.parse(content);
      return parsed.shouldMerge === true;
    } catch (error) {
      console.warn('[PositionConsolidator] LLM validation error:', error.message);
      return false; // Conservative: don't merge if uncertain
    }
  }

  /**
   * Stage 3: Execute validated merges
   * @param {Array} positions - All positions
   * @param {Array} validatedMerges - Validated merge candidates
   * @returns {Array} Merged positions
   */
  executeMerges(positions, validatedMerges) {
    if (validatedMerges.length === 0) {
      return positions; // Nothing to merge
    }

    // Build merge groups (handle transitive merging: A+B, B+C → A+B+C)
    const mergeGroups = this.buildMergeGroups(validatedMerges, positions.length);

    const merged = new Set();
    const result = [];

    for (let i = 0; i < positions.length; i++) {
      if (merged.has(i)) continue;

      const group = mergeGroups.find(g => g.includes(i));

      if (group && group.length > 1) {
        // Merge all positions in this group
        const groupPositions = group.map(idx => positions[idx]);
        const mergedPosition = this.mergePositions(groupPositions, this.allResponses || []);
        result.push(mergedPosition);

        // Mark all as merged
        group.forEach(idx => merged.add(idx));
      } else {
        // Keep as-is (no merge)
        result.push(positions[i]);
        merged.add(i);
      }
    }

    return result;
  }

  /**
   * Build transitive merge groups
   * If A merges with B, and B merges with C, then A+B+C form one group
   * @param {Array} validatedMerges - Validated merge pairs
   * @param {number} positionCount - Total number of positions
   * @returns {Array<Array<number>>} Groups of position indices to merge
   */
  buildMergeGroups(validatedMerges, positionCount) {
    // Union-Find algorithm for transitive grouping
    const parent = Array.from({ length: positionCount }, (_, i) => i);

    const find = (x) => {
      if (parent[x] !== x) {
        parent[x] = find(parent[x]); // Path compression
      }
      return parent[x];
    };

    const union = (x, y) => {
      const rootX = find(x);
      const rootY = find(y);
      if (rootX !== rootY) {
        parent[rootX] = rootY;
      }
    };

    // Union all merge pairs
    for (const merge of validatedMerges) {
      union(merge.idx1, merge.idx2);
    }

    // Group by root
    const groups = new Map();
    for (let i = 0; i < positionCount; i++) {
      const root = find(i);
      if (!groups.has(root)) {
        groups.set(root, []);
      }
      groups.get(root).push(i);
    }

    // Return only groups with 2+ members (actual merges)
    return Array.from(groups.values()).filter(g => g.length > 1);
  }

  /**
   * Merge multiple positions into one consolidated position
   * @param {Array} positions - Positions to merge
   * @param {Array} allResponses - All responses (for recalculating breakdown)
   * @returns {Object} Merged position
   */
  mergePositions(positions, allResponses = []) {
    // Combine responseNumbers (deduplicated and sorted)
    const allResponseNumbers = [
      ...new Set(positions.flatMap(p => p.responseNumbers || []))
    ].sort((a, b) => a - b);

    // Use the longest/most detailed summary as base
    const bestPosition = positions.reduce((best, curr) => {
      const currLength = (curr.summary || '').length;
      const bestLength = (best.summary || '').length;
      return currLength > bestLength ? curr : best;
    });

    // Recalculate respondent breakdown from actual responseNumbers
    const mergedBreakdown = this.mergeRespondentBreakdowns(
      positions.map(p => p.respondentBreakdown).filter(Boolean),
      allResponseNumbers,
      allResponses
    );

    // Combine material references (deduplicated)
    const allMaterialRefs = positions.flatMap(p => p.materialReferences || []);
    const uniqueMaterialRefs = this.deduplicateMaterialReferences(allMaterialRefs);

    // CRITICAL FIX: Create mapping of responseNumbers to their original positions
    // This helps sub-position extraction identify which respondents came from which original positions
    const responseNumberOrigins = {};
    positions.forEach(position => {
      const positionTitle = position.title;
      const positionSummary = (position.summary || '').slice(0, 300);
      (position.responseNumbers || []).forEach(respNum => {
        if (!responseNumberOrigins[respNum]) {
          responseNumberOrigins[respNum] = [];
        }
        responseNumberOrigins[respNum].push({
          title: positionTitle,
          summary: positionSummary
        });
      });
    });

    return {
      ...bestPosition,
      responseNumbers: allResponseNumbers,
      respondentBreakdown: mergedBreakdown,
      materialReferences: uniqueMaterialRefs,
      _mergedFrom: positions.map(p => p.title),
      _mergeCount: positions.length,
      _originalSummaries: positions.map(p => ({
        title: p.title,
        summary: (p.summary || '').slice(0, 500) // Increased for better synthesis
      })),
      _responseNumberOrigins: responseNumberOrigins,
      // Flag for summary regeneration - triggers LLM synthesis for mega-positions
      _needsSummaryRegeneration: positions.length >= 3
    };
  }

  /**
   * Recalculate respondent breakdown from response numbers
   * @param {Array<number>} responseNumbers - Response numbers to analyze
   * @param {Array} allResponses - All response objects (for lookup)
   * @returns {Object} Respondent breakdown
   */
  recalculateBreakdown(responseNumbers, allResponses = []) {
    const breakdown = {
      localCommittees: [],
      publicAuthorities: [],
      organizations: [],
      citizens: 0,
      total: responseNumbers.length
    };

    if (!allResponses || allResponses.length === 0) {
      // Fallback: all citizens if no response data
      breakdown.citizens = responseNumbers.length;
      return breakdown;
    }

    const seenCommittees = new Set();
    const seenAuthorities = new Set();
    const seenOrgs = new Set();

    for (const responseNumber of responseNumbers) {
      const response = allResponses.find(r => r.id === responseNumber);
      if (!response) {
        breakdown.citizens++;
        continue;
      }

      const respondentType = (response.respondentType || '').toLowerCase();
      const respondentName = response.respondentName || '';

      if (respondentType.includes('lokaludvalg') || respondentName.toLowerCase().includes('lokaludvalg')) {
        const name = respondentName || `Henvendelse ${responseNumber}`;
        if (!seenCommittees.has(name)) {
          breakdown.localCommittees.push(name);
          seenCommittees.add(name);
        }
      } else if (respondentType.includes('organisation')) {
        if (respondentName && !seenOrgs.has(respondentName)) {
          breakdown.organizations.push(respondentName);
          seenOrgs.add(respondentName);
        }
      } else if (respondentType.includes('myndighed')) {
        const name = respondentName || `Henvendelse ${responseNumber}`;
        if (!seenAuthorities.has(name)) {
          breakdown.publicAuthorities.push(name);
          seenAuthorities.add(name);
        }
      } else {
        breakdown.citizens++;
      }
    }

    return breakdown;
  }

  /**
   * Merge respondent breakdowns from multiple positions
   * RECALCULATES from merged responseNumbers instead of summing
   * @param {Array} breakdowns - Respondent breakdowns to merge (IGNORED - recalculated)
   * @param {Array} allResponseNumbers - All responseNumbers in merged position
   * @param {Array} allResponses - All responses (for lookup)
   * @returns {Object} Merged breakdown
   */
  mergeRespondentBreakdowns(breakdowns, allResponseNumbers, allResponses = []) {
    // Delegate to recalculateBreakdown for consistency
    return this.recalculateBreakdown(allResponseNumbers, allResponses);
  }

  /**
   * Deduplicate material references
   * @param {Array} references - Material references to deduplicate
   * @returns {Array} Deduplicated references
   */
  deduplicateMaterialReferences(references) {
    const seen = new Set();
    const unique = [];

    for (const ref of references) {
      const key = `${ref.type}:${ref.reference}`;
      if (!seen.has(key)) {
        unique.push(ref);
        seen.add(key);
      }
    }

    return unique;
  }

  /**
   * Compute cosine similarity between two embedding vectors
   * @param {Array<number>} vec1 - First embedding vector
   * @param {Array<number>} vec2 - Second embedding vector
   * @returns {number} Cosine similarity (0-1)
   */
  cosineSimilarity(vec1, vec2) {
    if (!vec1 || !vec2 || vec1.length !== vec2.length) {
      return 0;
    }

    let dotProduct = 0;
    let mag1 = 0;
    let mag2 = 0;

    for (let i = 0; i < vec1.length; i++) {
      dotProduct += vec1[i] * vec2[i];
      mag1 += vec1[i] * vec1[i];
      mag2 += vec2[i] * vec2[i];
    }

    mag1 = Math.sqrt(mag1);
    mag2 = Math.sqrt(mag2);

    if (mag1 === 0 || mag2 === 0) {
      return 0;
    }

    return dotProduct / (mag1 * mag2);
  }

  /**
   * Extract key objects from position title and summary
   * Used for object-aware merge validation
   * 
   * @param {string} title - Position title
   * @param {string} summary - Position summary
   * @returns {Array<string>} Extracted objects (normalized, lowercase)
   */
  extractKeyObjects(title, summary) {
    const text = `${title} ${summary}`.toLowerCase();
    const objects = new Set();
    
    // Object patterns to detect - ordered by specificity
    const objectPatterns = [
      // Specific named objects
      { pattern: /palads/gi, object: 'palads' },
      { pattern: /dahliahus|dahlia\s*hus/gi, object: 'dahliahus' },
      { pattern: /grøntorv/gi, object: 'grøntorvet' },
      
      // Infrastructure - specific types (mutually exclusive)
      { pattern: /bygningshøjde|bygnings\s*højde|(\d+)\s*meter.*bygning|bygning.*(\d+)\s*meter|høj.*bygning|bygning.*høj/gi, object: 'bygningshøjde' },
      { pattern: /boldbane|bold\s*bur|fodboldbane/gi, object: 'boldbane' },
      { pattern: /trafik|trafikforhold|trafikbelastning|trafikafvikling/gi, object: 'trafik' },
      { pattern: /støj|støjgener|støjbelastning|larm/gi, object: 'støj' },
      { pattern: /parkering|p-pladser|parkeringspladser/gi, object: 'parkering' },
      { pattern: /cykelsti|cykelvej|cykelinfrastruktur/gi, object: 'cykelsti' },
      { pattern: /adgangsforhold|adgang.*skole|skole.*adgang|indkørsel/gi, object: 'adgangsforhold' },
      
      // Geographic locations
      { pattern: /gammel\s*køge\s*landevej|gl\.?\s*køge\s*landevej/gi, object: 'gammel køge landevej' },
      { pattern: /værkstedvej/gi, object: 'værkstedvej' },
      { pattern: /torveporten/gi, object: 'torveporten' },
      
      // Building types
      { pattern: /skole|skolebygning/gi, object: 'skole' },
      { pattern: /almene\s*boliger|boligbyggeri/gi, object: 'almene boliger' },
    ];
    
    for (const { pattern, object } of objectPatterns) {
      if (pattern.test(text)) {
        objects.add(object);
      }
    }
    
    return Array.from(objects);
  }

  /**
   * Get PRIMARY physical elements from extracted objects
   * Filters out generic concern-based objects (støj, trafik) to focus on 
   * the actual physical things being REGULATED (boldbane, bygningshøjde, etc.)
   * 
   * @param {Array<string>} objects - Extracted objects from extractKeyObjects
   * @returns {Array<string>} Primary physical elements only
   */
  getPrimaryPhysicalElements(objects) {
    // Generic concerns - NOT primary physical elements
    // These describe HOW something affects people, not WHAT is being regulated
    const genericConcerns = new Set([
      'støj',       // Concern about noise - but what CAUSES the noise?
      'trafik',     // Concern about traffic - but what infrastructure?
      'adgangsforhold' // Generic access concern
    ]);
    
    // Primary physical elements - things that are REGULATED in the local plan
    // These are the actual physical structures/areas
    const primaryElements = new Set([
      'boldbane',           // § 8 Ubebyggede arealer
      'bygningshøjde',      // § 6 Bebyggelsens omfang
      'parkering',          // § 5 Parkering
      'cykelsti',           // § 4 Veje
      'skole',              // § 3 Anvendelse
      'almene boliger',     // § 3 Anvendelse
      'palads',             // Specific building
      'dahliahus',          // Specific building
      'grøntorvet',         // Specific area
      'gammel køge landevej', // Specific road
      'værkstedvej',        // Specific road
      'torveporten'         // Specific road
    ]);
    
    // Filter to only primary physical elements
    const primary = objects.filter(obj => {
      // Include if it's explicitly a primary element
      if (primaryElements.has(obj)) return true;
      // Exclude if it's a generic concern
      if (genericConcerns.has(obj)) return false;
      // Include other specific objects by default (to be safe)
      return true;
    });
    
    // If no primary elements found, return all non-generic objects
    // (better to have something than nothing for comparison)
    if (primary.length === 0) {
      return objects.filter(obj => !genericConcerns.has(obj));
    }
    
    return primary;
  }

  /**
   * Calculate object overlap between two positions
   * Returns analysis for LLM prompt
   * 
   * @param {Array<string>} objects1 - Objects from position 1
   * @param {Array<string>} objects2 - Objects from position 2
   * @returns {Object} Overlap analysis
   */
  calculateObjectOverlap(objects1, objects2) {
    const set1 = new Set(objects1);
    const set2 = new Set(objects2);
    
    const intersection = objects1.filter(o => set2.has(o));
    const onlyIn1 = objects1.filter(o => !set2.has(o));
    const onlyIn2 = objects2.filter(o => !set1.has(o));
    
    const totalUnique = new Set([...objects1, ...objects2]).size;
    const overlapRatio = totalUnique > 0 ? intersection.length / totalUnique : 0;
    
    let description;
    if (intersection.length === 0 && (objects1.length > 0 || objects2.length > 0)) {
      description = `INGEN OVERLAP - Forskellige objekter: A=[${objects1.join(', ')}], B=[${objects2.join(', ')}]. HOLD SEPARATE!`;
    } else if (intersection.length > 0 && (onlyIn1.length > 0 || onlyIn2.length > 0)) {
      description = `DELVIS OVERLAP - Fælles: [${intersection.join(', ')}], Kun i A: [${onlyIn1.join(', ')}], Kun i B: [${onlyIn2.join(', ')}]. Vurder om det fælles objekt er det primære.`;
    } else if (intersection.length > 0 && onlyIn1.length === 0 && onlyIn2.length === 0) {
      description = `FULD OVERLAP - Samme objekter: [${intersection.join(', ')}]. Kan potentielt merges.`;
    } else {
      description = `Ingen specifikke objekter identificeret. Vurder baseret på indhold.`;
    }
    
    return {
      intersection,
      onlyIn1,
      onlyIn2,
      overlapRatio,
      hasFullOverlap: intersection.length > 0 && onlyIn1.length === 0 && onlyIn2.length === 0,
      hasNoOverlap: intersection.length === 0 && (objects1.length > 0 || objects2.length > 0),
      description
    };
  }

  /**
   * Calculate position direction from argument-level direction metadata.
   * Uses the `direction` field from micro-summaries which is LLM-classified.
   * This is more reliable than title keyword matching as it's based on semantic understanding.
   *
   * @param {Object} position - Position with sourceArgumentRefs or args
   * @returns {string} 'support' | 'against' | 'neutral'
   */
  getPositionDirectionFromArguments(position) {
    // Get arguments from position (may be in different fields depending on pipeline stage)
    const args = position.args || position.sourceArgumentRefs || [];
    if (!args.length) {
      return 'neutral';
    }

    // Count direction classifications from micro-summaries
    const directions = args.map(a => a.direction).filter(Boolean);
    if (!directions.length) {
      return 'neutral';
    }

    const proChange = directions.filter(d => d === 'pro_change').length;
    const proStatusQuo = directions.filter(d => d === 'pro_status_quo').length;

    // pro_change = wants change = support for project that changes something
    // pro_status_quo = wants preservation = against project that changes something
    if (proChange > proStatusQuo) {
      return 'support';
    }
    if (proStatusQuo > proChange) {
      return 'against';
    }
    return 'neutral';
  }

  /**
   * Split positions by direction metadata (_directionGroup or argument direction).
   * Title-based fallback has been removed - direction comes from LLM classification.
   *
   * @param {Array} positions - Positions to classify
   * @returns {Object} { support: [], against: [], neutral: [], hasConflict: boolean }
   */
  splitPositionsByTitle(positions) {
    const support = [];
    const against = [];
    const neutral = [];

    for (const position of positions) {

      // PRIORITY 1: Check if position has explicit _directionGroup from aggregator
      // This is the most reliable indicator as it comes from micro-summary direction
      if (position._directionGroup === 'support') {
        position._titleStance = 'support';
        position._stanceSource = '_directionGroup';
        support.push(position);
        continue;
      }
      if (position._directionGroup === 'against') {
        position._titleStance = 'against';
        position._stanceSource = '_directionGroup';
        against.push(position);
        continue;
      }

      // PRIORITY 2: Calculate direction from argument-level direction metadata
      // This uses the LLM-classified direction from micro-summaries
      const argDirection = this.getPositionDirectionFromArguments(position);
      if (argDirection === 'support') {
        position._titleStance = 'support';
        position._stanceSource = 'argument_direction';
        support.push(position);
        continue;
      }
      if (argDirection === 'against') {
        position._titleStance = 'against';
        position._stanceSource = 'argument_direction';
        against.push(position);
        continue;
      }

      // PRIORITY 3: No direction available - classify as neutral
      // Title-based fallback removed - direction should come from _directionGroup or arguments
      // If we reach here, aggregator didn't set _directionGroup and arguments lack direction
      position._titleStance = 'neutral';
      position._stanceSource = 'no_direction_data';
      neutral.push(position);
      console.warn(`[PositionConsolidator] No direction data for position "${position.title?.slice(0, 50)}..." - classifying as neutral`);
    }

    const hasConflict = support.length > 0 && against.length > 0;

    // Debug logging
    if (positions.length > 0) {
      console.log(`[PositionConsolidator] Title-based stance classification: ${support.length} support, ${against.length} against, ${neutral.length} neutral (hasConflict: ${hasConflict})`);
    }

    return { support, against, neutral, hasConflict };
  }

  /**
   * Split positions by stance (support vs against vs neutral) using generic keyword patterns.
   * This is a CRITICAL pre-filter before mega-merge to prevent conflicting stances from being merged.
   *
   * IMPORTANT: Uses ONLY generic Danish patterns - no case-specific keywords!
   *
   * @param {Array} positions - Positions to classify by stance
   * @returns {Object} { support: [], against: [], neutral: [], hasConflict: boolean }
   */
  splitPositionsByStance(positions) {
    // Generic patterns for support (pro-project/pro-change)
    // IMPORTANT: Only UNAMBIGUOUS support signals. Words like "modernisering" and "fornyelse"
    // are context-dependent and should NOT be here - they can appear in preservation contexts too.
    const supportPatterns = [
      /\bstøtte(?:r|nde)?\s+(?:til\s+)?(?:projekt|forslag|plan)et?\b/i, // "støtter projektet/forslaget"
      /\bstøtte\s+til\s+\S+s?\s+(?:transformation|omdannelse|ombygning)\b/i, // "Støtte til X's transformation"
      /\bfor\s+(?:forslag|plan)et\b/i, // "for forslaget" (explicit)
      /\bpositiv\s+(?:overfor|over\s+for)\s+(?:projekt|forslag|plan)/i, // "positiv overfor projektet"
      /\bgod\s+(?:ide|idé)\b/i, // "god ide" (general approval)
      /\btilslut(?:ter|ning)\s+(?:mig|os|sig)?\s*(?:til\s+)?(?:projekt|forslag)/i, // "tilslutter mig forslaget"
      /\bopbakning\s+til\s+(?:projekt|forslag|plan)/i, // "opbakning til projektet"
      /\briv\s+(?:det\s+)?ned\b/i, // "riv det ned" - explicit demolition support
      /\bfjern\s+(?:den\s+)?(?:gamle\s+)?bygning/i, // "fjern bygningen"
      /\bned\s+med\b/i // "ned med [X]" - explicit opposition to preservation
    ];

    // Generic patterns for against (pro-preservation/anti-change)
    const againstPatterns = [
      /\bbevar(?:e|ing|es|ingsværdig)?/i,
      /\bmod(?:stand)?\s+(?:mod|imod)/i,
      /\bimod\s+(?:projekt|forslag|plan|nedrivning|ændring)/i,
      /\bnej\s+til/i,
      /\bikke\s+(?:nedriv|ændre|fjerne)/i,
      /\bbeskyt(?:te|telse|tes)?/i,
      /\bfred(?:e|ning|et)?/i, // fredning = preservation
      /\brestaurering/i,
      /\brenovering/i, // renovering = restore, not demolish
      /\bgenopret(?:ning|te)?/i,
      /\bkulturarv/i,
      /\bkulturhistorisk/i,
      /\bhistorisk\s+(?:værdi|bygning|bevarelse)/i,
      /\btab\s+(?:af|for)\s+(?:identitet|kulturarv|værdi)/i,
      /\bødelæggelse/i,
      /\brisiko\s+for\s+(?:tab|ødelæggelse)/i,
      /\bskal\s+(?:ikke\s+)?(?:bevares|beskyttes)/i
    ];

    const support = [];
    const against = [];
    const neutral = [];

    for (const position of positions) {
      // Build comprehensive text to analyze
      const text = [
        position.title,
        position.summary,
        ...(position._mergedFrom || []),
        ...(position.sourceArgumentRefs?.map(r => r.what) || []),
        ...(position.sourceArgumentRefs?.map(r => r.why) || [])
      ].filter(Boolean).join(' ');

      const hasSupport = supportPatterns.some(p => p.test(text));
      const hasAgainst = againstPatterns.some(p => p.test(text));

      // Classify based on pattern matches
      if (hasSupport && !hasAgainst) {
        position._detectedStance = 'support';
        support.push(position);
      } else if (hasAgainst && !hasSupport) {
        position._detectedStance = 'against';
        against.push(position);
      } else if (hasSupport && hasAgainst) {
        // Ambiguous - check which signals are stronger
        const supportCount = supportPatterns.filter(p => p.test(text)).length;
        const againstCount = againstPatterns.filter(p => p.test(text)).length;

        if (supportCount > againstCount * 1.5) {
          position._detectedStance = 'support';
          support.push(position);
        } else if (againstCount > supportCount * 1.5) {
          position._detectedStance = 'against';
          against.push(position);
        } else {
          position._detectedStance = 'neutral';
          neutral.push(position);
        }
      } else {
        position._detectedStance = 'neutral';
        neutral.push(position);
      }
    }

    // Conflict exists if we have both support AND against positions
    const hasConflict = support.length > 0 && against.length > 0;

    return { support, against, neutral, hasConflict };
  }

  /**
   * Detect the stance of a single position (support vs against vs neutral).
   * Used for checking stance conflicts before absorption.
   *
   * @param {Object} position - Single position to analyze
   * @returns {string} 'support' | 'against' | 'neutral'
   */
  detectPositionStance(position) {
    // Return cached stance if available
    if (position._detectedStance) {
      return position._detectedStance;
    }

    // Generic patterns for support (pro-project/pro-change)
    // IMPORTANT: Only UNAMBIGUOUS support signals. Words like "modernisering" and "fornyelse"
    // are context-dependent and should NOT be here - they can appear in preservation contexts too.
    const supportPatterns = [
      /\bstøtte(?:r|nde)?\s+(?:til\s+)?(?:projekt|forslag|plan)et?\b/i, // "støtter projektet/forslaget"
      /\bstøtte\s+til\s+\S+s?\s+(?:transformation|omdannelse|ombygning)\b/i, // "Støtte til X's transformation"
      /\bfor\s+(?:forslag|plan)et\b/i, // "for forslaget" (explicit)
      /\bpositiv\s+(?:overfor|over\s+for)\s+(?:projekt|forslag|plan)/i, // "positiv overfor projektet"
      /\bgod\s+(?:ide|idé)\b/i, // "god ide" (general approval)
      /\btilslut(?:ter|ning)\s+(?:mig|os|sig)?\s*(?:til\s+)?(?:projekt|forslag)/i, // "tilslutter mig forslaget"
      /\bopbakning\s+til\s+(?:projekt|forslag|plan)/i, // "opbakning til projektet"
      /\briv\s+(?:det\s+)?ned\b/i, // "riv det ned" - explicit demolition support
      /\bfjern\s+(?:den\s+)?(?:gamle\s+)?bygning/i, // "fjern bygningen"
      /\bned\s+med\b/i // "ned med [X]" - explicit opposition to preservation
    ];

    // Generic patterns for against (pro-preservation/anti-change)
    const againstPatterns = [
      /\bbevar(?:e|ing|es|ingsværdig)?/i,
      /\bmod(?:stand)?\s+(?:mod|imod)/i,
      /\bimod\s+(?:projekt|forslag|plan|nedrivning|ændring)/i,
      /\bnej\s+til/i,
      /\bikke\s+(?:nedriv|ændre|fjerne)/i,
      /\bbeskyt(?:te|telse|tes)?/i,
      /\bfred(?:e|ning|et)?/i,
      /\brestaurering/i,
      /\brenovering/i,
      /\bgenopret(?:ning|te)?/i,
      /\bkulturaarv/i,
      /\bkulturhistorisk/i,
      /\bhistorisk\s+(?:værdi|bygning|bevarelse)/i,
      /\btab\s+(?:af|for)\s+(?:identitet|kulturarv|værdi)/i,
      /\bødelæggelse/i,
      /\brisiko\s+for\s+(?:tab|ødelæggelse)/i,
      /\bskal\s+(?:ikke\s+)?(?:bevares|beskyttes)/i
    ];

    // Build comprehensive text to analyze
    const text = [
      position.title,
      position.summary,
      ...(position._mergedFrom || []),
      ...(position.sourceArgumentRefs?.map(r => r.what) || []),
      ...(position.sourceArgumentRefs?.map(r => r.why) || [])
    ].filter(Boolean).join(' ');

    const hasSupport = supportPatterns.some(p => p.test(text));
    const hasAgainst = againstPatterns.some(p => p.test(text));

    let stance;
    if (hasSupport && !hasAgainst) {
      stance = 'support';
    } else if (hasAgainst && !hasSupport) {
      stance = 'against';
    } else if (hasSupport && hasAgainst) {
      // Ambiguous - check which signals are stronger
      const supportCount = supportPatterns.filter(p => p.test(text)).length;
      const againstCount = againstPatterns.filter(p => p.test(text)).length;

      if (supportCount > againstCount * 1.5) {
        stance = 'support';
      } else if (againstCount > supportCount * 1.5) {
        stance = 'against';
      } else {
        stance = 'neutral';
      }
    } else {
      stance = 'neutral';
    }

    // Cache the result
    position._detectedStance = stance;
    return stance;
  }

  /**
   * Group positions by SEMANTIC SIMILARITY using embeddings
   * Much more robust than keyword-based sentiment analysis
   * 
   * @param {Array} positions - Positions to group
   * @returns {Promise<Object>} { groups: [], hasOpposition: boolean, oppositionReason: string }
   */
  async groupPositionsBySemanticSimilarity(positions) {
    if (positions.length <= 2) {
      // Too few positions to meaningfully cluster
      return {
        groups: [{ label: 'unified', positions, respondentCount: positions.reduce((sum, p) => sum + (p.responseNumbers?.length || 0), 0) }],
        hasOpposition: false,
        oppositionReason: 'too_few_positions'
      };
    }

    try {
      // Generate embeddings for all positions (using title + summary)
      const textsToEmbed = positions.map(p => {
        const parts = [p.title, p.summary?.slice(0, 200)].filter(Boolean);
        return parts.join(' - ');
      });

      const embeddings = await this.embedder.embedBatch(textsToEmbed);
      
      if (!embeddings || embeddings.length !== positions.length) {
        console.warn('[PositionConsolidator] Embedding failed, falling back to single group');
        return {
          groups: [{ label: 'unified', positions, respondentCount: positions.reduce((sum, p) => sum + (p.responseNumbers?.length || 0), 0) }],
          hasOpposition: false,
          oppositionReason: 'embedding_failed'
        };
      }

      // Calculate centroid (average embedding)
      const dim = embeddings[0].length;
      const centroid = new Array(dim).fill(0);
      for (const emb of embeddings) {
        for (let i = 0; i < dim; i++) {
          centroid[i] += emb[i] / embeddings.length;
        }
      }

      // Calculate similarity of each position to centroid
      const similarities = embeddings.map((emb, idx) => ({
        idx,
        position: positions[idx],
        similarity: this.cosineSimilarity(emb, centroid),
        embedding: emb
      }));

      // Sort by similarity (highest first)
      similarities.sort((a, b) => b.similarity - a.similarity);

      // Find outliers: positions with LOW similarity to centroid
      const avgSimilarity = similarities.reduce((sum, s) => sum + s.similarity, 0) / similarities.length;
      const stdDev = Math.sqrt(
        similarities.reduce((sum, s) => sum + Math.pow(s.similarity - avgSimilarity, 2), 0) / similarities.length
      );

      // Outliers are 1.5+ standard deviations below average
      const outlierThreshold = avgSimilarity - (stdDev * 1.5);
      const outliers = similarities.filter(s => s.similarity < outlierThreshold);
      const majority = similarities.filter(s => s.similarity >= outlierThreshold);

      console.log(`[PositionConsolidator] Semantic analysis: avg similarity ${avgSimilarity.toFixed(3)}, stdDev ${stdDev.toFixed(3)}, threshold ${outlierThreshold.toFixed(3)}`);
      console.log(`[PositionConsolidator] Majority: ${majority.length}, Outliers: ${outliers.length}`);

      // IMPROVED: Detect opposition more robustly
      // 1. Multiple outliers that are coherent (old logic)
      // 2. Single outlier that is VERY different from majority (new logic)
      // 3. Outliers that are opposite to majority mean direction (new logic)

      if (outliers.length >= 1) {
        // Check coherence if multiple outliers
        let outlierCoherence = 1.0; // Default to coherent for single outlier
        if (outliers.length >= 2) {
          let comparisons = 0;
          outlierCoherence = 0;
          for (let i = 0; i < outliers.length; i++) {
            for (let j = i + 1; j < outliers.length; j++) {
              outlierCoherence += this.cosineSimilarity(outliers[i].embedding, outliers[j].embedding);
              comparisons++;
            }
          }
          outlierCoherence = comparisons > 0 ? outlierCoherence / comparisons : 0;
        }

        console.log(`[PositionConsolidator] Outlier count: ${outliers.length}, coherence: ${outlierCoherence.toFixed(3)}`);

        // Check how similar outliers are to the MAJORITY (not centroid)
        // If outliers are very different from majority, they represent opposition
        const majorityEmbedding = this.calculateCentroid(majority.map(s => s.embedding));
        const outlierToMajoritySimSims = outliers.map(o => this.cosineSimilarity(o.embedding, majorityEmbedding));
        const avgOutlierToMajoritySim = outlierToMajoritySimSims.reduce((a, b) => a + b, 0) / outlierToMajoritySimSims.length;

        console.log(`[PositionConsolidator] Outlier-to-majority similarity: ${avgOutlierToMajoritySim.toFixed(3)}`);

        // Consider it opposition if:
        // - Multiple outliers (>= 2) with reasonable coherence (> 0.6), OR
        // - Any outliers with LOW similarity to majority (< 0.75) indicating semantic opposition
        const isSemanticOpposition =
          (outliers.length >= 2 && outlierCoherence > 0.6) ||
          (avgOutlierToMajoritySim < 0.75); // Very different from majority = opposition

        if (isSemanticOpposition) {
          const majorityRespondents = majority.reduce((sum, s) => sum + (s.position.responseNumbers?.length || 0), 0);
          const outlierRespondents = outliers.reduce((sum, s) => sum + (s.position.responseNumbers?.length || 0), 0);

          const reason = avgOutlierToMajoritySim < 0.75
            ? `${outliers.length} position(s) semantically opposed to majority (sim=${avgOutlierToMajoritySim.toFixed(2)})`
            : `${outliers.length} positions semantically different (coherence: ${outlierCoherence.toFixed(2)})`;

          console.log(`[PositionConsolidator] ✓ Semantic opposition detected: ${reason}`);

          return {
            groups: [
              {
                label: 'majority',
                positions: majority.map(s => s.position),
                respondentCount: majorityRespondents
              },
              {
                label: 'minority',
                positions: outliers.map(s => s.position),
                respondentCount: outlierRespondents
              }
            ],
            hasOpposition: true,
            oppositionReason: reason
          };
        }
      }

      // No meaningful opposition - return single group
      return {
        groups: [{
          label: 'unified',
          positions,
          respondentCount: positions.reduce((sum, p) => sum + (p.responseNumbers?.length || 0), 0)
        }],
        hasOpposition: false,
        oppositionReason: outliers.length > 0 ? 'outliers_similar_to_majority' : 'no_outliers'
      };

    } catch (error) {
      console.error('[PositionConsolidator] Semantic grouping failed:', error.message);
      return {
        groups: [{ label: 'unified', positions, respondentCount: positions.reduce((sum, p) => sum + (p.responseNumbers?.length || 0), 0) }],
        hasOpposition: false,
        oppositionReason: 'error: ' + error.message
      };
    }
  }

  /**
   * Filter positions into "core" (about the object itself) vs "peripheral" (mentions object but about something else)
   * 
   * Core positions: "Bevar Palads", "Riv bygningen ned" - directly about the object
   * Peripheral positions: "Kræv miljøanalyse for projektet", "§14-godkendelse" - about process/procedure
   * 
   * @param {Array} positions - Candidate positions for mega-merge
   * @param {string} objectName - The dominant object (e.g., "palads")
   * @returns {Promise<Object>} { corePositions: [], peripheralPositions: [] }
   */
  async filterCorePositions(positions, objectName) {
    if (positions.length === 0) {
      return { corePositions: [], peripheralPositions: [] };
    }

    try {
      // Heuristic: some positions are clearly preservation-variants even if they look "procedural"
      // (e.g., planproces/§14/fredning) and can be incorrectly classified as peripheral by pure embeddings.
      // This MUST remain generic (not case-specific), but should help absorb near-duplicates into the mega-position.
      const isPreservationVariant = (position) => {
        const text = [
          position?.title,
          position?.summary,
          ...(position?._mergedFrom || []),
          ...(position?.sourceArgumentRefs?.map(r => r?.what) || []),
          ...(position?.sourceArgumentRefs?.map(r => r?.why) || [])
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        
        // Core signals of "preserve/don't demolish/restore the object".
        // Intentionally NOT including broad terms like "inddragelse" or "kulturarv" alone,
        // as those can appear in unrelated topics (e.g., a swimming pool near the object).
        const preservationSignals = [
          'bevarelse', 'bevaring', 'bevaringsværdig',
          'nedriv', 'rive ned', 'nedrivning',
          'renover', 'restaurer', 'genanvend', 'istandsæt',
          'fred' // fredning/fredet
        ];
        if (preservationSignals.some(k => text.includes(k))) return true;

        // Weak indicator: "bevar" only counts if it's very close to the object mention
        const obj = String(objectName || '').toLowerCase();
        if (!obj) return false;
        const closeBevarPatterns = [
          // "bevar palads", "bevar hele palads", "bevar paladsbygningen"
          new RegExp(`\\bbevar\\w{0,6}\\s+(?:\\w+\\s+){0,2}${obj}\\w*\\b`, 'i'),
          // "palads skal bevares", "palads bør bevares"
          new RegExp(`\\b${obj}\\w*\\s+(?:\\w+\\s+){0,3}bevar\\w{0,6}\\b`, 'i')
        ];
        return closeBevarPatterns.some(r => r.test(text));
      };

      // Create anchor texts that represent "core" positions about the object
      // These anchors define what "primarily about the object" means semantically
      // IMPORTANT: Include MANY variations to catch different phrasings of the same sentiment
      const normalizedObject = objectName.charAt(0).toUpperCase() + objectName.slice(1);
      const anchorTexts = [
        // Direct preservation statements
        `Bevaring af ${normalizedObject}`,
        `${normalizedObject} bør bevares som kulturarv`,
        `Modstand mod nedrivning af ${normalizedObject}`,
        `Ønske om at bevare ${normalizedObject}`,
        `${normalizedObject} skal ikke rives ned`,
        `Bevar ${normalizedObject} i sin nuværende form`,
        // Indirect preservation statements (consequences of NOT preserving)
        `Manglende bevarelse af ${normalizedObject} svækker kulturarv`,
        `Tab af ${normalizedObject} truer byens identitet`,
        `Uden bevarelse mistes kulturel værdi`,
        `Bevaringsværdig bygning skal beskyttes`,
        // Renovation/restoration vs demolition
        `Renovering af ${normalizedObject} frem for nedrivning`,
        `${normalizedObject} skal bevares og restaureres`,
        `Støtte til bevarelse af ikonisk bygning`,
        // Cultural heritage framing
        `${normalizedObject} som kulturarv og vartegn`,
        `Bevaringsværdig historisk bygning`,
        `Kulturhistorisk værdi skal fastholdes`
      ];

      // Embed anchor texts
      const anchorEmbeddings = await this.embedder.embedBatch(anchorTexts);
      if (!anchorEmbeddings || anchorEmbeddings.length === 0) {
        console.warn('[PositionConsolidator] Anchor embedding failed, keeping all positions');
        return { corePositions: positions, peripheralPositions: [] };
      }

      // Calculate anchor centroid (average of all anchor embeddings)
      const dim = anchorEmbeddings[0].length;
      const anchorCentroid = new Array(dim).fill(0);
      for (const emb of anchorEmbeddings) {
        for (let i = 0; i < dim; i++) {
          anchorCentroid[i] += emb[i] / anchorEmbeddings.length;
        }
      }

      // Embed all candidate positions
      const positionTexts = positions.map(p => {
        const parts = [p.title, p.summary?.slice(0, 200)].filter(Boolean);
        return parts.join(' - ');
      });
      const positionEmbeddings = await this.embedder.embedBatch(positionTexts);

      if (!positionEmbeddings || positionEmbeddings.length !== positions.length) {
        console.warn('[PositionConsolidator] Position embedding failed, keeping all positions');
        return { corePositions: positions, peripheralPositions: [] };
      }

      // Classify each position based on similarity to anchor centroid
      // Lower threshold = more inclusive (fewer peripheral positions)
      // 0.55 catches most preservation-related positions while filtering out clearly unrelated topics
      const CORE_THRESHOLD = 0.55; // Positions must be this similar to anchor to be "core"
      const corePositions = [];
      const peripheralPositions = [];

      console.log(`[PositionConsolidator] Core position filtering (threshold: ${CORE_THRESHOLD}):`);

      for (let i = 0; i < positions.length; i++) {
        const similarity = this.cosineSimilarity(positionEmbeddings[i], anchorCentroid);
        const position = positions[i];
        const titlePreview = position.title?.slice(0, 50) || 'untitled';

        // Primary rule: semantic similarity to preservation anchors
        if (similarity >= CORE_THRESHOLD) {
          corePositions.push(position);
          // Only log a sample to avoid spam
          if (corePositions.length <= 5 || corePositions.length === positions.length) {
            console.log(`[PositionConsolidator]   ✓ CORE (${similarity.toFixed(3)}): "${titlePreview}..."`);
          }
        // Secondary rule: preservation-variant heuristic (procedural/heritage variants)
        // Guard: avoid pulling in unrelated topics by requiring at least some semantic closeness.
        } else if (isPreservationVariant(position)) {
          corePositions.push(position);
          console.log(`[PositionConsolidator]   ✓ CORE (heuristic, sim=${similarity.toFixed(3)}): "${titlePreview}..."`);
        } else {
          peripheralPositions.push(position);
          console.log(`[PositionConsolidator]   ○ PERIPHERAL (${similarity.toFixed(3)}): "${titlePreview}..."`);
        }
      }

      // Log summary
      if (corePositions.length > 5) {
        console.log(`[PositionConsolidator]   ... and ${corePositions.length - 5} more core positions`);
      }

      console.log(`[PositionConsolidator] Core filter result: ${corePositions.length} core, ${peripheralPositions.length} peripheral`);

      return { corePositions, peripheralPositions };

    } catch (error) {
      console.error('[PositionConsolidator] Core position filtering failed:', error.message);
      // Fallback: treat all as core (original behavior)
      return { corePositions: positions, peripheralPositions: [] };
    }
  }

  /**
   * Calculate cosine similarity between two vectors
   * @private
   */
  cosineSimilarity(vec1, vec2) {
    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;
    
    for (let i = 0; i < vec1.length; i++) {
      dotProduct += vec1[i] * vec2[i];
      norm1 += vec1[i] * vec1[i];
      norm2 += vec2[i] * vec2[i];
    }
    
    const magnitude = Math.sqrt(norm1) * Math.sqrt(norm2);
    return magnitude > 0 ? dotProduct / magnitude : 0;
  }

  /**
   * Detect sentiment/direction of a position (for/imod/neutral)
   * Analyzes title and merged titles for sentiment indicators
   * 
   * @param {Object} position - Position to analyze
   * @returns {Object} { sentiment: 'positive'|'negative'|'neutral', confidence: 0-1, indicators: [] }
   */
  detectPositionSentiment(position) {
    // Sentiment indicators - Danish terms that indicate position direction
    const positiveIndicators = [
      'ønske om', 'støtte til', 'opbakning til', 'forslag om', 'anbefaling af',
      'behov for', 'vigtigheden af', 'bevaring af', 'bevarelse af', 'ros af',
      'tilfredshed med', 'glæde over', 'håb om', 'positiv til'
    ];
    
    const negativeIndicators = [
      'modstand mod', 'bekymring for', 'kritik af', 'afvisning af', 'indsigelse mod',
      'protest mod', 'utilfredshed med', 'frygt for', 'skepsis over', 'negativ til',
      'problemer med', 'mangel på', 'manglende', 'nedrivning', 'fjernelse af'
    ];

    // Build search text from title and merged titles
    const searchTexts = [
      position.title,
      ...(position._mergedFrom || []),
      ...(position._originalTitles || [])
    ].filter(Boolean).map(t => t.toLowerCase());

    const foundPositive = [];
    const foundNegative = [];

    for (const text of searchTexts) {
      for (const indicator of positiveIndicators) {
        if (text.includes(indicator)) {
          foundPositive.push(indicator);
        }
      }
      for (const indicator of negativeIndicators) {
        if (text.includes(indicator)) {
          foundNegative.push(indicator);
        }
      }
    }

    // Determine sentiment based on indicator counts
    const positiveScore = foundPositive.length;
    const negativeScore = foundNegative.length;
    const totalScore = positiveScore + negativeScore;

    if (totalScore === 0) {
      return { sentiment: 'neutral', confidence: 0.3, indicators: [], reason: 'no_indicators' };
    }

    if (positiveScore > negativeScore * 2) {
      return { 
        sentiment: 'positive', 
        confidence: Math.min(0.9, 0.5 + positiveScore * 0.1),
        indicators: [...new Set(foundPositive)],
        reason: 'strong_positive'
      };
    }

    if (negativeScore > positiveScore * 2) {
      return { 
        sentiment: 'negative', 
        confidence: Math.min(0.9, 0.5 + negativeScore * 0.1),
        indicators: [...new Set(foundNegative)],
        reason: 'strong_negative'
      };
    }

    // Mixed signals - could be either
    if (positiveScore > negativeScore) {
      return { 
        sentiment: 'positive', 
        confidence: 0.5,
        indicators: [...new Set(foundPositive)],
        reason: 'mixed_leaning_positive'
      };
    } else if (negativeScore > positiveScore) {
      return { 
        sentiment: 'negative', 
        confidence: 0.5,
        indicators: [...new Set(foundNegative)],
        reason: 'mixed_leaning_negative'
      };
    }

    return { sentiment: 'neutral', confidence: 0.4, indicators: [], reason: 'balanced_mixed' };
  }

  /**
   * Group positions by their sentiment direction
   * Used before mega-merge to ensure we don't merge opposing positions
   * 
   * @param {Array} positions - Positions to group
   * @returns {Object} { positive: [], negative: [], neutral: [], analysis: {} }
   */
  groupPositionsBySentiment(positions) {
    const groups = {
      positive: [],
      negative: [],
      neutral: []
    };

    const analysis = {
      totalPositions: positions.length,
      sentimentCounts: { positive: 0, negative: 0, neutral: 0 },
      dominantSentiment: null,
      hasOpposingGroups: false
    };

    for (const position of positions) {
      const sentiment = this.detectPositionSentiment(position);
      position._detectedSentiment = sentiment; // Store for later use
      
      groups[sentiment.sentiment].push(position);
      analysis.sentimentCounts[sentiment.sentiment]++;
    }

    // Determine dominant sentiment
    const counts = analysis.sentimentCounts;
    if (counts.positive > counts.negative && counts.positive > counts.neutral) {
      analysis.dominantSentiment = 'positive';
    } else if (counts.negative > counts.positive && counts.negative > counts.neutral) {
      analysis.dominantSentiment = 'negative';
    } else {
      analysis.dominantSentiment = 'neutral';
    }

    // Check if there are significant opposing groups
    // Opposing = both positive and negative have meaningful presence
    const totalNonNeutral = counts.positive + counts.negative;
    if (totalNonNeutral > 0) {
      const minorityCount = Math.min(counts.positive, counts.negative);
      const minorityRatio = minorityCount / totalNonNeutral;
      // If minority is more than 10% of non-neutral, we have opposing groups
      analysis.hasOpposingGroups = minorityRatio > 0.1 && minorityCount >= 1;
    }

    return { ...groups, analysis };
  }

  /**
   * Generate a meaningful position title based on dominant sentiment and object
   * Replaces generic "Samlet holdning til X" with actual position direction
   * 
   * @param {string} objectName - The dominant object (e.g., "Palads")
   * @param {Object} sentimentAnalysis - Result from groupPositionsBySentiment
   * @param {Array} positions - The positions being merged
   * @returns {string} Meaningful title like "Ønske om bevaring af Palads"
   */
  generateHoldningsTitel(objectName, sentimentAnalysis, positions) {
    const capitalizedObject = objectName.charAt(0).toUpperCase() + objectName.slice(1);
    
    // Extract common action words from position titles
    const allTitles = positions.flatMap(p => [
      p.title,
      ...(p._mergedFrom || []),
      ...(p._originalTitles || [])
    ]).filter(Boolean).map(t => t.toLowerCase());

    // Look for common patterns in titles
    const actionPatterns = {
      bevaring: ['bevaring', 'bevarelse', 'bevar', 'bevare', 'bevares'],
      nedrivning: ['nedrivning', 'nedrive', 'rive ned', 'fjerne', 'fjernelse'],
      ændring: ['ændring', 'ændre', 'ombygning', 'ombygge', 'renovering'],
      støtte: ['støtte', 'opbakning', 'tilslutning'],
      modstand: ['modstand', 'protest', 'indsigelse', 'afvisning']
    };

    let dominantAction = null;
    let maxCount = 0;
    
    for (const [action, patterns] of Object.entries(actionPatterns)) {
      let count = 0;
      for (const title of allTitles) {
        for (const pattern of patterns) {
          if (title.includes(pattern)) {
            count++;
            break;
          }
        }
      }
      if (count > maxCount) {
        maxCount = count;
        dominantAction = action;
      }
    }

    // Generate title based on sentiment and action
    const sentiment = sentimentAnalysis.dominantSentiment;
    
    if (dominantAction === 'bevaring' && sentiment !== 'negative') {
      return `Ønske om bevaring af ${capitalizedObject}`;
    }
    
    if (dominantAction === 'nedrivning') {
      if (sentiment === 'negative') {
        return `Modstand mod nedrivning af ${capitalizedObject}`;
      } else {
        return `Ønske om nedrivning af ${capitalizedObject}`;
      }
    }
    
    if (dominantAction === 'ændring') {
      if (sentiment === 'negative') {
        return `Bekymring for ændringer af ${capitalizedObject}`;
      } else {
        return `Ønske om ændringer af ${capitalizedObject}`;
      }
    }

    if (dominantAction === 'modstand' || sentiment === 'negative') {
      return `Bekymring vedrørende ${capitalizedObject}`;
    }

    if (dominantAction === 'støtte' || sentiment === 'positive') {
      return `Støtte til ${capitalizedObject}`;
    }

    // Fallback: Try to extract action from most common title prefix
    const titlePrefixes = allTitles
      .map(t => t.split(' ').slice(0, 3).join(' '))
      .filter(p => p.length > 5);
    
    if (titlePrefixes.length > 0) {
      // Find most common prefix
      const prefixCounts = {};
      for (const prefix of titlePrefixes) {
        prefixCounts[prefix] = (prefixCounts[prefix] || 0) + 1;
      }
      const mostCommon = Object.entries(prefixCounts)
        .sort((a, b) => b[1] - a[1])[0];
      
      if (mostCommon && mostCommon[1] >= 2) {
        // Use the most common prefix pattern
        const pattern = mostCommon[0];
        if (pattern.includes('ønske') || pattern.includes('støtte') || pattern.includes('bevaring')) {
          return `Ønske om bevaring af ${capitalizedObject}`;
        }
        if (pattern.includes('modstand') || pattern.includes('bekymring')) {
          return `Bekymring vedrørende ${capitalizedObject}`;
        }
      }
    }

    // Ultimate fallback - but still better than "Samlet holdning"
    if (sentiment === 'positive') {
      return `Ønske vedrørende ${capitalizedObject}`;
    } else if (sentiment === 'negative') {
      return `Bekymring vedrørende ${capitalizedObject}`;
    }

    // If we reach here, sentiment is unclear/neutral - this should NOT happen
    // because positions without clear stance shouldn't be merged.
    // Return null to signal that this merge should be blocked.
    console.warn(`[PositionConsolidator] ⚠️ Cannot determine stance for "${capitalizedObject}" - merge should be blocked`);
    return null;
  }

  /**
   * Validate that a mega-position title follows format rules.
   * Rules are aligned with aggregation-prompt.md constraints.
   *
   * @param {string} title - The title to validate
   * @returns {{valid: boolean, reason?: string}} Validation result
   */
  validateMegaTitleFormat(title) {
    // Check for colon (forbidden in titles)
    if (title.includes(':')) {
      return { valid: false, reason: 'colon' };
    }

    // Check for list pattern (multiple commas suggest collapsed arguments)
    const commaCount = (title.match(/,/g) || []).length;
    if (commaCount > 1) {
      return { valid: false, reason: 'comma_list' };
    }

    // Check for required holdningsmarkør at start
    const markers = ['Støtte til', 'Modstand mod', 'Ønske om', 'Bekymring for', 'Forslag om', 'Opfordring til'];
    const hasMarker = markers.some(m => title.startsWith(m));
    if (!hasMarker) {
      return { valid: false, reason: 'missing_marker' };
    }

    return { valid: true };
  }

  /**
   * Generate a descriptive title for mega-position using LLM.
   * Uses the existing this.client (already configured with 'light' complexity).
   * Falls back to generateDirectionalMegaTitle if LLM fails.
   *
   * @param {string} objectName - Dominant object name
   * @param {string} direction - 'pro_change', 'pro_status_quo', or 'neutral'
   * @param {Array} positions - Positions being merged
   * @returns {Promise<string>} Descriptive title for the mega-position
   */
  async generateContentBasedMegaTitle(objectName, direction, positions) {
    if (!this.client) {
      return this.generateDirectionalMegaTitle(objectName, direction, positions);
    }

    // Sort positions by respondent count (descending) to prioritize dominant themes
    const sortedPositions = [...positions].sort((a, b) => {
      const countA = a.responseNumbers?.length || 0;
      const countB = b.responseNumbers?.length || 0;
      return countB - countA;
    });

    // Group arguments by position with respondent counts
    const groupedArgs = sortedPositions.map(p => {
      const respCount = p.responseNumbers?.length || 0;
      const args = (p.sourceArgumentRefs || p.args || []).slice(0, 3);
      return {
        title: p.title,
        respCount,
        args: args.map(a => a.what)
      };
    }).filter(g => g.args.length > 0);

    if (groupedArgs.length === 0) {
      return this.generateDirectionalMegaTitle(objectName, direction, positions);
    }

    // Find dominant theme (most respondents)
    const totalRespondents = sortedPositions.reduce((sum, p) => sum + (p.responseNumbers?.length || 0), 0);
    const dominantPosition = sortedPositions[0];
    const dominantCount = dominantPosition?.responseNumbers?.length || 0;
    const dominantPercent = totalRespondents > 0 ? Math.round((dominantCount / totalRespondents) * 100) : 0;

    // Format arguments with respondent weights
    const argsWithWeights = groupedArgs.map(g => {
      const header = `[${g.respCount} respondent${g.respCount !== 1 ? 'er' : ''}] ${g.title}:`;
      const argList = g.args.map(a => `  - ${a}`).join('\n');
      return `${header}\n${argList}`;
    }).join('\n\n');

    const dirLabel = direction === 'pro_change' ? 'STØTTE' :
                     direction === 'pro_status_quo' ? 'MODSTAND' : 'BETINGELSER';

    const prompt = `Generer en kort, beskrivende titel (maks 10 ord) for denne holdningsposition.

RETNING: ${dirLabel}
OBJEKT: ${objectName}

ARGUMENTER (sorteret efter antal respondenter - flest først):
${argsWithWeights}

VIGTIGT: Det DOMINANTE tema har ${dominantCount}/${totalRespondents} respondenter (${dominantPercent}%).
Titlen SKAL afspejle det dominante tema, IKKE minoritets-temaer.

REGLER:
- Titlen SKAL starte med: "Støtte til", "Modstand mod", "Ønske om", "Bekymring for", "Forslag om" eller "Opfordring til"
- Beskiv HVAD der støttes/modsættes specifikt (ikke bare "projektet")
- Titlen skal beskrive ÉN overordnet holdning, ikke flere
- Titlen SKAL afspejle det tema som flest respondenter deler

FORBUDT:
- INGEN kolon (:) i titlen
- INGEN komma-separerede lister
- INGEN "og" medmindre det er ét samlet objekt (fx "Palads og foyeren")
- UNDGÅ: "Holdninger til X", "Støtte til projektet"

GODE eksempler:
- "Støtte til 34 meter høj hotelbygning"
- "Modstand mod nedrivning af Paladsbygningen"
- "Ønske om bevaring af historisk facade"

DÅRLIGE eksempler (generer IKKE titler som disse):
- "Støtte: hotelbygning, filmmuseum" (kolon + liste)
- "Modstand mod nedrivning og bekymring for trafik" (to holdninger)
- "Bevaring af Palads" (mangler holdningsmarkør)

Returnér KUN titlen:`;

    try {
      const response = await this.client.createCompletion({
        messages: [
          {
            role: 'system',
            content: 'Du genererer korte, beskrivende titler for holdningspositioner i høringssvar.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 50
      });

      const title = response.choices?.[0]?.message?.content?.trim();
      if (title && title.length > 5 && title.length < 80 && !title.includes('\n')) {
        // Validate title format
        const formatCheck = this.validateMegaTitleFormat(title);
        if (formatCheck.valid) {
          console.log(`[PositionConsolidator] Generated content-based title: "${title}"`);
          return title;
        } else {
          console.warn(`[PositionConsolidator] Title format invalid (${formatCheck.reason}): "${title}" - using fallback`);
        }
      }
    } catch (error) {
      console.warn(`[PositionConsolidator] Title generation failed: ${error.message}`);
    }

    return this.generateDirectionalMegaTitle(objectName, direction, positions);
  }

  /**
   * DIRECTION-FIRST: Generate mega-position title based on direction.
   * This is simpler and more reliable than sentiment analysis - direction is already classified.
   *
   * @param {string} objectName - Dominant object name
   * @param {string} direction - 'pro_change', 'pro_status_quo', or 'neutral'
   * @param {Array} positions - Positions being merged
   * @returns {string} Title for the mega-position
   */
  generateDirectionalMegaTitle(objectName, direction, positions) {
    const capitalizedObject = objectName.charAt(0).toUpperCase() + objectName.slice(1);

    // Map direction to appropriate title
    if (direction === 'pro_change') {
      return `Støtte til projektet vedrørende ${capitalizedObject}`;
    }

    if (direction === 'pro_status_quo') {
      // Check if positions mention bevaring/preservation
      const allTitles = positions.flatMap(p => [p.title, ...(p._mergedFrom || [])]).filter(Boolean).map(t => t.toLowerCase());
      const hasPreservation = allTitles.some(t => /bevar|bevaring|bevarelse|fredning/.test(t));

      if (hasPreservation) {
        return `Ønske om bevaring af ${capitalizedObject}`;
      }
      return `Modstand mod projektet vedrørende ${capitalizedObject}`;
    }

    if (direction === 'neutral') {
      return `Betingelser og proceskrav vedrørende ${capitalizedObject}`;
    }

    // Unknown direction - this should RARELY happen
    // If we reach here, direction classification failed upstream
    console.warn(`[PositionConsolidator] ⚠️ FALLBACK TITLE: Unknown direction for "${capitalizedObject}" - this indicates missing direction classification`);
    return null; // Return null to signal this should go to "Andre emner" as ungrouped
  }

  /**
   * Generate a synthesized summary for mega-positions by combining original summaries.
   * Instead of inheriting the longest summary (which gives "En borger X. En borger Y." format),
   * this uses LLM to create a coherent synthesis of all merged position summaries.
   *
   * @param {Object} megaPosition - The mega-position with _originalSummaries
   * @returns {Promise<string>} Synthesized summary
   */
  async generateMegaPositionSummary(megaPosition) {
    if (!this.client) {
      console.warn('[PositionConsolidator] No LLM client - keeping original summary');
      return megaPosition.summary;
    }

    const originalSummaries = megaPosition._originalSummaries || [];
    const mergeCount = megaPosition._mergeCount || originalSummaries.length;
    const respondentCount = megaPosition.responseNumbers?.length || 0;
    const direction = megaPosition._direction || 'unknown';
    const title = megaPosition.title;

    // Skip if not enough summaries to synthesize
    if (originalSummaries.length < 2) {
      return megaPosition.summary;
    }

    // Format original summaries for the prompt
    const summariesText = originalSummaries
      .filter(s => s.summary && s.summary.trim())
      .map((s, i) => `[Position ${i + 1}: "${s.title}"]\n${s.summary}`)
      .join('\n\n---\n\n');

    if (!summariesText.trim()) {
      return megaPosition.summary;
    }

    const dirLabel = direction === 'pro_change' ? 'støtte til ændringen' :
                     direction === 'pro_status_quo' ? 'modstand mod/ønske om bevarelse' : 'betingelser/neutralt';

    const prompt = `Du skal syntetisere ${mergeCount} positionssammenfatninger til én sammenhængende opsummering.

MEGA-POSITION:
- Titel: ${title}
- Retning: ${dirLabel}
- Antal respondenter: ${respondentCount}
- Antal sammenlagte positioner: ${mergeCount}

ORIGINALE SAMMENFATNINGER:
${summariesText}

OPGAVE:
Skriv EN sammenhængende opsummering (150-300 ord) der:
1. Beskriver den OVERORDNEDE holdning som alle deler
2. Nævner de VIGTIGSTE nuancer/begrundelser fra de forskellige positioner
3. Er skrevet i 3. person ("Respondenterne mener..." eller "Der ønskes...")
4. IKKE er en liste ("En borger siger X. En anden siger Y.") men en syntese
5. Fanger bredden af argumenter uden at gentage samme pointe

FORMAT:
- Start med den overordnede holdning (1-2 sætninger)
- Uddyb med vigtige nuancer/begrundelser (2-3 sætninger)
- Afslut med eventuelle fælles konklusioner (1 sætning)

UNDGÅ:
- "En borger/respondent siger..." format
- Gentagelser af samme pointe
- At liste individuelle respondenter
- For mange detaljer - dette er en OVERORDNET sammenfatning

Returnér KUN sammenfatningen:`;

    try {
      const response = await this.client.createCompletion({
        messages: [
          {
            role: 'system',
            content: 'Du syntetiserer positionssammenfatninger til sammenhængende opsummeringer på dansk. Skriv professionelt og neutralt.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 500,
        temperature: 0.3 // Lower temp for more consistent, focused output
      });

      const summary = response.choices?.[0]?.message?.content?.trim();

      if (summary && summary.length > 50 && summary.length < 2000) {
        console.log(`[PositionConsolidator] ✓ Generated synthesized summary for mega-position "${title}" (${summary.length} chars from ${mergeCount} positions)`);
        return summary;
      } else {
        console.warn(`[PositionConsolidator] Summary generation returned invalid length (${summary?.length || 0}) - keeping original`);
      }
    } catch (error) {
      console.warn(`[PositionConsolidator] Summary synthesis failed: ${error.message} - keeping original`);
    }

    return megaPosition.summary;
  }

  /**
   * DIRECTION-FIRST: Apply mega-merge results with direction partitions.
   * Modifies themes to include direction-partitioned mega-positions.
   *
   * @param {Array} themes - Original themes
   * @param {Array} megaPositionsCreated - Array of {megaPosition, direction, locations}
   * @param {Set} positionsToRemove - Position keys to remove (themeIdx-posIdx)
   * @param {Array} peripheralPositions - Positions to keep separate
   * @param {string} objectName - Dominant object name
   * @param {Object} objectConcentration - Concentration metrics
   * @returns {Array} Modified themes
   */
  applyDirectionBasedMegaMerge(themes, megaPositionsCreated, positionsToRemove, peripheralPositions, objectName, objectConcentration) {
    // Determine best theme for mega-positions
    const allLocations = megaPositionsCreated.flatMap(m => m.locations);
    const themePositionCounts = new Map();

    for (const loc of allLocations) {
      if (loc?.themeName) {
        themePositionCounts.set(loc.themeName, (themePositionCounts.get(loc.themeName) || 0) + 1);
      }
    }

    // Find the theme with most positions (preferring specific themes over "Andre emner")
    let bestTheme = 'Andre emner';
    let maxCount = 0;

    for (const [themeName, count] of themePositionCounts) {
      const isSpecific = themeName !== 'Andre emner' && themeName !== 'Formål';
      if (count > maxCount || (count === maxCount && isSpecific)) {
        maxCount = count;
        bestTheme = themeName;
      }
    }

    // Remove merged positions from their original themes
    const newThemes = themes.map((theme, themeIdx) => {
      const newPositions = theme.positions.filter((pos, posIdx) => {
        return !positionsToRemove.has(`${themeIdx}-${posIdx}`);
      });

      return { ...theme, positions: newPositions };
    });

    // Add mega-positions to best theme
    const targetTheme = newThemes.find(t => t.name === bestTheme);
    if (targetTheme) {
      for (const { megaPosition, direction } of megaPositionsCreated) {
        // Calculate unique respondents
        const uniqueRespondents = new Set(megaPosition.responseNumbers || []);
        console.log(`[PositionConsolidator] Adding ${direction} mega-position to "${bestTheme}": "${megaPosition.title}" (${uniqueRespondents.size} respondents)`);
        targetTheme.positions.unshift(megaPosition); // Add at beginning for visibility
      }
    }

    // Log summary
    const totalMerged = positionsToRemove.size;
    const totalCreated = megaPositionsCreated.length;
    console.log(`[PositionConsolidator] Direction-first mega-merge complete: ${totalMerged} positions → ${totalCreated} mega-position(s)`);

    return newThemes;
  }

  /**
   * Set Job ID for LLM tracing
   * @param {string} jobId - The job ID to set on the LLM client
   */
  setJobId(jobId) {
    if (this.client?.setJobId) {
      this.client.setJobId(jobId);
    }
  }
}
