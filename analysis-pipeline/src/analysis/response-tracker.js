/**
 * ResponseTracker
 * 
 * Tracks responseNumbers through position consolidation to prevent data loss.
 * Provides auto-recovery for orphaned responses by following merge history.
 * 
 * Key features:
 * - Tracks responseNumber → position mappings before/after consolidation
 * - Records all merge operations with full history
 * - Validates no responses are lost during consolidation
 * - Auto-recovers orphaned responses by re-mapping to merged positions
 */

export class ResponseTracker {
  constructor() {
    // Maps responseNumber → positionId (before consolidation)
    this.initialMap = new Map();
    
    // Maps positionId → { title, responseNumbers, themeIdx, posIdx }
    this.positionRegistry = new Map();
    
    // Tracks merge operations: targetPositionId → [sourcePositionIds]
    this.mergeHistory = new Map();
    
    // Maps removed positionId → target positionId it was merged into
    this.removalTargets = new Map();
    
    // Statistics
    this.stats = {
      totalResponses: 0,
      totalPositions: 0,
      mergeOperations: 0,
      removals: 0
    };
  }

  /**
   * Initialize tracking before consolidation
   * Builds initial responseNumber → position mappings
   * @param {Array} themes - Themes with positions before consolidation
   */
  initialize(themes) {
    console.log('[ResponseTracker] Initializing response tracking...');
    
    let positionIdCounter = 0;
    const allResponseNumbers = new Set();
    
    themes.forEach((theme, themeIdx) => {
      (theme.positions || []).forEach((position, posIdx) => {
        const positionId = `pos_${positionIdCounter++}`;
        const responseNumbers = position.responseNumbers || [];
        
        // Register position
        this.positionRegistry.set(positionId, {
          title: position.title,
          responseNumbers: [...responseNumbers],
          themeIdx,
          posIdx,
          themeName: theme.name
        });
        
        // Map each response to this position
        responseNumbers.forEach(responseNum => {
          if (this.initialMap.has(responseNum)) {
          // WARNING suppressed by user request
          // console.warn(`[ResponseTracker] WARNING: Response ${responseNum} appears in multiple positions!`);
          }
          this.initialMap.set(responseNum, positionId);
          allResponseNumbers.add(responseNum);
        });
      });
    });
    
    this.stats.totalResponses = allResponseNumbers.size;
    this.stats.totalPositions = positionIdCounter;
    
    console.log(`[ResponseTracker] Initialized: ${this.stats.totalResponses} responses across ${this.stats.totalPositions} positions`);
  }

  /**
   * Record a merge operation
   * @param {Array<string>} sourcePositionIds - Positions being merged (will be removed)
   * @param {string} targetPositionId - Position they're merging into (survives)
   * @param {Array<number>} movedResponseNumbers - Response numbers from source positions
   */
  recordMerge(sourcePositionIds, targetPositionId, movedResponseNumbers = []) {
    if (!Array.isArray(sourcePositionIds)) {
      sourcePositionIds = [sourcePositionIds];
    }
    
    // Record merge history
    if (!this.mergeHistory.has(targetPositionId)) {
      this.mergeHistory.set(targetPositionId, []);
    }
    this.mergeHistory.get(targetPositionId).push(...sourcePositionIds);
    
    // Record removal targets (for recovery)
    sourcePositionIds.forEach(sourceId => {
      this.removalTargets.set(sourceId, targetPositionId);
    });
    
    this.stats.mergeOperations++;
    
    console.log(`[ResponseTracker] Recorded merge: [${sourcePositionIds.join(', ')}] → ${targetPositionId} (${movedResponseNumbers.length} responses)`);
  }

  /**
   * Record a position removal (without explicit merge target)
   * Used when we detect a removal after the fact
   * @param {string} positionId - Position being removed
   * @param {string} targetPositionId - Position it was merged into (if known)
   */
  recordRemoval(positionId, targetPositionId = null) {
    if (targetPositionId) {
      this.removalTargets.set(positionId, targetPositionId);
    }
    this.stats.removals++;
    
    console.log(`[ResponseTracker] Recorded removal: ${positionId}${targetPositionId ? ` → ${targetPositionId}` : ''}`);
  }

