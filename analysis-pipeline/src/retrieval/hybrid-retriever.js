/**
 * Hybrid Retriever
 *
 * Combines embedding-based similarity with BM25-like keyword matching for better retrieval.
 * Optionally applies cross-encoder reranking for improved precision.
 *
 * Supports multiple reranker providers via RERANKER_PROVIDER environment variable:
 * - 'openai' (default): Embedding-based cosine similarity
 * - 'alibaba': True cross-encoder reranking via qwen3-rerank
 * - 'bge': Local BGE reranker model
 */

import { EmbeddingService } from '../embedding/embedding-service.js';
import { getRerankerProvider, getRerankerProviderName } from './reranker-provider-factory.js';

export class HybridRetriever {
  constructor(options = {}) {
    this.embeddingService = new EmbeddingService(options);

    // Initialize reranker (optional, lazy-loaded)
    this.reranker = null;
    this._rerankerOptions = options;
    this._rerankerInitialized = false;
    this.reRankEnabled = options.reRank !== false;
    this.rerankerProviderName = options.rerankerProvider || getRerankerProviderName();

    // Dynamic parameters (will be set per hearing via setDynamicParameters)
    this.topK = options.topK || 20;
    this.reRankTopK = options.reRankTopK || 10;
    this.minScore = options.minScore || 0.6;
    this.hybridWeight = options.hybridWeight || 0.7; // Weight for embedding score (0-1)

    console.log(`[HybridRetriever] Configured with reranker provider: ${this.rerankerProviderName}`);
  }

  /**
   * Ensure reranker is initialized (lazy loading)
   * @private
   */
  async _ensureReranker() {
    if (this._rerankerInitialized) {
      return this.reranker;
    }

    if (!this.reRankEnabled) {
      this._rerankerInitialized = true;
      return null;
    }

    try {
      this.reranker = await getRerankerProvider({
        provider: this.rerankerProviderName,
        ...this._rerankerOptions
      });
      console.log(`[HybridRetriever] Reranker initialized: ${this.reranker.getProviderName?.() || this.rerankerProviderName}`);
    } catch (error) {
      console.warn('[HybridRetriever] Failed to initialize reranker:', error.message);
      this.reRankEnabled = false;
      this.reranker = null;
    }

    this._rerankerInitialized = true;
    return this.reranker;
  }

  /**
   * Set dynamic parameters for this hearing
   * Called by pipeline orchestrator with hearing-specific parameters
   */
  setDynamicParameters(params) {
    if (params.retrieval) {
      this.topK = params.retrieval.topK;
      this.reRankTopK = params.retrieval.reRankTopK || this.reRankTopK;
      this.minScore = params.retrieval.minScore;
      
      // Allow dynamic enabling/disabling of reranking
      if (params.retrieval.reRankEnabled !== undefined) {
        this.reRankEnabled = params.retrieval.reRankEnabled && this.reranker !== null;
      }
      
      console.log(`[HybridRetriever] Dynamic parameters set: topK=${this.topK}, reRankTopK=${this.reRankTopK}, reRankEnabled=${this.reRankEnabled}, minScore=${this.minScore}`);
    }
  }

