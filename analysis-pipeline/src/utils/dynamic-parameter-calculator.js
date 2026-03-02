/**
 * DynamicParameterCalculator
 * 
 * Intelligently scales pipeline parameters based on dataset characteristics.
 * Ensures robustness for both small (4 responses) and large (500+) hearings.
 */

export class DynamicParameterCalculator {
  /**
   * Calculate copy/paste detection parameters based on hearing characteristics
   *
   * DYNAMISK: Tilpasser sig til høringens karakteristika
   * - Flere organisationer → højere sandsynlighed for koordinerede svar
   * - Lokalplaner → kendt for copy/paste mellem stakeholders
   * - Lange svar → mere tekst at sammenligne
   *
   * @param {Object} stats - Hearing statistics
   * @returns {Object} Copy/paste detection parameters
   */
  static getCopyPasteDetectionParameters(stats) {
    const {
      responseCount = 0,
      organizationCount = 0,
      localCommitteeCount = 0,
      avgResponseLength = 100,
      hearingType = 'unknown' // lokalplan, dispensation, politik, etc.
    } = stats;

    // Base: disabled for very small hearings (not worth the overhead)
    if (responseCount < 5) {
      return { enabled: false, reason: 'too_few_responses' };
    }

    // Calculate likelihood of copy/paste based on multiple signals
    let copyPasteLikelihood = 0;

    // Signal 1: Multiple organizations responding (0-0.4)
    if (organizationCount >= 3) copyPasteLikelihood += 0.4;
    else if (organizationCount >= 2) copyPasteLikelihood += 0.25;

    // Signal 2: LocalCommittee present (often coordinates with clubs) (0-0.3)
    if (localCommitteeCount >= 1) copyPasteLikelihood += 0.3;

    // Signal 3: Hearing type (0-0.3)
    const copyPasteProneTypes = ['lokalplan', 'miljørapport', 'kommuneplan'];
    if (copyPasteProneTypes.includes(hearingType)) copyPasteLikelihood += 0.3;

    // Signal 4: Longer responses have more text to copy (0-0.2)
    if (avgResponseLength > 500) copyPasteLikelihood += 0.2;
    else if (avgResponseLength > 200) copyPasteLikelihood += 0.1;

    // Enable if likelihood > 0.4 OR if it's a small/medium hearing where overhead is low
    const enabled = copyPasteLikelihood >= 0.4 || responseCount <= 30;

    // Dynamic threshold based on likelihood
    // Higher likelihood = lower threshold (catch more variations)
    let jaccardThreshold;
    if (copyPasteLikelihood >= 0.7) {
      jaccardThreshold = 0.70; // Aggressive: catch substantial variations
    } else if (copyPasteLikelihood >= 0.5) {
      jaccardThreshold = 0.78; // Moderate: catch clear copy/paste
    } else {
      jaccardThreshold = 0.85; // Conservative: only near-exact matches
    }

    return {
      enabled,
      jaccardThreshold,
      minResponseLength: 100, // Don't compare very short responses
      ngramSize: 4,           // 4-gram fingerprinting
      preserveVariations: true, // Create metadata, don't force-merge
      _likelihood: copyPasteLikelihood,
      _reason: enabled ? 'signals_detected' : 'low_likelihood'
    };
  }

  /**
   * Calculate optimal aggregation batch size
   * Small hearings: No batching (process all together)
   * Large hearings: Batch to prevent context overflow
   *
   * @param {number} argumentCount - Number of arguments to group
   * @returns {number} Optimal batch size (Infinity = no batching)
   */
  static getAggregationBatchSize(argumentCount) {
    if (argumentCount <= 10) return Infinity; // No batching for small datasets
    if (argumentCount <= 30) return 30; // Small batching
    if (argumentCount <= 60) return 20; // Medium batching
    return 15; // Standard batching for large datasets
  }

  /**
   * Calculate optimal retrieval topK
   * Scales with corpus size to maintain quality while avoiding over-retrieval
   * 
   * @param {number} totalChunks - Total number of chunks in corpus
   * @param {number} responseCount - Number of responses (for context)
   * @returns {number} Optimal topK value
   */
  static getRetrievalTopK(totalChunks, responseCount = null) {
    if (totalChunks <= 10) return Math.max(3, totalChunks); // Small corpus: retrieve most
    if (totalChunks <= 50) return Math.min(10, Math.ceil(totalChunks * 0.3)); // 30% of corpus
    if (totalChunks <= 200) return 20; // Standard retrieval
    if (totalChunks <= 500) return 30; // Large corpus
    return 40; // Very large corpus
  }

  /**
   * Calculate optimal re-ranking topK
   * Re-ranking is expensive, so scale conservatively
   * 
   * @param {number} retrievalTopK - Number of chunks retrieved
   * @param {number} responseCount - Number of responses
   * @returns {number} Optimal re-rank topK
   */
  static getReRankTopK(retrievalTopK, responseCount = null) {
    if (retrievalTopK <= 5) return Math.max(2, retrievalTopK); // Minimal re-ranking
    if (retrievalTopK <= 10) return Math.ceil(retrievalTopK * 0.6); // 60% of retrieved
    if (retrievalTopK <= 20) return 10; // Standard re-ranking
    return Math.min(15, Math.ceil(retrievalTopK * 0.5)); // 50% of retrieved, max 15
  }

  /**
   * Calculate optimal batch size for parallel LLM calls
   * Balances parallelization with rate limits and context
   * 
   * @param {number} itemCount - Number of items to process
   * @param {string} taskComplexity - 'light', 'medium', 'heavy'
   * @returns {number} Optimal batch size
   */
  static getLLMBatchSize(itemCount, taskComplexity = 'medium') {
    // For very small datasets, process all at once
    if (itemCount <= 5) return itemCount;
    
    // Complexity-based base batch sizes
    const baseBatchSizes = {
      light: 30,   // Simple tasks: edge case screening
      medium: 20,  // Standard tasks: micro-summarization, citations
      heavy: 10    // Complex tasks: aggregation with rich context
    };
    
    const baseBatch = baseBatchSizes[taskComplexity] || 20;
    
    // Scale down for small datasets
    if (itemCount <= 10) return Math.min(10, itemCount);
    if (itemCount <= 20) return Math.min(15, baseBatch);
    
    return baseBatch;
  }

  /**
   * Calculate optimal position writer chunk size
   * Determines how many respondents to process per chunk
   * 
   * @param {number} respondentCount - Number of respondents for this position
   * @returns {number} Optimal chunk size
   */
  static getPositionWriterChunkSize(respondentCount) {
    if (respondentCount <= 10) return Infinity; // No chunking for small groups
    if (respondentCount <= 30) return 30; // Small chunking
    if (respondentCount <= 50) return 25; // Medium chunking
    return 20; // Standard chunking for large groups
  }

  /**
   * Calculate optimal embedding batch size
   * Embeddings are cheap, batch aggressively
   * 
   * @param {number} itemCount - Number of items to embed
   * @returns {number} Optimal batch size
   */
  static getEmbeddingBatchSize(itemCount) {
    if (itemCount <= 20) return itemCount; // Small batch: do all at once
    if (itemCount <= 100) return 50; // Standard batching
    return 100; // Large batching for efficiency
  }

  /**
   * Calculate optimal global embedding concurrency
   * 
   * CRITICAL: This determines the process-wide limit on concurrent OpenAI embedding HTTP requests.
   * Too high → "Connection error" / timeouts from connection saturation
   * Too low → Slow pipeline execution
   * 
   * The calculation considers:
   * - Number of pipeline components running in parallel (themes, positions, etc.)
   * - Network stability (lower for more retries/failures)
   * - Response count as proxy for overall workload
   * 
   * @param {Object} stats - Dataset statistics
   * @param {number} stats.responseCount - Number of responses
   * @param {number} stats.themeCount - Number of themes (affects parallelism)
   * @param {number} stats.argumentCount - Number of arguments (optional)
   * @returns {Object} Embedding concurrency configuration
   */
  static getEmbeddingConcurrency(stats = {}) {
    const {
      responseCount = 50,
      themeCount = 5,
      argumentCount = null
    } = stats;

    // Estimate total embedding workload
    // Each theme may trigger parallel embedding requests in Aggregator
    const estimatedParallelComponents = Math.min(themeCount, 10); // Cap at 10 parallel theme processors
    
    // Base concurrency: start conservative
    // OpenAI handles ~50 req/s but network/connection limits are usually lower
    let globalConcurrency;
    
    if (responseCount <= 20) {
      // Small hearings: can be more aggressive since total work is small
      globalConcurrency = 8;
    } else if (responseCount <= 100) {
      // Medium hearings: moderate concurrency
      globalConcurrency = 5;
    } else if (responseCount <= 300) {
      // Large hearings: conservative to avoid connection saturation
      globalConcurrency = 4;
    } else {
      // Very large hearings: very conservative
      globalConcurrency = 3;
    }
    
    // Adjust based on expected parallelism
    // If many themes run in parallel, reduce per-request concurrency
    if (estimatedParallelComponents > 5) {
      globalConcurrency = Math.max(2, globalConcurrency - 1);
    }
    
    // Per-batch concurrency: how many batches to run in parallel within a single embedBatch call
    // This should be lower than global to leave room for other components
    const batchConcurrency = Math.max(2, Math.min(globalConcurrency - 1, 4));
    
    // Theme-level concurrency: how many themes should do embedding work simultaneously
    // This is the key limiter - if 20 themes each try to embed, we need to serialize
    const themeConcurrency = Math.min(3, Math.ceil(globalConcurrency / 2));

    return {
      globalMaxConcurrency: globalConcurrency,
      batchMaxConcurrency: batchConcurrency,
      themeLevelConcurrency: themeConcurrency,
      _reasoning: {
        responseCount,
        themeCount,
        estimatedParallelComponents
      }
    };
  }

