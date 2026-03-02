/**
 * Argument Deduplicator
 *
 * Identifies and handles semantically duplicate arguments that appear across
 * multiple positions. Each argument should only be fully explained in ONE
 * position (the "primary" position), while other occurrences are marked as
 * "secondary" to prevent redundant explanations in the output.
 *
 * Strategy:
 * 1. Build fingerprints for all arguments across all positions
 * 2. Find clusters of semantically similar arguments using embeddings
 * 3. For each cluster, select a "primary" position based on scoring criteria
 * 4. Mark all other occurrences as "secondary" (respondent still counts, but
 *    the argument won't be explained in those positions)
 */

import { EmbeddingService } from '../embedding/embedding-service.js';
import { StepLogger } from '../utils/step-logger.js';

export class ArgumentDeduplicator {
  constructor(options = {}) {
    this.log = new StepLogger('ArgumentDeduplicator');
    this.embeddingService = new EmbeddingService(options.embedding || {});

    // Similarity threshold for considering arguments as duplicates
    // 0.85 is conservative - only very similar arguments will be grouped
    this.similarityThreshold = options.similarityThreshold || 0.85;

    // Minimum argument length to consider for deduplication
    // Very short arguments are too generic to deduplicate reliably
    this.minArgumentLength = options.minArgumentLength || 30;

    // Maximum number of arguments to process (performance guard)
    this.maxArgumentsToProcess = options.maxArgumentsToProcess || 5000;
  }

  /**
   * Deduplicate arguments across positions
   * @param {Array} sortedThemes - Themes with sorted positions (from sort-positions step)
   * @param {Array} microSummaries - Micro-summaries with arguments
   * @param {Object} options - Additional options
   * @returns {Promise<Array>} Themes with deduplication metadata on arguments
   */
  async deduplicate(sortedThemes, microSummaries, options = {}) {
    this.log.start({
      themes: sortedThemes.length,
      totalPositions: sortedThemes.reduce((sum, t) => sum + (t.positions?.length || 0), 0)
    });

    // Step 1: Build global argument registry with fingerprints
    const registry = this.buildArgumentRegistry(sortedThemes, microSummaries);
    this.log.metric('Arguments registered', registry.length);

    if (registry.length === 0) {
      this.log.warn('No arguments to deduplicate');
      return sortedThemes;
    }

    if (registry.length > this.maxArgumentsToProcess) {
      this.log.warn(`Too many arguments (${registry.length} > ${this.maxArgumentsToProcess}), processing first ${this.maxArgumentsToProcess}`);
      registry.splice(this.maxArgumentsToProcess);
    }

    // Step 2: Embed all arguments and find duplicate clusters
    const clusters = await this.findDuplicateClusters(registry);
    this.log.metric('Duplicate clusters found', clusters.length);

    if (clusters.length === 0) {
      this.log.info('No duplicate arguments found');
      return sortedThemes;
    }

    // Step 3: For each cluster, assign primary/secondary status
    const deduplicationMap = this.assignPrimaryPositions(clusters, sortedThemes);
    this.log.metric('Arguments marked as secondary', deduplicationMap.secondary.size);

    // Step 4: Apply deduplication metadata to positions
    const deduplicatedThemes = this.applyDeduplicationMetadata(
      sortedThemes,
      deduplicationMap,
      clusters  // Pass clusters for reverse lookup
    );

    // Step 5: Validate that respondent coverage is maintained
    this.validateCoverage(deduplicatedThemes, microSummaries);

    this.log.complete({
      duplicateClusters: clusters.length,
      secondaryArguments: deduplicationMap.secondary.size,
      primaryArguments: deduplicationMap.primary.size
    });

    return deduplicatedThemes;
  }

