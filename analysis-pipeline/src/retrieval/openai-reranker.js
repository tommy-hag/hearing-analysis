/**
 * OpenAI Reranker
 *
 * Uses OpenAI text-embedding-3-small for reranking via cosine similarity.
 * Much better Danish language support than BGE-reranker-v2-m3.
 *
 * Architecture:
 * - Embeds query and passages using OpenAI embeddings
 * - Calculates cosine similarity between query and each passage
 * - Returns normalized scores (0-1 range)
 *
 * IMPORTANT: Uses EmbeddingService for automatic usage tracking and concurrency control.
 * This ensures all embedding costs are captured in the run summary.
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { EmbeddingService } from '../embedding/embedding-service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: join(__dirname, '../../config/.env') });

export class OpenAIReranker {
  constructor(options = {}) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.warn('[OpenAIReranker] OPENAI_API_KEY not found - reranker will be disabled');
      this.enabled = false;
      return;
    }

    // Use text-embedding-3-small for speed and cost efficiency
    // It's excellent for Danish and much cheaper than large
    this.model = options.model || 'text-embedding-3-small';
    this.enabled = options.enabled !== false;

    // Create EmbeddingService for automatic usage tracking
    // Uses unique registryId to distinguish from other embedders
    this.embeddingService = new EmbeddingService({
      model: this.model,
      registryId: 'reranker-embedder',
      timeout: options.timeout || 120000,
      retryAttempts: options.retryAttempts || 3,
      batchSize: 50  // Reranking typically has many small passages
    });

    // Cache for query embeddings (avoid re-embedding same query)
    this._queryCache = new Map();
    this._cacheMaxSize = 100;
  }

  /**
   * Calculate cosine similarity between two vectors
   * @private
   */
  _cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }

  /**
   * Get embeddings for texts using EmbeddingService
   * EmbeddingService handles retries, semaphore, and usage tracking automatically
   * @private
   */
  async _getEmbeddings(texts) {
    // EmbeddingService.embedBatch handles all retry logic, concurrency, and tracking
    return this.embeddingService.embedBatch(texts);
  }

  /**
   * Rerank chunks using OpenAI embeddings + cosine similarity
   * 
   * @param {string} query - Search query
   * @param {Array} chunks - Array of chunk objects with content
   * @returns {Promise<Array>} Chunks with rerank scores
   */
  async rerank(query, chunks) {
    if (!this.enabled || !chunks || chunks.length === 0) {
      return chunks;
    }

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return chunks;
    }

    try {
      // Extract passage texts
      const passages = chunks.map(item => {
        const chunk = item.chunk || item;
        return (chunk.content || '').substring(0, 8000); // text-embedding-3 supports up to 8191 tokens
      });

      // Filter out empty passages
      const validIndices = [];
      const validPassages = [];
      passages.forEach((p, i) => {
        if (p && p.trim().length > 0) {
          validIndices.push(i);
          validPassages.push(p);
        }
      });

      if (validPassages.length === 0) {
        return chunks;
      }

      // Check cache for query embedding
      let queryEmbedding;
      const cacheKey = query.substring(0, 200); // Use first 200 chars as key
      
      if (this._queryCache.has(cacheKey)) {
        queryEmbedding = this._queryCache.get(cacheKey);
      } else {
        // Embed query and passages together for efficiency
        const allTexts = [query, ...validPassages];
        const embeddings = await this._getEmbeddings(allTexts);
        
        queryEmbedding = embeddings[0];
        
        // Cache query embedding
        if (this._queryCache.size >= this._cacheMaxSize) {
          // Remove oldest entry
          const firstKey = this._queryCache.keys().next().value;
          this._queryCache.delete(firstKey);
        }
        this._queryCache.set(cacheKey, queryEmbedding);
        
        // Calculate scores using pre-computed embeddings
        const passageEmbeddings = embeddings.slice(1);
        
        // Build scores array
        const scores = new Array(chunks.length).fill(0);
        validIndices.forEach((originalIdx, i) => {
          scores[originalIdx] = this._cosineSimilarity(queryEmbedding, passageEmbeddings[i]);
        });

        // Return chunks with scores
        return chunks.map((item, idx) => ({
          ...item,
          rerankScore: scores[idx],
          score: scores[idx] || item.score || 0
        }));
      }

      // If we hit cache, need to embed passages separately
      const passageEmbeddings = await this._getEmbeddings(validPassages);
      
      const scores = new Array(chunks.length).fill(0);
      validIndices.forEach((originalIdx, i) => {
        scores[originalIdx] = this._cosineSimilarity(queryEmbedding, passageEmbeddings[i]);
      });

      return chunks.map((item, idx) => ({
        ...item,
        rerankScore: scores[idx],
        score: scores[idx] || item.score || 0
      }));

    } catch (error) {
      console.warn('[OpenAIReranker] Reranking failed, returning original chunks:', error.message);
      return chunks;
    }
  }

  /**
   * Warm up the reranker by testing a simple query
   * @returns {Promise<boolean>} Success status
   */
  async warmup() {
    if (!this.enabled) {
      return false;
    }

    try {
      console.log('[OpenAIReranker] Warming up...');
      const testChunks = [{ content: 'test passage' }];
      await this.rerank('test query', testChunks);
      console.log('[OpenAIReranker] ✅ Warmup complete');
      return true;
    } catch (error) {
      console.warn('[OpenAIReranker] Warmup failed:', error.message);
      this.enabled = false;
      return false;
    }
  }

  /**
   * Check if the reranker is available
   * @returns {Promise<boolean>} Availability status
   */
  async checkAvailability() {
    if (!this.enabled) {
      return false;
    }

    try {
      const testChunks = [{ content: 'availability test' }];
      const result = await this.rerank('test', testChunks);
      return result && result.length > 0 && typeof result[0].rerankScore === 'number';
    } catch (error) {
      console.warn('[OpenAIReranker] Not available:', error.message);
      return false;
    }
  }

  /**
   * Clear the query embedding cache
   */
  clearCache() {
    this._queryCache.clear();
  }
}