  /**
   * Calculate optimal embedding retry configuration based on hearing size
   * 
   * Larger hearings generate more embedding requests, which increases the 
   * likelihood of transient connection errors. We compensate by:
   * - Increasing base retry attempts
   * - Using smaller batches for pre-embedding
   * - Adding longer delays between batches
   * 
   * @param {number} responseCount - Number of responses in the hearing
   * @returns {Object} Retry configuration
   */
  static getEmbeddingRetryConfig(responseCount) {
    // Categorize hearing size
    const isSmall = responseCount < 100;
    const isMedium = responseCount >= 100 && responseCount < 500;
    const isLarge = responseCount >= 500 && responseCount < 1000;
    const isVeryLarge = responseCount >= 1000;

    // Base retry attempts: more retries for larger hearings
    let baseRetryAttempts;
    if (isSmall) baseRetryAttempts = 4;
    else if (isMedium) baseRetryAttempts = 5;
    else if (isLarge) baseRetryAttempts = 6;
    else baseRetryAttempts = 8;  // Very large

    // Pre-embed batch size: smaller for larger hearings
    let preEmbedBatchSize;
    if (isSmall) preEmbedBatchSize = 50;
    else if (isMedium) preEmbedBatchSize = 40;
    else if (isLarge) preEmbedBatchSize = 30;
    else preEmbedBatchSize = 25;  // Very large

    // Delay between pre-embed batches: longer for larger hearings
    let preEmbedDelayMs;
    if (isSmall) preEmbedDelayMs = 200;
    else if (isMedium) preEmbedDelayMs = 300;
    else if (isLarge) preEmbedDelayMs = 400;
    else preEmbedDelayMs = 500;  // Very large

    // Max retries per pre-embed batch
    let preEmbedMaxRetries;
    if (isSmall) preEmbedMaxRetries = 3;
    else if (isMedium) preEmbedMaxRetries = 4;
    else if (isLarge) preEmbedMaxRetries = 5;
    else preEmbedMaxRetries = 6;  // Very large

    return {
      baseRetryAttempts,
      preEmbedBatchSize,
      preEmbedDelayMs,
      preEmbedMaxRetries,
      _sizeCategory: isVeryLarge ? 'very-large' : isLarge ? 'large' : isMedium ? 'medium' : 'small'
    };
  }

  /**
   * Calculate optimal consolidation similarity threshold based on complexity
   * Uses multi-dimensional complexity score instead of just count
   * 
   * UPDATED: Now returns separate thresholds for within-theme and cross-theme consolidation
   * Cross-theme consolidation requires HIGHER similarity to prevent merging different topics
   * 
   * NEW FIX: For small hearings (<20 responses), use MUCH MORE AGGRESSIVE thresholds
   * to prevent over-fragmentation that ruins output quality.
   * 
   * @param {Object} complexity - Complexity assessment from calculateComplexity
   * @param {number} positionCount - Number of positions to consolidate
   * @param {number} responseCount - Number of original responses
   * @param {Object} massAgreementParams - Optional mass agreement detection results
   * @returns {number} Similarity threshold (0-1) - this is the within-theme threshold
   */
  static getConsolidationThresholdByComplexity(complexity, positionCount, responseCount, massAgreementParams = null) {
    // If mass agreement is detected, override with its recommendation
    // BUT: apply a floor to prevent over-merging different topics
    if (massAgreementParams?.detected && massAgreementParams?.consolidationThreshold) {
      const recommended = massAgreementParams.consolidationThreshold;
      const floored = Math.max(0.78, recommended); // Lowered floor for mass agreement
      console.log(`[DynamicParameters] Mass agreement detected - threshold: ${floored.toFixed(3)} (recommended: ${recommended.toFixed(3)}, floor: 0.78)`);
      return floored;
    }
    
    const positionToResponseRatio = positionCount / Math.max(1, responseCount);
    
    // NEW: AGGRESSIVE THRESHOLDS FOR SMALL HEARINGS
    // Small hearings (<20 responses) often get over-fragmented, causing many (1) positions
    // We need to merge more aggressively to produce quality output
    if (responseCount <= 10) {
      // Very small hearings: be very aggressive with merging
      const smallHearingThreshold = 0.75; // Much lower - merge similar positions
      console.log(`[DynamicParameters] Very small hearing (${responseCount} responses) - using aggressive threshold: ${smallHearingThreshold}`);
      
      // Still adjust for explosion ratio
      if (positionToResponseRatio > 2) {
        return 0.72; // Even more aggressive if too many positions
      }
      return smallHearingThreshold;
    } else if (responseCount <= 20) {
      // Small hearings: still be more aggressive
      const smallHearingThreshold = 0.78;
      console.log(`[DynamicParameters] Small hearing (${responseCount} responses) - using aggressive threshold: ${smallHearingThreshold}`);
      
      if (positionToResponseRatio > 2) {
        return 0.75;
      }
      return smallHearingThreshold;
    }
    
    // Base threshold on complexity category AND sub-category (15-level granularity)
    let baseThreshold;
    const { category, subCategory } = complexity;
    
    switch (category) {
      case 'trivial':
        // 0.76-0.80 (LOWERED for better merging)
        if (subCategory === 'low') baseThreshold = 0.76;
        else if (subCategory === 'mid') baseThreshold = 0.78;
        else baseThreshold = 0.80;
        break;
      case 'simple':
        // 0.78-0.82 (LOWERED for better merging)
        if (subCategory === 'low') baseThreshold = 0.78;
        else if (subCategory === 'mid') baseThreshold = 0.80;
        else baseThreshold = 0.82;
        break;
      case 'moderate':
        // 0.80-0.84 (LOWERED for better merging)
        if (subCategory === 'low') baseThreshold = 0.80;
        else if (subCategory === 'mid') baseThreshold = 0.82;
        else baseThreshold = 0.84;
        break;
      case 'complex':
        // 0.80-0.84 (LOWERED from 0.84-0.88 for better semantic merging)
        if (subCategory === 'low') baseThreshold = 0.80;
        else if (subCategory === 'mid') baseThreshold = 0.82;
        else baseThreshold = 0.84;
        break;
      case 'very_complex':
        // 0.82-0.86 (LOWERED from 0.86-0.90 for better semantic merging)
        if (subCategory === 'low') baseThreshold = 0.82;
        else if (subCategory === 'mid') baseThreshold = 0.84;
        else baseThreshold = 0.86;
        break;
      default:
        baseThreshold = 0.82;
    }

    // Adjust for position-to-response ratio
    // If we have way too many positions relative to responses, be MORE aggressive
    if (positionToResponseRatio > 3) {
      baseThreshold -= 0.06; // MORE aggressive reduction
      console.log(`[DynamicParameters] High position/response ratio (${positionToResponseRatio.toFixed(1)}) - lowering threshold by 0.06`);
    } else if (positionToResponseRatio > 2) {
      baseThreshold -= 0.04;
    } else if (positionToResponseRatio > 1.5) {
      baseThreshold -= 0.02;
    }

    // Adjust for diversity
    // High diversity = be more conservative (preserve different opinions)
    // Low diversity = be more aggressive (likely redundant positions)
    if (complexity.breakdown.diversityScore < 0.30) {
      // Low diversity: more aggressive adjustment
      if (responseCount > 50) {
        baseThreshold -= 0.05;
      } else if (responseCount > 20) {
        baseThreshold -= 0.06;
      } else {
        baseThreshold -= 0.08; // Small hearing with low diversity = aggressive merge
      }
    } else if (complexity.breakdown.diversityScore < 0.35) {
      baseThreshold -= 0.04;
    } else if (complexity.breakdown.diversityScore < 0.50) {
      baseThreshold -= 0.02;
    } else if (complexity.breakdown.diversityScore > 0.70) {
      baseThreshold += 0.03; // High diversity - more conservative
    }

    // Apply floor based on hearing size
    // Small hearings can have lower floor (0.72), large hearings need higher floor (0.80)
    const FLOOR = responseCount <= 30 ? 0.72 : 0.78;
    const finalThreshold = Math.max(FLOOR, Math.min(0.92, baseThreshold));
    
    return finalThreshold;
  }

