/**
 * Alibaba Cloud Reranker
 *
 * Uses qwen3-rerank model via DashScope API for true cross-encoder reranking.
 * Unlike embedding-based reranking, this uses a dedicated reranking model
 * that directly scores query-document pairs.
 *
 * Endpoint: https://dashscope-intl.aliyuncs.com/compatible-mode/v1
 * Model: qwen3-rerank (or gte-rerank-v2)
 * Price: $0.10/1M tokens (international)
 */

import OpenAI from 'openai';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: join(__dirname, '../../config/.env') });

// Alibaba Cloud DashScope endpoints
const ALIBABA_ENDPOINTS = {
  international: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  china: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
};

export class AlibabaReranker {
  constructor(options = {}) {
    const apiKey = options.apiKey || process.env.ALIBABA_API_KEY || process.env.DASHSCOPE_API_KEY;
    if (!apiKey) {
      console.warn('[AlibabaReranker] ALIBABA_API_KEY not found - reranker will be disabled');
      this.enabled = false;
      return;
    }

    // Use international endpoint by default
    const region = options.region || process.env.ALIBABA_REGION || 'international';
    this.baseURL = options.baseURL || ALIBABA_ENDPOINTS[region] || ALIBABA_ENDPOINTS.international;

    // Create OpenAI-compatible client with Alibaba endpoint
    this.client = new OpenAI({
      apiKey,
      baseURL: this.baseURL,
      timeout: options.timeout || 60000, // 1 min default for reranking
      maxRetries: 0 // We handle retries manually
    });

    // Model configuration
    this.model = options.model || process.env.ALIBABA_RERANK_MODEL || 'gte-rerank';
    this.enabled = options.enabled !== false;

    // Retry configuration
    this.retryAttempts = options.retryAttempts || 3;
    this.maxRetryDelay = options.maxRetryDelay || 30000;

    // Batch configuration (reranking can handle more docs per request)
    this.maxDocsPerRequest = options.maxDocsPerRequest || 50;

    // Usage tracking for cost calculation
    this.usage = {
      totalTokens: 0,
      totalCalls: 0,
      totalDocs: 0,
      model: this.model,
      provider: 'alibaba'
    };

    console.log(`[AlibabaReranker] Initialized with model=${this.model}, endpoint=${this.baseURL}`);
  }

  /**
   * Get the provider name
   * @returns {string}
   */
  getProviderName() {
    return 'alibaba';
  }

  /**
   * Get usage statistics for cost calculation
   * @returns {Object}
   */
  getUsage() {
    return { ...this.usage };
  }

  /**
   * Reset usage statistics
   */
  resetUsage() {
    this.usage = {
      totalTokens: 0,
      totalCalls: 0,
      totalDocs: 0,
      model: this.model,
      provider: 'alibaba'
    };
  }

  /**
   * Rerank chunks using Alibaba's qwen3-rerank model
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
        return (chunk.content || '').substring(0, 4000); // Limit passage length
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

      // Call rerank API with retry
      const results = await this.rerankWithRetry(query, validPassages);

      // Build scores array
      const scores = new Array(chunks.length).fill(0);
      if (results && results.length > 0) {
        for (const result of results) {
          const originalIdx = validIndices[result.index];
          if (originalIdx !== undefined) {
            scores[originalIdx] = result.relevance_score || result.score || 0;
          }
        }
      }

      // Return chunks with scores
      return chunks.map((item, idx) => ({
        ...item,
        rerankScore: scores[idx],
        score: scores[idx] || item.score || 0
      }));

    } catch (error) {
      console.warn('[AlibabaReranker] Reranking failed, returning original chunks:', error.message);
      return chunks;
    }
  }

  /**
   * Call rerank API with retry logic
   * @private
   */
  async rerankWithRetry(query, documents) {
    let lastError;

    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      try {
        if (attempt > 1) {
          console.log(`[AlibabaReranker] Retry ${attempt}/${this.retryAttempts}`);
        }

        // Call the rerank endpoint
        // Note: Alibaba uses a similar format to Cohere's rerank API
        const response = await this.client.post('/rerank', {
          model: this.model,
          query: query,
          documents: documents,
          top_n: documents.length, // Return all scores
          return_documents: false
        });

        // Track usage
        if (response.usage) {
          this.usage.totalTokens += response.usage.total_tokens || 0;
        }
        this.usage.totalCalls++;
        this.usage.totalDocs += documents.length;

        // Extract results
        // Response format: { results: [{ index: 0, relevance_score: 0.95 }, ...] }
        return response.results || response.data || [];

      } catch (error) {
        lastError = error;

        // Check if we should retry
        const isRetryable = error.status === 429 ||
          error.status === 500 ||
          error.status === 503 ||
          error.message?.includes('timeout') ||
          error.message?.includes('connection');

        if (isRetryable && attempt < this.retryAttempts) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), this.maxRetryDelay);
          console.warn(`[AlibabaReranker] Error on attempt ${attempt}, retrying in ${delay}ms: ${error.message}`);
          await this.delay(delay);
          continue;
        }

        throw error;
      }
    }

    throw new Error(`Failed to rerank after ${this.retryAttempts} attempts: ${lastError?.message}`);
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
      console.log('[AlibabaReranker] Warming up...');
      const testChunks = [{ content: 'test passage' }];
      await this.rerank('test query', testChunks);
      console.log('[AlibabaReranker] ✅ Warmup complete');
      return true;
    } catch (error) {
      console.warn('[AlibabaReranker] Warmup failed:', error.message);
      // Don't disable - might work later
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
      console.warn('[AlibabaReranker] Not available:', error.message);
      return false;
    }
  }

  /**
   * Delay helper
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