  /**
   * Validate that all responses are still present after consolidation
   * @param {Array} consolidatedThemes - Themes after consolidation
   * @returns {Object} Validation result with orphaned responses
   */
  validate(consolidatedThemes) {
    console.log('[ResponseTracker] Validating post-consolidation coverage...');
    
    // Collect all response numbers in consolidated output
    const presentResponses = new Set();
    consolidatedThemes.forEach(theme => {
      (theme.positions || []).forEach(position => {
        (position.responseNumbers || []).forEach(num => {
          presentResponses.add(num);
        });
      });
    });
    
    // Find orphaned responses (were in initial map but not in consolidated output)
    const orphanedResponses = [];
    for (const [responseNum, originalPositionId] of this.initialMap.entries()) {
      if (!presentResponses.has(responseNum)) {
        orphanedResponses.push({
          responseNumber: responseNum,
          originalPositionId,
          originalPosition: this.positionRegistry.get(originalPositionId)
        });
      }
    }
    
    const result = {
      totalResponses: this.initialMap.size,
      presentResponses: presentResponses.size,
      orphanedResponses,
      isValid: orphanedResponses.length === 0
    };
    
    if (orphanedResponses.length > 0) {
      console.warn(`[ResponseTracker] VALIDATION FAILED: ${orphanedResponses.length} orphaned responses detected!`);
      console.warn(`[ResponseTracker] Orphaned response numbers: ${orphanedResponses.map(o => o.responseNumber).join(', ')}`);
    } else {
      console.log(`[ResponseTracker] ✓ Validation passed: All ${this.initialMap.size} responses accounted for`);
    }
    
    return result;
  }

  /**
   * Auto-recover orphaned responses by re-mapping them to merged positions
   * @param {Array} consolidatedThemes - Themes after consolidation
   * @param {Array} orphanedResponses - Orphaned responses from validate()
   * @param {Array} allResponses - All response objects (for breakdown recalculation)
   * @returns {Array} Consolidated themes with orphaned responses recovered
   */
  recover(consolidatedThemes, orphanedResponses, allResponses = []) {
    console.log(`[ResponseTracker] Starting auto-recovery for ${orphanedResponses.length} orphaned responses...`);
    
    const recoveryMap = new Map(); // positionKey → [responseNumbers to add]
    let recovered = 0;
    let unrecoverable = 0;
    
    // For each orphaned response, find its merge target
    for (const orphan of orphanedResponses) {
      const { responseNumber, originalPositionId, originalPosition } = orphan;
      
      // Follow merge chain to find final target position
      const targetPositionId = this.findMergeTarget(originalPositionId);
      
      if (!targetPositionId) {
        console.warn(`[ResponseTracker] Cannot recover response ${responseNumber}: no merge target found for position ${originalPositionId}`);
        unrecoverable++;
        continue;
      }
      
      // Find target position in consolidated themes
      const targetInfo = this.positionRegistry.get(targetPositionId);
      if (!targetInfo) {
        console.warn(`[ResponseTracker] Cannot recover response ${responseNumber}: target position ${targetPositionId} not in registry`);
        unrecoverable++;
        continue;
      }
      
      // Find actual position object in consolidated themes
      const targetTheme = consolidatedThemes[targetInfo.themeIdx];
      if (!targetTheme) {
        console.warn(`[ResponseTracker] Cannot recover response ${responseNumber}: target theme ${targetInfo.themeIdx} not found`);
        unrecoverable++;
        continue;
      }
      
      // Find position by title (more robust than index which may have changed)
      const targetPosition = targetTheme.positions?.find(p => p.title === targetInfo.title);
      if (!targetPosition) {
        console.warn(`[ResponseTracker] Cannot recover response ${responseNumber}: target position "${targetInfo.title}" not found in theme`);
        unrecoverable++;
        continue;
      }
      
      // Build recovery key
      const positionKey = `${targetInfo.themeIdx}:${targetInfo.title}`;
      if (!recoveryMap.has(positionKey)) {
        recoveryMap.set(positionKey, []);
      }
      recoveryMap.get(positionKey).push(responseNumber);
      recovered++;
      
      console.log(`[ResponseTracker] Recovered response ${responseNumber}: ${originalPosition?.title || 'unknown'} → ${targetInfo.title}`);
    }
    
    // Apply recoveries to consolidated themes
    const recoveredThemes = consolidatedThemes.map((theme, themeIdx) => {
      const positions = (theme.positions || []).map(position => {
        const positionKey = `${themeIdx}:${position.title}`;
        const responsesToAdd = recoveryMap.get(positionKey);
        
        if (!responsesToAdd || responsesToAdd.length === 0) {
          return position; // No recovery needed
        }
        
        // Merge recovered responses into position
        const updatedResponseNumbers = [
          ...new Set([...(position.responseNumbers || []), ...responsesToAdd])
        ].sort((a, b) => a - b);
        
        console.log(`[ResponseTracker] Adding ${responsesToAdd.length} recovered responses to "${position.title}": [${responsesToAdd.join(', ')}]`);
        
        // Recalculate respondent breakdown with recovered responses
        const updatedBreakdown = this.recalculateBreakdown(updatedResponseNumbers, allResponses);
        
        return {
          ...position,
          responseNumbers: updatedResponseNumbers,
          respondentBreakdown: updatedBreakdown,
          _recoveryMeta: {
            recoveredResponses: responsesToAdd,
            recoveryTimestamp: new Date().toISOString()
          }
        };
      });
      
      return {
        ...theme,
        positions
      };
    });
    
    console.log(`[ResponseTracker] Auto-recovery complete: ${recovered} recovered, ${unrecoverable} unrecoverable`);
    
    if (unrecoverable > 0) {
      console.error(`[ResponseTracker] CRITICAL: ${unrecoverable} responses could not be recovered!`);
    }
    
    return recoveredThemes;
  }