  /**
   * Get the cross-theme consolidation threshold
   * Cross-theme merging requires HIGHER similarity because positions in different themes
   * are more likely to be genuinely different topics that should stay separate
   *
   * NEW: For small hearings, use lower cross-theme threshold to enable more merging
   * NEW: For large hearings with high object concentration, use MUCH lower threshold
   *      to ensure fragmented same-object positions get merged across themes
   *
   * @param {number} withinThemeThreshold - The within-theme threshold
   * @param {number} responseCount - Optional response count for scaling
   * @param {Object} objectConcentration - Optional object concentration analysis
   * @returns {number} Cross-theme threshold (always higher than within-theme)
   */
  static getCrossThemeThreshold(withinThemeThreshold, responseCount = null, objectConcentration = null) {
    // For small hearings, use much lower cross-theme threshold
    if (responseCount !== null && responseCount <= 10) {
      // Very small hearings: only 0.03 higher than within-theme
      const crossThemeThreshold = Math.max(0.78, withinThemeThreshold + 0.03);
      console.log(`[DynamicParameters] Small hearing cross-theme threshold: ${crossThemeThreshold.toFixed(3)}`);
      return Math.min(0.90, crossThemeThreshold);
    } else if (responseCount !== null && responseCount <= 20) {
      // Small hearings: 0.04 higher than within-theme
      const crossThemeThreshold = Math.max(0.80, withinThemeThreshold + 0.04);
      return Math.min(0.90, crossThemeThreshold);
    }

    // HIGH OBJECT CONCENTRATION: Use MUCH lower threshold for same-object merging
    // When many respondents discuss the same object (like Palads), cross-theme positions
    // are likely about the same thing and should merge more aggressively.
    // This prevents fragmentation of preservation positions across themes.
    const concentration = objectConcentration?.concentration ?? 0;
    const isVeryLargeHearing = responseCount !== null && responseCount > 500;
    const isLargeHearing = responseCount !== null && responseCount > 100;

    if (isVeryLargeHearing && concentration > 0.5) {
      // Very large hearing + high object concentration: aggressive merging
      const crossThemeThreshold = 0.65;
      console.log(`[DynamicParameters] Very large hearing with high object concentration (${(concentration * 100).toFixed(1)}%) - using aggressive cross-theme threshold: ${crossThemeThreshold}`);
      return crossThemeThreshold;
    } else if (isLargeHearing && concentration > 0.6) {
      // Large hearing + very high object concentration: moderately aggressive
      const crossThemeThreshold = 0.70;
      console.log(`[DynamicParameters] Large hearing with very high object concentration (${(concentration * 100).toFixed(1)}%) - using lower cross-theme threshold: ${crossThemeThreshold}`);
      return crossThemeThreshold;
    } else if (concentration > 0.7) {
      // Any hearing with very high object concentration: somewhat aggressive
      const crossThemeThreshold = 0.75;
      console.log(`[DynamicParameters] Very high object concentration (${(concentration * 100).toFixed(1)}%) - using reduced cross-theme threshold: ${crossThemeThreshold}`);
      return crossThemeThreshold;
    }

    // Normal/large hearings without high object concentration: standard logic
    const CROSS_THEME_FLOOR = 0.83; // Lowered from 0.88
    const crossThemeThreshold = Math.max(CROSS_THEME_FLOOR, withinThemeThreshold + 0.05);
    return Math.min(0.92, crossThemeThreshold);
  }

  /**
   * Legacy method for backward compatibility
   * @deprecated Use getConsolidationThresholdByComplexity instead
   */
  static getConsolidationThreshold(positionCount, responseCount) {
    const complexity = this.calculateComplexity({ responseCount });
    return this.getConsolidationThresholdByComplexity(complexity, positionCount, responseCount);
  }

  /**
   * Calculate optimal max LLM validations for consolidation
   * Limit expensive LLM calls based on dataset size
   * 
   * @param {number} positionCount - Number of positions
   * @returns {number} Max number of LLM validation calls
   */
  static getMaxConsolidationValidations(positionCount) {
    if (positionCount <= 5) return 10; // Small: validate all pairs
    if (positionCount <= 10) return 30; // Medium: validate top candidates
    if (positionCount <= 20) return 50; // Large: selective validation
    return 100; // Very large: cap validations
  }

  /**
   * Calculate multi-dimensional complexity score
   * Takes into account: count, length, semantic diversity
   * 
   * @param {Object} stats - Dataset statistics
   * @param {number} stats.responseCount - Number of responses
   * @param {number} stats.avgResponseLength - Average response length in words
   * @param {number} stats.semanticDiversity - Semantic diversity (0-1)
   * @param {number} stats.themeCount - Number of distinct themes
   * @returns {Object} Complexity assessment
   */
  static calculateComplexity(stats) {
    const {
      responseCount = 0,
      avgResponseLength = 100, // Default assumption
      semanticDiversity = 0.5, // Default medium diversity
      themeCount = 3 // Default assumption
    } = stats;

    // Volume score (0-1): How much data to process
    let volumeScore = 0;
    if (responseCount <= 5) volumeScore = 0.1;
    else if (responseCount <= 20) volumeScore = 0.3;
    else if (responseCount <= 50) volumeScore = 0.5;
    else if (responseCount <= 150) volumeScore = 0.7;
    else volumeScore = 1.0;

    // Length score (0-1): How detailed are responses
    let lengthScore = 0;
    if (avgResponseLength < 50) lengthScore = 0.1; // Very short (1-2 sentences)
    else if (avgResponseLength < 150) lengthScore = 0.3; // Short (few sentences)
    else if (avgResponseLength < 300) lengthScore = 0.5; // Medium
    else if (avgResponseLength < 600) lengthScore = 0.7; // Long
    else lengthScore = 1.0; // Very long

    // Diversity score (0-1): How different are responses from each other
    // High diversity = many different opinions, needs careful consolidation
    // Low diversity = mostly same opinion, aggressive consolidation OK
    const diversityScore = semanticDiversity;

    // Step 1: Adjust volumeScore based on diversity
    // When diversity is low, volume matters less (many similar responses = simpler case)
    if (diversityScore < 0.30) {
      volumeScore *= 0.4; // Very low diversity = volume matters much less
    } else if (diversityScore < 0.40) {
      volumeScore *= 0.6;
    } else if (diversityScore < 0.50) {
      volumeScore *= 0.8;
    }
    // Else: keep volumeScore as-is (diversity >= 0.50)

    // Theme score (0-1): How many different topics
    let themeScore = 0;
    if (themeCount <= 2) themeScore = 0.2;
    else if (themeCount <= 4) themeScore = 0.4;
    else if (themeCount <= 6) themeScore = 0.6;
    else if (themeCount <= 10) themeScore = 0.8;
    else themeScore = 1.0;

    // Step 2: Dynamic weight adjustment based on diversity
    // When diversity is low, increase diversity weight and decrease volume weight
    let volumeWeight, lengthWeight, diversityWeight, themeWeight;
    if (diversityScore < 0.35) {
      // Low diversity: prioritize diversity in calculation, reduce volume impact
      volumeWeight = 0.20;      // Reduced from 35%
      lengthWeight = 0.25;      // Keep same
      diversityWeight = 0.40;   // Increased from 25%
      themeWeight = 0.15;       // Keep same
    } else {
      // Normal weights
      volumeWeight = 0.35;
      lengthWeight = 0.25;
      diversityWeight = 0.25;
      themeWeight = 0.15;
    }

    // Weighted complexity score
    // Volume matters most, but diversity and length are important too
    let complexityScore = 
      (volumeScore * volumeWeight) +
      (lengthScore * lengthWeight) +
      (diversityScore * diversityWeight) +
      (themeScore * themeWeight);

    // Step 3: Add thematic simplicity cap
    // If diversity is very low, cap complexity to prevent "complex" classification
    if (diversityScore < 0.30 && complexityScore > 0.45) {
      complexityScore = 0.45; // Cap at moderate category threshold
    }

    // Determine complexity category with fine-grained sub-categories
    let category;
    let subCategory; // 'low', 'mid', 'high' within category
    let shouldMergeAcrossThemes = false;
    
    if (complexityScore < 0.15) {
      category = 'trivial';
      // Divide 0.00-0.15 into thirds
      if (complexityScore < 0.05) subCategory = 'low';
      else if (complexityScore < 0.10) subCategory = 'mid';
      else subCategory = 'high';
      shouldMergeAcrossThemes = true;
    } else if (complexityScore < 0.30) {
      category = 'simple';
      // Divide 0.15-0.30 into thirds
      if (complexityScore < 0.20) subCategory = 'low';
      else if (complexityScore < 0.25) subCategory = 'mid';
      else subCategory = 'high';
      shouldMergeAcrossThemes = true;
    } else if (complexityScore < 0.45) {
      category = 'moderate';
      // Divide 0.30-0.45 into thirds
      if (complexityScore < 0.35) subCategory = 'low';
      else if (complexityScore < 0.40) subCategory = 'mid';
      else subCategory = 'high';
      // CRITICAL: Also enable cross-theme for moderate if diversity is LOW
      // Low diversity = people agree, even if more responses
      shouldMergeAcrossThemes = diversityScore < 0.40;
    } else if (complexityScore < 0.65) {
      category = 'complex';
      // Divide 0.45-0.65 into thirds
      if (complexityScore < 0.52) subCategory = 'low';
      else if (complexityScore < 0.58) subCategory = 'mid';
      else subCategory = 'high';
      shouldMergeAcrossThemes = false;
    } else {
      category = 'very_complex';
      // Divide 0.65-1.00 into thirds
      if (complexityScore < 0.77) subCategory = 'low';
      else if (complexityScore < 0.88) subCategory = 'mid';
      else subCategory = 'high';
      shouldMergeAcrossThemes = false;
    }

    return {
      score: complexityScore,
      category,
      subCategory,
      shouldMergeAcrossThemes,
      breakdown: {
        volumeScore,
        lengthScore,
        diversityScore,
        themeScore
      }
    };
  }

