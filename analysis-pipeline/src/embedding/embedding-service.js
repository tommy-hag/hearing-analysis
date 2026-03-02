/**
 * Embedding Service
 *
 * Wrapper for embeddings with batch processing, retry logic, and rate limiting.
 * Supports multiple providers: OpenAI (default) and Alibaba Cloud (DashScope).
 *
 * Provider selection via:
 * - Constructor option: { provider: 'alibaba' }
 * - Environment variable: EMBEDDING_PROVIDER=alibaba
 */

import OpenAI from 'openai';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import crypto from 'crypto';
import { getBatchSizeForStep } from '../utils/batch-calculator.js';
import embeddingRegistry from './embedding-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: join(__dirname, '../../config/.env') });

/**
 * Global concurrency limiter (process-wide)
 *
 * Why:
 * - Many parts of the pipeline create their own EmbeddingService instances.
 * - Instance-level concurrency limits do NOT prevent total concurrency explosion across the process.
 * - "Connection error" + timeouts were observed in logs when many embeddings ran in parallel.
 *
 * This semaphore provides a true process-wide cap on concurrent OpenAI embedding HTTP requests.
 */
class Semaphore {
  constructor(max) {
    this.max = Math.max(1, Number.isFinite(max) ? max : 1);
    this.active = 0;
    this.queue = [];
  }

  setMax(nextMax) {
    const m = Math.max(1, Number.isFinite(nextMax) ? nextMax : 1);
    this.max = m;
    this._drain();
  }

  _drain() {
    while (this.active < this.max && this.queue.length > 0) {
      this.active++;
      const resolve = this.queue.shift();
      resolve();
    }
  }

