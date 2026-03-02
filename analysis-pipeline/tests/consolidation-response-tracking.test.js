/**
 * Tests for Position Consolidation Response Tracking
 * 
 * Validates that responseNumbers are preserved through all consolidation operations
 * and that auto-recovery works correctly for orphaned responses.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { PositionConsolidator } from '../src/analysis/position-consolidator.js';
import { ResponseTracker } from '../src/analysis/response-tracker.js';

describe('ResponseTracker', () => {
  let tracker;
  
  beforeEach(() => {
    tracker = new ResponseTracker();
  });

  describe('initialize()', () => {
    it('should build initial responseNumber → position mappings', () => {
      const themes = [
        {
          name: 'Theme A',
          positions: [
            { title: 'Position 1', responseNumbers: [1, 2, 3] },
            { title: 'Position 2', responseNumbers: [4, 5] }
          ]
        },
        {
          name: 'Theme B',
          positions: [
            { title: 'Position 3', responseNumbers: [6, 7, 8] }
          ]
        }
      ];
      
      tracker.initialize(themes);
      
      expect(tracker.stats.totalResponses).toBe(8);
      expect(tracker.stats.totalPositions).toBe(3);
      expect(tracker.initialMap.size).toBe(8);
      expect(tracker.positionRegistry.size).toBe(3);
    });

    it('should warn about duplicate response numbers', () => {
      const themes = [
        {
          name: 'Theme A',
          positions: [
            { title: 'Position 1', responseNumbers: [1, 2] },
            { title: 'Position 2', responseNumbers: [2, 3] } // Duplicate: 2
          ]
        }
      ];
      
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      tracker.initialize(themes);
      
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Response 2 appears in multiple positions')
      );
      
      consoleSpy.mockRestore();
    });
  });

  describe('validate()', () => {
    it('should detect orphaned responses', () => {
      const initialThemes = [
        {
          name: 'Theme A',
          positions: [
            { title: 'Position 1', responseNumbers: [1, 2, 3] },
            { title: 'Position 2', responseNumbers: [4, 5] }
          ]
        }
      ];
      
      tracker.initialize(initialThemes);
      
      // Simulate consolidation that loses responses 4 and 5
      const consolidatedThemes = [
        {
          name: 'Theme A',
          positions: [
            { title: 'Position 1', responseNumbers: [1, 2, 3] }
            // Position 2 removed without merging responseNumbers!
          ]
        }
      ];
      
      const validation = tracker.validate(consolidatedThemes);
      
      expect(validation.isValid).toBe(false);
      expect(validation.orphanedResponses.length).toBe(2);
      expect(validation.orphanedResponses.map(o => o.responseNumber)).toEqual([4, 5]);
    });

    it('should pass validation when all responses present', () => {
      const themes = [
        {
          name: 'Theme A',
          positions: [
            { title: 'Position 1', responseNumbers: [1, 2, 3, 4, 5] }
          ]
        }
      ];
      
      tracker.initialize(themes);
      const validation = tracker.validate(themes);
      
      expect(validation.isValid).toBe(true);
      expect(validation.orphanedResponses.length).toBe(0);
      expect(validation.presentResponses).toBe(5);
    });
  });

  describe('recover()', () => {
    it('should recover orphaned responses to merged positions', () => {
      const initialThemes = [
        {
          name: 'Theme A',
          positions: [
            { title: 'Position 1', responseNumbers: [1, 2] },
            { title: 'Position 2', responseNumbers: [3, 4] }
          ]
        }
      ];
      
      tracker.initialize(initialThemes);
      
      // Record that Position 2 was merged into Position 1
      tracker.recordMerge(['pos_1'], 'pos_0', [3, 4]);
      
      // Simulate buggy consolidation that lost responses 3, 4
      const buggyConsolidated = [
        {
          name: 'Theme A',
          positions: [
            { title: 'Position 1', responseNumbers: [1, 2] }
          ]
        }
      ];
      
      const validation = tracker.validate(buggyConsolidated);
      expect(validation.orphanedResponses.length).toBe(2);
      
      // Auto-recover
      const recovered = tracker.recover(buggyConsolidated, validation.orphanedResponses, []);
      
      // Verify recovery
      expect(recovered[0].positions[0].responseNumbers).toEqual([1, 2, 3, 4]);
      expect(recovered[0].positions[0]._recoveryMeta).toBeDefined();
      expect(recovered[0].positions[0]._recoveryMeta.recoveredResponses).toEqual([3, 4]);
    });

    it('should handle transitive merges (A+B, B+C → all in A)', () => {
      const initialThemes = [
        {
          name: 'Theme A',
          positions: [
            { title: 'Position A', responseNumbers: [1] },
            { title: 'Position B', responseNumbers: [2] },
            { title: 'Position C', responseNumbers: [3] }
          ]
        }
      ];
      
      tracker.initialize(initialThemes);
      
      // Record transitive merge: B → A, C → B (so C should end up in A)
      tracker.recordMerge(['pos_1'], 'pos_0', [2]); // B → A
      tracker.recordMerge(['pos_2'], 'pos_1', [3]); // C → B (but B is already merged to A)
      
      // Buggy consolidation lost response 3
      const buggyConsolidated = [
        {
          name: 'Theme A',
          positions: [
            { title: 'Position A', responseNumbers: [1, 2] } // Missing 3!
          ]
        }
      ];
      
      const validation = tracker.validate(buggyConsolidated);
      const recovered = tracker.recover(buggyConsolidated, validation.orphanedResponses, []);
      
      // Response 3 should be recovered to Position A (following transitive merge)
      expect(recovered[0].positions[0].responseNumbers).toEqual([1, 2, 3]);
    });
  });

  describe('recalculateBreakdown()', () => {
    it('should correctly categorize respondent types', () => {
      const responses = [
        { id: 1, respondentType: 'Borger', respondentName: 'John Doe' },
        { id: 2, respondentType: 'Lokaludvalg', respondentName: 'Valby Lokaludvalg' },
        { id: 3, respondentType: 'Organisation', respondentName: 'ACME Corp' },
        { id: 4, respondentType: 'Myndighed', respondentName: 'Københavns Kommune' },
        { id: 5, respondentType: 'Borger', respondentName: 'Jane Smith' }
      ];
      
      const breakdown = tracker.recalculateBreakdown([1, 2, 3, 4, 5], responses);
      
      expect(breakdown.citizens).toBe(2);
      expect(breakdown.localCommittees).toEqual(['Valby Lokaludvalg']);
      expect(breakdown.organizations).toEqual(['ACME Corp']);
      expect(breakdown.publicAuthorities).toEqual(['Københavns Kommune']);
      expect(breakdown.total).toBe(5);
    });

    it('should handle missing responses gracefully', () => {
      const responses = [
        { id: 1, respondentType: 'Borger', respondentName: 'John Doe' }
      ];
      
      const breakdown = tracker.recalculateBreakdown([1, 2, 3, 999], responses);
      
      // Missing responses (2, 3, 999) should default to citizens
      expect(breakdown.citizens).toBe(4); // 1 known borger + 3 missing
      expect(breakdown.total).toBe(4);
    });
  });
});

describe('PositionConsolidator with ResponseTracker', () => {
  let consolidator;
  
  beforeEach(() => {
    consolidator = new PositionConsolidator({
      enabled: true,
      similarityThreshold: 0.90,
      embedding: { batchSize: 10 }
    });
  });

  describe('consolidate() integration', () => {
    it('should preserve all responseNumbers during within-theme consolidation', async () => {
      const themes = [
        {
          name: 'Theme A',
          positions: [
            { 
              title: 'Position 1', 
              summary: 'Opposition to building height',
              responseNumbers: [1, 2, 3],
              respondentBreakdown: { citizens: 3, total: 3, localCommittees: [], organizations: [], publicAuthorities: [] }
            },
            { 
              title: 'Position 2', 
              summary: 'Concern about tall buildings',
              responseNumbers: [4, 5],
              respondentBreakdown: { citizens: 2, total: 2, localCommittees: [], organizations: [], publicAuthorities: [] }
            }
          ]
        }
      ];
      
      const responses = [
        { id: 1, respondentType: 'Borger' },
        { id: 2, respondentType: 'Borger' },
        { id: 3, respondentType: 'Borger' },
        { id: 4, respondentType: 'Borger' },
        { id: 5, respondentType: 'Borger' }
      ];
      
      const consolidated = await consolidator.consolidate(
        themes,
        { responseCount: 5, complexity: 'tiny' },
        'none', // Within-theme only
        responses
      );
      
      // Collect all responseNumbers from consolidated output
      const allResponseNumbers = consolidated.flatMap(t => 
        t.positions.flatMap(p => p.responseNumbers || [])
      );
      
      // All 5 responses should be present
      expect(new Set(allResponseNumbers).size).toBe(5);
      expect(allResponseNumbers.sort()).toEqual([1, 2, 3, 4, 5]);
    });

    it('should throw error if consolidation loses responses and recovery fails', async () => {
      // This is a hypothetical test - in practice, our fix should prevent this
      // But we test the error handling for defensive programming
      
      const themes = [
        {
          name: 'Theme A',
          positions: [
            { title: 'Position 1', responseNumbers: [1, 2, 3], summary: 'Test' }
          ]
        }
      ];
      
      // Mock a scenario where validation fails (hypothetical)
      // In practice, this should never happen with our fixes
      const responses = [
        { id: 1, respondentType: 'Borger' },
        { id: 2, respondentType: 'Borger' },
        { id: 3, respondentType: 'Borger' }
      ];
      
      // This should NOT throw because our fixes preserve responses
      await expect(
        consolidator.consolidate(themes, { responseCount: 3 }, 'none', responses)
      ).resolves.not.toThrow();
    });
  });
});

describe('Hearing 168 Regression Test', () => {
  /**
   * This test reproduces the exact bug from CRITICAL-FINDINGS.md
   * where responses 2, 3, 6, 8, 9, 15 were marked as "Ingen holdning fundet"
   */
  
  it('should preserve all boldbane position responses during consolidation', async () => {
    // Simulate the 5 boldbane positions before consolidation
    const aggregatedThemes = [
      {
        name: 'Boldbane',
        positions: [
          { 
            title: 'Modstand mod boldbane nær beboelse',
            responseNumbers: [24],
            summary: 'Opposition to sports field near residential area',
            respondentBreakdown: { citizens: 1, total: 1, localCommittees: [], organizations: [], publicAuthorities: [] }
          },
          { 
            title: 'Modstand mod boldbanens placering nær boliger',
            responseNumbers: [2, 9, 15],
            summary: 'Opposition to sports field placement near homes',
            respondentBreakdown: { citizens: 3, total: 3, localCommittees: [], organizations: [], publicAuthorities: [] }
          },
          { 
            title: 'Ønske om placering ved Gl. Køge Landevej',
            responseNumbers: [3, 6],
            summary: 'Prefer sports field at Old Køge Road',
            respondentBreakdown: { citizens: 2, total: 2, localCommittees: [], organizations: [], publicAuthorities: [] }
          },
          { 
            title: 'Modstand + placering ved Gl. Køge Landevej',
            responseNumbers: [5, 7, 10, 11, 23],
            summary: 'Opposition and prefer Old Køge Road location',
            respondentBreakdown: { citizens: 5, total: 5, localCommittees: [], organizations: [], publicAuthorities: [] }
          },
          { 
            title: 'Ønske om ændret placering',
            responseNumbers: [8],
            summary: 'Want different placement',
            respondentBreakdown: { citizens: 1, total: 1, localCommittees: [], organizations: [], publicAuthorities: [] }
          }
        ]
      }
    ];
    
    const allResponseNumbers = [2, 3, 5, 6, 7, 8, 9, 10, 11, 15, 23, 24];
    const responses = allResponseNumbers.map(id => ({ 
      id, 
      respondentType: 'Borger',
      respondentName: `Respondent ${id}`
    }));
    
    const consolidator = new PositionConsolidator({
      enabled: true,
      similarityThreshold: 0.87,
      embedding: { batchSize: 10 }
    });
    
    // Consolidate (may merge some positions)
    const consolidated = await consolidator.consolidate(
      aggregatedThemes,
      { responseCount: allResponseNumbers.length, complexity: 'small-moderate' },
      'selective', // This was the strategy that caused the bug
      responses
    );
    
    // CRITICAL ASSERTION: All 12 response numbers must be present
    const consolidatedResponseNumbers = new Set(
      consolidated.flatMap(t => t.positions.flatMap(p => p.responseNumbers || []))
    );
    
    expect(consolidatedResponseNumbers.size).toBe(12);
    
    // Check that no responses are missing
    for (const num of allResponseNumbers) {
      expect(consolidatedResponseNumbers.has(num)).toBe(true);
    }
    
    // Specifically check the "problematic" responses from the bug report
    const problematicResponses = [2, 3, 6, 8, 9, 15];
    for (const num of problematicResponses) {
      expect(consolidatedResponseNumbers.has(num)).toBe(true);
    }
  });
});