  /**
   * Calculate threshold for cross-theme argument deduplication
   * Detect arguments that appear in multiple themes with high similarity
   * 
   * @param {Object} complexity - Complexity assessment from calculateComplexity
   * @returns {number} Similarity threshold (0-1) for deduplication
   */
  static getArgumentDeduplicationThreshold(complexity) {
    const { category, subCategory } = complexity;
    
    // For trivial/simple, use aggressive deduplication
    if (category === 'trivial' || category === 'simple') {
      return 0.88; // Aggressive - catch most cross-theme duplicates
    }
    
    // For moderate, be slightly more selective
    if (category === 'moderate') {
      if (subCategory === 'low') return 0.90;
      if (subCategory === 'mid') return 0.92;
      return 0.93; // Moderate-high: only catch very obvious duplicates
    }
    
    // For complex/very_complex, use very high threshold (only exact duplicates)
    return 0.95;
  }

  /**
   * Calculate threshold for sub-position harmonization (deduplication).
   * For mega-positions with many respondents, we need lower thresholds to
   * merge nearly-identical sub-positions, while still preserving distinct
   * reasoning dimensions (climate, cultural heritage, aesthetics, etc.).
   *
   * @param {Object} positionContext - Context about the position
   * @param {number} positionContext.respondentCount - Number of respondents in position
   * @param {number} [positionContext.subPositionCount] - Current number of sub-positions
   * @param {boolean} [positionContext.isMegaPosition] - Whether this is a mega-position
   * @returns {number} Similarity threshold (0-1) for harmonization
   */
  static getSubPositionHarmonizationThreshold(positionContext = {}) {
    const { respondentCount = 0, subPositionCount = 0, isMegaPosition = false } = positionContext;

    // Base threshold - conservative to preserve distinct reasoning types
    const BASE_THRESHOLD = 0.88;

    // For small positions, keep conservative threshold to preserve nuances
    if (respondentCount < 100) {
      return BASE_THRESHOLD;
    }

    // For medium positions (100-500), slight relaxation
    if (respondentCount < 500) {
      return 0.85;
    }

    // For large positions (500-1500), moderate relaxation
    if (respondentCount < 1500) {
      return 0.82;
    }

    // For very large positions (1500+), more aggressive but NOT too aggressive
    // 0.80 still preserves distinct reasoning dimensions (climate vs cultural heritage etc.)
    // Going below 0.78 would merge genuinely different arguments
    return 0.80;
  }

  /**
   * Handle mass agreement cases (like hearing 223)
   * Provides specific parameters for cases where many respondents have similar views
   * 
   * @param {Object} massAgreementAnalysis - Analysis from SimilarityAnalyzer
   * @param {Object} baseComplexity - Base complexity assessment
   * @returns {Object} Adjusted parameters for mass agreement cases
   */
  static handleMassAgreement(massAgreementAnalysis, baseComplexity) {
    if (!massAgreementAnalysis?.detected) {
      return null;
    }
    
    const { confidence, indicators } = massAgreementAnalysis;
    const adjustments = {};
    
    // Adjust consolidation strategy based on confidence
    if (confidence > 0.75) {
      adjustments.consolidationStrategy = 'full';
      adjustments.groupingStrategy = 'aggressive';
      adjustments.expectedPositionReduction = 0.8; // Expect 80% reduction
    } else if (confidence > 0.5) {
      adjustments.consolidationStrategy = 'selective';
      adjustments.groupingStrategy = 'moderate';
      adjustments.expectedPositionReduction = 0.6; // Expect 60% reduction
    }
    
    // Adjust batch sizes for efficiency with similar content
    if (indicators.largeClusters) {
      adjustments.aggregationBatchSize = 50; // Larger batches OK for similar content
      adjustments.positionWriterChunkSize = 50; // Can handle more respondents per chunk
    }
    
    // Enable hierarchical grouping for better organization
    adjustments.useHierarchicalGrouping = true;
    adjustments.minSubPositionSize = 3; // Create sub-positions for groups of 3+
    
    // Adjust theme mapping to be more lenient
    adjustments.themeDeduplicationThreshold = 0.75; // More aggressive deduplication
    
    return adjustments;
  }

  /**
   * Determine cross-theme consolidation strategy based on complexity
   * 
   * UPDATED: Now takes objectConcentration into account.
   * High object concentration (e.g., 90% of responses about "Palads") indicates
   * that respondents are discussing the same thing, even if spread across themes.
   * In such cases, cross-theme consolidation prevents duplicate positions.
   * 
   * @param {Object} complexity - Complexity assessment from calculateComplexity
   * @param {Object} massAgreementParams - Optional mass agreement detection results
   * @param {Object} objectConcentration - Object concentration analysis (from calculateObjectConcentration)
   * @returns {string} Strategy: 'full', 'selective', or 'none'
   */
  static getCrossThemeStrategy(complexity, massAgreementParams = null, objectConcentration = null) {
    const { category, subCategory, breakdown } = complexity;
    
    // PRIORITY 1: Object concentration override
    // When many responses focus on the SAME object (e.g., "Palads"), positions across
    // different themes likely discuss the same thing and MUST be consolidated.
    // This prevents "Generelle borgerbetingelser" (15 resp about Palads) from being
    // separate from "Ønske om bevaring af Palads" (467 resp about Palads).
    if (objectConcentration && objectConcentration.status !== 'NO_DATA') {
      if (objectConcentration.status === 'VERY_HIGH_CONCENTRATION') {
        // >80% of arguments about one object - definitely need cross-theme consolidation
        console.log(`[DynamicParameters] VERY_HIGH object concentration (${(objectConcentration.concentration * 100).toFixed(1)}%) - forcing 'selective' cross-theme strategy`);
        return 'selective'; // Use selective (not full) to still require LLM validation
      }
      if (objectConcentration.status === 'HIGH_CONCENTRATION' && objectConcentration.concentration > 0.6) {
        // 60-80% about one object - use selective cross-theme consolidation
        console.log(`[DynamicParameters] HIGH object concentration (${(objectConcentration.concentration * 100).toFixed(1)}%) - enabling 'selective' cross-theme strategy`);
        return 'selective';
      }
      // NEW: Check DOMINANT OBJECT PERCENTAGE directly (not just Herfindahl index)
      // If 40%+ of arguments mention the same physical object, enable cross-theme consolidation
      // even if the Herfindahl index is low due to many small objects
      const dominantObj = objectConcentration.dominantObjects?.[0];
      if (dominantObj && parseFloat(dominantObj.percentage) >= 40) {
        console.log(`[DynamicParameters] Dominant object "${dominantObj.object}" at ${dominantObj.percentage}% - enabling 'selective' cross-theme strategy`);
        return 'selective';
      }
    }
    
    // PRIORITY 2: Mass agreement detection (legacy)
    if (massAgreementParams?.detected && massAgreementParams?.confidence > 0.7) {
      return 'full';
    }
    
    // Full cross-theme merging for trivial/simple hearings
    if (category === 'trivial' || category === 'simple') {
      return 'full';
    }
    
    // Moderate complexity: use selective strategy
    // BUT: if diversity is very low, use full merging (original behavior)
    if (category === 'moderate') {
      if (breakdown?.diversityScore != null && breakdown.diversityScore < 0.40) {
        return 'full';
      }
      return 'selective';
    }
    
    // Complex-low with LOW diversity: use selective strategy (not none!)
    // This handles cases where response count is high, but people mostly agree
    if (category === 'complex' && subCategory === 'low' && breakdown?.diversityScore != null && breakdown.diversityScore < 0.35) {
      return 'selective';
    }
    
    // Complex/very_complex: no cross-theme merging (only within themes)
    return 'none';
  }

