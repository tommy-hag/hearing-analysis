/**
 * Similarity Analyzer
 * 
 * Pre-analyzes hearing response patterns to detect mass agreement cases
 * and recommend optimal grouping parameters.
 * 
 * Uses LSH (Locality Sensitive Hashing) for large datasets to accelerate
 * similarity computation without sacrificing accuracy.
 */

import { EmbeddingService } from '../embedding/embedding-service.js';

/**
 * Locality Sensitive Hashing for Cosine Similarity
 * 
 * Uses random hyperplane projections to hash similar vectors to the same bucket.
 * Pairs that hash together in multiple tables are candidates for high similarity.
 */
class CosineLSH {
  /**
   * @param {number} dimension - Vector dimension (e.g., 3072 for text-embedding-3-large)
   * @param {number} numTables - Number of hash tables (more = higher recall, slower)
   * @param {number} numHashes - Bits per hash (more = higher precision, fewer candidates)
   */
  constructor(dimension, numTables = 12, numHashes = 8) {
    this.dimension = dimension;
    this.numTables = numTables;
    this.numHashes = numHashes;
    
    // Generate random hyperplanes for each table
    // Each hyperplane is a random unit vector; sign of dot product gives hash bit
    this.hyperplanes = [];
    for (let t = 0; t < numTables; t++) {
      const tableHyperplanes = [];
      for (let h = 0; h < numHashes; h++) {
        tableHyperplanes.push(this.randomUnitVector(dimension));
      }
      this.hyperplanes.push(tableHyperplanes);
    }
  }

  /**
   * Generate a random unit vector
   * @private
   */
  randomUnitVector(dim) {
    const vec = new Float64Array(dim);
    let norm = 0;
    for (let i = 0; i < dim; i++) {
      // Box-Muller transform for normal distribution
      const u1 = Math.random();
      const u2 = Math.random();
      vec[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      norm += vec[i] * vec[i];
    }
    norm = Math.sqrt(norm);
    for (let i = 0; i < dim; i++) {
      vec[i] /= norm;
    }
    return vec;
  }

  /**
   * Compute hash for a vector in a specific table
   * @private
   */
  hashVector(vector, tableIndex) {
    let hash = 0;
    const hyperplanes = this.hyperplanes[tableIndex];
    
    for (let h = 0; h < this.numHashes; h++) {
      const hyperplane = hyperplanes[h];
      let dotProduct = 0;
      for (let i = 0; i < this.dimension; i++) {
        dotProduct += vector[i] * hyperplane[i];
      }
      // Set bit h if dot product is positive
      if (dotProduct >= 0) {
        hash |= (1 << h);
      }
    }
    return hash;
  }

  /**
   * Index all vectors and find candidate pairs
   * 
   * @param {Array} vectors - Array of vectors to index
   * @returns {Set<string>} Set of candidate pair keys "i,j" where i < j
   */
  findCandidatePairs(vectors) {
    const n = vectors.length;
    const candidatePairs = new Set();
    
    // For each hash table
    for (let t = 0; t < this.numTables; t++) {
      // Hash all vectors into buckets
      const buckets = new Map();
      
      for (let i = 0; i < n; i++) {
        const vec = vectors[i];
        if (!vec || vec.length !== this.dimension) continue;
        
        const hash = this.hashVector(vec, t);
        
        if (!buckets.has(hash)) {
          buckets.set(hash, []);
        }
        buckets.get(hash).push(i);
      }
      
      // All pairs within the same bucket are candidates
      for (const bucket of buckets.values()) {
        if (bucket.length > 1 && bucket.length < 500) {
          // Only process reasonably sized buckets (avoid O(n²) in single bucket)
          for (let i = 0; i < bucket.length; i++) {
            for (let j = i + 1; j < bucket.length; j++) {
              const a = Math.min(bucket[i], bucket[j]);
              const b = Math.max(bucket[i], bucket[j]);
              candidatePairs.add(`${a},${b}`);
            }
          }
        } else if (bucket.length >= 500) {
          // For very large buckets, this indicates high similarity mass
          // Sample pairs to avoid explosion
          const maxPairs = 5000;
          let added = 0;
          for (let i = 0; i < bucket.length && added < maxPairs; i++) {
            for (let j = i + 1; j < bucket.length && added < maxPairs; j++) {
              const a = Math.min(bucket[i], bucket[j]);
              const b = Math.max(bucket[i], bucket[j]);
              candidatePairs.add(`${a},${b}`);
              added++;
            }
          }
        }
      }
    }
    
    return candidatePairs;
  }
}

export class SimilarityAnalyzer {
  constructor(options = {}) {
    this.embedder = new EmbeddingService(options.embedding);
    this.verbose = options.verbose || false;
    
    // Threshold for using LSH-accelerated mode
    this.lshThreshold = options.lshThreshold || 1500;
  }