  async acquire() {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise(resolve => this.queue.push(resolve));
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    this._drain();
  }

  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

const parsePositiveInt = (value, fallback) => {
  const n = parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// ROBUST: Default to 3 (was 5) for better stability with large hearings
// Lower concurrency = fewer simultaneous connections = more stable
const GLOBAL_EMBEDDING_MAX_CONCURRENCY = parsePositiveInt(
  process.env.EMBEDDING_GLOBAL_MAX_CONCURRENCY || process.env.EMBEDDING_MAX_CONCURRENCY,
  3
);
const globalEmbeddingSemaphore = new Semaphore(GLOBAL_EMBEDDING_MAX_CONCURRENCY);

// Global dynamic configuration (set by configureGlobalEmbeddingConcurrency)
let globalDynamicConfig = {
  baseRetryAttempts: null,
  preEmbedBatchSize: null,
  preEmbedDelayMs: null,
  preEmbedMaxRetries: null
};

/**
 * Get current dynamic embedding configuration
 * Used by SubstanceEmbedder and other components
 */
export function getDynamicEmbeddingConfig() {
  return { ...globalDynamicConfig };
}

/**
 * Configure global embedding settings from dynamic parameters.
 * Call this ONCE at pipeline startup before any embeddings are created.
 * 
 * @param {Object} params - Dynamic parameters (from DynamicParameterCalculator.getParametersForHearing)
 */
export function configureGlobalEmbeddingConcurrency(params) {
  if (!params?.embedding) {
    console.log('[EmbeddingService] No dynamic embedding params, using defaults');
    return;
  }

  const embedding = params.embedding;
  
  // Update concurrency
  if (embedding.globalMaxConcurrency) {
    const newMax = parsePositiveInt(embedding.globalMaxConcurrency, 3);
    const oldMax = globalEmbeddingSemaphore.max;
    
    if (newMax !== oldMax) {
      globalEmbeddingSemaphore.setMax(newMax);
    }
  }
  
  // Store dynamic retry/batch config for use by all embedding components
  if (embedding.baseRetryAttempts) {
    globalDynamicConfig.baseRetryAttempts = embedding.baseRetryAttempts;
  }
  if (embedding.preEmbedBatchSize) {
    globalDynamicConfig.preEmbedBatchSize = embedding.preEmbedBatchSize;
  }
  if (embedding.preEmbedDelayMs) {
    globalDynamicConfig.preEmbedDelayMs = embedding.preEmbedDelayMs;
  }
  if (embedding.preEmbedMaxRetries) {
    globalDynamicConfig.preEmbedMaxRetries = embedding.preEmbedMaxRetries;
  }

  const sizeCategory = embedding._sizeCategory || 'unknown';
  console.log(`[EmbeddingService] Dynamic config applied (${sizeCategory}): concurrency=${globalEmbeddingSemaphore.max}, baseRetries=${globalDynamicConfig.baseRetryAttempts || 'default'}, preEmbedBatch=${globalDynamicConfig.preEmbedBatchSize || 'default'}`);
}

/**
 * Get current global embedding concurrency stats (for debugging)
 */
export function getEmbeddingConcurrencyStats() {
  return {
    max: globalEmbeddingSemaphore.max,
    active: globalEmbeddingSemaphore.active,
    queued: globalEmbeddingSemaphore.queue.length
  };
}

/**
 * Run a function with the global embedding semaphore
 * This allows other components (like OpenAIReranker) to share the same
 * concurrency control as EmbeddingService, preventing API overload.
 * 
 * @param {Function} fn - Async function to run with semaphore protection
 * @returns {Promise<any>} Result of fn
 */
export async function runWithEmbeddingSemaphore(fn) {
  return globalEmbeddingSemaphore.run(fn);
}

export class EmbeddingService {
  constructor(options = {}) {
    // Determine provider (alibaba or openai)
    this.providerName = (options.provider || process.env.EMBEDDING_PROVIDER || 'openai').toLowerCase();

    // If using Alibaba provider, flag for lazy initialization
    if (this.providerName === 'alibaba' || this.providerName === 'dashscope' || this.providerName === 'qwen') {
      this.providerName = 'alibaba';
      this._alibabaOptions = options;
      this._alibabaProvider = null; // Will be initialized on first use
      this.model = options.model || process.env.ALIBABA_EMBEDDING_MODEL || 'text-embedding-v4';

      // Usage tracking (will delegate to provider once initialized)
      this.usage = {
        totalTokens: 0,
        totalCalls: 0,
        totalTexts: 0,
        model: this.model,
        provider: 'alibaba'
      };

      // Auto-register to global registry
      this.registryId = options.registryId || `embedder-alibaba-${crypto.randomUUID().slice(0, 8)}`;
      embeddingRegistry.register(this.registryId, this);
      return;
    }

    // Default: OpenAI provider
    this.providerName = 'openai';
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is required');
    }

    // Note: We handle timeouts manually with Promise.race for progressive timeout support
    this.client = new OpenAI({
      apiKey,
      timeout: options.timeout || 300000, // 5 min fallback timeout on SDK level
      maxRetries: 0 // We handle retries manually
    });
    this.model = options.model || process.env.EMBEDDING_MODEL || 'text-embedding-3-large';
    this.batchSize = options.batchSize || parseInt(process.env.EMBEDDING_BATCH_SIZE || '20');
    // Base retry attempts - uses dynamic config if available, then env, then default
    // Will be further increased for large batches in embedBatchWithRetry
    this.baseRetryAttempts = options.retryAttempts
      || globalDynamicConfig.baseRetryAttempts
      || parseInt(process.env.EMBEDDING_RETRY_ATTEMPTS || '5');
    this.retryAttempts = this.baseRetryAttempts; // Will be adjusted dynamically per batch
    this.rateLimitDelay = options.rateLimitDelay || parseInt(process.env.EMBEDDING_RATE_LIMIT_DELAY || '100');
    // Higher max delay for better recovery from transient network issues ("Connection error")
    this.maxRetryDelay = options.maxRetryDelay || 30000; // Max 30 seconds between retries

    // Progressive timeout settings (aligned with openai-client.js pattern)
    this.baseTimeout = options.baseTimeout || 180000; // 3 minutes base
    this.timeoutRetryMultiplier = options.timeoutRetryMultiplier || 1.5;
    this.maxTimeout = options.maxTimeout || 600000; // 10 minutes max

    // CRITICAL: Global concurrency limit to prevent connection saturation
    // OpenAI can handle many requests, but too many simultaneous connections cause "Connection error"
    // ROBUST: Reduced from 5 to 3 for better stability with large hearings
    this.globalMaxConcurrency = options.globalMaxConcurrency || 3; // Max 3 parallel API calls

    // Ensure the process-wide semaphore respects the smallest configured cap.
    // This prevents concurrency explosion when multiple EmbeddingService instances exist.
    if (Number.isFinite(this.globalMaxConcurrency) && this.globalMaxConcurrency > 0) {
      globalEmbeddingSemaphore.setMax(Math.min(globalEmbeddingSemaphore.max, this.globalMaxConcurrency));
    }

    // Usage tracking for cost calculation
    this.usage = {
      totalTokens: 0,
      totalCalls: 0,
      totalTexts: 0,
      model: this.model,
      provider: 'openai'
    };

    // Auto-register to global registry for accurate cost tracking
    // Uses provided registryId or generates a unique one
    this.registryId = options.registryId || `embedder-${crypto.randomUUID().slice(0, 8)}`;
    embeddingRegistry.register(this.registryId, this);
  }

  /**
   * Ensure Alibaba provider is initialized (lazy loading)
   * @private
   */
  async _ensureAlibabaProvider() {
    if (this._alibabaProvider) {
      return this._alibabaProvider;
    }

    if (this.providerName !== 'alibaba') {
      return null;
    }

    // Lazy load to avoid circular imports
    const { AlibabaEmbeddingProvider } = await import('./providers/alibaba-embedding-provider.js');
    this._alibabaProvider = new AlibabaEmbeddingProvider(this._alibabaOptions || {});
    this.model = this._alibabaProvider.model;

    console.log(`[EmbeddingService] Alibaba provider initialized: model=${this.model}`);
    return this._alibabaProvider;
  }

  /**
   * Get the provider name
   * @returns {string} 'openai' or 'alibaba'
   */
  getProviderName() {
    return this.providerName;
  }

  /**
   * Get usage statistics for cost calculation
   * @returns {Object} Usage stats
   */
  getUsage() {
    if (this.providerName === 'alibaba' && this._alibabaProvider) {
      return this._alibabaProvider.getUsage();
    }
    return { ...this.usage };
  }

  /**
   * Reset usage statistics
   */
  resetUsage() {
    if (this.providerName === 'alibaba' && this._alibabaProvider) {
      this._alibabaProvider.resetUsage();
      return;
    }
    this.usage = {
      totalTokens: 0,
      totalCalls: 0,
      totalTexts: 0,
      model: this.model,
      provider: this.providerName
    };
  }

  /**
   * Embed a batch of texts
   * @param {Array<string>} texts - Array of texts to embed
   * @param {Object} options - Options for embedding
   * @returns {Promise<Array>} Array of embedding vectors
   */
  async embedBatch(texts, options = {}) {
    // Delegate to Alibaba provider if configured
    if (this.providerName === 'alibaba') {
      const provider = await this._ensureAlibabaProvider();
      return provider.embedBatch(texts, options);
    }

    if (!Array.isArray(texts) || texts.length === 0) {
      return [];
    }

    // Filter out empty texts
    const validTexts = texts.map((text, idx) => ({
      text: String(text || '').trim(),
      originalIndex: idx
    })).filter(item => item.text.length > 0);

    if (validTexts.length === 0) {
      return texts.map(() => []);
    }

    // CRITICAL: OpenAI Embeddings API has a hard limit of 300,000 tokens per request
    // We use 250,000 as safe limit with margin for error
    const MAX_TOKENS_PER_REQUEST = 250000;
    const CHARS_PER_TOKEN = 4; // Rough estimate
    
    // CRITICAL: Use instance concurrency limit for batch scheduling,
    // and process-wide semaphore inside each API call (embedBatchWithRetry).
    const maxConcurrency = Math.min(
      options.maxConcurrency || this.globalMaxConcurrency, 
      this.globalMaxConcurrency
    ); 

    // Also respect a max items-per-request cap (prevents huge payloads even if token estimate is low)
    const maxItemsPerRequest = parsePositiveInt(options.batchSize || this.batchSize, 20);
    
    const embeddings = new Array(texts.length).fill(null);
    
    // Create batches based on TOKEN count, not text count
    // This ensures we don't exceed the 300k token limit
    const batches = [];
    let currentBatch = [];
    let currentTokenCount = 0;
    
    for (const item of validTexts) {
      const estimatedTokens = Math.ceil(item.text.length / CHARS_PER_TOKEN);
      
      // If adding this item would exceed limit, start new batch
      if (
        currentBatch.length > 0 &&
        (
          currentTokenCount + estimatedTokens > MAX_TOKENS_PER_REQUEST ||
          currentBatch.length >= maxItemsPerRequest
        )
      ) {
        batches.push(currentBatch);
        currentBatch = [];
        currentTokenCount = 0;
      }
      
      currentBatch.push(item);
      currentTokenCount += estimatedTokens;
    }
    
    // Don't forget the last batch
    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }
    
    if (batches.length > 1) {
      console.log(`[EmbeddingService] Split ${validTexts.length} texts into ${batches.length} batches (respecting 300k token limit)`);
    }

    // Track progress across batches
    let totalProcessed = 0;

    // Process batches with concurrency limit
    const processBatch = async (batch, batchIdx) => {
      const batchTexts = batch.map(item => item.text);
      try {
        const batchEmbeddings = await this.embedBatchWithRetry(batchTexts, options);
        
        // Map embeddings back to original indices
        batch.forEach((item, itemIdx) => {
          embeddings[item.originalIndex] = batchEmbeddings[itemIdx] || [];
        });
        
        // Call progress callback if provided
        if (options.onProgress) {
          // Calculate progress based on actual batch size processed
          totalProcessed += batch.length;
          options.onProgress(Math.min(totalProcessed, validTexts.length), validTexts.length);
        }
      } catch (error) {
        console.error(`[EmbeddingService] Batch ${batchIdx + 1}/${batches.length} failed:`, error.message);
        // Fill with empty arrays for failed batch
        batch.forEach(item => {
          embeddings[item.originalIndex] = [];
        });
      }
    };

    // Execute with concurrency limit
    for (let i = 0; i < batches.length; i += maxConcurrency) {
      const currentBatchGroup = batches.slice(i, i + maxConcurrency);
      await Promise.all(currentBatchGroup.map((batch, idx) => processBatch(batch, i + idx)));
      
      // Rate limiting delay between groups
      if (i + maxConcurrency < batches.length) {
        await this.delay(this.rateLimitDelay);
      }
    }

    return embeddings;
  }