  /**
   * Extract object statistics from micro-summaries
   * Used to calculate object concentration for mass agreement cases
   * 
   * @param {Array} microSummaries - Array of micro-summary objects with arguments
   * @returns {Object} Object statistics for calculateObjectConcentration
   */
  static extractObjectStatsFromMicroSummaries(microSummaries) {
    if (!microSummaries || microSummaries.length === 0) {
      return null;
    }
    
    const objectFrequencies = {};
    let totalArguments = 0;
    
    // DYNAMIC physical objects and landmarks patterns
    // These are GENERIC patterns, not case-specific
    const objectPatterns = [
      // Buildings and structures (generic types)
      /\b(palads|rådhus|tårn|kirke|slot|museum|teater|biograf|bibliotek|station|skole|hospital|hal|arena|centrum|fabrik|silo|mølle|fyr|fyrtårn)\b/gi,
      // Areas and spaces
      /\b(park|plads|torv|gade|vej|allé|have|strand|sø|havn|område|kvarter|anlæg)\b/gi,
      // Infrastructure
      /\b(bro|tunnel|cykelsti|gangbro|viadukt|trappe|passage|sti)\b/gi,
      // Building parts (generic)
      /\b(facade|tag|stueetage|sal|indgang|kælder|loft|etage|spir|kuppel)\b/gi,
      // Compound Danish landmark names (Rundetårn, Marmorkirken, Frihedsmuseet, etc.)
      // Match word + one of the building types
      /\b([A-Za-zÆØÅæøå]+(?:tårn|kirke|slot|hus|museum|teater|palads|gård|borg|have|park|plads))\b/gi,
      // Named places with capital letter (Tivoli, Nyhavn, Strøget, etc.)
      /\b([A-ZÆØÅ][a-zæøå]{3,}(?:s)?(?:plads|park|torv|gade|vej|hus|gård|have|borg|slot)?)\b/g
    ];
    
    for (const summary of microSummaries) {
      if (!summary.arguments || !Array.isArray(summary.arguments)) continue;
      
      for (const arg of summary.arguments) {
        totalArguments++;
        
        // Build text to search in
        // IMPORTANT:
        // - Do NOT lowercase the full text before matching, otherwise capitalized-name patterns won't work.
        // - Count each matched object at most ONCE per argument (otherwise repeated mentions inflate counts
        //   and can lead to impossible percentages > 100%).
        const searchText = [arg.what, arg.why, arg.how, arg.argument, arg.summary]
          .filter(Boolean)
          .join(' ');
        
        // Deduplicate matches within the same argument
        const objectsMentionedInArg = new Set();
        
        // Extract objects using patterns
        // STOP WORDS: Common Danish words that should NOT be treated as physical objects
        // These often appear at the start of sentences and match the capitalized-word pattern
        const stopWords = new Set([
          // Common sentence starters
          'fordi', 'derfor', 'således', 'desuden', 'endvidere', 'imidlertid', 'nemlig',
          'altså', 'ligeledes', 'samtidig', 'herunder', 'hermed', 'herudover',
          // Common negations/adverbs
          'ikke', 'aldrig', 'også', 'måske', 'sandsynligvis', 'særligt', 'især',
          // Pronouns that might be capitalized
          'dette', 'disse', 'sådan', 'hvilket', 'hvad', 'hvor', 'hvordan', 'hvorfor',
          // Other common words
          'mange', 'flere', 'andre', 'samme', 'hele', 'alle', 'ingen', 'nogen',
          'både', 'enten', 'hverken', 'samt', 'eller', 'selv', 'efter', 'under',
          // Generic terms that aren't specific objects
          'byen', 'kommunen', 'projektet', 'forslaget',
          // ACTION WORDS that aren't physical objects (often start sentences)
          'bevar', 'bevare', 'bevaring', 'bevarelse', 'bevaringsværdig',
          'modstand', 'protest', 'afvis', 'afvise', 'afvisning',
          'støtte', 'støtter', 'opbakning', 'tilslutning',
          'krav', 'kræve', 'kræver', 'forlang', 'forlange',
          'ønske', 'ønsker', 'anmod', 'anmode', 'anmodning',
          'bekymring', 'bekymret', 'kritik', 'kritisere',
          'gennem', 'indarbejde', 'indføre', 'vedtage', 'gennemføre'
        ]);

        for (const pattern of objectPatterns) {
          const matches = searchText.match(pattern);
          if (matches) {
            for (const match of matches) {
              const normalized = match.toLowerCase().trim();
              // Filter out stop words to prevent common sentence starters from being treated as objects
              if (normalized && !stopWords.has(normalized)) {
                objectsMentionedInArg.add(normalized);
              }
            }
          }
        }
        
        // Increment frequency ONCE per object per argument
        for (const obj of objectsMentionedInArg) {
          objectFrequencies[obj] = (objectFrequencies[obj] || 0) + 1;
        }
      }
    }
    
    const uniqueObjects = Object.keys(objectFrequencies).length;
    
    if (uniqueObjects === 0) {
      return null;
    }
    
    return {
      uniqueObjects,
      totalArguments,
      objectFrequencies
    };
  }

  /**
   * Calculate object concentration
   * Measures how focused a hearing is on specific objects vs. many different objects
   * High concentration (e.g., Palads case) → enable hierarchical grouping
   * 
   * @param {Object} objectStats - Object-related statistics (or microSummaries array)
   * @param {number} objectStats.uniqueObjects - Number of unique objects mentioned
   * @param {number} objectStats.totalArguments - Total number of arguments
   * @param {Object} objectStats.objectFrequencies - Map of object -> count
   * @returns {Object} Object concentration analysis
   */
  static calculateObjectConcentration(objectStats) {
    // Auto-detect if we received microSummaries array instead of objectStats
    if (Array.isArray(objectStats)) {
      objectStats = this.extractObjectStatsFromMicroSummaries(objectStats);
    }
    
    const { uniqueObjects = null, totalArguments = 0, objectFrequencies = null } = objectStats || {};
    
    // If no object data, return neutral
    if (!uniqueObjects || !objectFrequencies || totalArguments === 0) {
      return {
        concentration: 0.5, // Neutral
        dominantObjects: [],
        status: 'NO_DATA'
      };
    }

    // Calculate concentration using Herfindahl index (0-1)
    // 1.0 = all arguments about same object
    // 0.0 = perfectly distributed across many objects
    const frequencies = Object.values(objectFrequencies);
    const herfindahl = frequencies.reduce((sum, count) => {
      const share = count / totalArguments;
      return sum + (share * share);
    }, 0);

    // Find dominant objects (>20% of arguments)
    const dominant = Object.entries(objectFrequencies)
      .filter(([obj, count]) => count / totalArguments > 0.2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([obj, count]) => ({
        object: obj,
        count,
        percentage: (count / totalArguments * 100).toFixed(1)
      }));

    let status;
    if (herfindahl > 0.8) {
      status = 'VERY_HIGH_CONCENTRATION'; // Like Palads (>80% same object)
    } else if (herfindahl > 0.6) {
      status = 'HIGH_CONCENTRATION';
    } else if (herfindahl > 0.4) {
      status = 'MODERATE_CONCENTRATION';
    } else if (herfindahl > 0.2) {
      status = 'LOW_CONCENTRATION';
    } else {
      status = 'VERY_LOW_CONCENTRATION'; // Many different objects
    }

    return {
      concentration: herfindahl,
      uniqueObjects,
      dominantObjects: dominant,
      status
    };
  }

  /**
   * Calculate relevance threshold for filtering tangential/irrelevant arguments.
   * Uses BGE reranker scores to determine if an argument is actually relevant
   * to the hearing topic or just tangential noise.
   * 
   * Dynamic scaling:
   * - Small hearings: Lower threshold (keep more, manual review easier)
   * - Large hearings: Higher threshold (filter aggressively to avoid noise flood)
   * 
   * @param {Object} complexity - Complexity assessment from calculateComplexity
   * @param {number} responseCount - Number of responses
   * @returns {number} Relevance threshold (0-1) - arguments below this are filtered
   */
  static getRelevanceThreshold(complexity, responseCount) {
    // Base threshold by hearing size
    // Small hearings can afford to keep more marginal content
    // Large hearings need aggressive filtering to prevent noise flood
    let baseThreshold;
    
    if (responseCount <= 10) {
      baseThreshold = 0.10; // Very permissive - tiny hearings
    } else if (responseCount <= 20) {
      baseThreshold = 0.15; // Permissive - small hearings
    } else if (responseCount <= 50) {
      baseThreshold = 0.20; // Mild filtering - medium hearings
    } else if (responseCount <= 150) {
      baseThreshold = 0.25; // Moderate filtering - large hearings
    } else if (responseCount <= 500) {
      baseThreshold = 0.30; // Aggressive filtering - very large hearings
    } else {
      baseThreshold = 0.35; // Very aggressive - mega hearings
    }
    
    // Adjust based on complexity/diversity
    // High diversity = many different topics, be more permissive
    // Low diversity = many similar arguments, can filter more aggressively
    if (complexity?.breakdown?.diversityScore > 0.6) {
      // High diversity - be more permissive (lower threshold)
      baseThreshold -= 0.05;
    } else if (complexity?.breakdown?.diversityScore < 0.3) {
      // Low diversity - can filter more (higher threshold)
      baseThreshold += 0.03;
    }
    
    // Clamp to reasonable range
    return Math.max(0.05, Math.min(0.40, baseThreshold));
  }

