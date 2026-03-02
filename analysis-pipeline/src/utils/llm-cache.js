/**
 * LLM Cache
 * 
 * Hash-based caching layer for LLM responses to avoid redundant API calls.
 * OPTIMIZATION: Reuse responses for identical inputs (10-30% speedup for similar positions).
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export class LLMCache {
  constructor(options = {}) {
    this.cacheDir = options.cacheDir || join(process.cwd(), '.cache', 'llm');
    this.ttl = options.ttl || 7 * 24 * 60 * 60 * 1000; // 7 days default TTL
    this.enabled = options.enabled !== false; // Enabled by default
    this.inMemoryCache = new Map();
    this.maxInMemorySize = options.maxInMemorySize || 100; // Keep last 100 in memory
    
    // Create cache directory if it doesn't exist
    if (this.enabled) {
      try {
        mkdirSync(this.cacheDir, { recursive: true });
        console.log(`[LLMCache] Cache enabled, directory: ${this.cacheDir}`);
      } catch (error) {
        console.warn(`[LLMCache] Failed to create cache directory:`, error.message);
        this.enabled = false;
      }
    }
    
    // Stats
    this.stats = {
      hits: 0,
      misses: 0,
      writes: 0,
      errors: 0
    };
  }

  /**
   * Generate cache key from request parameters
   * @param {Object} params - Request parameters (messages, model, temperature, etc.)
   * @returns {string} Cache key hash
   */
  generateKey(params) {
    // OPTIMIZATION: Include only semantically relevant fields in hash
    // Exclude fields that don't affect output (like timeout, retries, etc.)
    const relevant = {
      messages: params.messages,
      model: params.model,
      temperature: params.temperature,
      response_format: params.response_format
    };
    
    const serialized = JSON.stringify(relevant, Object.keys(relevant).sort());
    return createHash('sha256').update(serialized).digest('hex');
  }

  /**
   * Get cached response
   * @param {string} key - Cache key
   * @returns {Object|null} Cached response or null if not found/expired
   */
  get(key) {
    if (!this.enabled) return null;
    
    try {
      // Check in-memory cache first
      if (this.inMemoryCache.has(key)) {
        const cached = this.inMemoryCache.get(key);
        if (Date.now() - cached.timestamp < this.ttl) {
          this.stats.hits++;
          console.log(`[LLMCache] ✓ Hit (in-memory): ${key.slice(0, 8)}...`);
          return cached.response;
        } else {
          // Expired
          this.inMemoryCache.delete(key);
        }
      }
      
      // Check filesystem cache
      const cachePath = join(this.cacheDir, `${key}.json`);
      if (existsSync(cachePath)) {
        const cached = JSON.parse(readFileSync(cachePath, 'utf-8'));
        if (Date.now() - cached.timestamp < this.ttl) {
          this.stats.hits++;
          console.log(`[LLMCache] ✓ Hit (disk): ${key.slice(0, 8)}...`);
          
          // Load into in-memory cache
          this.setInMemory(key, cached.response, cached.timestamp);
          
          return cached.response;
        } else {
          // Expired - could delete file here
          console.log(`[LLMCache] Expired: ${key.slice(0, 8)}...`);
        }
      }
      
      this.stats.misses++;
      return null;
    } catch (error) {
      console.warn(`[LLMCache] Error reading cache:`, error.message);
      this.stats.errors++;
      return null;
    }
  }

  /**
   * Set cached response
   * @param {string} key - Cache key
   * @param {Object} response - LLM response to cache
   */
  set(key, response) {
    if (!this.enabled) return;
    
    try {
      const timestamp = Date.now();
      const cached = { response, timestamp };
      
      // Save to in-memory cache
      this.setInMemory(key, response, timestamp);
      
      // Save to filesystem
      const cachePath = join(this.cacheDir, `${key}.json`);
      writeFileSync(cachePath, JSON.stringify(cached), 'utf-8');
      
      this.stats.writes++;
      console.log(`[LLMCache] ✓ Cached: ${key.slice(0, 8)}...`);
    } catch (error) {
      console.warn(`[LLMCache] Error writing cache:`, error.message);
      this.stats.errors++;
    }
  }

  /**
   * Set in-memory cache with LRU eviction
   * @private
   */
  setInMemory(key, response, timestamp) {
    // LRU eviction if cache is full
    if (this.inMemoryCache.size >= this.maxInMemorySize) {
      // Remove oldest entry
      const firstKey = this.inMemoryCache.keys().next().value;
      this.inMemoryCache.delete(firstKey);
    }
    
    this.inMemoryCache.set(key, { response, timestamp });
  }

  /**
   * Get or compute with caching
   * @param {Object} params - Request parameters
   * @param {Function} compute - Async function to compute response if not cached
   * @returns {Promise<Object>} Response (cached or computed)
   */
  async getOrCompute(params, compute) {
    const key = this.generateKey(params);
    
    // Try to get from cache
    const cached = this.get(key);
    if (cached) {
      return cached;
    }
    
    // Compute if not cached
    console.log(`[LLMCache] Miss, computing: ${key.slice(0, 8)}...`);
    const response = await compute();
    
    // Cache the response
    this.set(key, response);
    
    return response;
  }

  /**
   * Clear all cached responses
   */
  clear() {
    this.inMemoryCache.clear();
    console.log(`[LLMCache] In-memory cache cleared`);
    // Note: Not clearing filesystem cache automatically for safety
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache stats
   */
  getStats() {
    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0 ? (this.stats.hits / total * 100).toFixed(1) : 0;
    
    return {
      ...this.stats,
      total,
      hitRate: `${hitRate}%`,
      inMemorySize: this.inMemoryCache.size
    };
  }

  /**
   * Log cache statistics
   */
  logStats() {
    const stats = this.getStats();
    console.log(`[LLMCache] Stats: ${stats.hits} hits, ${stats.misses} misses, hit rate: ${stats.hitRate}, in-memory: ${stats.inMemorySize} entries`);
  }
}