  /**
   * Analyze similarity patterns in hearing responses
   * @param {Array} responses - Array of response objects
   * @param {Array} microSummaries - Extracted arguments from responses
   * @returns {Promise<Object>} Analysis results with recommendations
   */
  async analyzePatterns(responses, microSummaries) {
    const startTime = Date.now();
    
    if (!responses || responses.length === 0) {
      console.log(`[SimilarityAnalyzer] No responses to analyze, returning defaults`);
      return this.getDefaultAnalysis();
    }

    console.log(`[SimilarityAnalyzer] Starting pattern analysis for ${responses.length} responses...`);

    // Extract all arguments from micro summaries
    const allArguments = this.extractArguments(microSummaries);
    console.log(`[SimilarityAnalyzer] Extracted ${allArguments.length} arguments from ${microSummaries.length} micro-summaries`);
    
    if (allArguments.length === 0) {
      console.log(`[SimilarityAnalyzer] No arguments found, returning defaults`);
      return this.getDefaultAnalysis();
    }

    // Estimate complexity and indicate mode
    const estimatedComparisons = (allArguments.length * (allArguments.length - 1)) / 2;
    const useLSH = allArguments.length > this.lshThreshold;
    console.log(`[SimilarityAnalyzer] ${estimatedComparisons.toLocaleString()} possible pairs, mode: ${useLSH ? 'LSH-accelerated' : 'full matrix'}`);

    // Generate embeddings for all arguments
    const embeddings = await this.generateEmbeddings(allArguments);
    
    // Calculate similarity matrix
    const similarityMatrix = this.calculateSimilarityMatrix(embeddings);
    
    // Analyze clustering patterns
    const clusterAnalysis = this.analyzeClusteringPatterns(similarityMatrix, allArguments);
    
    // Detect mass agreement patterns
    const massAgreementDetected = this.detectMassAgreement(clusterAnalysis, responses.length);
    
    // Generate recommendations
    const recommendations = this.generateRecommendations(clusterAnalysis, massAgreementDetected, responses.length);
    
    const analysisTime = Date.now() - startTime;
    
    console.log(`[SimilarityAnalyzer] ✓ Pattern analysis complete in ${(analysisTime / 1000).toFixed(1)}s`);
    console.log(`[SimilarityAnalyzer]   Mass agreement: ${massAgreementDetected.detected ? 'YES' : 'no'} (confidence: ${(massAgreementDetected.confidence * 100).toFixed(0)}%)`);
    console.log(`[SimilarityAnalyzer]   Recommended strategy: ${recommendations.consolidationStrategy} (threshold: ${recommendations.consolidationThreshold})`);
    
    return {
      responseCount: responses.length,
      argumentCount: allArguments.length,
      averageArgumentsPerResponse: allArguments.length / responses.length,
      clusterAnalysis,
      massAgreementDetected,
      recommendations,
      analysisTime
    };
  }

  /**
   * Extract all arguments from micro summaries
   * Supports both legacy format (arg.argument/summary) and new format (arg.what/why/how)
   * @private
   */
  extractArguments(microSummaries) {
    const allArguments = [];
    
    for (const summary of microSummaries) {
      if (summary.arguments && Array.isArray(summary.arguments)) {
        for (const arg of summary.arguments) {
          // Support new what/why/how format (primary) and legacy format (fallback)
          let text = '';
          if (arg.what || arg.why || arg.how) {
            // New format: combine what/why/how for semantic richness
            text = [arg.what, arg.why, arg.how].filter(Boolean).join(' ');
          } else {
            // Legacy format fallback
            text = arg.argument || arg.summary || '';
          }
          
          // Extract themes from new format or legacy
          const theme = arg.relevantThemes?.[0] || arg.theme;
          
          allArguments.push({
            text,
            theme,
            responseNumber: summary.responseNumber,
            id: `${summary.responseNumber}_${allArguments.length}`,
            // Preserve original for analysis
            _original: arg
          });
        }
      }
    }
    
    return allArguments;
  }