  /**
   * Build a registry of all arguments across all positions
   * @param {Array} themes - Themes with positions
   * @param {Array} microSummaries - Micro-summaries
   * @returns {Array} Registry of arguments with location info
   */
  buildArgumentRegistry(themes, microSummaries) {
    const registry = [];
    let argumentId = 0;

    // Build lookup for micro-summaries
    const summaryMap = new Map(
      microSummaries.map(ms => [ms.responseNumber, ms])
    );

    for (const theme of themes) {
      for (const position of (theme.positions || [])) {
        // Get arguments from sourceArgumentRefs (preferred) or extract from micro-summaries
        const positionArgs = this.getPositionArguments(position, summaryMap);

        for (const arg of positionArgs) {
          const fingerprint = this.buildArgumentFingerprint(arg);

          // Skip very short/generic arguments
          if (fingerprint.length < this.minArgumentLength) {
            continue;
          }

          registry.push({
            id: `ARG_${String(argumentId++).padStart(4, '0')}`,
            fingerprint,
            argument: arg,
            theme: theme.name,
            positionTitle: position.title,
            responseNumber: arg.responseNumber,
            direction: arg.direction || 'unknown',
            sourceQuoteRef: arg.sourceQuoteRef
          });
        }
      }
    }

    return registry;
  }

  /**
   * Get arguments for a position from sourceArgumentRefs or micro-summaries
   * @private
   */
  getPositionArguments(position, summaryMap) {
    const args = [];
    const seen = new Set();

    // Use sourceArgumentRefs if available (most accurate)
    if (position.sourceArgumentRefs && position.sourceArgumentRefs.length > 0) {
      for (const ref of position.sourceArgumentRefs) {
        const key = `${ref.responseNumber}:${ref.sourceQuoteRef || ref.what}`;
        if (seen.has(key)) continue;
        seen.add(key);

        args.push({
          responseNumber: ref.responseNumber,
          what: ref.what || '',
          why: ref.why || '',
          how: ref.how || '',
          concern: ref.concern || '',
          consequence: ref.consequence || '',
          direction: ref.direction || 'unknown',
          sourceQuoteRef: ref.sourceQuoteRef,
          relevantThemes: ref.relevantThemes || []
        });
      }
    } else {
      // Fallback: Get from micro-summaries for this position's response numbers
      for (const responseNumber of (position.responseNumbers || [])) {
        const summary = summaryMap.get(responseNumber);
        if (!summary?.arguments) continue;

        for (const arg of summary.arguments) {
          const key = `${responseNumber}:${arg.sourceQuoteRef || arg.what}`;
          if (seen.has(key)) continue;
          seen.add(key);

          args.push({
            responseNumber,
            what: arg.what || '',
            why: arg.why || '',
            how: arg.how || '',
            concern: arg.concern || '',
            consequence: arg.consequence || '',
            direction: arg.direction || 'unknown',
            sourceQuoteRef: arg.sourceQuoteRef,
            relevantThemes: arg.relevantThemes || []
          });
        }
      }
    }

    return args;
  }

  /**
   * Build a fingerprint string for an argument
   * Combines semantic fields to create a comparable string
   * @param {Object} arg - Argument object
   * @returns {string} Fingerprint string
   */
  buildArgumentFingerprint(arg) {
    const parts = [
      arg.what || '',
      arg.why || '',
      arg.concern || ''
    ].filter(Boolean);

    return parts.join(' | ').toLowerCase().trim();
  }

  /**
   * Find clusters of duplicate arguments using embeddings
   * @param {Array} registry - Argument registry
   * @returns {Promise<Array>} Array of clusters, each containing duplicate arguments
   */
  async findDuplicateClusters(registry) {
    if (registry.length === 0) return [];

    // Stage 1: Fast pre-filtering by text similarity
    const preGroups = this.preFilterByTextSimilarity(registry);
    this.log.metric('Pre-filter groups', preGroups.length);

    // Stage 2: Embed and verify with cosine similarity
    const clusters = [];

    for (const group of preGroups) {
      if (group.length < 2) continue;

      // Embed all arguments in this pre-group
      const fingerprints = group.map(item => item.fingerprint);
      let embeddings;

      try {
        embeddings = await this.embeddingService.embedBatch(fingerprints);
      } catch (error) {
        this.log.warn(`Embedding failed for group: ${error.message}`);
        continue;
      }

      // Find clusters within this pre-group using cosine similarity
      const groupClusters = this.clusterByEmbedding(group, embeddings);
      clusters.push(...groupClusters);
    }

    return clusters;
  }