  /**
   * Get complete parameter set for a hearing
   * Single source of truth for all dynamic parameters
   * 
   * @param {Object} stats - Dataset statistics
   * @param {number} stats.responseCount - Number of responses
   * @param {number} stats.chunkCount - Number of chunks
   * @param {number} stats.argumentCount - Number of arguments (optional)
   * @param {number} stats.positionCount - Number of positions (optional)
   * @param {number} stats.avgResponseLength - Average response length in words (optional)
   * @param {number} stats.semanticDiversity - Semantic diversity 0-1 (optional)
   * @param {number} stats.themeCount - Number of distinct themes (optional)
   * @param {Object} stats.objectStats - Object concentration statistics (optional)
   * @returns {Object} Complete parameter set
   */
  static getParametersForHearing(stats) {
    const {
      responseCount = 0,
      chunkCount = 0,
      argumentCount = responseCount * 3, // Estimate if not provided
      positionCount = Math.ceil(responseCount * 0.5), // Estimate if not provided
      avgResponseLength = 100,
      semanticDiversity = 0.5,
      themeCount = 3,
      objectStats = null
    } = stats;

    // Calculate multi-dimensional complexity
    const complexity = this.calculateComplexity({
      responseCount,
      avgResponseLength,
      semanticDiversity,
      themeCount
    });

    const retrievalTopK = this.getRetrievalTopK(chunkCount, responseCount);
    const reRankTopK = this.getReRankTopK(retrievalTopK, responseCount);
    const argumentDeduplicationThreshold = this.getArgumentDeduplicationThreshold(complexity);
    
    // Calculate object concentration for hierarchical grouping decision
    // MUST be calculated BEFORE getCrossThemeStrategy as it influences the decision
    const objectConcentration = this.calculateObjectConcentration(objectStats);
    
    // Determine cross-theme strategy - now considers object concentration
    const crossThemeStrategy = this.getCrossThemeStrategy(complexity, null, objectConcentration);

    return {
      // Aggregation
      aggregation: {
        batchSize: this.getAggregationBatchSize(argumentCount),
        noBatching: argumentCount <= 10 || complexity.category === 'trivial'
      },

      // Retrieval
      retrieval: {
        topK: retrievalTopK,
        reRankTopK: reRankTopK,
        reRankEnabled: retrievalTopK > 10, // Only enable reranking when retrieving more than 10 chunks
        minScore: 0.6 // Keep constant
      },

      // Embedding - CRITICAL for avoiding "Connection error" timeouts
      embedding: {
        batchSize: this.getEmbeddingBatchSize(responseCount * 2), // 2x for chunks
        ...this.getEmbeddingConcurrency({
          responseCount,
          themeCount,
          argumentCount
        }),
        // Dynamic retry configuration based on hearing size
        ...this.getEmbeddingRetryConfig(responseCount)
      },

      // LLM Batching
      llmBatching: {
        edgeCaseScreening: this.getLLMBatchSize(responseCount, 'light'),
        microSummarization: this.getLLMBatchSize(responseCount, 'medium'),
        citationExtraction: this.getLLMBatchSize(positionCount, 'medium')
      },

      // Position Writing
      positionWriter: {
        maxRespondentsPerChunk: this.getPositionWriterChunkSize(responseCount)
      },

      // Theme Mapping
      themeMapping: {
        deduplicationEnabled: true, // Enable cross-theme argument deduplication
        deduplicationThreshold: argumentDeduplicationThreshold
      },

      // Relevance Filtering (post micro-summarize)
      relevance: {
        enabled: responseCount > 10, // Enable for hearings with >10 responses
        threshold: this.getRelevanceThreshold(complexity, responseCount),
        minArgumentsToKeep: Math.max(1, Math.floor(responseCount * 0.5)) // Keep at least 50% or 1
      },

      // Consolidation
      consolidation: {
        enabled: positionCount > 1, // Always enable if we have 2+ positions
        similarityThreshold: this.getConsolidationThresholdByComplexity(complexity, positionCount, responseCount),
        maxLLMValidations: this.getMaxConsolidationValidations(positionCount),
        mergeAcrossThemes: complexity.shouldMergeAcrossThemes, // Legacy field (deprecated)
        crossThemeStrategy // NEW: fine-grained strategy ('full', 'selective', 'none')
      },

      // Object Concentration (for hierarchical grouping)
      objectConcentration: objectConcentration,

      // Metadata
      _stats: {
        responseCount,
        chunkCount,
        argumentCount,
        positionCount,
        avgResponseLength,
        semanticDiversity,
        themeCount,
        scale: this._determineScale(responseCount)
      },
      _complexity: complexity
    };
  }

  /**
   * Determine hearing scale category
   * @private
   */
  static _determineScale(responseCount) {
    if (responseCount <= 5) return 'tiny';
    if (responseCount <= 20) return 'small';
    if (responseCount <= 50) return 'medium';
    if (responseCount <= 150) return 'large';
    return 'xlarge';
  }

  /**
   * Determine aggregation tier based on average arguments per theme.
   * This drives the aggregation strategy selection:
   * - SMALL (≤100): Direct LLM grouping (current approach)
   * - MEDIUM (100-500): Two-pass aggregation (K-means → LLM per cluster)
   * - LARGE (≥500): Hierarchical sampling + attribution
   *
   * @param {number} avgArgsPerTheme - Average number of arguments per theme
   * @returns {string} 'small', 'medium', or 'large'
   */
  static _determineAggregationTier(avgArgsPerTheme) {
    if (avgArgsPerTheme <= 100) return 'small';
    if (avgArgsPerTheme <= 500) return 'medium';
    return 'large';
  }

  /**
   * Calculate aggregation tier parameters based on hearing statistics.
   * Returns tier-specific configuration for the aggregator.
   *
   * @param {Object} stats - Dataset statistics
   * @param {number} stats.argumentCount - Total number of arguments
   * @param {number} stats.themeCount - Number of themes
   * @param {number} stats.responseCount - Number of responses (for tier validation)
   * @returns {Object} Aggregation tier configuration
   */
  static getAggregationTierConfig(stats) {
    const {
      argumentCount = 0,
      themeCount = 1,
      responseCount = 0
    } = stats;

    const avgArgsPerTheme = themeCount > 0 ? Math.ceil(argumentCount / themeCount) : argumentCount;
    const tier = this._determineAggregationTier(avgArgsPerTheme);

    const config = {
      tier,
      avgArgsPerTheme,

      // SMALL tier: Direct LLM grouping (current approach)
      // No changes needed, works well for small datasets
      small: {
        strategy: 'direct-llm',
        batchSize: this.getAggregationBatchSize(avgArgsPerTheme),
        useTwoPass: false,
        useSampling: false
      },

      // MEDIUM tier: Two-pass aggregation
      // Pass 1: K-means clustering
      // Pass 2: LLM grouping per cluster
      medium: {
        strategy: 'two-pass',
        useTwoPass: true,
        useSampling: false,
        // K = sqrt(N) * 0.8 for initial clustering
        targetClusterCount: Math.ceil(Math.sqrt(avgArgsPerTheme) * 0.8),
        // Max cluster size before subdivision
        maxClusterSize: 40,
        // Subdivision uses K that targets ~25 args per cluster
        subdivisionTargetSize: 25,
        // Never subdivide recursively - one level only
        maxSubdivisionDepth: 1
      },

      // LARGE tier: Hierarchical sampling + attribution
      // Phase 1: Stratified sampling
      // Phase 2: Build skeleton positions from sample
      // Phase 3: Attribute remaining via embedding similarity
      large: {
        strategy: 'hierarchical-sampling',
        useTwoPass: true, // For skeleton building
        useSampling: true,
        // Sample size: min(200, 10% of arguments)
        sampleSize: Math.min(200, Math.ceil(avgArgsPerTheme * 0.1)),
        // Attribution similarity threshold
        attributionThreshold: 0.75,
        // Minimum similarity to attribute (below this → secondary LLM pass)
        attributionFloor: 0.60,
        // Use direction for hard constraint on attribution
        respectDirectionInAttribution: true
      }
    };

    // Log the selected tier
    console.log(`[DynamicParameters] Aggregation tier: ${tier.toUpperCase()} (${avgArgsPerTheme} avg args/theme)`);
    if (tier === 'medium') {
      console.log(`[DynamicParameters]   Two-pass: K=${config.medium.targetClusterCount}, maxCluster=${config.medium.maxClusterSize}`);
    } else if (tier === 'large') {
      console.log(`[DynamicParameters]   Sampling: N=${config.large.sampleSize}, threshold=${config.large.attributionThreshold}`);
    }

    return config;
  }

