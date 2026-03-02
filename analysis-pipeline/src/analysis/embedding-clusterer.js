/**
 * EmbeddingClusterer
 * 
 * Fast, embedding-based clustering of arguments before LLM refinement.
 * Reduces LLM calls from O(n) to O(k) where k << n.
 */

import { EmbeddingService } from '../embedding/embedding-service.js';
import { ObjectExtractor } from './object-extractor.js';

export class EmbeddingClusterer {
  constructor(options = {}) {
    this.embedder = new EmbeddingService(options);
    this.objectExtractor = new ObjectExtractor(options);
    this.minClusterSize = options.minClusterSize || 1;
    this.maxClusters = options.maxClusters || 100;
    this.semanticDiversity = null; // Will be set by setDynamicParameters
  }

  /**
   * Set dynamic parameters including semantic diversity
   * @param {Object} params - Dynamic parameters from calculator
   */
  setDynamicParameters(params) {
    if (params._stats?.semanticDiversity !== undefined) {
      this.semanticDiversity = params._stats.semanticDiversity;
      console.log(`[EmbeddingClusterer] Semantic diversity set to ${this.semanticDiversity.toFixed(3)}`);
    }
  }

  /**
   * Cluster arguments using embedding similarity
   * @param {Array} arguments - Arguments to cluster
   * @param {string} themeName - Theme name for context
   * @param {Array} precomputedEmbeddings - Optional pre-computed embeddings (OPTIMIZATION)
   * @returns {Promise<Array>} Clusters of arguments
   */
  async clusterArguments(args, themeName, precomputedEmbeddings = null) {
    if (args.length <= 3) {
      // Too few to cluster - treat as one group
      return [args];
    }

    console.log(`[EmbeddingClusterer] Clustering ${args.length} arguments for theme "${themeName}"`);

    let embeddings;
    
    // OPTIMIZATION: Use pre-computed embeddings if available
    if (precomputedEmbeddings && precomputedEmbeddings.length > 0) {
      console.log(`[EmbeddingClusterer] Using ${precomputedEmbeddings.length} pre-computed embeddings (what/why/how)`);
      
      // Build lookup map: responseNumber+argumentIndex -> embedding
      const embeddingMap = new Map();
      precomputedEmbeddings.forEach(emb => {
        const key = `${emb.responseNumber}_${emb.argumentIndex}`;
        embeddingMap.set(key, emb.embedding);
      });
      
      // Match arguments with their embeddings
      embeddings = args.map(arg => {
        const key = `${arg.responseNumber}_${args.indexOf(arg)}`; // Use index if argumentIndex not available
        const embedding = embeddingMap.get(key);
        if (!embedding && arg.argumentIndex !== undefined) {
          // Try with explicit argumentIndex
          const altKey = `${arg.responseNumber}_${arg.argumentIndex}`;
          return embeddingMap.get(altKey);
        }
        return embedding;
      }).filter(Boolean);
      
      if (embeddings.length !== args.length) {
        console.warn(`[EmbeddingClusterer] Could only match ${embeddings.length}/${args.length} embeddings, falling back to fresh embedding`);
        embeddings = null; // Fall back to generating new
      } else {
        console.log(`[EmbeddingClusterer] ✓ Matched all ${embeddings.length} arguments with pre-computed embeddings`);
      }
    }
    
    // Fallback: Generate embeddings if not provided or matching failed
    if (!embeddings) {
      console.log('[EmbeddingClusterer] Generating fresh embeddings for arguments...');
      const embeddingTexts = args.map(arg => {
        const parts = [];
        if (arg.what) parts.push(arg.what);
        if (arg.why) parts.push(arg.why);
        if (arg.how) parts.push(arg.how);
        // Fallback to deprecated fields
        if (parts.length === 0 && arg.coreContent) parts.push(arg.coreContent);
        if (parts.length === 0 && arg.concern) parts.push(arg.concern);
        if (parts.length === 0 && arg.desiredAction) parts.push(arg.desiredAction);
        return parts.join(' ');
      });

      embeddings = await this.embedder.embedBatch(embeddingTexts);
    }

    if (!embeddings || embeddings.length !== args.length) {
      console.warn('[EmbeddingClusterer] Embedding failed, returning all as one cluster');
      return [args];
    }

    // Validate that all embeddings are valid non-empty arrays
    const validIndices = [];
    const validEmbeddings = [];
    const validArgs = [];
    
    for (let i = 0; i < embeddings.length; i++) {
      const emb = embeddings[i];
      if (Array.isArray(emb) && emb.length > 0) {
        validIndices.push(i);
        validEmbeddings.push(emb);
        validArgs.push(args[i]);
      }
    }
    
    if (validEmbeddings.length < args.length) {
      console.warn(`[EmbeddingClusterer] ${args.length - validEmbeddings.length} invalid embeddings filtered out`);
    }
    
    // If too many invalid, fall back to single cluster
    if (validEmbeddings.length < 3) {
      console.warn('[EmbeddingClusterer] Too few valid embeddings, returning all as one cluster');
      return [args];
    }

    // Determine optimal number of clusters based on actual argument complexity
    const k = this.determineOptimalK(validArgs);
    console.log(`[EmbeddingClusterer] Using k=${k} clusters for ${validArgs.length} arguments`);

    // Cluster using simple k-means
    const clusters = this.kMeansClustering(validEmbeddings, k);

    // Map back to arguments (using validArgs since clusters are based on validEmbeddings)
    const argumentClusters = [];
    for (let i = 0; i < k; i++) {
      const clusterArgs = [];
      clusters.forEach((clusterId, argIdx) => {
        if (clusterId === i) {
          clusterArgs.push(validArgs[argIdx]);
        }
      });
      
      if (clusterArgs.length >= this.minClusterSize) {
        argumentClusters.push(clusterArgs);
      }
    }
    
    // Add arguments with invalid embeddings to the largest cluster
    const invalidArgs = args.filter((_, i) => !validIndices.includes(i));
    if (invalidArgs.length > 0 && argumentClusters.length > 0) {
      console.log(`[EmbeddingClusterer] Adding ${invalidArgs.length} args with invalid embeddings to largest cluster`);
      argumentClusters[0].push(...invalidArgs);
    } else if (invalidArgs.length > 0) {
      argumentClusters.push(invalidArgs);
    }

    // Sort by size (largest first)
    argumentClusters.sort((a, b) => b.length - a.length);

    console.log(`[EmbeddingClusterer] Created ${argumentClusters.length} clusters: ${argumentClusters.map(c => c.length).join(', ')} arguments per cluster`);

    // CRITICAL FIX: Split clusters that contain different objects
    // This prevents "all-in-one" positions that combine building height + ball court + traffic
    const refinedClusters = await this.splitClustersByObjects(argumentClusters, themeName);

    if (refinedClusters.length > argumentClusters.length) {
      console.log(`[EmbeddingClusterer] Object-based split: ${argumentClusters.length} clusters → ${refinedClusters.length} clusters`);
    }

    // ADDITIONAL FIX: Split clusters by substanceRefs (§-references)
    // Prevents arguments about different lokalplan sections from being grouped together
    // E.g., §5 (bebyggelse) arguments shouldn't mix with §6 (parkering) arguments
    const substanceRefinedClusters = this.splitClustersBySubstanceRefs(refinedClusters, themeName);

    if (substanceRefinedClusters.length > refinedClusters.length) {
      console.log(`[EmbeddingClusterer] SubstanceRef-based split: ${refinedClusters.length} clusters → ${substanceRefinedClusters.length} clusters`);
    }

    return substanceRefinedClusters;
  }

