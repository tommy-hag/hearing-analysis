/**
 * MaterialCacheManager
 *
 * Manages a hearing-level cache for material analysis steps.
 * These steps (material-summary, analyze-material, extract-substance, embed-substance)
 * are independent of respondent scope, so their results can be reused across
 * different pipeline runs with varying --limit-responses or --response-ids.
 *
 * Cache Location:
 *   output/hearings/{hearingId}/material-cache/
 *
 * Cache Invalidation:
 *   - When material content hash changes (new/modified materials)
 *   - When --clear-material-cache flag is used
 *   - NOT when respondent scope changes (that's the whole point)
 */

import { createHash } from 'crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Steps that can be cached at hearing level (independent of respondent scope)
export const MATERIAL_CACHE_STEPS = [
  'material-summary',
  'material-summary-lite', // Lite version for token-efficient operations
  'analyze-material',
  'extract-substance',
  'embed-substance'
];

export class MaterialCacheManager {
  /**
   * @param {Object} options
   * @param {string} [options.baseDir] - Base directory for cache storage
   */
  constructor(options = {}) {
    this.baseDir = options.baseDir || join(__dirname, '../../output/hearings');
    this.metadataFile = 'cache-metadata.json';
  }

  /**
   * Get the cache directory for a hearing
   * @param {number|string} hearingId
   * @returns {string}
   */
  getCacheDir(hearingId) {
    return join(this.baseDir, String(hearingId), 'material-cache');
  }

  /**
   * Compute a SHA-256 hash of the materials content.
   * Used to detect when materials have changed.
   * @param {Array} materials - Array of material objects
   * @returns {string} SHA-256 hash
   */
  computeMaterialHash(materials) {
    if (!materials || materials.length === 0) {
      return 'empty';
    }

    // Create a deterministic string from materials
    // Include content and key metadata that would affect analysis
    const contentParts = materials
      .sort((a, b) => (a.materialId || 0) - (b.materialId || 0))
      .map(m => {
        const content = m.contentMd || m.content || '';
        const title = m.title || '';
        const id = m.materialId || '';
        return `${id}:${title}:${content}`;
      });

    const combinedContent = contentParts.join('|||');

    return createHash('sha256')
      .update(combinedContent, 'utf8')
      .digest('hex')
      .slice(0, 16); // Use first 16 chars for readability
  }

  /**
   * Load cache metadata for a hearing
   * @param {number|string} hearingId
   * @returns {Object|null}
   */
  loadMetadata(hearingId) {
    const metadataPath = join(this.getCacheDir(hearingId), this.metadataFile);

    if (!existsSync(metadataPath)) {
      return null;
    }

    try {
      const raw = readFileSync(metadataPath, 'utf-8');
      return JSON.parse(raw);
    } catch (error) {
      console.warn(`[MaterialCacheManager] Failed to read metadata: ${error.message}`);
      return null;
    }
  }

  /**
   * Save cache metadata
   * @param {number|string} hearingId
   * @param {Object} metadata
   */
  saveMetadata(hearingId, metadata) {
    const cacheDir = this.getCacheDir(hearingId);
    mkdirSync(cacheDir, { recursive: true });

    const metadataPath = join(cacheDir, this.metadataFile);
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
  }

  /**
   * Check if the cache is valid for the current materials
   * @param {number|string} hearingId
   * @param {string} currentHash - Hash of current materials
   * @returns {{ valid: boolean, reason?: string, metadata?: Object }}
   */
  isCacheValid(hearingId, currentHash) {
    const metadata = this.loadMetadata(hearingId);

    if (!metadata) {
      return { valid: false, reason: 'no cache exists' };
    }

    if (metadata.materialHash !== currentHash) {
      return {
        valid: false,
        reason: `hash mismatch (cached: ${metadata.materialHash}, current: ${currentHash})`
      };
    }

    // Check that all required steps are cached
    const cacheDir = this.getCacheDir(hearingId);
    const missingSteps = MATERIAL_CACHE_STEPS.filter(step => {
      const stepPath = join(cacheDir, `${step}.json`);
      return !existsSync(stepPath);
    });

    if (missingSteps.length > 0) {
      return {
        valid: false,
        reason: `missing cached steps: ${missingSteps.join(', ')}`
      };
    }

    return { valid: true, metadata };
  }