  /**
   * Calculate argument-to-position explosion ratio and suggest threshold adjustments
   * This is a feedback mechanism to detect if we're creating too many positions
   * 
   * @param {number} argumentCount - Total number of arguments
   * @param {number} positionCount - Total number of positions created
   * @param {number} currentThreshold - Current consolidation threshold
   * @returns {Object} Analysis with suggested threshold adjustment
   */
  static analyzeExplosionRatio(argumentCount, positionCount, currentThreshold) {
    if (argumentCount === 0) {
      return { 
        ratio: 0, 
        status: 'N/A', 
        suggestedAdjustment: 0, 
        suggestedThreshold: currentThreshold 
      };
    }
    
    const ratio = positionCount / argumentCount;
    let status;
    let suggestedAdjustment = 0;
    
    if (ratio > 0.7) {
      status = 'TOO_MANY_POSITIONS';
      suggestedAdjustment = -0.03; // Be more aggressive (lower threshold = merge more)
    } else if (ratio > 0.5) {
      status = 'SLIGHTLY_HIGH';
      suggestedAdjustment = -0.01; // Slightly more aggressive
    } else if (ratio < 0.3) {
      status = 'GOOD_CONSOLIDATION';
      suggestedAdjustment = 0; // Keep current threshold
    } else if (ratio < 0.4) {
      status: 'OPTIMAL';
      suggestedAdjustment = 0; // Optimal range
    } else {
      status = 'ACCEPTABLE';
      suggestedAdjustment = 0;
    }
    
    const suggestedThreshold = Math.max(0.60, Math.min(0.90, currentThreshold + suggestedAdjustment));
    
    return {
      ratio,
      status,
      suggestedAdjustment,
      suggestedThreshold,
      message: this._getExplosionRatioMessage(ratio, status, suggestedAdjustment)
    };
  }

  /**
   * Generate human-readable message for explosion ratio analysis
   * @private
   */
  static _getExplosionRatioMessage(ratio, status, adjustment) {
    const ratioPercent = (ratio * 100).toFixed(1);
    
    if (status === 'TOO_MANY_POSITIONS') {
      return `Explosion ratio ${ratioPercent}% is too high - consider lowering threshold by ${Math.abs(adjustment).toFixed(2)} for next iteration`;
    } else if (status === 'SLIGHTLY_HIGH') {
      return `Explosion ratio ${ratioPercent}% is slightly high - minor adjustment suggested`;
    } else if (status === 'GOOD_CONSOLIDATION') {
      return `Explosion ratio ${ratioPercent}% is good - effective consolidation`;
    } else if (status === 'OPTIMAL') {
      return `Explosion ratio ${ratioPercent}% is optimal - maintain current threshold`;
    } else {
      return `Explosion ratio ${ratioPercent}% is acceptable`;
    }
  }

  /**
   * Log parameter decisions for debugging
   */
  static logParameters(params, logger = console) {
    const complexity = params._complexity || {};
    const stats = params._stats || {};
    
    const complexityLabel = complexity.subCategory 
      ? `${complexity.category}-${complexity.subCategory}` 
      : complexity.category || 'unknown';
    
    logger.log(`[DynamicParameters] Complexity: ${complexityLabel} (score: ${(complexity.score || 0).toFixed(3)})`);
    logger.log(`[DynamicParameters]   - Volume: ${(complexity.breakdown?.volumeScore || 0).toFixed(2)} (${stats.responseCount} responses)`);
    logger.log(`[DynamicParameters]   - Length: ${(complexity.breakdown?.lengthScore || 0).toFixed(2)} (avg ${stats.avgResponseLength} words)`);
    logger.log(`[DynamicParameters]   - Diversity: ${(complexity.breakdown?.diversityScore || 0).toFixed(2)}`);
    logger.log(`[DynamicParameters]   - Themes: ${(complexity.breakdown?.themeScore || 0).toFixed(2)} (${stats.themeCount} themes)`);
    logger.log(`[DynamicParameters] Aggregation: ${params.aggregation.noBatching ? 'NO BATCHING' : `batch=${params.aggregation.batchSize}`}`);
    logger.log(`[DynamicParameters] Retrieval: topK=${params.retrieval.topK}, reRank=${params.retrieval.reRankTopK}`);
    logger.log(`[DynamicParameters] Consolidation: enabled=${params.consolidation.enabled}, strategy=${params.consolidation.crossThemeStrategy || 'legacy'}, threshold=${params.consolidation.similarityThreshold.toFixed(3)}`);
    logger.log(`[DynamicParameters] Embedding: globalConcurrency=${params.embedding.globalMaxConcurrency}, batchConcurrency=${params.embedding.batchMaxConcurrency}, themeConcurrency=${params.embedding.themeLevelConcurrency}`);
    
    // Log object concentration if available
    if (params.objectConcentration && params.objectConcentration.status !== 'NO_DATA') {
      const objConc = params.objectConcentration;
      logger.log(`[DynamicParameters] Object Concentration: ${objConc.status} (${(objConc.concentration * 100).toFixed(1)}%)`);
      if (objConc.dominantObjects.length > 0) {
        const dominant = objConc.dominantObjects.map(o => `${o.object} (${o.percentage}%)`).join(', ');
        logger.log(`[DynamicParameters]   - Dominant: ${dominant}`);
      }
    }
  }

  /**
   * Get optimal verbosity and reasoning effort for a position
   * Automatically scales based on position size and consolidation
   * @param {Object} position - Position object with responseNumbers and _mergeCount
   * @returns {Object} { verbosity, reasoningEffort }
   */
  static getVerbosityForPosition(position) {
    const respondentCount = position.responseNumbers?.length || 0;
    const mergeCount = position._mergeCount || 1;
    
    // DRASTICALLY lower thresholds - almost everything gets high verbosity
    // Goal: LONG detailed summaries that show all sub-arguments WITHIN the position
    if (respondentCount > 20 || mergeCount > 5) {
      // High verbosity for most positions (was >50)
      return { verbosity: 'high', reasoningEffort: 'medium' };
    } else if (respondentCount > 10 || mergeCount > 3) {
      // Medium verbosity for moderate positions (was >15)
      return { verbosity: 'medium', reasoningEffort: 'medium' };
    }
    // Only tiny positions get medium-plus settings (low verbosity, low reasoning)
    // This matches the medium-plus complexity level in env configuration
    return { verbosity: 'low', reasoningEffort: 'low' };
  }

  /**
   * Determine if a position should have sub-positions extracted
   * Based on argument diversity, not purely numeric thresholds
   * 
   * CRITICAL CHANGE: Now uses hybrid diversity measurement instead of count-based logic.
   * Even 2-3 people with fundamentally different begrundelser should get sub-positions.
   * 
   * @param {Object} position - Position object
   * @param {Object} options - Additional context
   * @returns {boolean} Should extract sub-positions
   */
  static shouldExtractSubPositions(position, options = {}) {
    const respondentCount = position.responseNumbers?.length || 0;
    const mergeCount = position._mergeCount || 1;
    const mergedFromCount = position._mergedFrom?.length || 0;
    const { massAgreementDetected = false, objectConcentration = null, argumentDiversity = null } = options;
    
    // HYBRID APPROACH: Trigger on diversity score, not just merge count
    // This ensures we capture sub-arguments even when positions weren't heavily merged
    
    // 1. HIGH DIVERSITY ALWAYS TRIGGERS (most important signal)
    // Score > 0.35 indicates meaningful diversity in reasoning/arguments
    // This catches cases where people agree on WHAT but differ on WHY/HOW
    if (argumentDiversity?.score > 0.35) {
      return true;
    }
    
    // 2. MERGED POSITIONS (FIXED: use >= 3 instead of > 3)
    // If we have merged 3+ positions, there were likely distinct arguments that need sub-positioning
    // Also check _mergedFrom array as alternative signal
    if (mergeCount >= 3 || mergedFromCount >= 3) {
      return true;
    }
    
    // 3. MASS AGREEMENT with enough respondents
    // Look for nuanced differences even when people broadly agree
    if (massAgreementDetected && respondentCount > 5) {
      return true;
    }
    
    // 4. HIGH OBJECT CONCENTRATION with moderate diversity
    // When many discuss the same object, there may be different angles
    const highObjectConcentration = objectConcentration?.concentration > 0.6;
    if (highObjectConcentration && argumentDiversity?.score > 0.25) {
      return true;
    }
    
    // 5. LARGE SINGLE POSITIONS with any diversity signal
    // For unmerged but large positions, extract if there's any evidence of diversity
    if (mergeCount === 1 && respondentCount > 10) {
      // More lenient threshold for large positions
      if (argumentDiversity?.score > 0.25 || highObjectConcentration) {
        return true;
      }
    }
    
    // 6. MODERATE MERGE COUNT with diversity indication
    // Even mergeCount of 2 can indicate important sub-arguments if there's diversity
    if (mergeCount >= 2 && argumentDiversity?.score > 0.20) {
      return true;
    }
    
    // 7. NEW: Positions with 5+ respondents where _mergedFrom shows distinct original titles
    // This catches cases where mergeCount might be low but original positions had distinct focuses
    if (respondentCount >= 5 && mergedFromCount >= 2) {
      // Check if original titles suggest different focuses
      const originalTitles = position._mergedFrom || [];
      const hasDistinctFocuses = this._detectDistinctFocusesInTitles(originalTitles);
      if (hasDistinctFocuses) {
        return true;
      }
    }
    
    return false;
  }
  