  /**
   * Split clusters that contain arguments about different objects.
   * Prevents semantically similar but topically different arguments from being grouped.
   * 
   * @param {Array<Array>} clusters - Clusters from k-means
   * @param {string} themeName - Theme name for logging
   * @returns {Promise<Array<Array>>} Refined clusters split by object
   */
  async splitClustersByObjects(clusters, themeName) {
    const refinedClusters = [];
    
    for (const cluster of clusters) {
      if (cluster.length <= 2) {
        // Too small to split
        refinedClusters.push(cluster);
        continue;
      }
      
      try {
        const splitClusters = await this.splitByDistinctObjects(cluster, themeName);
        refinedClusters.push(...splitClusters);
      } catch (error) {
        console.warn(`[EmbeddingClusterer] Object split failed for cluster of ${cluster.length}, keeping original:`, error.message);
        refinedClusters.push(cluster);
      }
    }
    
    // Re-sort by size
    refinedClusters.sort((a, b) => b.length - a.length);

    return refinedClusters;
  }

  /**
   * Split clusters that contain arguments with conflicting substanceRefs.
   * Arguments about different § sections should not be grouped together.
   *
   * @param {Array<Array>} clusters - Clusters from previous steps
   * @param {string} themeName - Theme name for logging
   * @returns {Array<Array>} Refined clusters split by substanceRefs
   */
  splitClustersBySubstanceRefs(clusters, themeName) {
    const refinedClusters = [];

    for (const cluster of clusters) {
      if (cluster.length <= 2) {
        // Too small to split
        refinedClusters.push(cluster);
        continue;
      }

      // Extract §-references from each argument's substanceRefs
      const argsByParagraph = new Map(); // Map<string, Array> - paragraph key -> arguments

      for (const arg of cluster) {
        const paragraphKey = this.extractParagraphKey(arg.substanceRefs || []);
        if (!argsByParagraph.has(paragraphKey)) {
          argsByParagraph.set(paragraphKey, []);
        }
        argsByParagraph.get(paragraphKey).push(arg);
      }

      // If all arguments have the same §-reference (or none), keep as single cluster
      if (argsByParagraph.size <= 1) {
        refinedClusters.push(cluster);
        continue;
      }

      // Split by §-reference
      let splitCount = 0;
      for (const [paragraphKey, args] of argsByParagraph.entries()) {
        if (args.length > 0) {
          refinedClusters.push(args);
          if (paragraphKey !== 'none') {
            splitCount++;
          }
        }
      }

      if (splitCount > 0) {
        console.log(`[EmbeddingClusterer] Split cluster of ${cluster.length} by substanceRefs: ${Array.from(argsByParagraph.entries()).map(([k, v]) => `${k}(${v.length})`).join(', ')}`);
      }
    }

    // Re-sort by size
    refinedClusters.sort((a, b) => b.length - a.length);

    return refinedClusters;
  }