  /**
   * Pre-filter arguments by text similarity (fast, no embeddings)
   * Groups arguments that have significant word overlap
   * @param {Array} registry - Full argument registry
   * @returns {Array} Groups of potentially similar arguments
   */
  preFilterByTextSimilarity(registry) {
    const groups = [];
    const assigned = new Set();

    // Sort by fingerprint length for efficiency
    const sorted = [...registry].sort(
      (a, b) => a.fingerprint.length - b.fingerprint.length
    );

    for (let i = 0; i < sorted.length; i++) {
      if (assigned.has(sorted[i].id)) continue;

      const group = [sorted[i]];
      assigned.add(sorted[i].id);

      const wordsA = new Set(sorted[i].fingerprint.split(/\s+/).filter(w => w.length > 3));

      for (let j = i + 1; j < sorted.length; j++) {
        if (assigned.has(sorted[j].id)) continue;

        // Quick length check
        const lenRatio = sorted[j].fingerprint.length / sorted[i].fingerprint.length;
        if (lenRatio > 2 || lenRatio < 0.5) continue;

        // Word overlap check
        const wordsB = new Set(sorted[j].fingerprint.split(/\s+/).filter(w => w.length > 3));
        const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
        const union = new Set([...wordsA, ...wordsB]).size;
        const jaccard = union > 0 ? intersection / union : 0;

        // Also check for direction conflict - don't group opposing directions
        if (sorted[i].direction && sorted[j].direction) {
          const directionConflict =
            (sorted[i].direction === 'pro_change' && sorted[j].direction === 'pro_status_quo') ||
            (sorted[i].direction === 'pro_status_quo' && sorted[j].direction === 'pro_change');
          if (directionConflict) continue;
        }

        if (jaccard > 0.4) {
          group.push(sorted[j]);
          assigned.add(sorted[j].id);
        }
      }

      if (group.length >= 2) {
        groups.push(group);
      }
    }

    return groups;
  }

  /**
   * Cluster arguments within a pre-group by embedding similarity
   * @param {Array} group - Pre-filtered group of arguments
   * @param {Array} embeddings - Corresponding embeddings
   * @returns {Array} Clusters of semantically similar arguments
   */
  clusterByEmbedding(group, embeddings) {
    const clusters = [];
    const assigned = new Set();

    for (let i = 0; i < group.length; i++) {
      if (assigned.has(i)) continue;

      const cluster = [{ ...group[i], embeddingIndex: i }];
      assigned.add(i);

      for (let j = i + 1; j < group.length; j++) {
        if (assigned.has(j)) continue;

        const similarity = this.cosineSimilarity(embeddings[i], embeddings[j]);

        if (similarity >= this.similarityThreshold) {
          cluster.push({ ...group[j], embeddingIndex: j });
          assigned.add(j);
        }
      }

      if (cluster.length >= 2) {
        clusters.push(cluster);
      }
    }

    return clusters;
  }

