/**
 * IncrementalManager
 * 
 * Manages incremental pipeline runs by tracking content hashes and determining
 * which steps and responses need reprocessing vs. reuse from baseline.
 * 
 * Key features:
 * - Content-based hashing (not just IDs) to detect actual changes
 * - Per-response tracking for granular reuse
 * - Material hash tracking to detect hearing document changes
 * - Metadata for UI integration and audit trail
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Metadata version for forward compatibility
 */
const METADATA_VERSION = 1;

export class IncrementalManager {
  constructor(options = {}) {
    this.hearingId = options.hearingId;
    this.baselineLabel = options.baselineLabel || null;
    this.targetLabel = options.targetLabel || 'default';
    this.checkpointManager = options.checkpointManager;
    
    // Cached baseline metadata
    this._baselineMetadata = null;
    this._baselineLoaded = false;
    
    // Current run tracking
    this.currentMetadata = {
      version: METADATA_VERSION,
      createdAt: new Date().toISOString(),
      baselineLabel: this.baselineLabel,
      hearingId: this.hearingId,
      targetLabel: this.targetLabel,
      materialHash: null,
      taxonomyHash: null,
      responseHashes: {},
      processedResponseIds: [],
      reusedResponseIds: [],
      newResponseIds: [],
      modifiedResponseIds: [],
      removedResponseIds: [],
      stepDecisions: {},
      stats: {
        totalResponses: 0,
        reusedCount: 0,
        newCount: 0,
        modifiedCount: 0,
        removedCount: 0
      }
    };
  }

  /**
   * Compute SHA-256 hash of content
   * @param {string|Object} content - Content to hash
   * @returns {string} Hex hash
   */
  computeHash(content) {
    const str = typeof content === 'string' 
      ? content 
      : JSON.stringify(content, Object.keys(content).sort());
    return createHash('sha256').update(str, 'utf-8').digest('hex').slice(0, 16);
  }

  /**
   * Compute hash for a response (based on text content)
   * @param {Object} response - Response object with text
   * @returns {string} Hash
   */
  computeResponseHash(response) {
    // Hash based on actual content that affects analysis
    const contentToHash = {
      id: response.id,
      text: (response.text || '').trim(),
      respondentType: response.respondentType || null
    };
    return this.computeHash(contentToHash);
  }

  /**
   * Compute hash for materials (hearing documents)
   * @param {Array} materials - Array of material objects
   * @returns {string} Hash
   */
  computeMaterialsHash(materials) {
    if (!materials || materials.length === 0) return 'empty';
    
    // Sort and hash material content
    const sorted = [...materials].sort((a, b) => 
      (a.title || '').localeCompare(b.title || '')
    );
    const contentToHash = sorted.map(m => ({
      title: m.title || '',
      contentMd: (m.contentMd || '').trim().slice(0, 10000) // First 10k chars for performance
    }));
    return this.computeHash(contentToHash);
  }

  /**
   * Compute hash for taxonomy
   * @param {Object} taxonomy - Taxonomy object with themes
   * @returns {string} Hash
   */
  computeTaxonomyHash(taxonomy) {
    if (!taxonomy || !taxonomy.themes) return 'empty';
    
    const contentToHash = {
      themes: taxonomy.themes.map(t => ({
        name: t.name,
        description: t.description || ''
      }))
    };
    return this.computeHash(contentToHash);
  }

  /**
   * Load baseline metadata from checkpoint
   * @returns {Object|null} Baseline metadata or null
   */
  loadBaselineMetadata() {
    if (this._baselineLoaded) return this._baselineMetadata;
    
    if (!this.baselineLabel || !this.checkpointManager) {
      this._baselineLoaded = true;
      return null;
    }

    try {
      // Try to load incremental metadata file
      const metadataPath = this._getMetadataPath(this.baselineLabel);
      if (existsSync(metadataPath)) {
        const raw = readFileSync(metadataPath, 'utf-8');
        this._baselineMetadata = JSON.parse(raw);
        console.log(`[IncrementalManager] Loaded baseline metadata from ${this.baselineLabel}`);
      } else {
        // Fallback: reconstruct metadata from checkpoint files
        this._baselineMetadata = this._reconstructMetadataFromCheckpoints();
      }
    } catch (error) {
      console.warn(`[IncrementalManager] Could not load baseline metadata: ${error.message}`);
      this._baselineMetadata = null;
    }
    
    this._baselineLoaded = true;
    return this._baselineMetadata;
  }