  /**
   * Extract a paragraph key from substanceRefs for grouping purposes.
   * E.g., ["LP-§5", "PALADS-§5"] -> "§5"
   *       ["LP_§6_ydre_fremtræden"] -> "§6"
   *
   * @param {Array<string>} substanceRefs - Substance references
   * @returns {string} Paragraph key (e.g., "§5") or "none"
   */
  extractParagraphKey(substanceRefs) {
    if (!substanceRefs || substanceRefs.length === 0) {
      return 'none';
    }

    // Extract all §-numbers
    const paragraphs = new Set();
    for (const ref of substanceRefs) {
      const match = ref.match(/[§_-](\d+)/);
      if (match) {
        paragraphs.add(`§${match[1]}`);
      }
    }

    if (paragraphs.size === 0) {
      return 'none';
    }

    // Return sorted §-keys joined (e.g., "§5" or "§5,§6" if multiple)
    return Array.from(paragraphs).sort().join(',');
  }

  /**
   * Determine minimum unique objects needed before splitting
   * DYNAMISK: Tilpasser sig til antallet af argumenter og respondenter
   *
   * @param {number} clusterSize - Size of the cluster
   * @param {number} totalArguments - Total arguments in hearing (for context)
   * @returns {number} Minimum unique objects required for split
   */
  getMinObjectsForSplit(clusterSize, totalArguments = null) {
    // For small hearings, require more objects before splitting
    if (totalArguments !== null && totalArguments <= 30) {
      return 3; // Only split with 3+ different objects
    }

    // For large clusters, be more willing to split
    if (clusterSize > 20) {
      return 2;
    }

    return 3; // Default: require 3+ objects
  }

  /**
   * Check if objects are semantically similar (should NOT be split)
   * E.g., "vandledning" and "forsyningsledning" are related
   *
   * @param {Array<string>} objects - Array of object names
   * @returns {boolean} True if objects are semantically similar
   */
  areObjectsSemanticallySimilar(objects) {
    if (objects.length <= 1) return true;

    // Define semantic groups (objects that should stay together)
    const semanticGroups = [
      // Infrastructure / utilities
      ['vandledning', 'forsyningsledning', 'kloakledning', 'spildevandsledning', 'regnvandsledning', 'ledning'],
      // Sports facilities
      ['boldbane', 'fodboldbane', 'kunstgræsbane', 'græsbane', 'bane'],
      ['boldbur', 'multibane', 'boldområde', 'boldareal'],
      // Buildings
      ['bygning', 'bebyggelse', 'hus', 'ejendom'],
      ['klubhus', 'foreningshus', 'omklædning', 'facilitet'],
      // Traffic
      ['vej', 'adgangsvej', 'stikevej', 'tilkørsel', 'adgang'],
      ['parkering', 'parkeringsplads', 'p-plads', 'bilparkering'],
      ['cykelsti', 'sti', 'gangsti', 'fodgængersti'],
      // Green areas
      ['park', 'grønne arealer', 'grønt område', 'fælled', 'naturområde'],
      ['træ', 'træer', 'beplantning', 'vegetation']
    ];

    // Check if all objects belong to the same semantic group
    for (const group of semanticGroups) {
      const matchingObjects = objects.filter(obj =>
        group.some(term => obj.includes(term) || term.includes(obj))
      );

      if (matchingObjects.length >= objects.length - 1) {
        // Most objects (all but one) are in this group - consider similar
        return true;
      }
    }

    return false;
  }

