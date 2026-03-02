/**
 * Position Sorter
 *
 * Sorts positions within themes according to specified rules:
 * 1. Common elements first (positions with multiple respondent types)
 * 2. Then by respondent type priority: Public authorities > Local committees > Organizations > Citizens
 * 3. Within same type, sort by size (largest to smallest)
 */

import { StepLogger } from '../utils/step-logger.js';

export class PositionSorter {
  constructor() {
    this.log = new StepLogger('PositionSorter');
  }
  /**
   * Sort positions within each theme
   * @param {Array} themes - Themes with positions
   * @returns {Array} Themes with sorted positions
   */
  sortThemes(themes) {
    const totalPositions = themes.reduce((sum, t) => sum + (t.positions?.length || 0), 0);
    this.log.start({ themes: themes.length, positions: totalPositions });

    // Analyze position types before sorting
    const typeStats = { common: 0, authorities: 0, localCommittees: 0, organizations: 0, citizens: 0 };
    let reorderedCount = 0;

    const sortedThemes = themes.map(theme => {
      const originalOrder = (theme.positions || []).map(p => p.title);
      const sorted = this.sortPositions(theme.positions || []);
      const newOrder = sorted.map(p => p.title);

      // Count reordered positions
      for (let i = 0; i < originalOrder.length; i++) {
        if (originalOrder[i] !== newOrder[i]) {
          reorderedCount++;
        }
      }

      // Collect type statistics
      for (const position of sorted) {
        const analysis = this.analyzePosition(position);
        if (analysis.isCommon) {
          typeStats.common++;
        } else if (analysis.typePriority === 1) {
          typeStats.authorities++;
        } else if (analysis.typePriority === 2) {
          typeStats.localCommittees++;
        } else if (analysis.typePriority === 3) {
          typeStats.organizations++;
        } else {
          typeStats.citizens++;
        }
      }

      return {
        ...theme,
        positions: sorted
      };
    });

    this.log.distribution('Position types', typeStats);
    this.log.metric('Reordered', `${reorderedCount}/${totalPositions}`, 'positions moved');
    this.log.complete({ themes: themes.length, sorted: totalPositions });

    return sortedThemes;
  }

  /**
   * Sort positions according to rules
   * @param {Array} positions - Positions to sort
   * @returns {Array} Sorted positions
   */
  sortPositions(positions) {
    if (!positions || positions.length === 0) return positions;

    // Analyze each position for sorting
    const analyzed = positions.map(position => ({
      position,
      ...this.analyzePosition(position)
    }));

    // Sort by:
    // 1. Common elements (multi-type) first
    // 2. Respondent type priority
    // 3. Size (response count)
    analyzed.sort((a, b) => {
      // 1. Common elements first (positions with multiple types)
      if (a.isCommon && !b.isCommon) return -1;
      if (!a.isCommon && b.isCommon) return 1;

      // 2. Respondent type priority
      if (a.typePriority !== b.typePriority) {
        return a.typePriority - b.typePriority; // Lower number = higher priority
      }

      // 3. Size (larger first)
      return b.size - a.size;
    });

    return analyzed.map(a => a.position);
  }

  /**
   * Analyze a position for sorting
   * @param {Object} position - Position to analyze
   * @returns {Object} Analysis results
   */
  analyzePosition(position) {
    const breakdown = position.respondentBreakdown || {};
    
    // Count types present
    const hasPublicAuth = (breakdown.publicAuthorities?.length || 0) > 0;
    const hasLocalCommittee = (breakdown.localCommittees?.length || 0) > 0;
    const hasOrganization = (breakdown.organizations?.length || 0) > 0;
    const hasCitizens = (breakdown.citizens || 0) > 0;
    
    const typeCount = [hasPublicAuth, hasLocalCommittee, hasOrganization, hasCitizens]
      .filter(Boolean).length;
    
    // Common element: has multiple types
    const isCommon = typeCount > 1;
    
    // Type priority (lower number = higher priority)
    let typePriority = 4; // Default: citizens only
    if (hasPublicAuth) {
      typePriority = 1; // Highest priority
    } else if (hasLocalCommittee) {
      typePriority = 2;
    } else if (hasOrganization) {
      typePriority = 3;
    }
    
    // Size (total response count)
    const size = position.responseNumbers?.length || 0;
    
    return {
      isCommon,
      typePriority,
      size,
      typeCount
    };
  }
}