  /**
   * Reconstruct metadata from existing checkpoint files
   * Used for backward compatibility with runs that don't have metadata
   * @private
   */
  _reconstructMetadataFromCheckpoints() {
    const reconstructed = {
      version: 0, // Indicates reconstructed
      reconstructed: true,
      baselineLabel: this.baselineLabel,
      responseHashes: {},
      processedResponseIds: []
    };

    // Load micro-summarize to get processed response IDs
    const microSummaries = this.checkpointManager.load(
      this.hearingId, 
      'micro-summarize', 
      this.baselineLabel
    );

    if (microSummaries && Array.isArray(microSummaries)) {
      for (const summary of microSummaries) {
        const responseId = summary.responseNumber;
        if (responseId) {
          reconstructed.processedResponseIds.push(responseId);
          // We can't reconstruct hashes without original response text
          // Mark as 'unknown' - will need to reprocess if we want hash validation
          reconstructed.responseHashes[responseId] = 'unknown';
        }
      }
    }

    // Load materials hash from material-summary if available
    const loadData = this.checkpointManager.load(
      this.hearingId, 
      'load-data', 
      this.baselineLabel
    );
    if (loadData?.materials) {
      reconstructed.materialHash = this.computeMaterialsHash(loadData.materials);
    }

    // Load taxonomy hash
    const taxonomy = this.checkpointManager.load(
      this.hearingId,
      'analyze-material',
      this.baselineLabel
    );
    if (taxonomy) {
      reconstructed.taxonomyHash = this.computeTaxonomyHash(taxonomy);
    }

    console.log(`[IncrementalManager] Reconstructed metadata: ${reconstructed.processedResponseIds.length} responses`);
    return reconstructed;
  }

  /**
   * Get metadata file path for a label
   * @private
   */
  _getMetadataPath(label) {
    // Use run directory structure
    return join(
      __dirname, 
      '../../output/runs', 
      String(this.hearingId), 
      label, 
      'checkpoints',
      '_incremental-metadata.json'
    );
  }

  /**
   * Analyze current data against baseline and determine what needs processing
   * @param {Object} currentData - Current hearing data from load-data step
   * @returns {Object} Analysis result with decisions
   */
  analyzeIncrementalNeeds(currentData) {
    const baseline = this.loadBaselineMetadata();
    const responses = currentData.responses || [];
    const materials = currentData.materials || [];

    // Compute current hashes
    const currentMaterialHash = this.computeMaterialsHash(materials);
    this.currentMetadata.materialHash = currentMaterialHash;

    // Track all current responses
    const currentResponseHashes = {};
    for (const response of responses) {
      const hash = this.computeResponseHash(response);
      currentResponseHashes[response.id] = hash;
      this.currentMetadata.responseHashes[response.id] = hash;
    }

    // Analyze differences
    const analysis = {
      materialsChanged: false,
      newResponses: [],
      modifiedResponses: [],
      unchangedResponses: [],
      removedResponses: [],
      canReuseSteps: {}
    };

    if (!baseline) {
      // No baseline - everything is new
      analysis.newResponses = responses.map(r => r.id);
      this.currentMetadata.newResponseIds = analysis.newResponses;
      this.currentMetadata.stats.newCount = analysis.newResponses.length;
      this.currentMetadata.stats.totalResponses = responses.length;
      
      console.log(`[IncrementalManager] No baseline - all ${responses.length} responses are new`);
      return analysis;
    }

    // Check materials
    if (baseline.materialHash && baseline.materialHash !== currentMaterialHash) {
      analysis.materialsChanged = true;
      console.log(`[IncrementalManager] ⚠️ Materials changed (${baseline.materialHash} → ${currentMaterialHash})`);
    } else {
      console.log(`[IncrementalManager] ✓ Materials unchanged`);
    }

    // Check each current response
    const baselineIds = new Set(baseline.processedResponseIds || []);
    const currentIds = new Set(responses.map(r => r.id));

    for (const response of responses) {
      const responseId = response.id;
      const currentHash = currentResponseHashes[responseId];
      const baselineHash = baseline.responseHashes?.[responseId];

      if (!baselineIds.has(responseId)) {
        // New response
        analysis.newResponses.push(responseId);
      } else if (baselineHash === 'unknown') {
        // Reconstructed baseline without hashes - assume unchanged
        analysis.unchangedResponses.push(responseId);
      } else if (baselineHash !== currentHash) {
        // Modified response
        analysis.modifiedResponses.push(responseId);
      } else {
        // Unchanged
        analysis.unchangedResponses.push(responseId);
      }
    }

    // Check for removed responses
    for (const baselineId of baselineIds) {
      if (!currentIds.has(baselineId)) {
        analysis.removedResponses.push(baselineId);
      }
    }

    // Update metadata
    this.currentMetadata.newResponseIds = analysis.newResponses;
    this.currentMetadata.modifiedResponseIds = analysis.modifiedResponses;
    this.currentMetadata.reusedResponseIds = analysis.unchangedResponses;
    this.currentMetadata.removedResponseIds = analysis.removedResponses;
    this.currentMetadata.stats = {
      totalResponses: responses.length,
      reusedCount: analysis.unchangedResponses.length,
      newCount: analysis.newResponses.length,
      modifiedCount: analysis.modifiedResponses.length,
      removedCount: analysis.removedResponses.length
    };

    // Determine which steps can be reused
    analysis.canReuseSteps = this._determineReusableSteps(analysis);

    // Log summary
    console.log(`[IncrementalManager] Analysis complete:`);
    console.log(`  - Unchanged: ${analysis.unchangedResponses.length} responses`);
    console.log(`  - New: ${analysis.newResponses.length} responses`);
    console.log(`  - Modified: ${analysis.modifiedResponses.length} responses`);
    console.log(`  - Removed: ${analysis.removedResponses.length} responses`);
    if (analysis.materialsChanged) {
      console.log(`  - ⚠️ Materials changed - material-dependent steps will re-run`);
    }

    return analysis;
  }