  /**
   * Split a single cluster by distinct objects using ObjectExtractor.
   * DEACTIVATED: Object-split is disabled to reduce over-fragmentation.
   * Substance-split already handles topic differentiation (different § = different regulatory topics).
   * Object-level splitting (facade vs interior) is too granular - they're the same building.
   *
   * @param {Array} cluster - Cluster of arguments
   * @param {string} themeName - Theme name for logging
   * @param {Object} context - Optional context with totalArguments
   * @returns {Promise<Array<Array>>} Original cluster (no splitting)
   */
  async splitByDistinctObjects(cluster, themeName, context = {}) {
    // DEACTIVATED: Object-split causes over-fragmentation
    // K-means clustering + substance-split handle semantic grouping adequately
    // Example: "facade" vs "interior" are the same building - should stay together
    console.log(`[EmbeddingClusterer] Object split DISABLED for cluster of ${cluster.length} in "${themeName}" - substance-split handles topic differentiation`);
    return [cluster];
  }

  /**
   * Calculate text complexity for an argument
   * @param {Object} arg - Argument object
   * @returns {number} Complexity score (characters)
   * @private
   */
  calculateArgumentComplexity(arg) {
    if (!arg) return 0;
    
    // Combine all text fields to get total content length
    const textParts = [];
    if (arg.what) textParts.push(arg.what);
    if (arg.why) textParts.push(arg.why);
    if (arg.how) textParts.push(arg.how);
    if (arg.concern) textParts.push(arg.concern);
    if (arg.desiredAction) textParts.push(arg.desiredAction);
    // Fallback to deprecated fields
    if (textParts.length === 0 && arg.coreContent) textParts.push(arg.coreContent);
    if (textParts.length === 0 && arg.consequence) textParts.push(arg.consequence);
    
    const totalText = textParts.join(' ');
    return totalText.length;
  }

  /**
   * Determine optimal number of clusters using CASE-AWARE calculation.
   * Uses multiple signals: argument count, semantic diversity, direction concentration, substance breadth.
   * Goal: Scale from ~5-15 positions for small cases to ~20-50 for large cases.
   *
   * @param {Array} args - Arguments array (for complexity calculation)
   * @param {number} argCount - Number of arguments (for fallback)
   * @returns {number} Optimal number of clusters (k)
   */
  determineOptimalK(args, argCount = null) {
    // Use provided args array if available, otherwise fall back to count
    const actualArgs = Array.isArray(args) ? args : null;
    const count = actualArgs ? actualArgs.length : (argCount || 0);

    // Small cases: minimal clustering
    if (count <= 5) {
      return 1;
    }
    if (count <= 10) {
      return Math.min(2, Math.ceil(count / 5));
    }

    // === CASE-AWARE SIGNALS ===

    // 1. Basis: sqrt-scaling (logarithmic growth for large cases)
    const baseK = Math.ceil(Math.sqrt(count) * 1.2);

    // 2. Semantic diversity adjustment
    //    High diversity (>0.7) → more clusters (+30%)
    //    Low diversity (<0.4) → fewer clusters (-20%)
    let diversityFactor = 1.0;
    if (this.semanticDiversity !== null) {
      if (this.semanticDiversity > 0.7) {
        diversityFactor = 1.3;
      } else if (this.semanticDiversity > 0.55) {
        diversityFactor = 1.1;
      } else if (this.semanticDiversity < 0.4) {
        diversityFactor = 0.8; // Reduce K for homogeneous cases
      }
    }

    // 3. Direction concentration: if 90%+ have same direction → fewer positions
    const directionConcentration = this.calculateDirectionConcentration(actualArgs);
    let directionFactor = 1.0;
    if (directionConcentration > 0.9) {
      directionFactor = 0.7; // Very homogeneous
    } else if (directionConcentration > 0.75) {
      directionFactor = 0.85;
    }
    // Balanced (50/50 split) keeps factor = 1.0

    // 4. Substance breadth: more unique § references → more topics → more positions
    const uniqueSubstances = this.countUniqueSubstances(actualArgs);
    const substanceFactor = Math.max(1.0, Math.log2(uniqueSubstances + 1) / 3);
    // 1 § → 1.0, 4 § → 1.0, 8 § → 1.1, 16 § → 1.3

    // === COMBINED CALCULATION ===
    const adjustedK = Math.round(baseK * diversityFactor * directionFactor * substanceFactor);

    // Clamp to reasonable bounds
    // Min: at least ~150 args per cluster (allows large positions)
    // Max: at most ~20 args per cluster (prevents tiny positions)
    const minK = Math.max(3, Math.ceil(count / 150));
    const maxK = Math.min(60, Math.ceil(count / 20));

    const finalK = Math.max(minK, Math.min(maxK, adjustedK));

    console.log(`[EmbeddingClusterer] Case-aware K: count=${count}, base=${baseK}, ` +
      `diversity=${(this.semanticDiversity || 0.5).toFixed(2)}→${diversityFactor.toFixed(2)}, ` +
      `direction=${directionConcentration.toFixed(2)}→${directionFactor.toFixed(2)}, ` +
      `substances=${uniqueSubstances}→${substanceFactor.toFixed(2)}, ` +
      `adjusted=${adjustedK}, final=${finalK}`);

    return finalK;
  }