  /**
   * Find the final merge target for a position by following merge chains
   * @param {string} positionId - Position ID to trace
   * @returns {string|null} Final target position ID, or null if not merged
   */
  findMergeTarget(positionId) {
    let currentId = positionId;
    const visited = new Set();
    
    // Follow merge chain (handle transitive merges)
    while (this.removalTargets.has(currentId)) {
      if (visited.has(currentId)) {
        console.warn(`[ResponseTracker] Circular merge chain detected for position ${positionId}`);
        return null;
      }
      visited.add(currentId);
      currentId = this.removalTargets.get(currentId);
    }
    
    // If we moved at all, return the final target
    return currentId !== positionId ? currentId : null;
  }

  /**
   * Recalculate respondent breakdown from response numbers
   * @param {Array<number>} responseNumbers - Response numbers
   * @param {Array} allResponses - All response objects
   * @returns {Object} Respondent breakdown
   */
  recalculateBreakdown(responseNumbers, allResponses) {
    const breakdown = {
      localCommittees: [],
      publicAuthorities: [],
      organizations: [],
      citizens: 0,
      total: responseNumbers.length
    };

    if (!allResponses || allResponses.length === 0) {
      // Fallback: all citizens if no response data
      breakdown.citizens = responseNumbers.length;
      return breakdown;
    }

    const seenCommittees = new Set();
    const seenAuthorities = new Set();
    const seenOrgs = new Set();

    for (const responseNumber of responseNumbers) {
      const response = allResponses.find(r => r.id === responseNumber);
      if (!response) {
        breakdown.citizens++;
        continue;
      }

      const respondentType = (response.respondentType || '').toLowerCase();
      const respondentName = response.respondentName || '';

      if (respondentType.includes('lokaludvalg') || respondentName.toLowerCase().includes('lokaludvalg')) {
        const name = respondentName || `Henvendelse ${responseNumber}`;
        if (!seenCommittees.has(name)) {
          breakdown.localCommittees.push(name);
          seenCommittees.add(name);
        }
      } else if (respondentType.includes('organisation')) {
        if (respondentName && !seenOrgs.has(respondentName)) {
          breakdown.organizations.push(respondentName);
          seenOrgs.add(respondentName);
        }
      } else if (respondentType.includes('myndighed')) {
        const name = respondentName || `Henvendelse ${responseNumber}`;
        if (!seenAuthorities.has(name)) {
          breakdown.publicAuthorities.push(name);
          seenAuthorities.add(name);
        }
      } else {
        breakdown.citizens++;
      }
    }

    return breakdown;
  }

  /**
   * Generate diagnostic report
   * @returns {Object} Statistics and diagnostic information
   */
  generateReport() {
    return {
      stats: this.stats,
      mergeHistory: Array.from(this.mergeHistory.entries()).map(([target, sources]) => ({
        target,
        sources,
        count: sources.length
      })),
      removalCount: this.removalTargets.size,
      initialPositionCount: this.positionRegistry.size,
      initialResponseCount: this.initialMap.size
    };
  }
}