  /**
   * Generate embeddings for arguments
   * @private
   */
  async generateEmbeddings(argumentsList) {
    console.log(`[SimilarityAnalyzer] Generating embeddings for ${argumentsList.length} arguments...`);
    const startTime = Date.now();
    
    const texts = argumentsList.map(arg => arg.text);
    const embeddings = await this.embedder.embedBatch(texts);
    
    const validCount = embeddings.filter(e => e && e.length > 0).length;
    console.log(`[SimilarityAnalyzer] Embeddings complete in ${((Date.now() - startTime) / 1000).toFixed(1)}s (${validCount}/${argumentsList.length} valid)`);
    
    return argumentsList.map((arg, idx) => ({
      ...arg,
      embedding: embeddings[idx]
    }));
  }

  /**
   * Calculate similarity matrix between all arguments
   * Automatically selects between full O(n²) and LSH-accelerated mode based on dataset size
   * @private
   */
  calculateSimilarityMatrix(embeddedArguments) {
    const n = embeddedArguments.length;
    
    // For small datasets, use full matrix calculation
    // For large datasets, use LSH-accelerated mode
    if (n <= this.lshThreshold) {
      return this.calculateFullSimilarityMatrix(embeddedArguments);
    } else {
      return this.calculateLSHSimilarityMatrix(embeddedArguments);
    }
  }

  /**
   * Calculate full similarity matrix (O(n²) - for small datasets)
   * Optimized version with pre-computed norms and progress logging
   * @private
   */
  calculateFullSimilarityMatrix(embeddedArguments) {
    const n = embeddedArguments.length;
    const totalComparisons = (n * (n - 1)) / 2;
    
    console.log(`[SimilarityAnalyzer] Full matrix mode: ${n} arguments, ${totalComparisons.toLocaleString()} comparisons`);
    const startTime = Date.now();
    
    // Pre-compute all vector norms for O(n) instead of O(n²) norm calculations
    console.log(`[SimilarityAnalyzer] Pre-computing vector norms...`);
    const norms = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const vec = embeddedArguments[i].embedding;
      if (vec && vec.length > 0) {
        let sum = 0;
        for (let k = 0; k < vec.length; k++) {
          sum += vec[k] * vec[k];
        }
        norms[i] = Math.sqrt(sum);
      } else {
        norms[i] = 0;
      }
    }
    console.log(`[SimilarityAnalyzer] Norms pre-computed in ${Date.now() - startTime}ms`);
    
    // Initialize matrix
    const matrix = Array(n).fill(null).map(() => new Float64Array(n));
    
    // Set diagonal to 1.0
    for (let i = 0; i < n; i++) {
      matrix[i][i] = 1.0;
    }
    
    // Calculate similarities with progress logging
    let completedComparisons = 0;
    let lastLogPercent = 0;
    const logInterval = 10; // Log every 10%
    
    for (let i = 0; i < n; i++) {
      const vec1 = embeddedArguments[i].embedding;
      const norm1 = norms[i];
      
      // Skip if no valid embedding
      if (!vec1 || norm1 === 0) {
        completedComparisons += (n - i - 1);
        continue;
      }
      
      for (let j = i + 1; j < n; j++) {
        const vec2 = embeddedArguments[j].embedding;
        const norm2 = norms[j];
        
        if (vec2 && norm2 > 0 && vec1.length === vec2.length) {
          // Optimized dot product calculation
          let dotProduct = 0;
          for (let k = 0; k < vec1.length; k++) {
            dotProduct += vec1[k] * vec2[k];
          }
          const similarity = dotProduct / (norm1 * norm2);
          matrix[i][j] = similarity;
          matrix[j][i] = similarity;
        }
        
        completedComparisons++;
      }
      
      // Progress logging
      const currentPercent = Math.floor((completedComparisons / totalComparisons) * 100);
      if (currentPercent >= lastLogPercent + logInterval) {
        const elapsed = Date.now() - startTime;
        const rate = completedComparisons / (elapsed / 1000);
        const remaining = (totalComparisons - completedComparisons) / rate;
        console.log(`[SimilarityAnalyzer] Progress: ${currentPercent}% (${completedComparisons.toLocaleString()}/${totalComparisons.toLocaleString()} comparisons, ~${Math.ceil(remaining)}s remaining)`);
        lastLogPercent = currentPercent;
      }
    }
    