  /**
   * Calculate cosine similarity between two vectors
   * @param {Array} a - First vector
   * @param {Array} b - Second vector
   * @returns {number} Cosine similarity (0 to 1)
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
    return denom > 0 ? dotProduct / denom : 0;
  }

  /**
   * Assign primary/secondary status to arguments in each cluster
   * @param {Array} clusters - Duplicate clusters
   * @param {Array} themes - Original themes for context
   * @returns {Object} Maps of primary and secondary argument IDs
   */
  assignPrimaryPositions(clusters, themes) {
    const primary = new Map(); // argumentId -> cluster info
    const secondary = new Map(); // argumentId -> { primaryArgumentId, primaryPosition }

    // Build position metadata lookup for scoring
    const positionMeta = this.buildPositionMetadata(themes);

    for (const cluster of clusters) {
      // Score each argument's position as a potential primary
      const scored = cluster.map(arg => ({
        ...arg,
        score: this.scorePositionAsPrimary(arg, positionMeta)
      }));

      // Sort by score (highest first)
      scored.sort((a, b) => b.score - a.score);

      // First one is primary
      const primaryArg = scored[0];
      primary.set(primaryArg.id, {
        theme: primaryArg.theme,
        positionTitle: primaryArg.positionTitle,
        score: primaryArg.score
      });

      // Rest are secondary
      for (let i = 1; i < scored.length; i++) {
        const secondaryArg = scored[i];
        secondary.set(secondaryArg.id, {
          primaryArgumentId: primaryArg.id,
          primaryPosition: {
            theme: primaryArg.theme,
            title: primaryArg.positionTitle
          },
          originalScore: secondaryArg.score
        });
      }
    }

    return { primary, secondary };
  }

  /**
   * Build metadata about positions for scoring
   * @param {Array} themes - Themes with positions
   * @returns {Map} Position title -> metadata
   */
  buildPositionMetadata(themes) {
    const meta = new Map();

    for (const theme of themes) {
      for (const position of (theme.positions || [])) {
        const key = `${theme.name}::${position.title}`;
        meta.set(key, {
          theme: theme.name,
          title: position.title,
          respondentCount: position.responseNumbers?.length || 0,
          isOtherTheme: theme.name.toLowerCase().includes('andre') ||
                        theme.name.toLowerCase().includes('other')
        });
      }
    }

    return meta;
  }

  /**
   * Score a position as a potential primary for an argument
   * Higher score = better fit for being the primary position
   *
   * Criteria:
   * - 40%: Respondent count (more = better representation)
   * - 30%: Not in "Andre emner" theme (prefer specific themes)
   * - 20%: Position has sub-positions (indicates structured coverage)
   * - 10%: Argument centrality (is this the main topic of the position?)
   *
   * @param {Object} arg - Argument with position info
   * @param {Map} positionMeta - Position metadata
   * @returns {number} Score (0 to 1)
   */
  scorePositionAsPrimary(arg, positionMeta) {
    const key = `${arg.theme}::${arg.positionTitle}`;
    const meta = positionMeta.get(key);

    if (!meta) return 0;

    let score = 0;

    // Criteria 1: Respondent count (40%)
    // Normalize to 0-1 range, assume max ~100 respondents per position
    const countScore = Math.min(meta.respondentCount / 100, 1);
    score += countScore * 0.4;

    // Criteria 2: Not in "Andre emner" (30%)
    // "Andre emner" positions are catch-all and less appropriate for primary
    if (!meta.isOtherTheme) {
      score += 0.3;
    }

    // Criteria 3: Theme specificity (20%)
    // Check if argument's what/concern matches position title keywords
    const centralityScore = this.calculateCentrality(arg, meta);
    score += centralityScore * 0.2;

    // Criteria 4: Base score for having a position (10%)
    score += 0.1;

    return score;
  }

  /**
   * Calculate how central an argument is to its position
   * @param {Object} arg - Argument
   * @param {Object} meta - Position metadata
   * @returns {number} Centrality score (0 to 1)
   */
  calculateCentrality(arg, meta) {
    const argText = (arg.argument?.what || '').toLowerCase();
    const titleText = (meta.title || '').toLowerCase();

    // Check for keyword overlap
    const argWords = new Set(argText.split(/\s+/).filter(w => w.length > 4));
    const titleWords = new Set(titleText.split(/\s+/).filter(w => w.length > 4));

    if (argWords.size === 0 || titleWords.size === 0) return 0.5;

    const overlap = [...argWords].filter(w => titleWords.has(w)).length;
    return Math.min(overlap / Math.min(argWords.size, titleWords.size), 1);
  }

