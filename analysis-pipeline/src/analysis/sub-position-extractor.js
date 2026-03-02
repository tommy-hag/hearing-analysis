/**
 * SubPositionExtractor
 *
 * Extracts sub-positions from mega-positions that were heavily consolidated.
 * Preserves nuance by identifying distinct sub-arguments within a consolidated position.
 *
 * For large positions (>40 respondents), uses stratified sampling to select a diverse
 * subset of micro-summaries for LLM extraction, then attributes remaining respondents
 * via centroid embedding similarity.
 */

import { OpenAIClientWrapper, getComplexityConfig } from '../utils/openai-client.js';
import { getResponseFormat } from '../utils/json-schemas.js';
import { DynamicParameterCalculator } from '../utils/dynamic-parameter-calculator.js';
import { EmbeddingService } from '../embedding/embedding-service.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class SubPositionExtractor {
  constructor(options = {}) {
    // Use MEDIUM complexity for sub-position extraction (structured analysis)
    const complexityConfig = getComplexityConfig(options.complexityLevel || 'medium');
    this.client = new OpenAIClientWrapper({
      model: options.model || complexityConfig.model,
      verbosity: options.verbosity || complexityConfig.verbosity,
      reasoningEffort: options.reasoningEffort || complexityConfig.reasoningEffort,
      timeout: options.timeout || 60000 // 60 seconds timeout - prevent hanging
    });
    
    // Create light client for simple extractions
    const lightConfig = getComplexityConfig('light');
    this.lightClient = new OpenAIClientWrapper({
      model: lightConfig.model,
      verbosity: lightConfig.verbosity,
      reasoningEffort: lightConfig.reasoningEffort,
      timeout: 60000 // 60 seconds for light client
    });
    
    // Embedding service for centroid attribution
    this.embedder = new EmbeddingService(options);

    // Citation registry for enriching representative arguments with original quotes
    this.citationRegistry = options.citationRegistry || null;

    // Log actual models being used
    console.log(`[SubPositionExtractor] Initialized with MEDIUM=${this.client.model}, LIGHT=${this.lightClient.model}`);
    
    // Load prompt template
    const promptPath = join(__dirname, '../../prompts/sub-position-extraction-prompt.md');
    this.promptTemplate = readFileSync(promptPath, 'utf-8');
  }

  /**
   * Harmonize and deduplicate sub-positions to avoid near-duplicate nuance buckets.
   * 
   * Key goals:
   * - If two sub-positions are semantically the same, merge them so the output is cleaner.
   * - Prefer keeping the larger/more representative sub-position as the "canonical" one.
   * - Be "nænsom": preserve nuance via representativeArguments and merged metadata.
   * 
   * @param {Array} subPositions
   * @returns {Promise<Array>} deduplicated subPositions
   * @private
   */
  async harmonizeSubPositions(subPositions = [], positionContext = {}) {
    if (!subPositions || subPositions.length <= 1) return subPositions || [];

    // Sort by respondent count (largest first) so we keep the best canonical bucket
    const sorted = [...subPositions].sort((a, b) => (b.responseNumbers?.length || 0) - (a.responseNumbers?.length || 0));

    // Build embedding texts
    const texts = sorted.map(sp => this.buildSubPositionEmbeddingText(sp));
    let embeddings = [];
    try {
      embeddings = await this.embedder.embedBatch(texts);
    } catch (e) {
      console.warn(`[SubPositionExtractor] Sub-position dedup embedding failed: ${e.message}`);
      return subPositions;
    }

    if (!embeddings || embeddings.length !== sorted.length) {
      console.warn('[SubPositionExtractor] Sub-position dedup embedding mismatch, skipping harmonization');
      return subPositions;
    }

    // Dynamic base threshold based on position context (respondent count)
    // For mega-positions with 1500+ respondents, use 0.80
    // For smaller positions, use more conservative thresholds to preserve nuances
    const BASE_THRESHOLD = DynamicParameterCalculator.getSubPositionHarmonizationThreshold({
      respondentCount: positionContext.respondentCount || 0,
      subPositionCount: subPositions.length,
      isMegaPosition: positionContext.isMegaPosition || false
    });

    if (positionContext.respondentCount >= 100) {
      console.log(`[SubPositionExtractor] Dynamic harmonization threshold: ${BASE_THRESHOLD.toFixed(2)} (${positionContext.respondentCount} respondents)`);
    }
    const OPEN_SPACE_KEYWORDS = [
      // Generic urban/open-space terms (not case-specific)
      'ubebyggede', 'areal', 'arealer', 'friareal', 'friarealer', 'byrum',
      'træ', 'træer', 'grøn', 'grønne', 'park', 'plads', 'torv'
    ];

    const hasKeyword = (text, keywords) => {
      const t = (text || '').toLowerCase();
      return keywords.some(k => t.includes(k));
    };

    const merged = [];
    const consumed = new Set();

    for (let i = 0; i < sorted.length; i++) {
      if (consumed.has(i)) continue;

      const canonical = { ...sorted[i] };
      const canonicalText = texts[i];
      const canonicalEmb = embeddings[i];

      for (let j = i + 1; j < sorted.length; j++) {
        if (consumed.has(j)) continue;

        const sim = this.cosineSimilarity(canonicalEmb, embeddings[j]);
        const relaxed = (hasKeyword(canonicalText, OPEN_SPACE_KEYWORDS) && hasKeyword(texts[j], OPEN_SPACE_KEYWORDS))
          ? 0.84
          : BASE_THRESHOLD;

        if (sim >= relaxed) {
          // Merge j into canonical
          const incoming = sorted[j];
          canonical._mergedFromSubPositions = [
            ...(canonical._mergedFromSubPositions || []),
            incoming.title || '(untitled)'
          ];

          // Merge responseNumbers
          const mergedNums = new Set([...(canonical.responseNumbers || []), ...(incoming.responseNumbers || [])]);
          canonical.responseNumbers = [...mergedNums].sort((a, b) => a - b);

          // Merge representative arguments (preserve nuance)
          const repA = canonical.representativeArguments || [];
          const repB = incoming.representativeArguments || [];
          const seen = new Set(repA.map(r => r?.responseNumber).filter(Boolean));
          const combined = [...repA];
          for (const r of repB) {
            const num = r?.responseNumber;
            if (num == null || !seen.has(num)) {
              combined.push(r);
              if (num != null) seen.add(num);
            }
          }
          canonical.representativeArguments = combined;
          canonical._argumentDiversitySamples = combined.length;

          // Optional: keep trace for debugging/observability
          canonical._harmonized = true;
          canonical._harmonizedThreshold = relaxed;
          canonical._harmonizedPairs = [
            ...(canonical._harmonizedPairs || []),
            { mergedTitle: incoming.title, similarity: Number(sim.toFixed(3)) }
          ];

          consumed.add(j);
        }
      }

      merged.push(canonical);
    }

    // Keep stable order: largest first (after merges)
    merged.sort((a, b) => (b.responseNumbers?.length || 0) - (a.responseNumbers?.length || 0));

    const removed = sorted.length - merged.length;
    if (removed > 0) {
      console.log(`[SubPositionExtractor] Harmonized sub-positions: ${sorted.length} → ${merged.length} (merged ${removed})`);
    }

    return merged;
  }

  /**
   * CRITICAL: Validate sub-position integrity against master position.
   *
   * Sub-positions must SUPPORT the master position's direction.
   * Uses DYNAMIC detection based on the master position's own text - NOT hardcoded keywords.
   *
   * Returns: { validSubPositions, conflictingSubPositions, otherTopicSubPositions }
   *
   * @param {Array} subPositions - Sub-positions to validate
   * @param {Object} masterPosition - The parent position
   * @returns {Object} Validation result with categorized sub-positions
   */
  validateSubPositionIntegrity(subPositions, masterPosition) {
    if (!subPositions || subPositions.length === 0) {
      return {
        validSubPositions: [],
        conflictingSubPositions: [],
        otherTopicSubPositions: []
      };
    }

    const masterTitle = (masterPosition.title || '').toLowerCase();
    const masterSummary = (masterPosition.summary || '').toLowerCase();
    const masterText = `${masterTitle} ${masterSummary}`;

    // DYNAMIC: Detect master position's stance (for/against/neutral)
    const masterStance = this.detectStance(masterText);
    console.log(`[SubPositionExtractor] Master position "${masterPosition.title?.slice(0, 50)}..." detected stance: ${masterStance}`);

    // DYNAMIC: Extract significant nouns from master position to understand WHAT it's about
    const masterNouns = this.extractSignificantNouns(masterText);

    const validSubPositions = [];
    const conflictingSubPositions = [];
    const otherTopicSubPositions = [];

    for (const subPos of subPositions) {
      const subText = [
        subPos.title,
        subPos.what,
        subPos.why,
        subPos.summary
      ].filter(Boolean).join(' ').toLowerCase();

      // Detect sub-position stance
      const subStance = this.detectStance(subText);

      // Check for CONFLICT: master is FOR something, sub is AGAINST (or vice versa)
      const isConflict = this.stancesConflict(masterStance, subStance);

      if (isConflict) {
        console.log(`[SubPositionExtractor] ⚠️ CONFLICT detected: "${subPos.title?.slice(0, 40)}" (${subStance}) conflicts with master (${masterStance})`);
        conflictingSubPositions.push({
          ...subPos,
          _conflictReason: `Stance conflict: master=${masterStance}, sub=${subStance}`,
          _shouldBeSeparatePosition: true
        });
        continue;
      }

      // Valid sub-position - passes integrity check
      validSubPositions.push(subPos);
    }

    const invalidCount = conflictingSubPositions.length + otherTopicSubPositions.length;
    if (invalidCount > 0) {
      console.log(`[SubPositionExtractor] Sub-position integrity check: ${validSubPositions.length} valid, ${conflictingSubPositions.length} conflicts`);
    }

    return {
      validSubPositions,
      conflictingSubPositions,
      otherTopicSubPositions
    };
  }

  /**
   * DYNAMIC stance detection using general Danish sentiment patterns.
   * Does NOT use case-specific keywords - only general for/against patterns.
   * @returns {'for'|'against'|'neutral'}
   * @private
   */
  detectStance(text) {
    const normalized = text.toLowerCase();

    // General SUPPORT patterns (not case-specific)
    const forPatterns = [
      /\bstøtter?\b/,           // støtter, støtte
      /\bfor\s+(forslag|projekt|plan)/,
      /\bpositiv/,
      /\benig\b/,
      /\bgod(t)?\s+ide/,
      /\bvelkommen/,
      /\bglad\s+for/
    ];

    // General AGAINST patterns (not case-specific)
    const againstPatterns = [
      /\bimod\b/,               // imod
      /\bmod\s+(forslag|projekt|plan)/,
      /\bnej\s+til/,
      /\bprotester/,
      /\bbekymr/,               // bekymring, bekymret
      /\bkritisk/,
      /\bafvis/,
      /\buenig/
    ];

    let forScore = 0;
    let againstScore = 0;

    for (const pattern of forPatterns) {
      if (pattern.test(normalized)) forScore++;
    }
    for (const pattern of againstPatterns) {
      if (pattern.test(normalized)) againstScore++;
    }

    if (forScore > againstScore && forScore > 0) return 'for';
    if (againstScore > forScore && againstScore > 0) return 'against';
    return 'neutral';
  }

  /**
   * Check if two stances conflict (for vs against).
   * @private
   */
  stancesConflict(stance1, stance2) {
    // Only clear conflict: one is FOR and other is AGAINST
    return (stance1 === 'for' && stance2 === 'against') ||
           (stance1 === 'against' && stance2 === 'for');
  }

  /**
   * DYNAMIC: Extract significant nouns from text.
   * Used to understand what a position is ABOUT without hardcoded keywords.
   * @private
   */
  extractSignificantNouns(text) {
    // Simple noun extraction: words that are capitalized or appear multiple times
    // This is a heuristic - not perfect but doesn't hardcode case-specific terms
    const words = text.toLowerCase().split(/\s+/);
    const wordCounts = new Map();

    for (const word of words) {
      if (word.length > 4) { // Skip short words
        wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
      }
    }

    // Return words that appear multiple times (likely significant)
    return Array.from(wordCounts.entries())
      .filter(([_, count]) => count >= 2)
      .map(([word]) => word);
  }

  /**
   * Build embedding text for a sub-position.
   * @private
   */
  buildSubPositionEmbeddingText(subPos) {
    const parts = [
      subPos?.title,
      subPos?.what,
      subPos?.why,
      subPos?.how,
      subPos?.summary
    ].filter(Boolean);
    // Cap length to keep embedding stable/cost-effective
    return parts.join(' | ').slice(0, 1200);
  }

  /**
   * Build text for a micro-summary (for embedding)
   * @private
   */
  buildMicroSummaryText(ms) {
    const parts = [];
    if (ms.arguments && ms.arguments.length > 0) {
      ms.arguments.forEach(arg => {
        if (arg.what) parts.push(arg.what);
        if (arg.why) parts.push(arg.why);
        if (arg.how) parts.push(arg.how);
      });
    }
    if (parts.length === 0) {
      if (ms.coreContent) parts.push(ms.coreContent);
      if (ms.concern) parts.push(ms.concern);
    }
    return parts.join(' ') || 'ingen indhold';
  }

  /**
   * Sample diverse arguments from a sub-position using max-diversity selection.
   * This gives the LLM rich context about the variety of viewpoints within a sub-position.
   *
   * IMPROVED:
   * - Dynamic sampling based on 15% coverage target
   * - Includes original quotes from citation-registry for verbosity
   * - Respects dynamic verbosity guidelines
   * - Cross-position deduplication: prioritizes unused arguments
   *
   * @param {Object} subPosition - Sub-position with responseNumbers
   * @param {Array} microSummaries - All micro-summaries
   * @param {number} maxSamplesOverride - Optional override for max samples (defaults to dynamic 15% calculation)
   * @param {Set} usedArguments - Optional set of already-used argument keys (responseNumber:argKey) for cross-position dedup
   * @returns {Promise<Array>} Array of representative arguments with responseNumber and quote
   */
  async sampleDiverseArguments(subPosition, microSummaries, maxSamplesOverride = null, usedArguments = null) {
    const responseNumbers = subPosition.responseNumbers || [];
    
    if (responseNumbers.length === 0) {
      return [];
    }
    
    // SMART LOGARITHMIC SAMPLING (v2 - enhanced for mega-positions)
    // Diversity "saturates" - there are only so many unique viewpoints
    // Use logarithmic scaling to capture this:
    // - Small cases: high coverage (most/all)
    // - Medium cases: moderate coverage with logarithmic decay
    // - Mega-positions (1000+): extended sampling for better nuance capture
    //
    // Formula for n <= 1000: samples = BASE + MULTIPLIER * log2(n)
    // Formula for n > 1000:  samples = 40 + 20 * log2(n/1000)
    //
    // This gives roughly:
    //   n=10:    10 samples (100%)
    //   n=50:    ~20 samples (40%)
    //   n=100:   ~25 samples (25%)
    //   n=500:   ~32 samples (6%)
    //   n=1000:  40 samples (4%)
    //   n=2000:  60 samples (3%)
    //   n=5000:  86 samples (1.7%)
    //   n=10000: 100 samples (1%, MAX_SAMPLES_MEGA cap)
    
    const n = responseNumbers.length;
    let maxSamples;
    
    if (maxSamplesOverride !== null) {
      maxSamples = maxSamplesOverride;
    } else {
      const MIN_SAMPLES = 3;
      
      // For very small cases, just use all
      if (n <= 10) {
        maxSamples = n;
      } else if (n <= 1000) {
        // Standard logarithmic formula
        const BASE = 5;
        const MULTIPLIER = 3;
        const MAX_SAMPLES_STANDARD = 40;
        const logSamples = Math.ceil(BASE + MULTIPLIER * Math.log2(n));
        maxSamples = Math.min(MAX_SAMPLES_STANDARD, Math.max(MIN_SAMPLES, logSamples));
      } else {
        // Mega-position formula: extended sampling for 1000+ respondents
        const MAX_SAMPLES_MEGA = 100;
        const megaSamples = Math.ceil(40 + 20 * Math.log2(n / 1000));
        maxSamples = Math.min(MAX_SAMPLES_MEGA, megaSamples);
      }
    }
    
    // Collect all arguments from respondents in this sub-position
    const allArguments = [];
    for (const respNum of responseNumbers) {
      const summary = microSummaries.find(ms => ms.responseNumber === respNum);
      if (summary?.arguments) {
        for (const arg of summary.arguments) {
          if (arg.what || arg.why) {
            // Get original quote from citation-registry if available
            let originalQuote = null;
            if (this.citationRegistry && arg.sourceQuoteRef) {
              const citation = this.citationRegistry.citations?.get(arg.sourceQuoteRef);
              if (citation?.quote) {
                originalQuote = citation.quote;
              }
            }

            allArguments.push({
              responseNumber: respNum,
              what: arg.what || '',
              why: arg.why || '',
              how: arg.how || '',
              // Include original quote for verbosity - this is the REAL source
              quote: originalQuote || arg.sourceQuote || null,
              text: [arg.what, arg.why].filter(Boolean).join(' - '),
              // Track sourceQuoteRef for cross-position deduplication
              sourceQuoteRef: arg.sourceQuoteRef || null
            });
          }
        }
      }
    }

    // Cross-position deduplication: prioritize arguments not yet used in other sub-positions
    // This ensures the same argument (e.g., "livscyklusvurdering" from respondent 2257)
    // is only fully expanded in ONE sub-position, not repeated across multiple.
    let sortedArguments = allArguments;
    let unusedCount = allArguments.length;

    if (usedArguments && usedArguments.size > 0) {
      // Separate into unused and already-used arguments
      const unused = [];
      const alreadyUsed = [];

      for (const arg of allArguments) {
        const argKey = arg.sourceQuoteRef || arg.what || '';
        const key = `${arg.responseNumber}:${argKey}`;
        if (usedArguments.has(key)) {
          alreadyUsed.push(arg);
        } else {
          unused.push(arg);
        }
      }

      // Put unused first, then already-used (as fallback for coverage)
      sortedArguments = [...unused, ...alreadyUsed];
      unusedCount = unused.length;

      if (alreadyUsed.length > 0) {
        console.log(`[SubPositionExtractor] Cross-dedup: ${unused.length} unused, ${alreadyUsed.length} already-used in sub-position "${subPosition.title?.substring(0, 40) || 'unnamed'}..."`);
      }
    }

    // If few arguments, just return them all (with quotes) - prefer unused ones
    if (sortedArguments.length <= maxSamples) {
      return sortedArguments.map(({ responseNumber, what, why, how, quote, sourceQuoteRef }) => ({
        responseNumber, what, why, how, quote, sourceQuoteRef
      }));
    }
    
    try {
      // Embed all arguments (use sortedArguments which has unused first)
      const texts = sortedArguments.map(a => a.text);
      const embeddings = await this.embedder.embedBatch(texts);

      if (!embeddings || embeddings.length !== sortedArguments.length) {
        // Fallback: return first maxSamples from sorted list (unused first)
        return sortedArguments
          .slice(0, maxSamples)
          .map(({ responseNumber, what, why, how, quote, sourceQuoteRef }) => ({
            responseNumber, what, why, how, quote, sourceQuoteRef
          }));
      }

      // Max-diversity sampling with cross-position deduplication awareness
      // Strategy: prefer unused arguments, but still maintain diversity
      const selected = [];
      const selectedEmbeddings = [];
      const available = new Set(sortedArguments.map((_, i) => i));

      // Helper to check if an index is unused (in the first unusedCount elements)
      const isUnused = (idx) => idx < unusedCount;

      // OPTIMIZATION: Start with CENTROID from UNUSED arguments (if any)
      // This ensures we start with the most representative FRESH viewpoint
      const centroid = this.computeCentroid(embeddings);
      let centroidIdx = 0;
      let minDistToCentroid = Infinity;

      // First pass: find centroid among unused arguments
      for (let i = 0; i < unusedCount && i < embeddings.length; i++) {
        const dist = this.euclideanDistance(embeddings[i], centroid);
        if (dist < minDistToCentroid) {
          minDistToCentroid = dist;
          centroidIdx = i;
        }
      }

      // Fallback: if no unused args, find centroid among all
      if (unusedCount === 0) {
        for (let i = 0; i < embeddings.length; i++) {
          const dist = this.euclideanDistance(embeddings[i], centroid);
          if (dist < minDistToCentroid) {
            minDistToCentroid = dist;
            centroidIdx = i;
          }
        }
      }

      // Start with centroid (what most people say - preferably unused)
      selected.push(sortedArguments[centroidIdx]);
      selectedEmbeddings.push(embeddings[centroidIdx]);
      available.delete(centroidIdx);

      // Iteratively add the most diverse argument, preferring unused
      while (selected.length < maxSamples && available.size > 0) {
        let maxMinDist = -1;
        let bestIdx = -1;
        let bestIsUnused = false;

        for (const idx of available) {
          // Calculate minimum distance to all already-selected embeddings
          let minDist = Infinity;
          for (const selEmb of selectedEmbeddings) {
            const dist = 1 - this.cosineSimilarity(embeddings[idx], selEmb);
            if (dist < minDist) minDist = dist;
          }

          const currentIsUnused = isUnused(idx);

          // Selection criteria: prefer unused, then prefer higher diversity
          // Unused args get a significant boost in the selection
          const shouldSelect =
            (currentIsUnused && !bestIsUnused) ||  // Prefer unused over used
            (currentIsUnused === bestIsUnused && minDist > maxMinDist);  // Same status: prefer more diverse

          if (shouldSelect) {
            maxMinDist = minDist;
            bestIdx = idx;
            bestIsUnused = currentIsUnused;
          }
        }

        if (bestIdx >= 0) {
          selected.push(sortedArguments[bestIdx]);
          selectedEmbeddings.push(embeddings[bestIdx]);
          available.delete(bestIdx);
        } else {
          break;
        }
      }

      const coverage = (selected.length / responseNumbers.length * 100).toFixed(1);
      const unusedSelected = selected.filter((_, i) => {
        const origIdx = sortedArguments.indexOf(selected[i]);
        return origIdx < unusedCount;
      }).length;
      console.log(`[SubPositionExtractor] Diversity sampling: ${selected.length}/${responseNumbers.length} args (${coverage}% coverage, ${unusedSelected} fresh)`);

      return selected.map(({ responseNumber, what, why, how, quote, sourceQuoteRef }) => ({
        responseNumber, what, why, how, quote, sourceQuoteRef
      }));
      
    } catch (error) {
      console.warn(`[SubPositionExtractor] Diverse sampling failed: ${error.message}, using simple sampling`);
      // Fallback: return first maxSamples from sorted list (unused first due to sorting)
      return sortedArguments
        .slice(0, maxSamples)
        .map(({ responseNumber, what, why, how, quote, sourceQuoteRef }) => ({
          responseNumber, what, why, how, quote, sourceQuoteRef
        }));
    }
  }

  /**
   * Cosine similarity helper
   * @private
   */
  cosineSimilarity(vec1, vec2) {
    if (!vec1 || !vec2 || vec1.length !== vec2.length) return 0;
    
    let dot = 0, norm1 = 0, norm2 = 0;
    for (let i = 0; i < vec1.length; i++) {
      dot += vec1[i] * vec2[i];
      norm1 += vec1[i] * vec1[i];
      norm2 += vec2[i] * vec2[i];
    }
    
    const mag = Math.sqrt(norm1) * Math.sqrt(norm2);
    return mag > 0 ? dot / mag : 0;
  }

  /**
   * Enrich sub-positions with diverse representative arguments
   * Cross-sub-position deduplication: tracks (responseNumber, argumentKey) to avoid
   * the same argument appearing as representative in multiple sub-positions.
   * @param {Array} subPositions - Sub-positions to enrich
   * @param {Array} microSummaries - All micro-summaries
   * @returns {Promise<Array>} Enriched sub-positions with representativeArguments
   */
  async enrichWithDiverseArguments(subPositions, microSummaries) {
    const enriched = [];

    // Track (responseNumber:argumentKey) across all sub-positions to avoid duplicates
    // An argument should only be expanded/explained in ONE sub-position
    const usedArguments = new Set();

    for (const subPos of subPositions) {
      // Let sampleDiverseArguments calculate dynamic coverage, passing usedArguments for deduplication
      const diverseArgs = await this.sampleDiverseArguments(subPos, microSummaries, null, usedArguments);

      // Mark these arguments as used for subsequent sub-positions
      for (const arg of diverseArgs) {
        // Key: responseNumber + sourceQuoteRef (preferred) or what (fallback)
        const argKey = arg.sourceQuoteRef || arg.what || '';
        const key = `${arg.responseNumber}:${argKey}`;
        usedArguments.add(key);
      }

      enriched.push({
        ...subPos,
        representativeArguments: diverseArgs,
        _argumentDiversitySamples: diverseArgs.length
      });
    }

    if (usedArguments.size > 0) {
      console.log(`[SubPositionExtractor] Cross-position dedup: tracked ${usedArguments.size} unique representative arguments`);
    }

    return enriched;
  }

  /**
   * Compute centroid of vectors
   * @private
   */
  computeCentroid(vectors) {
    if (vectors.length === 0) return [];
    
    const dim = vectors[0].length;
    const centroid = new Array(dim).fill(0);

    for (const vec of vectors) {
      for (let i = 0; i < dim; i++) {
        centroid[i] += vec[i];
      }
    }

    for (let i = 0; i < dim; i++) {
      centroid[i] /= vectors.length;
    }

    return centroid;
  }

  /**
   * Euclidean distance between two vectors
   * @private
   */
  euclideanDistance(vec1, vec2) {
    let sum = 0;
    for (let i = 0; i < vec1.length; i++) {
      const diff = vec1[i] - vec2[i];
      sum += diff * diff;
    }
    return Math.sqrt(sum);
  }

  /**
   * Extract sub-positions from a mega-position
   * 
   * OPTIMIZATION: For large positions (>15 respondents), uses embedding-based pre-clustering
   * to reduce token usage. Instead of sending all micro-summaries, we send cluster representatives.
   * 
   * @param {Object} position - Consolidated position with many respondents
   * @param {Array} microSummaries - Original micro-summaries for detailed analysis
   * @param {Array} allResponses - All responses for lookup
   * @param {Object} context - Additional context (mass agreement, object concentration)
   * @returns {Promise<Array>} Array of sub-positions
   */
  async extractSubPositions(position, microSummaries = [], allResponses = [], context = {}) {
    // Check if extraction is needed with context
    if (!DynamicParameterCalculator.shouldExtractSubPositions(position, context)) {
      console.log(`[SubPositionExtractor] Position "${position.title}" doesn't need sub-position extraction (${position.responseNumbers?.length || 0} respondents, ${position._mergeCount || 1} merges)`);
      return {
        subPositions: [],
        masterOnlyRespondents: []
      };
    }

    const respondentCount = position.responseNumbers?.length || 0;
    const mergeCount = position._mergeCount || 1;
    
    console.log(`[SubPositionExtractor] Extracting sub-positions from mega-position "${position.title}" (${respondentCount} respondents, ${mergeCount} merges)`);

    // Get sub-position parameters based on context
    const subPosParams = DynamicParameterCalculator.getSubPositionParameters(position, context);

    // Build context from merged positions
    const mergedTitles = position._mergedFrom || [];
    const originalSummaries = position._originalSummaries || [];
    
    // Get micro-summaries for this position's respondents
    const relevantMicroSummaries = microSummaries.filter(ms => 
      position.responseNumbers.includes(ms.responseNumber)
    );

    // PRE-IDENTIFY master-only candidates based on:
    // 1. Short original response text (< 50 chars)
    // 2. No explicit reasoning (why: "Ikke specificeret")
    const SHORT_RESPONSE_THRESHOLD = 50;
    const shortResponseRespondents = new Set();
    
    for (const respNum of position.responseNumbers) {
      const response = allResponses.find(r => r.id === respNum);
      const microSummary = relevantMicroSummaries.find(ms => ms.responseNumber === respNum);
      
      let isMasterOnlyCandidate = false;
      
      // Check 1: Short response text
      if (response) {
        const textLength = (response.text || '').length;
        if (textLength > 0 && textLength < SHORT_RESPONSE_THRESHOLD) {
          isMasterOnlyCandidate = true;
        }
      }
      
      // Check 2: No explicit reasoning in micro-summary (why is "Ikke specificeret" or very short)
      if (microSummary?.arguments) {
        const allWhysUnspecified = microSummary.arguments.every(arg => {
          const why = (arg.why || '').toLowerCase().trim();
          return why === 'ikke specificeret' || 
                 why === '' || 
                 why.length < 15; // Very short why is also a signal
        });
        if (allWhysUnspecified) {
          isMasterOnlyCandidate = true;
        }
      }
      
      if (isMasterOnlyCandidate) {
        shortResponseRespondents.add(respNum);
      }
    }
    
    if (shortResponseRespondents.size > 0) {
      console.log(`[SubPositionExtractor] Identified ${shortResponseRespondents.size} master-only candidates (short response or no explicit reasoning)`);
    }

    // STRATIFIED SAMPLING: For large positions, sample diverse micro-summaries
    // instead of pre-clustering. This preserves raw arguments for the LLM.
    let sampledMicroSummaries = relevantMicroSummaries;
    let useStratifiedPrompt = false;
    const STRATIFIED_THRESHOLD = 40; // Use stratified sampling for positions with >40 respondents

    if (relevantMicroSummaries.length > STRATIFIED_THRESHOLD) {
      const sampleResult = this.stratifiedSampleMicroSummaries(relevantMicroSummaries);
      sampledMicroSummaries = sampleResult.sampled;
      useStratifiedPrompt = true;
      console.log(`[SubPositionExtractor] Stratified sampling: ${relevantMicroSummaries.length} → ${sampledMicroSummaries.length} micro-summaries (${sampleResult.strata.map(s => `${s.label}:${s.count}`).join(', ')})`);
    }

    // Build prompt (stratified or full)
    const prompt = useStratifiedPrompt
      ? this.buildStratifiedExtractionPrompt({
          position,
          respondentCount,
          mergeCount,
          mergedTitles,
          originalSummaries,
          sampledMicroSummaries,
          totalCount: relevantMicroSummaries.length,
          parameters: subPosParams,
          context
        })
      : this.buildExtractionPrompt({
          position,
          respondentCount,
          mergeCount,
          mergedTitles,
          originalSummaries,
          microSummaries: relevantMicroSummaries,
          parameters: subPosParams,
          context
        });

    // Use standard model - stratified sampling keeps prompt size manageable
    const client = this.client;
    console.log(`[SubPositionExtractor] Using standard model for ${respondentCount} respondents (stratified: ${useStratifiedPrompt})`);

    try {
      console.log(`[SubPositionExtractor] Calling LLM with prompt size: ${prompt.length} characters${useStratifiedPrompt ? ' (stratified sample)' : ''}`);
      const startTime = Date.now();

      // Dynamic timeout: baseline 60s + 5s per KB over 6KB, capped at 180s
      // Increased from 45s/120s to handle complex reasoning tasks
      const promptKb = Math.max(0, (prompt.length - 6000) / 1000);
      const baseTimeoutMs = Math.min(180000, 60000 + Math.round(promptKb * 5000));
      
      // Retry configuration: 2 attempts with increasing timeout
      const maxAttempts = 2;
      let lastError = null;
      let response = null;
      
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // Increase timeout on retry (1.5x for second attempt)
        const timeoutMs = attempt === 1 ? baseTimeoutMs : Math.min(180000, Math.round(baseTimeoutMs * 1.5));
        
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`LLM call timeout after ${timeoutMs}ms`)), timeoutMs);
        });
        
        try {
          // Race between LLM call and timeout
          response = await Promise.race([
            client.createCompletion({
              messages: [
                {
                  role: 'system',
                  content: 'Du er ekspert i at identificere nuancerede sub-argumenter i høringssvar-analyser.'
                },
                {
                  role: 'user',
                  content: prompt
                }
              ],
              response_format: getResponseFormat('subPositionExtraction')
            }),
            timeoutPromise
          ]);
          
          // Success - break out of retry loop
          break;
        } catch (attemptError) {
          lastError = attemptError;
          if (attempt < maxAttempts) {
            console.warn(`[SubPositionExtractor] Attempt ${attempt}/${maxAttempts} failed: ${attemptError.message}. Retrying with ${Math.round(timeoutMs * 1.5 / 1000)}s timeout...`);
          }
        }
      }
      
      // If all attempts failed, throw the last error
      if (!response) {
        throw lastError;
      }
      
      const llmTime = Date.now() - startTime;
      console.log(`[SubPositionExtractor] LLM responded in ${llmTime}ms`);

      const content = response.choices[0]?.message?.content;
      if (!content) {
        console.warn('[SubPositionExtractor] No content in LLM response');
        return {
          subPositions: [],
          masterOnlyRespondents: [...shortResponseRespondents].sort((a, b) => a - b)
        };
      }

      const parsed = JSON.parse(content);
      let subPositions = parsed.subPositions || [];
      let masterOnlyRespondents = parsed.masterOnlyRespondents || [];

      // CENTROID ATTRIBUTION: For stratified positions, attribute remaining respondents via embedding similarity
      if (useStratifiedPrompt && relevantMicroSummaries.length > sampledMicroSummaries.length) {
        const attributionResult = await this.attributeRemainingViaCentroid(
          subPositions,
          masterOnlyRespondents,
          sampledMicroSummaries,
          relevantMicroSummaries,
          position
        );
        subPositions = attributionResult.subPositions;
        masterOnlyRespondents = attributionResult.masterOnlyRespondents;
      }

      // CRITICAL: Remove short-response respondents from sub-positions
      // Short responses (< 50 chars) should ONLY be in master-only, not in sub-positions
      // because they don't have specific arguments - just the general position
      if (shortResponseRespondents.size > 0) {
        for (const subPos of subPositions) {
          const originalCount = subPos.responseNumbers?.length || 0;
          subPos.responseNumbers = (subPos.responseNumbers || []).filter(r => !shortResponseRespondents.has(r));
          if (subPos.responseNumbers.length < originalCount) {
            console.log(`[SubPositionExtractor] Removed ${originalCount - subPos.responseNumbers.length} short-response respondents from sub-position "${subPos.title?.substring(0, 40)}..."`);
          }
        }
        // Remove empty sub-positions after filtering
        subPositions = subPositions.filter(sp => sp.responseNumbers && sp.responseNumbers.length > 0);
      }

      // Combine: short-response respondents + LLM-identified master-only (avoiding duplicates)
      const allMasterOnly = new Set([...shortResponseRespondents, ...masterOnlyRespondents]);
      
      // Validate: ensure masterOnlyRespondents don't overlap with sub-position respondents
      const subPosRespondents = new Set(subPositions.flatMap(sp => sp.responseNumbers || []));
      const finalMasterOnly = [...allMasterOnly].filter(r => !subPosRespondents.has(r));
      
      console.log(`[SubPositionExtractor] Extracted ${subPositions.length} sub-positions + ${finalMasterOnly.length} master-only (${shortResponseRespondents.size} from short responses) from "${position.title}"`);
      masterOnlyRespondents = finalMasterOnly;

      // Enrich sub-positions with metadata
      const enrichedSubPositions = subPositions.map((subPos, idx) => ({
        ...subPos,
        _isSubPosition: true,
        _parentTitle: position.title,
        _extractionMethod: useStratifiedPrompt ? 'llm-stratified' : 'llm',
        _confidence: parsed.confidence || 0.8
      }));

      // ENRICH with diverse representative arguments for better verbosity in writer
      const finalSubPositions = await this.enrichWithDiverseArguments(enrichedSubPositions, relevantMicroSummaries);
      console.log(`[SubPositionExtractor] Enriched ${finalSubPositions.length} sub-positions with diverse arguments`);

      // NEW: Harmonize/deduplicate sub-positions so near-duplicates become ONE coherent sub-position
      // Pass position context for dynamic threshold calculation
      const harmonizedSubPositions = await this.harmonizeSubPositions(finalSubPositions, {
        respondentCount: respondentCount,
        isMegaPosition: position._isMegaPosition || false
      });

      // CRITICAL: Validate sub-position integrity (sub-positions must support master direction)
      // This filters out sub-positions that conflict with master or are about different topics
      const integrityCheck = this.validateSubPositionIntegrity(harmonizedSubPositions, position);

      // Use only valid sub-positions; conflicts/other topics will be logged for potential separate positions
      let validatedSubPositions = integrityCheck.validSubPositions;

      // Log any invalid sub-positions that should be separate positions
      if (integrityCheck.conflictingSubPositions.length > 0) {
        console.log(`[SubPositionExtractor] ⚠️ ${integrityCheck.conflictingSubPositions.length} sub-positions removed due to direction conflict:`);
        for (const sp of integrityCheck.conflictingSubPositions) {
          console.log(`   - "${sp.title?.slice(0, 50)}" (${sp.responseNumbers?.length || 0} respondents) - should be SEPARATE position`);
        }
      }
      if (integrityCheck.otherTopicSubPositions.length > 0) {
        console.log(`[SubPositionExtractor] ⚠️ ${integrityCheck.otherTopicSubPositions.length} sub-positions removed due to topic mismatch:`);
        for (const sp of integrityCheck.otherTopicSubPositions) {
          console.log(`   - "${sp.title?.slice(0, 50)}" (${sp.responseNumbers?.length || 0} respondents) - should be SEPARATE position`);
        }
      }

      // Return both sub-positions and master-only respondents
      // Include invalidSubPositions so caller can create separate positions if needed
      return {
        subPositions: validatedSubPositions,
        masterOnlyRespondents: masterOnlyRespondents.sort((a, b) => a - b),
        _conflictingSubPositions: integrityCheck.conflictingSubPositions,
        _otherTopicSubPositions: integrityCheck.otherTopicSubPositions
      };
    } catch (error) {
      console.error('[SubPositionExtractor] Failed to extract sub-positions:', error.message);

      // Return empty - better than artificial groupings
      console.warn('[SubPositionExtractor] LLM extraction failed - returning empty array');
      return {
        subPositions: [],
        masterOnlyRespondents: [...shortResponseRespondents].sort((a, b) => a - b)
      };
    }
  }

  /**
   * Stratified sample of micro-summaries for large positions.
   * Stratifies by direction + whether why is specified + argument length bucket.
   * Samples proportionally from each stratum.
   *
   * @param {Array} microSummaries - All micro-summaries for this position
   * @param {number} targetSize - Target sample size (default 120)
   * @returns {Object} { sampled: Array, strata: Array<{label, count}> }
   */
  stratifiedSampleMicroSummaries(microSummaries, targetSize = 120) {
    // Cap sample at available size
    targetSize = Math.min(targetSize, microSummaries.length);

    // Build strata: direction × whySpecified × lengthBucket
    const strata = new Map(); // key → [microSummary, ...]

    for (const ms of microSummaries) {
      // Determine direction from first argument
      const firstArg = ms.arguments?.[0];
      const direction = ms.direction || firstArg?.direction || 'unknown';

      // Check if why is specified
      const why = firstArg?.why || '';
      const whySpecified = why.length > 0 && why.toLowerCase() !== 'ikke specificeret';

      // Argument length bucket
      const text = this.buildMicroSummaryText(ms);
      const lengthBucket = text.length < 50 ? 'short' : text.length < 200 ? 'medium' : 'long';

      const key = `${direction}|${whySpecified ? 'why' : 'no-why'}|${lengthBucket}`;
      if (!strata.has(key)) strata.set(key, []);
      strata.get(key).push(ms);
    }

    // Sample proportionally from each stratum
    const sampled = [];
    const strataInfo = [];

    for (const [key, members] of strata) {
      const proportion = members.length / microSummaries.length;
      const sampleCount = Math.max(1, Math.round(proportion * targetSize));
      const actualCount = Math.min(sampleCount, members.length);

      // Pick evenly spaced members for diversity within stratum
      const step = members.length / actualCount;
      for (let i = 0; i < actualCount; i++) {
        const idx = Math.min(Math.floor(i * step), members.length - 1);
        sampled.push(members[idx]);
      }

      strataInfo.push({ label: key, count: actualCount, total: members.length });
    }

    // Deduplicate (in case of rounding artifacts)
    const seen = new Set();
    const deduped = sampled.filter(ms => {
      if (seen.has(ms.responseNumber)) return false;
      seen.add(ms.responseNumber);
      return true;
    });

    return { sampled: deduped, strata: strataInfo };
  }

  /**
   * Build extraction prompt with stratified sampled raw arguments.
   * Sends actual what/why/how from sampled micro-summaries to LLM.
   * @private
   */
  buildStratifiedExtractionPrompt({ position, respondentCount, mergeCount, mergedTitles, originalSummaries, sampledMicroSummaries, totalCount, parameters, context }) {
    // Format sampled arguments with full what/why/how
    const argLines = sampledMicroSummaries.map((ms, idx) => {
      const direction = ms.direction || ms.arguments?.[0]?.direction || '?';
      let argText = '';
      if (ms.arguments && ms.arguments.length > 0) {
        argText = ms.arguments.map(arg =>
          `HVAD: ${arg.what || '(ikke specificeret)'} | HVORFOR: ${arg.why || '(ikke specificeret)'} | HVORDAN: ${arg.how || '(ikke specificeret)'}`
        ).join('\n    ');
      } else {
        argText = `HVAD: ${ms.coreContent || '(intet)'} | HVORFOR: ${ms.concern || '(ingen)'}`;
      }
      return `[${idx + 1}] Svar ${ms.responseNumber} (${direction}): ${argText}`;
    }).join('\n');

    // Build context notes
    const massAgreementNote = context.massAgreementDetected
      ? '\n**BEMÆRK:** Masseenighed detekteret - fokusér på nuancerede forskelle i ellers lignende holdninger.'
      : '';

    const objectConcentrationNote = context.objectConcentration?.concentration > 0.7
      ? `\n**BEMÆRK:** Høj objektkoncentration (${(context.objectConcentration.concentration * 100).toFixed(0)}%) - mange diskuterer samme objekt med forskellige nuancer.`
      : '';

    const overlapRule = parameters.overlapAllowed
      ? '- Respondenter må gerne overlappe mellem sub-positioner (samme person kan støtte flere nuancer)'
      : '- Hver respondent må kun tildeles ÉN sub-position';

    return `# Udtrækning af nuancerede underargumenter

## OPGAVE

Du skal identificere distinkte underargumenter inden for en samlet position fra en høring.

## DATAINPUT

**Position under analyse:**
- Titel: ${position.title}
- Antal respondenter: ${respondentCount} (sample: ${sampledMicroSummaries.length} af ${totalCount})
- Antal sammenlagte positioner: ${mergeCount}
- Overordnet sammenfatning: ${position.summary || '(ingen opsummering)'}

## SAMPLED ARGUMENTER

Nedenstående er en stratificeret stikprøve af ${sampledMicroSummaries.length} argumenter fra i alt ${totalCount} respondenter.
Stikprøven dækker forskellige holdninger, begrundelsestyper og argumentlængder.

${argLines}

## KONTEKST

Dette er en samlet position med ${respondentCount} respondenter, dannet ved at sammenlægge ${mergeCount} oprindelige positioner.
${massAgreementNote}
${objectConcentrationNote}

## DIN OPGAVE

Identificér **2-8 distinkte underargumenter** baseret på de sampled argumenter. Lad diversiteten bestemme antallet.

Udled dimensionerne direkte fra argumenterne - led efter forskelle i:
1. **HVAD** der ønskes (mål, omfang, fokusområde)
2. **HVORFOR** det ønskes (begrundelsestype)
3. **HVORDAN** det skal opnås (metode)

## VIGTIGE REGLER

- Inkludér KUN responseNumbers fra de sampled argumenter ovenfor
- Respondenter med why: "(ikke specificeret)" → masterOnlyRespondents
- Respondenter med korte, ubegrundede svar → masterOnlyRespondents
- Opret IKKE "Generel holdning" som sub-position
${overlapRule}

## OUTPUT-FORMAT

Returnér JSON:

\`\`\`json
{
  "subPositions": [
    {
      "title": "Kort beskrivende titel",
      "what": "Hvad der konkret ønskes",
      "why": "Begrundelse",
      "how": "Metode",
      "responseNumbers": [sampled response numbers],
      "summary": "Kort sammenfatning"
    }
  ],
  "masterOnlyRespondents": [sampled numbers uden specifik begrundelse],
  "confidence": 0.85
}
\`\`\`

**KVALITETSKRAV:**
- Alle ${sampledMicroSummaries.length} sampled respondentnumre skal fordeles - enten i sub-position ELLER masterOnlyRespondents
- Sub-positioner skal afspejle genuint forskellige argumenter, ikke kunstige opdelinger
`;
  }

  /**
   * Attribute remaining (non-sampled) micro-summaries to sub-positions via centroid embedding similarity.
   *
   * For each sub-position: compute centroid embedding from (description + sample args).
   * For each remaining micro-summary: embed what+why, find closest centroid.
   * Threshold >0.65 → assign. Below → masterOnly.
   *
   * @param {Array} subPositions - Sub-positions from LLM (with sampled responseNumbers)
   * @param {Array} masterOnlyRespondents - Master-only from LLM (sampled)
   * @param {Array} sampledMicroSummaries - The sampled subset
   * @param {Array} allMicroSummaries - All micro-summaries for this position
   * @param {Object} position - The parent position
   * @returns {Promise<Object>} { subPositions, masterOnlyRespondents } with all respondents attributed
   */
  async attributeRemainingViaCentroid(subPositions, masterOnlyRespondents, sampledMicroSummaries, allMicroSummaries, position) {
    const sampledNumbers = new Set(sampledMicroSummaries.map(ms => ms.responseNumber));
    const allNumbers = new Set(position.responseNumbers || []);

    // Respondents already assigned via LLM
    const assignedInSample = new Set([
      ...subPositions.flatMap(sp => sp.responseNumbers || []),
      ...masterOnlyRespondents
    ]);

    // Remaining micro-summaries to attribute
    const remaining = allMicroSummaries.filter(ms =>
      allNumbers.has(ms.responseNumber) && !assignedInSample.has(ms.responseNumber)
    );

    if (remaining.length === 0) {
      console.log(`[SubPositionExtractor] No remaining respondents to attribute`);
      return { subPositions, masterOnlyRespondents };
    }

    console.log(`[SubPositionExtractor] Attributing ${remaining.length} remaining respondents via centroid similarity...`);

    if (subPositions.length === 0) {
      // No sub-positions to attribute to → all remaining go to masterOnly
      const expandedMasterOnly = [...new Set([...masterOnlyRespondents, ...remaining.map(ms => ms.responseNumber)])];
      return { subPositions, masterOnlyRespondents: expandedMasterOnly.sort((a, b) => a - b) };
    }

    try {
      // Step 1: Build centroid text for each sub-position
      const subPosCentroidTexts = subPositions.map(sp => {
        const parts = [sp.title, sp.what, sp.why, sp.how, sp.summary].filter(Boolean);
        // Also include a few sample argument texts for better centroid
        const sampleArgs = (sp.responseNumbers || []).slice(0, 5).map(rn => {
          const ms = allMicroSummaries.find(m => m.responseNumber === rn);
          return ms ? this.buildMicroSummaryText(ms) : '';
        }).filter(Boolean);
        return [...parts, ...sampleArgs].join(' ').slice(0, 2000);
      });

      // Step 2: Embed sub-position centroids
      const centroidEmbeddings = await this.embedder.embedBatch(subPosCentroidTexts);
      if (!centroidEmbeddings || centroidEmbeddings.length !== subPositions.length) {
        console.warn('[SubPositionExtractor] Centroid embedding failed, putting remaining in masterOnly');
        const expandedMasterOnly = [...new Set([...masterOnlyRespondents, ...remaining.map(ms => ms.responseNumber)])];
        return { subPositions, masterOnlyRespondents: expandedMasterOnly.sort((a, b) => a - b) };
      }

      // Step 3: Embed remaining micro-summaries
      const remainingTexts = remaining.map(ms => this.buildMicroSummaryText(ms));
      const remainingEmbeddings = await this.embedder.embedBatch(remainingTexts);
      if (!remainingEmbeddings || remainingEmbeddings.length !== remaining.length) {
        console.warn('[SubPositionExtractor] Remaining embedding failed, putting remaining in masterOnly');
        const expandedMasterOnly = [...new Set([...masterOnlyRespondents, ...remaining.map(ms => ms.responseNumber)])];
        return { subPositions, masterOnlyRespondents: expandedMasterOnly.sort((a, b) => a - b) };
      }

      // Step 4: Assign each remaining micro-summary to best matching sub-position
      const ATTRIBUTION_THRESHOLD = 0.65;
      const expandedSubPositions = subPositions.map(sp => ({
        ...sp,
        responseNumbers: [...(sp.responseNumbers || [])]
      }));
      const newMasterOnly = [...masterOnlyRespondents];
      let attributedCount = 0;
      let masterOnlyCount = 0;

      for (let i = 0; i < remaining.length; i++) {
        const ms = remaining[i];
        const emb = remainingEmbeddings[i];

        // Check if this respondent has no specific reasoning (master-only candidate)
        const hasReasoning = ms.arguments?.some(arg => {
          const why = (arg.why || '').toLowerCase().trim();
          return why && why !== 'ikke specificeret' && why.length >= 15;
        });

        if (!hasReasoning) {
          // No specific reasoning → masterOnly
          newMasterOnly.push(ms.responseNumber);
          masterOnlyCount++;
          continue;
        }

        // Find best matching sub-position
        let bestSim = -1;
        let bestIdx = -1;

        for (let j = 0; j < centroidEmbeddings.length; j++) {
          const sim = this.cosineSimilarity(emb, centroidEmbeddings[j]);
          if (sim > bestSim) {
            bestSim = sim;
            bestIdx = j;
          }
        }

        if (bestSim >= ATTRIBUTION_THRESHOLD && bestIdx >= 0) {
          expandedSubPositions[bestIdx].responseNumbers.push(ms.responseNumber);
          attributedCount++;
        } else {
          newMasterOnly.push(ms.responseNumber);
          masterOnlyCount++;
        }
      }

      // Sort responseNumbers in each sub-position
      for (const sp of expandedSubPositions) {
        sp.responseNumbers.sort((a, b) => a - b);
      }

      // Deduplicate masterOnly
      const uniqueMasterOnly = [...new Set(newMasterOnly)].sort((a, b) => a - b);

      const totalCovered = new Set([
        ...expandedSubPositions.flatMap(sp => sp.responseNumbers),
        ...uniqueMasterOnly
      ]);
      console.log(`[SubPositionExtractor] Centroid attribution: ${attributedCount} attributed to sub-positions, ${masterOnlyCount} to masterOnly (${totalCovered.size}/${allNumbers.size} total coverage)`);

      return { subPositions: expandedSubPositions, masterOnlyRespondents: uniqueMasterOnly };
    } catch (error) {
      console.warn(`[SubPositionExtractor] Centroid attribution failed: ${error.message}, putting remaining in masterOnly`);
      const expandedMasterOnly = [...new Set([...masterOnlyRespondents, ...remaining.map(ms => ms.responseNumber)])];
      return { subPositions, masterOnlyRespondents: expandedMasterOnly.sort((a, b) => a - b) };
    }
  }

  /**
   * Build extraction prompt (for small positions)
   * @private
   */
  buildExtractionPrompt({ position, respondentCount, mergeCount, mergedTitles, originalSummaries, microSummaries, parameters, context }) {
    // Format titles - show all if reasonable, otherwise show selection with note
    const MAX_TITLES_TO_SHOW = 30;
    let titlesText = '';
    
    if (mergedTitles.length === 0) {
      titlesText = 'Ingen tilgængelige';
    } else if (mergedTitles.length <= MAX_TITLES_TO_SHOW) {
      // Show all titles
      titlesText = mergedTitles.map((t, i) => `${i + 1}. ${t}`).join('\n');
    } else {
      // Show first 30 with note about remaining
      titlesText = mergedTitles.slice(0, MAX_TITLES_TO_SHOW).map((t, i) => `${i + 1}. ${t}`).join('\n');
      titlesText += `\n(... og ${mergedTitles.length - MAX_TITLES_TO_SHOW} flere titler)`;
    }

    // Format summaries - show all if reasonable
    const MAX_SUMMARIES_TO_SHOW = 15;
    let summariesText = '';
    
    if (originalSummaries.length === 0) {
      summariesText = 'Ingen tilgængelige';
    } else if (originalSummaries.length <= MAX_SUMMARIES_TO_SHOW) {
      // Show all summaries (with full text)
      summariesText = originalSummaries.map((s, i) => 
        `**Position ${i + 1}:** ${s.title}\n${s.summary || '(ingen opsummering)'}`
      ).join('\n\n');
    } else {
      // Show selection with note
      summariesText = originalSummaries.slice(0, MAX_SUMMARIES_TO_SHOW).map((s, i) => 
        `**Position ${i + 1}:** ${s.title}\n${s.summary || '(ingen opsummering)'}`
      ).join('\n\n');
      summariesText += `\n\n(... og ${originalSummaries.length - MAX_SUMMARIES_TO_SHOW} flere position-opsummeringer)`;
    }

    // Format micro-summaries - show ALL arguments for accurate attribution
    const MAX_MICRO_TO_SHOW = 50; // Increased to show more detail
    let microText = '';
    
    if (microSummaries.length === 0) {
      microText = 'Ingen tilgængelige';
    } else if (microSummaries.length <= MAX_MICRO_TO_SHOW) {
      // Show all micro-summaries with FULL argument details for accurate attribution
      microText = microSummaries.map(ms => {
        let argText = '';
        if (ms.arguments && ms.arguments.length > 0) {
          argText = ms.arguments.map((arg, idx) => 
            `  Argument ${idx + 1}:\n    - HVAD: ${arg.what || '(ikke specificeret)'}\n    - HVORFOR: ${arg.why || '(ikke specificeret)'}\n    - HVORDAN: ${arg.how || '(ikke specificeret)'}`
          ).join('\n');
        } else {
          argText = `  - Hovedargument: ${ms.coreContent || '(intet)'}\n  - Bekymring: ${ms.concern || '(ingen)'}`;
        }
        return `**Svar ${ms.responseNumber}:**\n${argText}`;
      }).join('\n\n');
    } else {
      // For very large positions, show first 50 with note
      microText = `${microSummaries.length} micro-summaries tilgængelige. Viser først ${MAX_MICRO_TO_SHOW}:\n\n`;
      microText += microSummaries.slice(0, MAX_MICRO_TO_SHOW).map(ms => {
        let argText = '';
        if (ms.arguments && ms.arguments.length > 0) {
          argText = ms.arguments.map((arg, idx) => 
            `  Argument ${idx + 1}:\n    - HVAD: ${arg.what || '(ikke specificeret)'}\n    - HVORFOR: ${arg.why || '(ikke specificeret)'}\n    - HVORDAN: ${arg.how || '(ikke specificeret)'}`
          ).join('\n');
        } else {
          argText = `  - Hovedargument: ${ms.coreContent || '(intet)'}\n  - Bekymring: ${ms.concern || '(ingen)'}`;
        }
        return `**Svar ${ms.responseNumber}:**\n${argText}`;
      }).join('\n\n');
    }

    // Build context notes
    const massAgreementNote = context.massAgreementDetected 
      ? '\n**BEMÆRK:** Masseenighed detekteret - fokusér på nuancerede forskelle i ellers lignende holdninger.' 
      : '';
    
    const objectConcentrationNote = context.objectConcentration?.concentration > 0.7 
      ? `\n**BEMÆRK:** Høj objektkoncentration (${(context.objectConcentration.concentration * 100).toFixed(0)}%) - mange diskuterer samme objekt med forskellige nuancer.`
      : '';

    const overlapRule = parameters.overlapAllowed 
      ? '- Respondenter må gerne overlappe mellem sub-positioner (samme person kan støtte flere nuancer)'
      : '- Hver respondent må kun tildeles ÉN sub-position';

    // Replace placeholders in template
    let prompt = this.promptTemplate;
    prompt = prompt.replace('{{POSITION_TITLE}}', position.title);
    prompt = prompt.replace(/{{RESPONDENT_COUNT}}/g, respondentCount); // Replace all occurrences
    prompt = prompt.replace(/{{MERGE_COUNT}}/g, mergeCount);
    prompt = prompt.replace('{{POSITION_SUMMARY}}', position.summary || '(ingen opsummering)');
    prompt = prompt.replace('{{MERGED_TITLES}}', titlesText);
    prompt = prompt.replace('{{ORIGINAL_SUMMARIES}}', summariesText);
    prompt = prompt.replace('{{MICRO_SUMMARIES}}', microText);
    prompt = prompt.replace('{{MASS_AGREEMENT_NOTE}}', massAgreementNote);
    prompt = prompt.replace('{{OBJECT_CONCENTRATION_NOTE}}', objectConcentrationNote);
    prompt = prompt.replace('{{OVERLAP_RULE}}', overlapRule);

    return prompt;
  }

  /**
   * Calculate argument diversity score for a specific position
   * Measures how diverse the arguments are within a position's respondents
   * High score = respondents have different nuances/reasons (should extract sub-positions)
   * Low score = respondents say roughly the same thing (no sub-positions needed)
   * 
   * @param {Object} position - Position with responseNumbers
   * @param {Array} microSummaries - All micro-summaries
   * @returns {Object} Diversity analysis { score: 0-1, uniqueThemes: [], reason: string }
   * @private
   */
  calculatePositionArgumentDiversity(position, microSummaries) {
    const responseNumbers = position.responseNumbers || [];
    if (responseNumbers.length <= 1) {
      return { score: 0, uniqueThemes: [], reason: 'single_respondent' };
    }

    // Get micro-summaries for this position
    const relevantSummaries = microSummaries.filter(ms => 
      responseNumbers.includes(ms.responseNumber)
    );

    if (relevantSummaries.length === 0) {
      return { score: 0.3, uniqueThemes: [], reason: 'no_summaries' };
    }

    // Extract all unique themes mentioned across respondents
    const allThemes = new Set();
    const themeFrequency = {};
    
    // Extract key phrases from what/why/how fields
    const keyPhrasesByRespondent = [];
    
    for (const summary of relevantSummaries) {
      const phrases = new Set();
      
      if (summary.arguments && Array.isArray(summary.arguments)) {
        for (const arg of summary.arguments) {
          // Collect relevant themes
          if (arg.relevantThemes) {
            arg.relevantThemes.forEach(t => {
              allThemes.add(t);
              themeFrequency[t] = (themeFrequency[t] || 0) + 1;
            });
          }
          
          // Extract key phrases from what/why/how
          const text = [arg.what, arg.why, arg.how].filter(Boolean).join(' ').toLowerCase();
          
          // Simple keyword extraction (focus on nouns and key terms)
          const keywords = text.match(/\b[a-zæøå]{4,}\b/g) || [];
          keywords.forEach(kw => phrases.add(kw));
        }
      }
      
      keyPhrasesByRespondent.push(phrases);
    }

    // Calculate Jaccard distance between respondents (how different their key phrases are)
    let totalDistance = 0;
    let comparisons = 0;
    
    for (let i = 0; i < keyPhrasesByRespondent.length; i++) {
      for (let j = i + 1; j < keyPhrasesByRespondent.length; j++) {
        const setA = keyPhrasesByRespondent[i];
        const setB = keyPhrasesByRespondent[j];
        
        const intersection = new Set([...setA].filter(x => setB.has(x)));
        const union = new Set([...setA, ...setB]);
        
        // Jaccard distance = 1 - (intersection / union)
        const distance = union.size > 0 ? 1 - (intersection.size / union.size) : 0;
        totalDistance += distance;
        comparisons++;
      }
    }

    // Average distance (0 = identical, 1 = completely different)
    const avgDistance = comparisons > 0 ? totalDistance / comparisons : 0;
    
    // Theme diversity: how many different themes are mentioned
    const uniqueThemeCount = allThemes.size;
    const themeScore = Math.min(1, uniqueThemeCount / 5); // Cap at 5 themes
    
    // Combined score: weighted average of phrase diversity and theme diversity
    const score = (avgDistance * 0.7) + (themeScore * 0.3);

    return {
      score: Math.min(1, Math.max(0, score)),
      uniqueThemes: [...allThemes],
      avgPhraseDistance: avgDistance,
      respondentCount: relevantSummaries.length,
      reason: score > 0.35 ? 'high_diversity' : 'low_diversity'
    };
  }

  /**
   * Extract sub-positions from all mega-positions in themes
   * @param {Array} themes - Themes with positions
   * @param {Array} microSummaries - Micro-summaries
   * @param {Array} allResponses - All responses
   * @param {Object} context - Additional context (mass agreement, object concentration)
   * @returns {Promise<Array>} Themes with sub-positions added
   */
  async extractFromThemes(themes, microSummaries = [], allResponses = [], context = {}) {
    console.log(`[SubPositionExtractor] Processing ${themes.length} themes for sub-position extraction`);
    if (context.massAgreementDetected) {
      console.log(`[SubPositionExtractor] Mass agreement context detected - using enhanced extraction`);
    }

    // Process all themes in PARALLEL for massive performance improvement
    const themePromises = themes.map(async (theme) => {
      // Process all positions in this theme in PARALLEL
      const positionPromises = (theme.positions || []).map(async (position) => {
        // Calculate position-specific argument diversity
        const argumentDiversity = this.calculatePositionArgumentDiversity(position, microSummaries);
        
        // Build enriched context with position-specific diversity
        const enrichedContext = {
          ...context,
          argumentDiversity
        };
        
        // Check if this position needs sub-position extraction with enriched context
        if (DynamicParameterCalculator.shouldExtractSubPositions(position, enrichedContext)) {
          console.log(`[SubPositionExtractor] Extracting sub-positions from "${position.title}" (diversity: ${argumentDiversity.score.toFixed(2)})`);

          try {
            const extractionResult = await this.extractSubPositions(position, microSummaries, allResponses, enrichedContext);
            const { subPositions, masterOnlyRespondents } = extractionResult;

            // Add sub-positions AND master-only respondents to the main position
            return {
              ...position,
              subPositions: subPositions.length > 0 ? subPositions : undefined,
              masterOnlyRespondents: masterOnlyRespondents.length > 0 ? masterOnlyRespondents : undefined,
              _hasSubPositions: subPositions.length > 0,
              _hasMasterOnlyRespondents: masterOnlyRespondents.length > 0,
              _argumentDiversity: argumentDiversity.score
            };
          } catch (extractionError) {
            console.error(`[SubPositionExtractor] ❌ Failed to extract sub-positions for "${position.title}": ${extractionError.message}`);
            // Return position unchanged on error - don't crash the pipeline
            return {
              ...position,
              _subPositionExtractionFailed: true,
              _extractionError: extractionError.message
            };
          }
        } else {
          // No extraction needed
          return position;
        }
      });

      // Wait for all positions in this theme
      const positions = await Promise.all(positionPromises);
      
      return {
        ...theme,
        positions
      };
    });

    // Wait for all themes to complete
    const results = await Promise.all(themePromises);

    console.log(`[SubPositionExtractor] Completed sub-position extraction`);
    
    // DEDUPLICATE: Remove sub-positions that have been "promoted" to master-positions elsewhere
    const deduplicated = this.deduplicatePromotedSubPositions(results);
    
    return deduplicated;
  }

  /**
   * Deduplicate sub-positions that have been "promoted" to master-positions in other themes.
   * 
   * Example: If "Parkering" is both a sub-position under "Bevaring af Palads" AND
   * a master-position under "Bil- og cykelparkering", remove the sub-position version.
   * 
   * The respondent can still be counted in both master-positions with appropriate citations,
   * but we avoid showing the same argument twice.
   * 
   * @param {Array} themes - Themes with positions and sub-positions
   * @returns {Array} Themes with deduplicated sub-positions
   */
  deduplicatePromotedSubPositions(themes) {
    console.log(`[SubPositionExtractor] Running sub-position deduplication...`);

    // Step 1: Build index of ALL master-position titles/topics across all themes
    const masterPositionIndex = new Map(); // normalized title -> position info
    
    for (const theme of themes) {
      for (const position of (theme.positions || [])) {
        // Skip positions that are themselves sub-positions
        if (position._isSubPosition) continue;
        
        // Extract key concepts from master position title
        const titleNormalized = this.normalizePositionTitle(position.title);
        const keywords = this.extractTopicKeywords(position.title);
        
        // Store position reference
        masterPositionIndex.set(titleNormalized, {
          theme: theme.name,
          title: position.title,
          keywords,
          responseNumbers: position.responseNumbers || []
        });
      }
    }

    console.log(`[SubPositionExtractor] Indexed ${masterPositionIndex.size} master-positions for deduplication`);

    // Step 2: For each position with sub-positions, check if any sub-position overlaps with a master-position
    let removedCount = 0;
    
    const deduplicatedThemes = themes.map(theme => {
      const deduplicatedPositions = (theme.positions || []).map(position => {
        if (!position.subPositions || position.subPositions.length === 0) {
          return position; // No sub-positions to deduplicate
        }

        // Filter out sub-positions that match master-positions elsewhere
        const filteredSubPositions = position.subPositions.filter(subPos => {
          const subTitleNormalized = this.normalizePositionTitle(subPos.title);
          const subKeywords = this.extractTopicKeywords(subPos.title);
          
          // Check if this sub-position overlaps with any master-position (except the parent)
          for (const [masterTitle, masterInfo] of masterPositionIndex) {
            // Skip self (the parent position)
            if (masterInfo.title === position.title) continue;
            
            // Check for title overlap
            if (this.titlesOverlap(subTitleNormalized, masterTitle, subKeywords, masterInfo.keywords)) {
              console.log(`[SubPositionExtractor] ♻️ Removing sub-position "${subPos.title?.slice(0, 50)}..." from "${position.title?.slice(0, 30)}..." (promoted to master in "${masterInfo.theme}")`);
              removedCount++;
              return false; // Remove this sub-position
            }
          }
          
          return true; // Keep this sub-position
        });

        return {
          ...position,
          subPositions: filteredSubPositions.length > 0 ? filteredSubPositions : undefined,
          _deduplicatedSubPositions: position.subPositions.length - filteredSubPositions.length
        };
      });

      return {
        ...theme,
        positions: deduplicatedPositions
      };
    });

    console.log(`[SubPositionExtractor] Deduplication complete: removed ${removedCount} promoted sub-positions`);
    return deduplicatedThemes;
  }

  /**
   * Normalize position title for comparison
   * @private
   */
  normalizePositionTitle(title) {
    if (!title) return '';
    return title
      .toLowerCase()
      .replace(/^(ønske om|modstand mod|krav om|støtte til|bekymring for)\s*/i, '')
      .replace(/[^a-zæøå0-9\s]/g, '')
      .trim();
  }

  /**
   * Extract topic keywords from position title
   * @private
   */
  extractTopicKeywords(title) {
    if (!title) return [];
    const normalized = title.toLowerCase();
    const keywords = new Set();
    
    // Topic keywords to look for
    const topicPatterns = [
      'parkering', 'bil', 'cykel', 'cykelparkering', 'bilparkering',
      'støj', 'støjforhold', 'larm',
      'højde', 'bygningshøjde', 'etager',
      'trafik', 'vej', 'adgang',
      'bevaring', 'bevaringsværdig', 'kulturarv', 'fredning', 'nedrivning',
      'facade', 'arkitektur', 'udseende',
      'miljø', 'klima', 'grøn',
      'hotel', 'biograf', 'anvendelse'
    ];
    
    for (const pattern of topicPatterns) {
      if (normalized.includes(pattern)) {
        keywords.add(pattern);
      }
    }
    
    return [...keywords];
  }

  /**
   * Check if two position titles overlap semantically
   * @private
   */
  titlesOverlap(title1, title2, keywords1, keywords2) {
    // Method 1: Direct title similarity
    if (title1 && title2) {
      // Check if one contains the other
      if (title1.includes(title2) || title2.includes(title1)) {
        return true;
      }
      
      // Jaccard similarity of words
      const words1 = new Set(title1.split(/\s+/).filter(w => w.length > 3));
      const words2 = new Set(title2.split(/\s+/).filter(w => w.length > 3));
      const intersection = [...words1].filter(w => words2.has(w)).length;
      const union = new Set([...words1, ...words2]).size;
      const jaccard = union > 0 ? intersection / union : 0;
      
      if (jaccard >= 0.5) {
        return true;
      }
    }
    
    // Method 2: Topic keyword overlap (stricter - requires multiple keyword matches)
    if (keywords1.length > 0 && keywords2.length > 0) {
      const commonKeywords = keywords1.filter(k => keywords2.includes(k));
      
      // If the primary topic keyword matches AND there are no conflicting keywords, consider it an overlap
      if (commonKeywords.length >= 1) {
        // Check for topic-specific overlap (e.g., both about "parkering")
        const topicMatchKeywords = ['parkering', 'støj', 'trafik', 'bevaring', 'højde', 'hotel'];
        const hasTopicMatch = topicMatchKeywords.some(topic =>
          commonKeywords.includes(topic) ||
          commonKeywords.some(k => k.includes(topic))
        );

        if (hasTopicMatch) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Set Job ID for LLM tracing
   * @param {string} jobId - The job ID to set on the LLM client
   */
  setJobId(jobId) {
    if (this.client?.setJobId) {
      this.client.setJobId(jobId);
    }
    if (this.lightClient?.setJobId) {
      this.lightClient.setJobId(jobId);
    }
  }
}