    const totalTime = Date.now() - startTime;
    console.log(`[SimilarityAnalyzer] Similarity matrix complete in ${(totalTime / 1000).toFixed(1)}s (${Math.round(totalComparisons / (totalTime / 1000)).toLocaleString()} comparisons/sec)`);
    
    return matrix;
  }

  /**
   * Calculate similarity matrix using LSH acceleration
   * 
   * Uses Locality Sensitive Hashing to identify candidate pairs that might be similar,
   * then computes EXACT cosine similarity only for those pairs.
   * 
   * This gives the same clustering results as full matrix for pairs above min threshold,
   * while skipping pairs that are guaranteed to be below the minimum threshold (0.70).
   * 
   * @private
   */
  calculateLSHSimilarityMatrix(embeddedArguments) {
    const n = embeddedArguments.length;
    const totalPossibleComparisons = (n * (n - 1)) / 2;
    
    console.log(`[SimilarityAnalyzer] LSH-accelerated mode: ${n} arguments (${totalPossibleComparisons.toLocaleString()} possible pairs)`);
    const startTime = Date.now();
    
    // Extract vectors and find dimension
    const vectors = embeddedArguments.map(arg => arg.embedding);
    const dimension = vectors.find(v => v && v.length > 0)?.length || 3072;
    
    // Pre-compute all vector norms
    console.log(`[SimilarityAnalyzer] Pre-computing vector norms...`);
    const norms = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const vec = vectors[i];
      if (vec && vec.length > 0) {
        let sum = 0;
        for (let k = 0; k < vec.length; k++) {
          sum += vec[k] * vec[k];
        }
        norms[i] = Math.sqrt(sum);
      }
    }
    
    // Initialize LSH with tuned parameters for cosine similarity ≥ 0.70
    // More tables = higher recall (fewer false negatives)
    // More hashes = higher precision (fewer false positives)
    console.log(`[SimilarityAnalyzer] Building LSH index (12 tables, 8 bits each)...`);
    const lsh = new CosineLSH(dimension, 12, 8);
    
    // Find candidate pairs using LSH
    console.log(`[SimilarityAnalyzer] Finding candidate pairs via LSH...`);
    const candidatePairs = lsh.findCandidatePairs(vectors);
    const candidateCount = candidatePairs.size;
    
    const reductionPercent = ((1 - candidateCount / totalPossibleComparisons) * 100).toFixed(1);
    console.log(`[SimilarityAnalyzer] LSH found ${candidateCount.toLocaleString()} candidate pairs (${reductionPercent}% reduction)`);
    
    // Initialize sparse similarity storage
    // We'll build a full matrix but only compute values for candidate pairs
    const matrix = Array(n).fill(null).map(() => new Float64Array(n));
    
    // Set diagonal to 1.0
    for (let i = 0; i < n; i++) {
      matrix[i][i] = 1.0;
    }
    
    // Compute exact similarity only for candidate pairs
    console.log(`[SimilarityAnalyzer] Computing exact similarities for candidates...`);
    let computed = 0;
    let lastLogPercent = 0;
    const logInterval = 10;
    