  /**
   * Determine which steps can be fully reused vs. need reprocessing
   * @private
   */
  _determineReusableSteps(analysis) {
    const canReuse = {};
    const hasChanges = analysis.newResponses.length > 0 || 
                       analysis.modifiedResponses.length > 0 ||
                       analysis.removedResponses.length > 0;

    // Material-dependent steps
    if (!analysis.materialsChanged) {
      canReuse['material-summary'] = true;
      canReuse['analyze-material'] = true;
      canReuse['extract-substance'] = true;
      canReuse['embed-substance'] = true;
    }

    // Per-response steps - can partially reuse
    if (!hasChanges && !analysis.materialsChanged) {
      canReuse['edge-case-screening'] = true;
      canReuse['enrich-responses'] = true;
      canReuse['chunking'] = true;
      canReuse['embedding'] = true;
      canReuse['micro-summarize'] = true;
    }

    // Downstream steps always need rerun if any response changes
    // (theme-mapping, aggregate, etc. depend on all responses)

    // Store decisions
    this.currentMetadata.stepDecisions = canReuse;

    return canReuse;
  }

  /**
   * Get responses that need processing (new + modified)
   * @returns {number[]} Array of response IDs
   */
  getResponsesNeedingProcessing() {
    return [
      ...this.currentMetadata.newResponseIds,
      ...this.currentMetadata.modifiedResponseIds
    ];
  }

  /**
   * Get response IDs that can be reused from baseline
   * @returns {number[]} Array of response IDs
   */
  getReusableResponseIds() {
    return this.currentMetadata.reusedResponseIds;
  }

  /**
   * Check if a step can be fully reused from baseline
   * @param {string} stepName - Step name
   * @returns {boolean}
   */
  canReuseStep(stepName) {
    return this.currentMetadata.stepDecisions[stepName] === true;
  }