  /**
   * Embed batch with retry logic and progressive timeouts
   * 
   * DYNAMIC ADAPTATION: Automatically adjusts retries based on batch size
   * - Larger batches get more retry attempts (connection issues more likely)
   * - Small batches (< 20 texts): base retries
   * - Medium batches (20-100): +2 retries
   * - Large batches (100+): +4 retries
   * 
   * CRITICAL FIX: Timeout is now started INSIDE the semaphore, not before.
   * This prevents requests waiting in queue from timing out before they even start.
   */
  async embedBatchWithRetry(texts, options = {}) {
    let lastError;
    
    // DYNAMIC: Calculate retries based on batch size
    // Larger batches are more prone to connection issues, so we retry more
    const baseRetries = options.retryAttempts || this.baseRetryAttempts;
    const sizeBonus = texts.length >= 100 ? 4 : texts.length >= 20 ? 2 : 0;
    const maxAttempts = Math.min(baseRetries + sizeBonus, 12); // Cap at 12 retries

    // DEBUG: Log batch details for troubleshooting
    const totalChars = texts.reduce((sum, t) => sum + (t?.length || 0), 0);
    const caller = new Error().stack?.split('\n')[2]?.trim() || 'unknown';
    console.log(`[EmbeddingService] DEBUG: Batch of ${texts.length} texts (${totalChars} chars total), maxAttempts=${maxAttempts}, caller=${caller.substring(0, 80)}`);

    // Calculate size-based timeout adjustment
    // Larger batches need more time - estimate ~100ms per text in batch
    const batchSizeMultiplier = Math.max(1, 1 + (texts.length - 10) * 0.05); // +5% per text over 10
    const sizeAdjustedBaseTimeout = Math.min(this.baseTimeout * batchSizeMultiplier, this.maxTimeout);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Progressive timeout: each retry gets more time
      const attemptMultiplier = Math.pow(this.timeoutRetryMultiplier, attempt - 1);
      const attemptTimeout = Math.min(Math.round(sizeAdjustedBaseTimeout * attemptMultiplier), this.maxTimeout);

      try {
        // Truncate texts to max length (8000 chars for embeddings)
        const truncatedTexts = texts.map(text => String(text).slice(0, 8000));

        if (attempt > 1) {
          console.log(`[EmbeddingService] Retry ${attempt}/${maxAttempts} with ${(attemptTimeout/1000).toFixed(0)}s timeout`);
        }

        // CRITICAL FIX: Timeout is started INSIDE the semaphore.run() callback.
        // This ensures we only start timing when we actually get to run (not while waiting in queue).
        // Without this fix, requests waiting in queue would time out before even starting.
        const response = await globalEmbeddingSemaphore.run(async () => {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), attemptTimeout);
          
          try {
            return await this.client.embeddings.create(
              {
                model: this.model,
                input: truncatedTexts
              },
              {
                signal: controller.signal
              }
            );
          } finally {
            clearTimeout(timeoutId);
          }
        });