  /**
   * Pre-embed multiple queries in a single batch to avoid connection saturation
   * Call this BEFORE calling retrieve() multiple times with same queries
   * 
   * @param {Array<{id: string, query: string}>} queryItems - Items with id and query text
   * @returns {Promise<Map<string, Array>>} Map of id → embedding vector
   */
  async preEmbedQueries(queryItems) {
    if (!Array.isArray(queryItems) || queryItems.length === 0) {
      return new Map();
    }

    const validItems = queryItems.filter(item => item.query && item.query.trim().length > 0);
    if (validItems.length === 0) {
      return new Map();
    }

    console.log(`[HybridRetriever] Pre-embedding ${validItems.length} retrieval queries in batch...`);
    const startTime = Date.now();

    try {
      const texts = validItems.map(item => item.query);
      const embeddings = await this.embeddingService.embedBatch(texts);

      const embeddingsMap = new Map();
      validItems.forEach((item, idx) => {
        const embedding = embeddings[idx];
        if (Array.isArray(embedding) && embedding.length > 0) {
          embeddingsMap.set(item.id, embedding);
        }
      });

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[HybridRetriever] Pre-embedded ${embeddingsMap.size}/${validItems.length} queries in ${duration}s`);

      return embeddingsMap;
    } catch (error) {
      console.error('[HybridRetriever] Failed to pre-embed queries:', error.message);
      return new Map();
    }
  }

  /**
   * Set pre-computed query embeddings for use in retrieve()
   * @param {Map<string, Array>} embeddingsMap - Map of query id → embedding
   */
  setPreEmbeddedQueries(embeddingsMap) {
    this.preEmbeddedQueries = embeddingsMap;
    console.log(`[HybridRetriever] Set ${embeddingsMap.size} pre-embedded queries`);
  }

  /**
   * Clear pre-embedded queries (call after aggregation is done)
   */
  clearPreEmbeddedQueries() {
    this.preEmbeddedQueries = null;
  }

  /**
   * Retrieve relevant chunks using hybrid approach
   * @param {string} query - Search query
   * @param {Array} chunks - Array of chunks with embeddings
   * @param {Object} options - Retrieval options
   * @param {string} [options.queryId] - Query ID for looking up pre-computed embedding
   * @returns {Promise<Array>} Ranked chunks
   */
  async retrieve(query, chunks, options = {}) {
    if (!query || !chunks || chunks.length === 0) {
      return [];
    }

    const topK = options.topK || this.topK;
    const reRankTopK = options.reRankTopK || this.reRankTopK;
    const minScore = options.minScore || this.minScore;

    // Ensure reranker is initialized (lazy loading)
    const reranker = await this._ensureReranker();
    const enableRerank = (options.reRank !== false) && this.reRankEnabled && reranker;

    // Try to use pre-computed embedding first (avoids API call)
    let queryEmbedding = null;
    if (options.queryId && this.preEmbeddedQueries?.has(options.queryId)) {
      queryEmbedding = this.preEmbeddedQueries.get(options.queryId);
    } else if (options.preComputedEmbedding) {
      queryEmbedding = options.preComputedEmbedding;
    }

    // Fallback: compute embedding on-the-fly (slow path)
    if (!queryEmbedding || queryEmbedding.length === 0) {
      queryEmbedding = await this.embeddingService.embedQuery(query);
    }

    if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
      console.warn('[HybridRetriever] Failed to get query embedding');
      return [];
    }

    // Step 1: Calculate embedding similarity scores
    const embeddingScores = this.calculateEmbeddingScores(queryEmbedding, chunks);

    // Step 2: Calculate BM25-like keyword scores
    const keywordScores = this.calculateKeywordScores(query, chunks);

    // Step 3: Combine scores
    const combinedScores = this.combineScores(embeddingScores, keywordScores);

    // Step 4: Filter by minimum score and sort
    let filtered = combinedScores
      .filter(item => item.score >= minScore)
      .sort((a, b) => b.score - a.score);

    // Step 5: Apply reranking if enabled and we have more chunks than reRankTopK
    if (enableRerank && filtered.length > reRankTopK) {
      const candidateCount = Math.min(filtered.length, topK * 2); // Get 2x topK candidates for reranking
      const candidates = filtered.slice(0, candidateCount);

      try {
        console.log(`[HybridRetriever] Reranking ${candidates.length} candidates to get top ${reRankTopK}`);
        const reranked = await reranker.rerank(query, candidates);
        
        // Sort by rerank score
        filtered = reranked
          .sort((a, b) => (b.rerankScore || b.score) - (a.rerankScore || a.score))
          .slice(0, topK * 2) // Keep 2x topK for diversification
          .concat(filtered.slice(candidateCount)); // Add remaining chunks (not reranked)
        
      } catch (error) {
        console.warn('[HybridRetriever] Reranking failed, using hybrid scores:', error.message);
        // Continue with hybrid scores
      }
    } else {
      filtered = filtered.slice(0, topK * 2); // Get 2x topK for diversification
    }

    // Step 6: Diversify results (avoid too many from same source)
    const diversified = this.diversifyResults(filtered, topK);

    // Return with consistent format
    return diversified.map(item => ({
      chunk: item.chunk,
      score: item.rerankScore || item.score,
      embeddingScore: item.embeddingScore,
      keywordScore: item.keywordScore,
      ...(item.rerankScore && { rerankScore: item.rerankScore })
    }));
  }

  /**
   * Calculate cosine similarity scores
   */
  calculateEmbeddingScores(queryEmbedding, chunks) {
    return chunks.map(chunk => {
      const embedding = chunk.embedding || [];
      if (!Array.isArray(embedding) || embedding.length === 0) {
        return { chunk, score: 0 };
      }

      const similarity = this.cosineSimilarity(queryEmbedding, embedding);
      return { chunk, score: similarity };
    });
  }

  /**
   * Calculate BM25-like keyword scores
   */
  calculateKeywordScores(query, chunks) {
    // Tokenize query (simple word split)
    const queryTerms = this.tokenize(query.toLowerCase());
    if (queryTerms.length === 0) {
      return chunks.map(chunk => ({ chunk, score: 0 }));
    }

    // Calculate term frequencies and document frequencies
    const termFreqs = new Map();
    const docFreqs = new Map();

    chunks.forEach((chunk, docIdx) => {
      const content = (chunk.content || '').toLowerCase();
      const docTerms = this.tokenize(content);
      const docTermSet = new Set(docTerms);

      queryTerms.forEach(term => {
        if (!termFreqs.has(term)) {
          termFreqs.set(term, new Map());
        }
        const tf = docTerms.filter(t => t === term).length;
        termFreqs.get(term).set(docIdx, tf);

        if (docTermSet.has(term)) {
          docFreqs.set(term, (docFreqs.get(term) || 0) + 1);
        }
      });
    });

    // Calculate BM25 scores
    const scores = chunks.map((chunk, docIdx) => {
      const content = (chunk.content || '').toLowerCase();
      const docTerms = this.tokenize(content);
      const docLength = docTerms.length;
      const avgDocLength = chunks.reduce((sum, c) => sum + this.tokenize(c.content || '').length, 0) / chunks.length;

      let score = 0;
      const k1 = 1.5;
      const b = 0.75;
      const totalDocs = chunks.length;

      queryTerms.forEach(term => {
        const tf = termFreqs.get(term)?.get(docIdx) || 0;
        const df = docFreqs.get(term) || 0;

        if (df === 0) return;

        const idf = Math.log((totalDocs - df + 0.5) / (df + 0.5) + 1);
        const numerator = tf * (k1 + 1);
        const denominator = tf + k1 * (1 - b + b * (docLength / avgDocLength));
        score += idf * (numerator / denominator);
      });

      return { chunk, score: score / queryTerms.length }; // Normalize by query length
    });

    // Normalize scores to 0-1 range
    const maxScore = Math.max(...scores.map(s => s.score), 1);
    return scores.map(item => ({
      chunk: item.chunk,
      score: maxScore > 0 ? item.score / maxScore : 0
    }));
  }

  /**
   * Combine embedding and keyword scores
   */
  combineScores(embeddingScores, keywordScores) {
    const combined = new Map();

    embeddingScores.forEach(({ chunk, score }) => {
      combined.set(chunk.chunkId, {
        chunk,
        embeddingScore: score,
        keywordScore: 0
      });
    });

    keywordScores.forEach(({ chunk, score }) => {
      const existing = combined.get(chunk.chunkId);
      if (existing) {
        existing.keywordScore = score;
      } else {
        combined.set(chunk.chunkId, {
          chunk,
          embeddingScore: 0,
          keywordScore: score
        });
      }
    });

    // Calculate combined score
    return Array.from(combined.values()).map(item => ({
      ...item,
      score: (item.embeddingScore * this.hybridWeight) + (item.keywordScore * (1 - this.hybridWeight))
    }));
  }

  /**
   * Diversify results to avoid too many from same source
   */
  diversifyResults(scoredChunks, topK) {
    const diversified = [];
    const sourceCounts = new Map();
    const maxPerSource = Math.max(2, Math.ceil(topK / 4)); // Max 25% from same source

    for (const item of scoredChunks) {
      const source = item.chunk.source || 'unknown';
      const count = sourceCounts.get(source) || 0;

      if (count < maxPerSource || diversified.length < topK) {
        diversified.push(item);
        sourceCounts.set(source, count + 1);
        if (diversified.length >= topK) break;
      }
    }

    return diversified.slice(0, topK);
  }

  /**
   * Calculate cosine similarity
   */
  cosineSimilarity(vecA, vecB) {
    if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length) {
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  /**
   * Simple tokenization (word split, remove punctuation)
   */
  tokenize(text) {
    return text
      .toLowerCase()
      .replace(/[^\w\sæøå]/g, ' ')
      .split(/\s+/)
      .filter(token => token.length > 0);
  }
}