  /**
   * Load a cached step result
   * @param {number|string} hearingId
   * @param {string} stepName
   * @returns {*|null}
   */
  loadCachedStep(hearingId, stepName) {
    if (!MATERIAL_CACHE_STEPS.includes(stepName)) {
      console.warn(`[MaterialCacheManager] Step "${stepName}" is not a cacheable material step`);
      return null;
    }

    const stepPath = join(this.getCacheDir(hearingId), `${stepName}.json`);

    if (!existsSync(stepPath)) {
      return null;
    }

    try {
      const raw = readFileSync(stepPath, 'utf-8');
      return JSON.parse(raw);
    } catch (error) {
      console.warn(`[MaterialCacheManager] Failed to load ${stepName}: ${error.message}`);
      return null;
    }
  }

  /**
   * Save a step result to the cache
   * @param {number|string} hearingId
   * @param {string} stepName
   * @param {*} data
   * @param {string} hash - Current material hash
   * @param {Object} [options]
   * @param {string} [options.sourceRun] - Label of the run that created this cache
   */
  saveToCache(hearingId, stepName, data, hash, options = {}) {
    if (!MATERIAL_CACHE_STEPS.includes(stepName)) {
      console.warn(`[MaterialCacheManager] Step "${stepName}" is not a cacheable material step`);
      return;
    }

    const cacheDir = this.getCacheDir(hearingId);
    mkdirSync(cacheDir, { recursive: true });

    // Save step data
    const stepPath = join(cacheDir, `${stepName}.json`);
    writeFileSync(stepPath, JSON.stringify(data, null, 2), 'utf-8');

    // Update metadata
    const existingMetadata = this.loadMetadata(hearingId) || {};
    const metadata = {
      ...existingMetadata,
      materialHash: hash,
      lastUpdated: new Date().toISOString(),
      sourceRun: options.sourceRun || existingMetadata.sourceRun,
      cachedSteps: [...new Set([...(existingMetadata.cachedSteps || []), stepName])]
    };

    this.saveMetadata(hearingId, metadata);
  }

  /**
   * Clear the cache for a hearing
   * @param {number|string} hearingId
   * @returns {{ cleared: boolean, path: string }}
   */
  clearCache(hearingId) {
    const cacheDir = this.getCacheDir(hearingId);

    if (!existsSync(cacheDir)) {
      return { cleared: false, path: cacheDir };
    }

    try {
      rmSync(cacheDir, { recursive: true, force: true });
      return { cleared: true, path: cacheDir };
    } catch (error) {
      console.warn(`[MaterialCacheManager] Failed to clear cache: ${error.message}`);
      return { cleared: false, path: cacheDir, error: error.message };
    }
  }

  /**
   * Load all cached steps if cache is valid
   * @param {number|string} hearingId
   * @param {string} currentHash
   * @returns {{ valid: boolean, steps: Object, metadata?: Object, reason?: string }}
   */
  loadAllCachedSteps(hearingId, currentHash) {
    const validation = this.isCacheValid(hearingId, currentHash);

    if (!validation.valid) {
      return { valid: false, steps: {}, reason: validation.reason };
    }

    const steps = {};
    for (const stepName of MATERIAL_CACHE_STEPS) {
      const data = this.loadCachedStep(hearingId, stepName);
      if (data !== null) {
        steps[stepName] = data;
      }
    }

    return {
      valid: true,
      steps,
      metadata: validation.metadata
    };
  }

  /**
   * Save all material steps to cache
   * @param {number|string} hearingId
   * @param {Object} stepResults - Map of step name to result
   * @param {string} hash - Current material hash
   * @param {Object} [options]
   */
  saveAllSteps(hearingId, stepResults, hash, options = {}) {
    for (const stepName of MATERIAL_CACHE_STEPS) {
      if (stepResults[stepName] !== undefined) {
        this.saveToCache(hearingId, stepName, stepResults[stepName], hash, options);
      }
    }
  }

  /**
   * Get cache status for logging
   * @param {number|string} hearingId
   * @param {string} currentHash
   * @returns {Object}
   */
  getCacheStatus(hearingId, currentHash) {
    const metadata = this.loadMetadata(hearingId);
    const validation = this.isCacheValid(hearingId, currentHash);

    return {
      exists: metadata !== null,
      valid: validation.valid,
      reason: validation.reason,
      materialHash: currentHash,
      cachedHash: metadata?.materialHash || null,
      cachedSteps: metadata?.cachedSteps || [],
      lastUpdated: metadata?.lastUpdated || null,
      sourceRun: metadata?.sourceRun || null
    };
  }
}