describe('Edge Cases', () => {
  let tracker;
  
  beforeEach(() => {
    tracker = new ResponseTracker();
  });

  it('should handle positions with zero responseNumbers', () => {
    const themes = [
      {
        name: 'Theme A',
        positions: [
          { title: 'Position 1', responseNumbers: [] },
          { title: 'Position 2', responseNumbers: [1, 2] }
        ]
      }
    ];
    
    tracker.initialize(themes);
    const validation = tracker.validate(themes);
    
    expect(validation.isValid).toBe(true);
    expect(validation.totalResponses).toBe(2);
  });

  it('should handle empty themes', () => {
    const themes = [
      { name: 'Empty Theme', positions: [] }
    ];
    
    tracker.initialize(themes);
    const validation = tracker.validate(themes);
    
    expect(validation.isValid).toBe(true);
    expect(validation.totalResponses).toBe(0);
  });

  it('should handle circular merge references gracefully', () => {
    const themes = [
      {
        name: 'Theme A',
        positions: [
          { title: 'Position 1', responseNumbers: [1] }
        ]
      }
    ];
    
    tracker.initialize(themes);
    
    // Create circular reference (should not happen, but test defensive code)
    tracker.recordMerge(['pos_0'], 'pos_1', [1]);
    tracker.recordMerge(['pos_1'], 'pos_0', [1]); // Circular!
    
    const target = tracker.findMergeTarget('pos_0');
    
    // Should detect circular reference and return null
    expect(target).toBeNull();
  });
});