  /**
   * Detect if merged position titles suggest distinctly different focuses
   * @private
   */
  static _detectDistinctFocusesInTitles(titles) {
    if (!titles || titles.length < 2) return false;
    
    // Keywords that indicate distinct focuses
    const focusKeywords = {
      støj: ['støj', 'larm', 'gene'],
      trafik: ['trafik', 'vej', 'kørsel', 'parkering'],
      højde: ['højde', 'etage', 'meter', 'høj'],
      placering: ['placering', 'flytte', 'flyttes', 'placeres'],
      boldbane: ['boldbane', 'boldbur', 'bold'],
      skole: ['skole', 'undervisning'],
      bolig: ['bolig', 'beboer', 'nabo']
    };
    
    // Check which focus categories are mentioned in titles
    const foundCategories = new Set();
    
    for (const title of titles) {
      const lowerTitle = title.toLowerCase();
      for (const [category, keywords] of Object.entries(focusKeywords)) {
        if (keywords.some(kw => lowerTitle.includes(kw))) {
          foundCategories.add(category);
        }
      }
    }
    
    // If we have 2+ distinct focus categories, titles suggest different focuses
    return foundCategories.size >= 2;
  }
  
  /**
   * Calculate optimal sub-position parameters
   * @param {Object} position - Position object
   * @param {Object} context - Additional context (mass agreement, object concentration, etc.)
   * @returns {Object} Sub-position extraction parameters
   */
  static getSubPositionParameters(position, context = {}) {
    const respondentCount = position.responseNumbers?.length || 0;
    const { massAgreementDetected = false, objectConcentration = null } = context;
    
    // Base parameters - err on the side of more detail
    let minSubPositions = 2; // Capture nuances if they exist, but don't force too many
    let maxSubPositions = 8; // Allow reasonable breakdown
    let minRespondentsPerSubPosition = 1; // CRITICAL: Even 1 person's unique argument matters
    let overlapAllowed = true;
    
    // Adjust for mass agreement
    if (massAgreementDetected && respondentCount > 30) {
      minSubPositions = 4; // Extract some nuances in large unified groups
      maxSubPositions = 12; // Allow extensive granularity
      // Keep minRespondentsPerSubPosition at 1 - unique arguments matter regardless of support
    }
    
    // Adjust for high object concentration
    if (objectConcentration?.concentration > 0.8) {
      // Very focused discussion (like Palads) - extract more nuanced views
      minSubPositions = 4; // Ensure we capture angles but don't force too many
      maxSubPositions = 15; // Allow maximum detail
      overlapAllowed = true; // Same person may have multiple nuanced views
    }
    
    // Adjust for very large positions
    if (respondentCount > 40) {
      // Do NOT force high minimum - allow natural clustering
      minSubPositions = Math.max(minSubPositions, 4); // At least 4 sub-positions for large groups, but not 10
      maxSubPositions = Math.min(15, Math.max(8, Math.ceil(respondentCount / 5))); // Cap at 15
    }
    
    return {
      minSubPositions,
      maxSubPositions,
      minRespondentsPerSubPosition, // Always 1 - content uniqueness matters, not count
      overlapAllowed,
      extractionStrategy: massAgreementDetected ? 'nuanced' : 'standard',
      focusAreas: ['what', 'why', 'how'] // What is wanted, why, and how
    };
  }

  /**
   * Calculate optimal clustering parameters for sub-position extraction
   * 
   * DYNAMIC: Adapts to hearing characteristics - no hardcoded values.
   * Solves the problem of k-means producing skewed clusters (e.g., 305 + 145 + 5 + 3...)
   * by calculating appropriate k AND enforcing max cluster size with post-split.
   * 
   * @param {Object} position - Position being processed
   * @param {Object} context - Hearing context (diversity, concentration, etc.)
   * @returns {Object} Clustering parameters for k-means and post-processing
   */
  static getSubPositionClusteringParameters(position, context = {}) {
    const respondentCount = position.responseNumbers?.length || 0;
    const mergeCount = position._mergeCount || 1;
    const {
      massAgreementDetected = false,
      objectConcentration = null,
      argumentDiversity = null,  // Position-specific diversity score (0-1)
      complexity = null          // Hearing-level complexity assessment
    } = context;

    // === 1. EXTRACT KEY FACTORS ===
    const diversityScore = argumentDiversity?.score ?? 0.5;
    const concentration = objectConcentration?.concentration ?? 0.5;
    const hearingDiversity = complexity?.breakdown?.diversityScore ?? 0.5;
    
    // Use max of position-specific and hearing-level diversity
    const effectiveDiversity = Math.max(diversityScore, hearingDiversity);

    // === 2. CALCULATE TARGET CLUSTER SIZE ===
    // Based on: How many respondents should ideally be in each sub-position?
    // 
    // High diversity (>0.6): ~25 per cluster - many distinct viewpoints to capture
    // Medium diversity (0.4-0.6): ~35 per cluster - moderate variation
    // Low diversity (<0.4): ~45 per cluster - similar viewpoints, less granularity needed
    let targetClusterSize;
    if (effectiveDiversity > 0.6) {
      targetClusterSize = 25;
    } else if (effectiveDiversity > 0.4) {
      targetClusterSize = 35;
    } else {
      targetClusterSize = 45;
    }
    
    // Adjust for object concentration
    // High concentration = everyone talks about same object → need finer granularity
    if (concentration > 0.7) {
      targetClusterSize = Math.min(targetClusterSize, 30);
    }
    
    // Adjust for mass agreement - find subtle differences
    if (massAgreementDetected) {
      targetClusterSize = Math.min(targetClusterSize, 35);
    }

    // === 3. CALCULATE TARGET K (number of clusters) ===
    const baseK = Math.ceil(respondentCount / targetClusterSize);
    
    // Apply reasonable bounds
    // Min: at least 3 clusters, or mergeCount if we merged many positions
    const minK = Math.max(3, Math.min(mergeCount, 8));
    // Max: never average less than 8 respondents per cluster initially
    const maxK = Math.min(30, Math.ceil(respondentCount / 8));
    
    const targetK = Math.max(minK, Math.min(maxK, baseK));

    // === 4. MAX CLUSTER SIZE (CRITICAL for post-split) ===
    // K-means does NOT guarantee even distribution!
    // This is the HARD LIMIT - clusters exceeding this will be split recursively
    //
    // Scales with hearing size to avoid explosion of tiny sub-positions
    let maxClusterSize;
    if (respondentCount <= 50) {
      maxClusterSize = 20;  // Small hearings: tight limit, more detail per respondent OK
    } else if (respondentCount <= 150) {
      maxClusterSize = 30;  // Medium hearings
    } else if (respondentCount <= 400) {
      maxClusterSize = 40;  // Large hearings
    } else {
      maxClusterSize = 50;  // Very large hearings: slightly relaxed
    }
    
    // Tighten for high concentration cases (like Palads)
    // Same object discussed → need finer sub-divisions
    if (concentration > 0.8) {
      maxClusterSize = Math.min(maxClusterSize, 35);
    }
    
    // Tighten for very high diversity
    if (effectiveDiversity > 0.7) {
      maxClusterSize = Math.min(maxClusterSize, 35);
    }

    // === 5. SPLITTING PARAMETERS ===
    // When a cluster exceeds maxClusterSize, how to split it?
    const subClusterTargetSize = Math.ceil(maxClusterSize * 0.7); // Target ~70% of max for safety margin
    
    const result = {
      // Primary clustering parameters
      targetK,
      targetClusterSize,
      maxClusterSize,
      minClusterSize: 1, // Keep single-respondent nuances
      
      // Post-clustering split parameters
      splitLargeClusters: {
        enabled: true,
        threshold: maxClusterSize,
        subClusterTargetSize,
        minSplitK: 2,   // Split into at least 2
        maxSplitK: 8    // Never split into more than 8 sub-clusters
      },
      
      // Metadata for logging/debugging
      _factors: {
        diversityScore: effectiveDiversity,
        concentration,
        massAgreement: massAgreementDetected,
        mergeCount,
        respondentCount
      }
    };
    
    console.log(`[DynamicParameters] Clustering params for ${respondentCount} respondents: k=${targetK}, maxSize=${maxClusterSize}, targetSize=${targetClusterSize} (diversity=${effectiveDiversity.toFixed(2)}, conc=${concentration.toFixed(2)})`);
    
    return result;
  }
}