  /**
   * Load and merge per-response data from baseline
   * @param {string} stepName - Step name (e.g., 'micro-summarize')
   * @param {Array} newResults - Results for newly processed responses
   * @param {Array} allResponses - All current responses (for ordering)
   * @returns {Array} Merged results
   */
  mergeWithBaseline(stepName, newResults, allResponses) {
    if (!this.baselineLabel || !this.checkpointManager) {
      return newResults;
    }

    const baseline = this.checkpointManager.load(
      this.hearingId,
      stepName,
      this.baselineLabel
    );

    if (!baseline || !Array.isArray(baseline)) {
      return newResults;
    }

    // Create lookup for new results
    const newResultsById = new Map();
    for (const result of newResults) {
      const id = result.responseNumber || result.id || result.responseId;
      if (id) newResultsById.set(id, result);
    }

    // Create lookup for baseline results
    const baselineById = new Map();
    for (const result of baseline) {
      const id = result.responseNumber || result.id || result.responseId;
      if (id) baselineById.set(id, result);
    }

    // Get current response IDs in order
    const currentIds = allResponses.map(r => r.id);

    // Merge: prefer new results, fall back to baseline for unchanged
    const merged = [];
    const reusedIds = new Set(this.currentMetadata.reusedResponseIds);
    const removedIds = new Set(this.currentMetadata.removedResponseIds);

    for (const id of currentIds) {
      if (newResultsById.has(id)) {
        // Use new result
        merged.push(newResultsById.get(id));
      } else if (reusedIds.has(id) && baselineById.has(id)) {
        // Reuse from baseline
        merged.push(baselineById.get(id));
      }
      // Note: removed responses are not included
    }

    console.log(`[IncrementalManager] Merged ${stepName}: ${merged.length} total (${newResults.length} new, ${merged.length - newResults.length} reused)`);
    
    return merged;
  }

  /**
   * Merge patched results with baseline (for patch mode)
   *
   * Unlike mergeWithBaseline() which handles incremental new/modified responses,
   * this method specifically handles PATCH mode where we:
   * 1. Replace entries for patched response IDs with new results
   * 2. Keep all other entries from baseline
   *
   * @param {string} stepName - Step name (e.g., 'micro-summarize')
   * @param {Array} patchedResults - Results for patched responses only
   * @param {Set<number>} patchedIds - Set of response IDs that were patched
   * @returns {Array} Merged results (patched + baseline)
   */
  patchMerge(stepName, patchedResults, patchedIds) {
    if (!this.baselineLabel || !this.checkpointManager) {
      console.warn('[IncrementalManager] No baseline for patchMerge, returning patched results only');
      return patchedResults;
    }

    const baseline = this.checkpointManager.load(
      this.hearingId,
      stepName,
      this.baselineLabel
    );

    if (!baseline || !Array.isArray(baseline)) {
      console.warn(`[IncrementalManager] No baseline found for ${stepName}, returning patched results only`);
      return patchedResults;
    }

    // Create lookup for patched results
    const patchedById = new Map();
    for (const result of patchedResults) {
      const id = result.responseNumber || result.id || result.responseId;
      if (id !== undefined) patchedById.set(id, result);
    }

    // Build merged array: use patched for patched IDs, baseline for all others
    const merged = [];
    const patchedIdsSet = patchedIds instanceof Set ? patchedIds : new Set(patchedIds);
    const seenIds = new Set();

    // First, add all baseline entries (replacing patched ones)
    for (const entry of baseline) {
      const id = entry.responseNumber || entry.id || entry.responseId;
      if (id === undefined) continue;

      if (patchedIdsSet.has(id)) {
        // Use patched result instead
        const patched = patchedById.get(id);
        if (patched) {
          merged.push(patched);
          seenIds.add(id);
        }
      } else {
        // Keep baseline entry
        merged.push(entry);
        seenIds.add(id);
      }
    }

    // Add any patched results that weren't in baseline (edge case)
    for (const result of patchedResults) {
      const id = result.responseNumber || result.id || result.responseId;
      if (id !== undefined && !seenIds.has(id)) {
        merged.push(result);
      }
    }

    console.log(`[IncrementalManager] patchMerge(${stepName}): ${patchedResults.length} patched + ${baseline.length - patchedResults.length} from baseline = ${merged.length} total`);

    return merged;
  }

  /**
   * Get themes that are touched by a set of response IDs
   * Used in patch mode to determine which themes need re-aggregation
   *
   * @param {Set<number>|Array<number>} patchedResponseIds - IDs of patched responses
   * @param {Object} responseToThemes - Mapping from responseId to array of theme names
   * @returns {Set<string>} Set of theme names that are affected
   */
  getTouchedThemes(patchedResponseIds, responseToThemes) {
    const touchedThemes = new Set();
    const idsSet = patchedResponseIds instanceof Set
      ? patchedResponseIds
      : new Set(patchedResponseIds);

    for (const responseId of idsSet) {
      const themes = responseToThemes[responseId] || responseToThemes[String(responseId)] || [];
      for (const theme of themes) {
        touchedThemes.add(theme);
      }
    }

    console.log(`[IncrementalManager] getTouchedThemes: ${idsSet.size} patched responses touch ${touchedThemes.size} themes: ${[...touchedThemes].join(', ')}`);

    return touchedThemes;
  }