  /**
   * Calculate direction concentration - how homogeneous is the opinion direction?
   * @param {Array} args - Arguments array
   * @returns {number} Concentration 0.33 (balanced) to 1.0 (unanimous)
   */
  calculateDirectionConcentration(args) {
    if (!args?.length) return 0.5;

    const directions = { support: 0, oppose: 0, neutral: 0 };
    for (const arg of args) {
      const dir = (arg.direction || '').toLowerCase();
      if (dir.includes('support') || dir.includes('for') || dir.includes('støtte')) {
        directions.support++;
      } else if (dir.includes('oppose') || dir.includes('mod') || dir.includes('against')) {
        directions.oppose++;
      } else {
        directions.neutral++;
      }
    }

    const max = Math.max(directions.support, directions.oppose, directions.neutral);
    return max / args.length; // 0.33 = balanced, 1.0 = unanimous
  }

  /**
   * Count unique substance references (§ paragraphs) in arguments.
   * More substances = more topics = potentially more positions needed.
   * @param {Array} args - Arguments array
   * @returns {number} Count of unique § references
   */
  countUniqueSubstances(args) {
    if (!args?.length) return 1;

    const substances = new Set();
    for (const arg of args) {
      if (arg.substanceRefs?.length) {
        for (const ref of arg.substanceRefs) {
          const match = ref.match(/§(\d+)/);
          if (match) substances.add(match[1]);
        }
      }
    }

    return Math.max(1, substances.size);
  }

  /**
   * Simple k-means clustering on embeddings
   * @param {Array<Array<number>>} embeddings - Embedding vectors
   * @param {number} k - Number of clusters
   * @returns {Array<number>} Cluster assignments (index -> cluster ID)
   */
  kMeansClustering(embeddings, k) {
    const n = embeddings.length;
    
    if (k >= n) {
      // Each point is its own cluster
      return embeddings.map((_, i) => i);
    }

    // Initialize centroids randomly (use first k embeddings)
    const centroids = embeddings.slice(0, k).map(e => [...e]);
    
    let assignments = new Array(n).fill(0);
    let changed = true;
    let iterations = 0;
    const maxIterations = 50;

    // K-means iterations
    while (changed && iterations < maxIterations) {
      changed = false;
      iterations++;

      // Assignment step
      const newAssignments = embeddings.map((emb, idx) => {
        let bestCluster = 0;
        let bestDistance = Infinity;

        for (let j = 0; j < k; j++) {
          const dist = this.euclideanDistance(emb, centroids[j]);
          if (dist < bestDistance) {
            bestDistance = dist;
            bestCluster = j;
          }
        }

        return bestCluster;
      });

      // Check if changed
      for (let i = 0; i < n; i++) {
        if (newAssignments[i] !== assignments[i]) {
          changed = true;
          break;
        }
      }

      assignments = newAssignments;

      // Update centroids
      for (let j = 0; j < k; j++) {
        const clusterPoints = [];
        for (let i = 0; i < n; i++) {
          if (assignments[i] === j) {
            clusterPoints.push(embeddings[i]);
          }
        }

        if (clusterPoints.length > 0) {
          centroids[j] = this.computeCentroid(clusterPoints);
        }
      }
    }

    console.log(`[EmbeddingClusterer] K-means converged in ${iterations} iterations`);
    return assignments;
  }

  /**
   * Compute centroid (mean) of a set of vectors
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
   */
  euclideanDistance(vec1, vec2) {
    let sum = 0;
    for (let i = 0; i < vec1.length; i++) {
      const diff = vec1[i] - vec2[i];
      sum += diff * diff;
    }
    return Math.sqrt(sum);
  }
}