    for (const pairKey of candidatePairs) {
      const [iStr, jStr] = pairKey.split(',');
      const i = parseInt(iStr, 10);
      const j = parseInt(jStr, 10);
      
      const vec1 = vectors[i];
      const vec2 = vectors[j];
      const norm1 = norms[i];
      const norm2 = norms[j];
      
      if (vec1 && vec2 && norm1 > 0 && norm2 > 0 && vec1.length === vec2.length) {
        let dotProduct = 0;
        for (let k = 0; k < vec1.length; k++) {
          dotProduct += vec1[k] * vec2[k];
        }
        const similarity = dotProduct / (norm1 * norm2);
        matrix[i][j] = similarity;
        matrix[j][i] = similarity;
      }
      
      computed++;
      
      // Progress logging
      const currentPercent = Math.floor((computed / candidateCount) * 100);
      if (currentPercent >= lastLogPercent + logInterval) {
        const elapsed = Date.now() - startTime;
        const rate = computed / (elapsed / 1000);
        const remaining = (candidateCount - computed) / rate;
        console.log(`[SimilarityAnalyzer] Progress: ${currentPercent}% (${computed.toLocaleString()}/${candidateCount.toLocaleString()} candidates, ~${Math.ceil(remaining)}s remaining)`);
        lastLogPercent = currentPercent;
      }
    }
    
    const totalTime = Date.now() - startTime;
    console.log(`[SimilarityAnalyzer] LSH similarity complete in ${(totalTime / 1000).toFixed(1)}s`);
    console.log(`[SimilarityAnalyzer]   Computed: ${candidateCount.toLocaleString()} pairs (skipped ${(totalPossibleComparisons - candidateCount).toLocaleString()} guaranteed-low pairs)`);
    