        if (!response || !response.data || !Array.isArray(response.data)) {
          throw new Error('Invalid response from OpenAI API');
        }

        // Track usage for cost calculation
        if (response.usage) {
          this.usage.totalTokens += response.usage.total_tokens || 0;
          this.usage.totalCalls++;
          this.usage.totalTexts += texts.length;
        }

        // Extract embeddings
        const embeddings = response.data.map(item => item.embedding || []);
        
        if (embeddings.length !== texts.length) {
          throw new Error(`Expected ${texts.length} embeddings, got ${embeddings.length}`);
        }

        return embeddings;
      } catch (error) {
        lastError = error;
        
        const msg = String(error?.message || '');
        const code = error?.code;
        const name = String(error?.name || '');

        // Check if it's a timeout error - use progressive retry
        // When using AbortController, OpenAI SDK typically throws AbortError / APIUserAbortError.
        const isTimeout =
          name.toLowerCase().includes('abort') ||
          msg.toLowerCase().includes('timed out') ||
          msg.toLowerCase().includes('timeout') ||
          msg.toLowerCase().includes('aborted');

        // Transient network/transport errors (these often show up as "Connection error.")
        const isConnectionError =
          ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code) ||
          msg.toLowerCase().includes('connection error') ||
          msg.toLowerCase().includes('socket') ||
          msg.toLowerCase().includes('network');

        const jitter = (ms) => {
          const factor = 0.5 + Math.random(); // 0.5..1.5
          return Math.round(ms * factor);
        };

        if (isTimeout && attempt < maxAttempts) {
          const nextTimeout = Math.min(Math.round(sizeAdjustedBaseTimeout * Math.pow(this.timeoutRetryMultiplier, attempt)), this.maxTimeout);
          console.warn(`[EmbeddingService] Timeout after ${(attemptTimeout/1000).toFixed(0)}s (attempt ${attempt}/${maxAttempts}), retrying with ${(nextTimeout/1000).toFixed(0)}s...`);
          await this.delay(jitter(Math.min(2000 * attempt, this.maxRetryDelay))); // Brief pause before retry (with jitter)
          continue;
        }
        
        // Check if it's a rate limit error
        const isRateLimit = error.status === 429 || 
                           error.message?.includes('rate limit') ||
                           error.message?.includes('Rate limit');
        
        if (isRateLimit && attempt < maxAttempts) {
          // Exponential backoff for rate limits
          const delay = Math.min(this.rateLimitDelay * Math.pow(2, attempt - 1), this.maxRetryDelay);
          console.warn(`[EmbeddingService] Rate limit hit, retrying in ${delay}ms (attempt ${attempt}/${maxAttempts})`);
          await this.delay(jitter(delay));
          continue;
        }

        // Transient connection errors: exponential backoff with jitter
        if (isConnectionError && attempt < maxAttempts) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), this.maxRetryDelay);
          // DEBUG: More details about connection error
          const stats = getEmbeddingConcurrencyStats();
          console.warn(`[EmbeddingService] Connection error (attempt ${attempt}/${maxAttempts}), active=${stats.active}/${stats.max}, queued=${stats.queued}, batch=${texts.length} texts, retrying in ${delay}ms: ${msg}`);
          await this.delay(jitter(delay));
          continue;
        }
        
        // For other errors, retry with shorter delay
        if (attempt < maxAttempts) {
          const delay = Math.min(1000 * attempt, this.maxRetryDelay);
          console.warn(`[EmbeddingService] Error on attempt ${attempt}/${maxAttempts}, retrying in ${delay}ms:`, error.message);
          await this.delay(jitter(delay));
          continue;
        }
      }
    }

    throw new Error(`Failed to embed batch after ${maxAttempts} attempts: ${lastError?.message || 'Unknown error'}`);
  }

  /**
   * Embed a single text (convenience method)
   */
  async embedQuery(text) {
    // Delegate to Alibaba provider if configured
    if (this.providerName === 'alibaba') {
      const provider = await this._ensureAlibabaProvider();
      return provider.embedQuery(text);
    }
    const embeddings = await this.embedBatch([text]);
    return embeddings[0] || [];
  }

  /**
   * Delay helper
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get embedding dimensions for the model
   */
  getDimensions() {
    // Delegate to Alibaba provider if configured
    if (this.providerName === 'alibaba') {
      // Return expected dimensions even before provider is initialized
      if (this._alibabaProvider) {
        return this._alibabaProvider.getDimensions();
      }
      // Default Alibaba dimension (before lazy init)
      return parseInt(process.env.ALIBABA_EMBEDDING_DIMENSIONS || '2048');
    }
    // text-embedding-3-large has 3072 dimensions
    if (this.model.includes('3-large')) {
      return 3072;
    }
    // text-embedding-3-small has 1536 dimensions
    if (this.model.includes('3-small')) {
      return 1536;
    }
    // Default for text-embedding-3
    return 1536;
  }
}