  /**
   * Get positions that are touched by a set of response IDs
   * Used in patch mode to determine which positions need re-writing
   *
   * @param {Set<number>|Array<number>} patchedResponseIds - IDs of patched responses
   * @param {Array} themes - Array of themes with positions
   * @returns {Object} { touchedPositions: Map<themeName, Set<positionTitle>>, touchedCount, skippedCount }
   */
  getTouchedPositions(patchedResponseIds, themes) {
    const idsSet = patchedResponseIds instanceof Set
      ? patchedResponseIds
      : new Set(patchedResponseIds);

    const touchedPositions = new Map(); // themeName -> Set of position titles
    let touchedCount = 0;
    let skippedCount = 0;

    for (const theme of themes) {
      const touchedInTheme = new Set();

      for (const position of (theme.positions || [])) {
        const positionResponseIds = position.responseNumbers || [];
        const hasPatched = positionResponseIds.some(id => idsSet.has(id));

        if (hasPatched) {
          touchedInTheme.add(position.title);
          touchedCount++;
        } else {
          skippedCount++;
        }
      }

      if (touchedInTheme.size > 0) {
        touchedPositions.set(theme.name, touchedInTheme);
      }
    }

    console.log(`[IncrementalManager] getTouchedPositions: ${touchedCount} positions touched, ${skippedCount} can be skipped`);

    return { touchedPositions, touchedCount, skippedCount };
  }

  /**
   * Save current metadata for future incremental runs
   */
  saveMetadata() {
    this.currentMetadata.completedAt = new Date().toISOString();
    this.currentMetadata.processedResponseIds = [
      ...this.currentMetadata.reusedResponseIds,
      ...this.currentMetadata.newResponseIds,
      ...this.currentMetadata.modifiedResponseIds
    ];

    const metadataPath = this._getMetadataPath(this.targetLabel);
    
    try {
      writeFileSync(metadataPath, JSON.stringify(this.currentMetadata, null, 2), 'utf-8');
      console.log(`[IncrementalManager] Saved metadata to ${metadataPath}`);
    } catch (error) {
      console.warn(`[IncrementalManager] Could not save metadata: ${error.message}`);
    }
  }

  /**
   * Get a summary for logging/UI
   * @returns {Object} Summary object
   */
  getSummary() {
    return {
      baselineLabel: this.baselineLabel,
      targetLabel: this.targetLabel,
      materialsChanged: this.currentMetadata.stepDecisions['material-summary'] !== true,
      stats: this.currentMetadata.stats,
      reusableSteps: Object.keys(this.currentMetadata.stepDecisions)
        .filter(k => this.currentMetadata.stepDecisions[k]),
      estimatedSavings: this._estimateSavings()
    };
  }

  /**
   * Estimate token/cost savings from incremental run
   * @private
   */
  _estimateSavings() {
    const stats = this.currentMetadata.stats;
    const totalResponses = stats.totalResponses || 1;
    const reusedCount = stats.reusedCount || 0;
    
    // Rough estimates based on typical token usage
    const avgTokensPerMicroSummary = 2000; // input + output
    const avgTokensPerEdgeCase = 500;
    const avgTokensPerEmbedding = 200;
    
    const savedMicroSummaryTokens = reusedCount * avgTokensPerMicroSummary;
    const savedEdgeCaseTokens = reusedCount * avgTokensPerEdgeCase;
    const savedEmbeddingTokens = reusedCount * avgTokensPerEmbedding;
    
    const totalSavedTokens = savedMicroSummaryTokens + savedEdgeCaseTokens + savedEmbeddingTokens;
    const percentReused = Math.round((reusedCount / totalResponses) * 100);
    
    return {
      reusedResponses: reusedCount,
      percentReused,
      estimatedSavedTokens: totalSavedTokens,
      estimatedSavedCost: `~$${(totalSavedTokens * 0.000003).toFixed(2)}` // Rough avg cost
    };
  }
}