  /**
   * Apply deduplication metadata to positions
   * @param {Array} themes - Original themes
   * @param {Object} deduplicationMap - Primary/secondary maps
   * @param {Array} clusters - Original clusters with full argument info
   * @returns {Array} Themes with deduplication metadata on arguments
   */
  applyDeduplicationMetadata(themes, deduplicationMap, clusters = []) {
    const { primary, secondary } = deduplicationMap;

    // Deep clone themes to avoid mutation
    const result = JSON.parse(JSON.stringify(themes));

    // Build lookup from cluster data: (theme, positionTitle, responseNumber, sourceQuoteRef) -> argumentId
    // This allows us to match sourceArgumentRefs back to registry entries
    const argLookup = new Map();
    for (const cluster of clusters) {
      for (const arg of cluster) {
        // Create a unique key for this argument
        const key = `${arg.theme}::${arg.positionTitle}::${arg.responseNumber}::${arg.sourceQuoteRef || arg.argument?.what || ''}`;
        argLookup.set(key, {
          id: arg.id,
          isPrimary: primary.has(arg.id),
          isSecondary: secondary.has(arg.id),
          primaryInfo: primary.get(arg.id),
          secondaryInfo: secondary.get(arg.id)
        });
      }
    }

    // Apply metadata by iterating through and matching
    let secondaryCount = 0;
    let primaryCount = 0;

    for (const theme of result) {
      for (const position of (theme.positions || [])) {
        // Add deduplication tracking to position
        position._deduplication = {
          primaryArguments: [],
          secondaryArguments: []
        };

        // Check each sourceArgumentRef
        if (position.sourceArgumentRefs) {
          for (const ref of position.sourceArgumentRefs) {
            // Try to find matching argument in our lookup
            const key = `${theme.name}::${position.title}::${ref.responseNumber}::${ref.sourceQuoteRef || ref.what || ''}`;
            const match = argLookup.get(key);

            if (match) {
              if (match.isSecondary) {
                const secInfo = match.secondaryInfo;
                ref._deduplicationStatus = 'secondary';
                ref._argumentId = match.id;
                ref._primaryPosition = secInfo.primaryPosition;
                position._deduplication.secondaryArguments.push(ref.responseNumber);
                secondaryCount++;
              } else if (match.isPrimary) {
                ref._deduplicationStatus = 'primary';
                ref._argumentId = match.id;
                position._deduplication.primaryArguments.push(ref.responseNumber);
                primaryCount++;
              }
            }
          }
        }

        // Track secondary respondent numbers for position-writer
        position._secondaryRespondents = [...new Set(position._deduplication.secondaryArguments)];
      }
    }

    this.log.metric('Primary arguments marked', primaryCount);
    this.log.metric('Secondary arguments marked', secondaryCount);

    return result;
  }

  /**
   * Validate that all respondents are still represented after deduplication
   * @param {Array} themes - Deduplicated themes
   * @param {Array} microSummaries - Original micro-summaries
   */
  validateCoverage(themes, microSummaries) {
    const allResponseNumbers = new Set(microSummaries.map(ms => ms.responseNumber));
    const coveredResponses = new Set();

    for (const theme of themes) {
      for (const position of (theme.positions || [])) {
        for (const responseNumber of (position.responseNumbers || [])) {
          coveredResponses.add(responseNumber);
        }
      }
    }

    const missing = [...allResponseNumbers].filter(r => !coveredResponses.has(r));

    if (missing.length > 0) {
      this.log.warn(`Coverage issue: ${missing.length} respondents not in any position after deduplication`);
    } else {
      this.log.info('Coverage validated: all respondents represented');
    }
  }
}