    return matrix;
  }

  /**
   * Analyze clustering patterns in similarity matrix
   * @private
   */
  analyzeClusteringPatterns(similarityMatrix, argumentsList) {
    const n = similarityMatrix.length;
    const thresholds = [0.95, 0.90, 0.85, 0.80, 0.75, 0.70];
    const clustersByThreshold = {};
    
    console.log(`[SimilarityAnalyzer] Analyzing clustering patterns for ${n} arguments across ${thresholds.length} thresholds...`);
    const startTime = Date.now();
    
    // For each threshold, find clusters
    for (const threshold of thresholds) {
      const clusters = this.findClustersAtThreshold(similarityMatrix, threshold);
      clustersByThreshold[threshold] = {
        clusterCount: clusters.length,
        largestClusterSize: Math.max(...clusters.map(c => c.length), 0),
        averageClusterSize: clusters.length > 0 ? 
          clusters.reduce((sum, c) => sum + c.length, 0) / clusters.length : 0,
        singletonCount: clusters.filter(c => c.length === 1).length,
        clusters
      };
      console.log(`[SimilarityAnalyzer] Threshold ${threshold}: ${clusters.length} clusters (largest: ${clustersByThreshold[threshold].largestClusterSize})`);
    }
    
    // Calculate diversity score
    console.log(`[SimilarityAnalyzer] Calculating diversity score...`);
    const diversityScore = this.calculateDiversityScore(similarityMatrix);
    
    // Identify dominant patterns
    const dominantPatterns = this.identifyDominantPatterns(clustersByThreshold, argumentsList);
    
    console.log(`[SimilarityAnalyzer] Clustering analysis complete in ${Date.now() - startTime}ms (diversity: ${diversityScore.toFixed(3)})`);
    
    return {
      totalArguments: n,
      clustersByThreshold,
      diversityScore,
      dominantPatterns,
      similarityDistribution: this.calculateSimilarityDistribution(similarityMatrix)
    };
  }

  /**
   * Find clusters at a given similarity threshold
   * @private
   */
  findClustersAtThreshold(similarityMatrix, threshold) {
    const n = similarityMatrix.length;
    const visited = new Set();
    const clusters = [];
    
    for (let i = 0; i < n; i++) {
      if (!visited.has(i)) {
        const cluster = [];
        const queue = [i];
        
        while (queue.length > 0) {
          const current = queue.shift();
          if (!visited.has(current)) {
            visited.add(current);
            cluster.push(current);
            
            // Add all similar arguments to queue
            for (let j = 0; j < n; j++) {
              if (!visited.has(j) && similarityMatrix[current][j] >= threshold) {
                queue.push(j);
              }
            }
          }
        }
        
        clusters.push(cluster);
      }
    }
    
    return clusters;
  }

  /**
   * Calculate diversity score based on similarity distribution
   * 
   * In LSH mode, pairs with 0 similarity are either:
   * - Actually very dissimilar (below min threshold, so LSH didn't flag them)
   * - Pairs we computed that happen to have near-zero similarity
   * 
   * For accurate diversity estimation, we consider:
   * - Non-zero pairs: use their actual similarity
   * - Zero pairs (from LSH): assume they're at the median of "low similarity" (~0.5)
   * 
   * @private
   */
  calculateDiversityScore(similarityMatrix) {
    const n = similarityMatrix.length;
    const totalPairs = (n * (n - 1)) / 2;
    
    let totalSimilarity = 0;
    let nonZeroCount = 0;
    let nonZeroSum = 0;
    
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const sim = similarityMatrix[i][j];
        totalSimilarity += sim;
        if (sim > 0.01) { // Consider effectively non-zero
          nonZeroCount++;
          nonZeroSum += sim;
        }
      }
    }
    
    // If we have many non-zero pairs, the matrix is complete (full mode)
    // If we have few non-zero pairs, we used LSH mode
    const completenessRatio = nonZeroCount / totalPairs;
    
    let averageSimilarity;
    if (completenessRatio > 0.5) {
      // Full matrix mode: use actual average
      averageSimilarity = totalSimilarity / totalPairs;
    } else {
      // LSH mode: estimate average
      // Non-zero pairs have their actual similarity
      // Zero pairs (LSH-skipped) are assumed to be low similarity (~0.4 average)
      const zeroCount = totalPairs - nonZeroCount;
      const estimatedZeroAvg = 0.4; // Conservative estimate for skipped pairs
      const estimatedTotal = nonZeroSum + (zeroCount * estimatedZeroAvg);
      averageSimilarity = estimatedTotal / totalPairs;
      
      console.log(`[SimilarityAnalyzer] Diversity estimate: ${nonZeroCount.toLocaleString()} measured pairs (avg ${(nonZeroSum/nonZeroCount).toFixed(3)}), ${zeroCount.toLocaleString()} estimated low-similarity pairs`);
    }
    
    // Diversity score: 0 = all identical, 1 = all completely different
    return 1 - averageSimilarity;
  }

  /**
   * Calculate similarity distribution statistics
   * 
   * In LSH mode, only includes actually computed pairs (non-zero similarities)
   * to give accurate distribution of "similar enough to matter" pairs.
   * 
   * @private
   */
  calculateSimilarityDistribution(similarityMatrix) {
    const n = similarityMatrix.length;
    const allSimilarities = [];
    const nonZeroSimilarities = [];
    
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const sim = similarityMatrix[i][j];
        allSimilarities.push(sim);
        if (sim > 0.01) {
          nonZeroSimilarities.push(sim);
        }
      }
    }
    
    if (allSimilarities.length === 0) {
      return { mean: 0, median: 0, std: 0, percentiles: {}, mode: 'empty' };
    }
    
    // Determine if this is LSH mode (many zero entries)
    const isLSHMode = nonZeroSimilarities.length < allSimilarities.length * 0.5;
    
    // Use non-zero similarities for distribution in LSH mode
    const similarities = isLSHMode && nonZeroSimilarities.length > 0 
      ? nonZeroSimilarities 
      : allSimilarities;
    
    similarities.sort((a, b) => a - b);
    
    const mean = similarities.reduce((a, b) => a + b, 0) / similarities.length;
    const median = similarities[Math.floor(similarities.length / 2)];
    const std = Math.sqrt(
      similarities.reduce((sum, x) => sum + Math.pow(x - mean, 2), 0) / similarities.length
    );
    
    const percentiles = {
      p10: similarities[Math.floor(similarities.length * 0.1)],
      p25: similarities[Math.floor(similarities.length * 0.25)],
      p50: median,
      p75: similarities[Math.floor(similarities.length * 0.75)],
      p90: similarities[Math.floor(similarities.length * 0.9)]
    };
    
    return { 
      mean, 
      median, 
      std, 
      percentiles,
      mode: isLSHMode ? 'lsh-computed-only' : 'full',
      pairsAnalyzed: similarities.length,
      totalPairs: allSimilarities.length
    };
  }

  /**
   * Identify dominant patterns in the arguments
   * @private
   */
  identifyDominantPatterns(clustersByThreshold, argumentsList) {
    const patterns = [];
    
    // Check for "unanimous agreement" pattern
    const t90 = clustersByThreshold[0.90];
    if (t90 && t90.largestClusterSize / argumentsList.length > 0.8) {
      patterns.push({
        type: 'unanimous_agreement',
        confidence: t90.largestClusterSize / argumentsList.length,
        description: 'Most respondents share very similar positions'
      });
    }
    
    // Check for "polarized" pattern
    const t80 = clustersByThreshold[0.80];
    if (t80 && t80.clusterCount === 2 && 
        Math.min(t80.clusters[0].length, t80.clusters[1].length) / argumentsList.length > 0.3) {
      patterns.push({
        type: 'polarized',
        confidence: 0.8,
        description: 'Respondents are divided into two main camps'
      });
    }
    
    // Check for "diverse opinions" pattern
    const t70 = clustersByThreshold[0.70];
    if (t70 && t70.singletonCount / argumentsList.length > 0.5) {
      patterns.push({
        type: 'diverse_opinions',
        confidence: t70.singletonCount / argumentsList.length,
        description: 'Respondents have many unique perspectives'
      });
    }
    
    // Check for "clustered agreement" pattern
    const t85 = clustersByThreshold[0.85];
    if (t85 && t85.clusterCount > 2 && t85.clusterCount < argumentsList.length / 3 &&
        t85.averageClusterSize > 3) {
      patterns.push({
        type: 'clustered_agreement',
        confidence: 0.7,
        description: 'Several distinct groups of similar opinions'
      });
    }
    
    return patterns;
  }

  /**
   * Detect mass agreement pattern (like hearing 223)
   * @private
   */
  detectMassAgreement(clusterAnalysis, responseCount) {
    // Mass agreement indicators:
    // 1. Low diversity score (< 0.35)
    // 2. Large clusters at high similarity thresholds
    // 3. Dominant pattern is unanimous_agreement
    
    const diversityScore = clusterAnalysis.diversityScore;
    const hasUnanimousPattern = clusterAnalysis.dominantPatterns.some(p => p.type === 'unanimous_agreement');
    const t85 = clusterAnalysis.clustersByThreshold[0.85];
    const hasLargeClusters = t85 && t85.largestClusterSize / clusterAnalysis.totalArguments > 0.6;
    
    const indicators = {
      lowDiversity: diversityScore < 0.35,
      unanimousPattern: hasUnanimousPattern,
      largeClusters: hasLargeClusters,
      highSimilarityMean: clusterAnalysis.similarityDistribution.mean > 0.75
    };
    
    const score = Object.values(indicators).filter(Boolean).length / 4;
    
    return {
      detected: score >= 0.5,
      confidence: score,
      indicators,
      recommendation: score >= 0.5 ? 
        'High agreement detected - use aggressive consolidation' : 
        'Normal diversity - use standard consolidation'
    };
  }

  /**
   * Generate recommendations based on analysis
   * @private
   */
  generateRecommendations(clusterAnalysis, massAgreementDetected, responseCount) {
    const recommendations = {
      consolidationStrategy: 'selective',
      consolidationThreshold: 0.85,
      expectedPositionCount: null,
      groupingStrategy: 'standard',
      parameters: {}
    };
    
    // Adjust based on mass agreement
    if (massAgreementDetected.detected) {
      recommendations.consolidationStrategy = 'full';
      recommendations.groupingStrategy = 'aggressive';
      
      // For mass agreement, adjust threshold based on diversity
      if (clusterAnalysis.diversityScore < 0.25) {
        recommendations.consolidationThreshold = 0.65; // Very aggressive
      } else if (clusterAnalysis.diversityScore < 0.35) {
        recommendations.consolidationThreshold = 0.70; // Aggressive
      } else {
        recommendations.consolidationThreshold = 0.75; // Moderately aggressive
      }
      
      // Estimate position count for mass agreement
      const t = recommendations.consolidationThreshold;
      const clusterData = clusterAnalysis.clustersByThreshold[
        Object.keys(clusterAnalysis.clustersByThreshold)
          .map(Number)
          .sort((a, b) => Math.abs(a - t) - Math.abs(b - t))[0]
      ];
      recommendations.expectedPositionCount = clusterData ? clusterData.clusterCount : 5;
    }
    // Adjust for other patterns
    else if (clusterAnalysis.dominantPatterns.some(p => p.type === 'diverse_opinions')) {
      recommendations.consolidationStrategy = 'none';
      recommendations.consolidationThreshold = 0.90;
      recommendations.groupingStrategy = 'conservative';
    }
    else if (clusterAnalysis.dominantPatterns.some(p => p.type === 'clustered_agreement')) {
      recommendations.consolidationStrategy = 'selective';
      recommendations.consolidationThreshold = 0.82;
      recommendations.groupingStrategy = 'balanced';
    }
    
    // Set specific parameters
    recommendations.parameters = {
      aggregationBatchSize: massAgreementDetected.detected ? 50 : 30,
      positionWriterChunkSize: massAgreementDetected.detected ? 50 : 20,
      useSubPositions: massAgreementDetected.detected || responseCount > 30,
      minClusterSize: massAgreementDetected.detected ? 3 : 2
    };
    
    return recommendations;
  }

  /**
   * Calculate cosine similarity between two vectors
   * @private
   */
  cosineSimilarity(vec1, vec2) {
    if (!vec1 || !vec2 || vec1.length !== vec2.length) return 0;
    
    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;
    
    for (let i = 0; i < vec1.length; i++) {
      dotProduct += vec1[i] * vec2[i];
      norm1 += vec1[i] * vec1[i];
      norm2 += vec2[i] * vec2[i];
    }
    
    norm1 = Math.sqrt(norm1);
    norm2 = Math.sqrt(norm2);
    
    if (norm1 === 0 || norm2 === 0) return 0;
    
    return dotProduct / (norm1 * norm2);
  }

  /**
   * Get default analysis for edge cases
   * @private
   */
  getDefaultAnalysis() {
    return {
      responseCount: 0,
      argumentCount: 0,
      averageArgumentsPerResponse: 0,
      clusterAnalysis: {
        totalArguments: 0,
        clustersByThreshold: {},
        diversityScore: 0.5,
        dominantPatterns: [],
        similarityDistribution: { mean: 0, median: 0, std: 0, percentiles: {} }
      },
      massAgreementDetected: {
        detected: false,
        confidence: 0,
        indicators: {},
        recommendation: 'Use default parameters'
      },
      recommendations: {
        consolidationStrategy: 'selective',
        consolidationThreshold: 0.85,
        expectedPositionCount: null,
        groupingStrategy: 'standard',
        parameters: {}
      },
      analysisTime: 0
    };
  }

  /**
   * Log analysis results if verbose
   * @param {Object} analysis - Analysis results
   */
  logAnalysis(analysis) {
    if (!this.verbose) return;
    
    console.log('\n[SimilarityAnalyzer] Pattern Analysis Results:');
    console.log(`- Response Count: ${analysis.responseCount}`);
    console.log(`- Argument Count: ${analysis.argumentCount}`);
    console.log(`- Average Arguments per Response: ${analysis.averageArgumentsPerResponse.toFixed(2)}`);
    console.log(`- Diversity Score: ${analysis.clusterAnalysis.diversityScore.toFixed(3)}`);
    console.log(`- Mass Agreement Detected: ${analysis.massAgreementDetected.detected} (confidence: ${analysis.massAgreementDetected.confidence.toFixed(2)})`);
    
    if (analysis.clusterAnalysis.dominantPatterns.length > 0) {
      console.log('- Dominant Patterns:');
      analysis.clusterAnalysis.dominantPatterns.forEach(p => {
        console.log(`  * ${p.type}: ${p.description} (confidence: ${p.confidence.toFixed(2)})`);
      });
    }
    
    console.log('- Recommendations:');
    console.log(`  * Consolidation Strategy: ${analysis.recommendations.consolidationStrategy}`);
    console.log(`  * Consolidation Threshold: ${analysis.recommendations.consolidationThreshold}`);
    console.log(`  * Expected Position Count: ${analysis.recommendations.expectedPositionCount || 'N/A'}`);
    console.log(`  * Grouping Strategy: ${analysis.recommendations.groupingStrategy}`);
    console.log(`- Analysis Time: ${analysis.analysisTime}ms\n`);
  }
}
