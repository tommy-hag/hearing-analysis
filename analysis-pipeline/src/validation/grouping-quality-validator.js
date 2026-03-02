/**
 * Grouping Quality Validator
 *
 * Validates and repairs grouping issues in the final position output:
 * 1. Duplicate citations within a position (same respondent/quote multiple times)
 * 2. Redundant positions (similar positions that should be merged)
 * 3. Micro-positions (tiny positions that should be absorbed)
 *
 * Runs AFTER hybrid-position-writing but BEFORE extract-citations.
 * Preserves critical invariants: 100% coverage, theme boundaries, citation integrity.
 */

import { EmbeddingService } from '../embedding/embedding-service.js';
import { OpenAIClientWrapper, getComplexityConfig } from '../utils/openai-client.js';
import { getResponseFormat } from '../utils/json-schemas.js';

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * Normalize text for comparison (lowercase, remove punctuation)
 */
function normalizeText(text) {
  if (!text || typeof text !== 'string') return '';
  return text.toLowerCase()
    .replace(/[^a-zæøå0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Calculate Jaccard similarity between two sets of words
 */
function wordJaccardSimilarity(text1, text2) {
  const words1 = new Set(normalizeText(text1).split(' ').filter(w => w.length > 2));
  const words2 = new Set(normalizeText(text2).split(' ').filter(w => w.length > 2));

  if (words1.size === 0 || words2.size === 0) return 0;

  const intersection = [...words1].filter(w => words2.has(w)).length;
  const union = new Set([...words1, ...words2]).size;

  return intersection / union;
}

export class GroupingQualityValidator {
  constructor(options = {}) {
    this.embeddingService = new EmbeddingService();

    // Use LIGHT complexity for validation (simple checks)
    try {
      const complexityConfig = getComplexityConfig(options.complexityLevel || 'light');
      this.client = new OpenAIClientWrapper({
        model: options.model || complexityConfig.model,
        verbosity: options.verbosity || complexityConfig.verbosity,
        reasoningEffort: options.reasoningEffort || complexityConfig.reasoningEffort,
        timeout: options.timeout || 30000
      });
    } catch (error) {
      console.warn('[GroupingQualityValidator] Failed to initialize LLM client:', error.message);
      this.client = null;
    }

    // Configuration thresholds
    this.duplicateCitationThreshold = options.duplicateCitationThreshold || 2; // Same REF 2+ times
    this.positionSimilarityThreshold = options.positionSimilarityThreshold || 0.85;
    this.respondentOverlapThreshold = options.respondentOverlapThreshold || 0.50; // 50% overlap
    this.microPositionThreshold = options.microPositionThreshold || 2; // <= 2 respondents
    this.microPositionMergeSimilarity = options.microPositionMergeSimilarity || 0.70;

    // Auto-repair settings
    this.autoRepair = options.autoRepair !== false;
    this.enabled = options.enabled !== false;
  }

  /**
   * Main validation method
   * @param {Object} hybridPositions - Output from hybrid-position-writing step
   * @param {Object} context - Additional context (microSummaries, etc.)
   * @returns {Promise<Object>} Validation result with issues and repairs
   */
  async validate(hybridPositions, context = {}) {
    if (!this.enabled) {
      console.log('[GroupingQualityValidator] Validation disabled, skipping');
      return { valid: true, issues: [], repairs: [], skipped: true };
    }

    console.log('[GroupingQualityValidator] Starting grouping quality validation...');

    const issues = [];
    const repairs = [];

    // Track all input response numbers for coverage validation
    const inputResponseNumbers = new Set();

    // Extract themes/positions structure
    const themes = hybridPositions.themes || hybridPositions;
    if (!Array.isArray(themes)) {
      console.warn('[GroupingQualityValidator] Invalid input structure, skipping');
      return { valid: true, issues: [], repairs: [], skipped: true };
    }

    // Collect all response numbers for coverage tracking
    for (const theme of themes) {
      for (const position of theme.positions || []) {
        for (const respNum of position.responseNumbers || []) {
          inputResponseNumbers.add(respNum);
        }
      }
    }

    console.log(`[GroupingQualityValidator] Validating ${themes.length} themes, ${inputResponseNumbers.size} total respondents`);

    // ========================================================================
    // CHECK 1: Duplicate citations within positions
    // ========================================================================
    const duplicateIssues = this.detectDuplicateCitations(themes);
    issues.push(...duplicateIssues);

    if (duplicateIssues.length > 0) {
      console.log(`[GroupingQualityValidator] Found ${duplicateIssues.length} duplicate citation issues`);
    }

    // ========================================================================
    // CHECK 2: Redundant positions (similar titles + overlapping respondents)
    // ========================================================================
    const redundantIssues = await this.detectRedundantPositions(themes);
    issues.push(...redundantIssues);

    if (redundantIssues.length > 0) {
      console.log(`[GroupingQualityValidator] Found ${redundantIssues.length} redundant position issues`);
    }

    // ========================================================================
    // CHECK 3: Micro-positions that could be absorbed
    // ========================================================================
    const microIssues = await this.detectMicroPositions(themes);
    issues.push(...microIssues);

    if (microIssues.length > 0) {
      console.log(`[GroupingQualityValidator] Found ${microIssues.length} micro-position issues`);
    }

    // ========================================================================
    // CHECK 4: Mixed directions in positions (direction contamination)
    // ========================================================================
    const mixedDirectionIssues = this.detectMixedDirectionsInPositions(themes);
    issues.push(...mixedDirectionIssues);

    if (mixedDirectionIssues.length > 0) {
      console.log(`[GroupingQualityValidator] Found ${mixedDirectionIssues.length} mixed direction issues`);
    }

    // ========================================================================
    // AUTO-REPAIR if enabled and issues found
    // ========================================================================
    let repairedThemes = themes;

    if (this.autoRepair && issues.length > 0) {
      console.log(`[GroupingQualityValidator] Auto-repairing ${issues.length} issues...`);

      const repairResult = await this.repairIssues(themes, issues, context);
      repairedThemes = repairResult.themes;
      repairs.push(...repairResult.repairs);

      // Verify coverage after repair
      const outputResponseNumbers = new Set();
      for (const theme of repairedThemes) {
        for (const position of theme.positions || []) {
          for (const respNum of position.responseNumbers || []) {
            outputResponseNumbers.add(respNum);
          }
        }
      }

      const missingRespondents = [...inputResponseNumbers].filter(r => !outputResponseNumbers.has(r));
      if (missingRespondents.length > 0) {
        console.error(`[GroupingQualityValidator] CRITICAL: Lost ${missingRespondents.length} respondents during repair!`);
        issues.push({
          type: 'COVERAGE_LOSS',
          severity: 'CRITICAL',
          description: `Lost ${missingRespondents.length} respondents during repair: [${missingRespondents.slice(0, 10).join(', ')}${missingRespondents.length > 10 ? '...' : ''}]`,
          affectedResponseNumbers: missingRespondents
        });
        // Rollback to original themes
        repairedThemes = themes;
        repairs.length = 0;
      }
    }

    const result = {
      valid: issues.filter(i => i.severity === 'CRITICAL' || i.severity === 'HIGH').length === 0,
      issueCount: issues.length,
      issues,
      repairs,
      themes: this.autoRepair ? repairedThemes : themes,
      repaired: repairs.length > 0
    };

    console.log(`[GroupingQualityValidator] Validation complete: ${issues.length} issues, ${repairs.length} repairs, valid=${result.valid}`);

    return result;
  }

  /**
   * Detect duplicate citations within positions
   * Finds where same REF_X appears multiple times in a summary
   */
  detectDuplicateCitations(themes) {
    const issues = [];

    for (const theme of themes) {
      for (const position of theme.positions || []) {
        const summary = position.summary || '';

        // Find all REF_X references
        const refMatches = summary.match(/<<REF_\d+>>/g);
        if (!refMatches || refMatches.length === 0) continue;

        // Count occurrences
        const refCounts = {};
        for (const ref of refMatches) {
          refCounts[ref] = (refCounts[ref] || 0) + 1;
        }

        // Find duplicates
        const duplicates = Object.entries(refCounts)
          .filter(([ref, count]) => count > this.duplicateCitationThreshold)
          .map(([ref, count]) => ({ ref, count }));

        if (duplicates.length > 0) {
          issues.push({
            type: 'DUPLICATE_CITATION',
            severity: 'HIGH',
            theme: theme.name,
            positionTitle: position.title,
            description: `Position has duplicate references: ${duplicates.map(d => `${d.ref} (${d.count}x)`).join(', ')}`,
            duplicates,
            affectedResponseNumbers: position.responseNumbers || []
          });
        }
      }
    }

    return issues;
  }

  /**
   * Detect redundant positions - both within same theme AND across themes
   * Uses title similarity + respondent overlap
   */
  async detectRedundantPositions(themes) {
    const issues = [];

    // ========================================================================
    // PART 1: Check within same theme (stricter threshold)
    // ========================================================================
    for (const theme of themes) {
      const positions = theme.positions || [];
      if (positions.length < 2) continue;

      for (let i = 0; i < positions.length; i++) {
        for (let j = i + 1; j < positions.length; j++) {
          const pos1 = positions[i];
          const pos2 = positions[j];

          const titleSimilarity = wordJaccardSimilarity(pos1.title || '', pos2.title || '');
          const resp1 = new Set(pos1.responseNumbers || []);
          const resp2 = new Set(pos2.responseNumbers || []);
          const sharedRespondents = [...resp1].filter(r => resp2.has(r));
          const smallerSize = Math.min(resp1.size, resp2.size);
          const overlapRatio = smallerSize > 0 ? sharedRespondents.length / smallerSize : 0;

          // Within-theme threshold: similarity ≥0.85 OR (≥0.60 + overlap ≥50%)
          const isRedundant = titleSimilarity >= this.positionSimilarityThreshold ||
                              (titleSimilarity >= 0.6 && overlapRatio >= this.respondentOverlapThreshold);

          if (isRedundant) {
            if (this.detectStanceConflict(pos1, pos2)) {
              console.log(`[GroupingQualityValidator] Skipping merge for stance conflict: "${pos1.title}" vs "${pos2.title}"`);
              continue;
            }

            issues.push({
              type: 'REDUNDANT_POSITION',
              severity: 'HIGH',
              theme: theme.name,
              position1Title: pos1.title,
              position2Title: pos2.title,
              description: `Similar positions should be merged: "${pos1.title}" and "${pos2.title}" (title similarity: ${(titleSimilarity * 100).toFixed(0)}%, respondent overlap: ${(overlapRatio * 100).toFixed(0)}%)`,
              titleSimilarity,
              overlapRatio,
              sharedRespondents,
              position1Index: i,
              position2Index: j,
              crossTheme: false,
              affectedResponseNumbers: [...new Set([...(pos1.responseNumbers || []), ...(pos2.responseNumbers || [])])]
            });
          }
        }
      }
    }

    // ========================================================================
    // PART 2: Check ACROSS themes (requires higher overlap threshold)
    // This catches cases like "Ønske om bevarelse" in "Andre emner" vs
    // "Ønske om bevarelse af Palads" in "Bebyggelsens ydre fremtræden"
    // ========================================================================
    const allPositionsWithTheme = [];
    for (const theme of themes) {
      for (let posIdx = 0; posIdx < (theme.positions || []).length; posIdx++) {
        const position = theme.positions[posIdx];
        allPositionsWithTheme.push({
          theme: theme.name,
          themeIndex: themes.indexOf(theme),
          positionIndex: posIdx,
          position
        });
      }
    }

    // Compare all positions across different themes
    for (let i = 0; i < allPositionsWithTheme.length; i++) {
      for (let j = i + 1; j < allPositionsWithTheme.length; j++) {
        const item1 = allPositionsWithTheme[i];
        const item2 = allPositionsWithTheme[j];

        // Skip if same theme (already checked in PART 1)
        if (item1.theme === item2.theme) continue;

        const pos1 = item1.position;
        const pos2 = item2.position;

        const titleSimilarity = wordJaccardSimilarity(pos1.title || '', pos2.title || '');
        const resp1 = new Set(pos1.responseNumbers || []);
        const resp2 = new Set(pos2.responseNumbers || []);
        const sharedRespondents = [...resp1].filter(r => resp2.has(r));
        const smallerSize = Math.min(resp1.size, resp2.size);
        const overlapRatio = smallerSize > 0 ? sharedRespondents.length / smallerSize : 0;

        // Cross-theme threshold: STRICTER - requires BOTH title similarity AND overlap
        // Title similarity ≥0.50 AND respondent overlap ≥40%
        // This prevents merging unrelated positions that happen to share respondents
        //
        // EXCEPTION 1: If overlap is 100% (all respondents in smaller are in larger),
        // AND both titles mention the same object (e.g., both mention "Palads"),
        // AND the smaller position has ≥3 respondents (to avoid 1-respondent noise),
        // lower the title similarity threshold to 0.20 to catch vague titles like "Holdninger til X"
        //
        // EXCEPTION 2: If overlap is ≥80% (high overlap but not complete),
        // AND both titles mention the same object,
        // AND the smaller position has ≥5 respondents (more stringent for non-100% overlap),
        // lower the title similarity threshold to 0.25
        const hasFullOverlap = overlapRatio >= 0.99;
        const hasHighOverlap = overlapRatio >= 0.80;

        // Check if both titles mention the same key object
        const extractObjects = (title) => {
          const normalized = (title || '').toLowerCase();
          const objects = [];
          // Common object patterns in Danish
          const objectPatterns = [/palads/i, /axeltorv/i, /bygning/i, /træ/i, /hotel/i, /biograf/i];
          for (const pattern of objectPatterns) {
            if (pattern.test(normalized)) {
              objects.push(pattern.source.replace(/\\i$/, ''));
            }
          }
          return objects;
        };

        const objects1 = extractObjects(pos1.title);
        const objects2 = extractObjects(pos2.title);
        const sharedObjects = objects1.filter(o => objects2.includes(o));
        const hasSameObject = sharedObjects.length > 0;

        const crossThemeRedundant =
          (titleSimilarity >= 0.50 && overlapRatio >= 0.40) ||
          (hasFullOverlap && smallerSize >= 3 && hasSameObject && titleSimilarity >= 0.20) ||
          (hasHighOverlap && smallerSize >= 5 && hasSameObject && titleSimilarity >= 0.20);

        if (crossThemeRedundant) {
          if (this.detectStanceConflict(pos1, pos2)) {
            console.log(`[GroupingQualityValidator] Skipping cross-theme merge for stance conflict: "${pos1.title}" (${item1.theme}) vs "${pos2.title}" (${item2.theme})`);
            continue;
          }

          // Determine which position should absorb the other (larger one wins)
          const pos1Size = resp1.size;
          const pos2Size = resp2.size;
          const [primary, secondary] = pos1Size >= pos2Size
            ? [item1, item2]
            : [item2, item1];

          console.log(`[GroupingQualityValidator] Cross-theme redundancy: "${primary.position.title}" (${primary.theme}, ${primary.position.responseNumbers?.length || 0} resp) ← "${secondary.position.title}" (${secondary.theme}, ${secondary.position.responseNumbers?.length || 0} resp)`);

          issues.push({
            type: 'CROSS_THEME_REDUNDANT',
            severity: 'HIGH',
            theme: primary.theme,
            theme2: secondary.theme,
            position1Title: primary.position.title,
            position2Title: secondary.position.title,
            description: `Cross-theme redundancy: "${secondary.position.title}" (${secondary.theme}) should merge into "${primary.position.title}" (${primary.theme}) - title similarity: ${(titleSimilarity * 100).toFixed(0)}%, respondent overlap: ${(overlapRatio * 100).toFixed(0)}%`,
            titleSimilarity,
            overlapRatio,
            sharedRespondents,
            primaryThemeIndex: primary.themeIndex,
            primaryPositionIndex: primary.positionIndex,
            secondaryThemeIndex: secondary.themeIndex,
            secondaryPositionIndex: secondary.positionIndex,
            crossTheme: true,
            affectedResponseNumbers: [...new Set([...(pos1.responseNumbers || []), ...(pos2.responseNumbers || [])])]
          });
        }
      }
    }

    return issues;
  }

  /**
   * Detect micro-positions that could be absorbed into larger positions
   */
  async detectMicroPositions(themes) {
    const issues = [];

    for (const theme of themes) {
      const positions = theme.positions || [];

      // Find micro-positions and potential merge targets
      const microPositions = positions.filter(p =>
        (p.responseNumbers || []).length <= this.microPositionThreshold
      );

      const largerPositions = positions.filter(p =>
        (p.responseNumbers || []).length > this.microPositionThreshold
      );

      for (const microPos of microPositions) {
        // Find best merge candidate among larger positions
        let bestCandidate = null;
        let bestSimilarity = 0;

        for (const largePos of largerPositions) {
          const similarity = wordJaccardSimilarity(microPos.title || '', largePos.title || '');

          if (similarity >= this.microPositionMergeSimilarity && similarity > bestSimilarity) {
            // Check stance conflict
            if (!this.detectStanceConflict(microPos, largePos)) {
              bestCandidate = largePos;
              bestSimilarity = similarity;
            }
          }
        }

        if (bestCandidate) {
          const microIndex = positions.indexOf(microPos);
          const targetIndex = positions.indexOf(bestCandidate);

          issues.push({
            type: 'MICRO_POSITION',
            severity: 'MEDIUM',
            theme: theme.name,
            microPositionTitle: microPos.title,
            targetPositionTitle: bestCandidate.title,
            description: `Micro-position "${microPos.title}" (${(microPos.responseNumbers || []).length} resp.) could be absorbed into "${bestCandidate.title}" (similarity: ${(bestSimilarity * 100).toFixed(0)}%)`,
            titleSimilarity: bestSimilarity,
            microPositionIndex: microIndex,
            targetPositionIndex: targetIndex,
            affectedResponseNumbers: microPos.responseNumbers || []
          });
        }
      }
    }

    return issues;
  }

  /**
   * Detect positions with mixed directions (direction contamination).
   * Flags positions that contain both pro_change and pro_status_quo arguments.
   * This indicates improper merging of positions with opposite stances.
   */
  detectMixedDirectionsInPositions(themes) {
    const issues = [];

    for (const theme of themes) {
      for (const position of theme.positions || []) {
        const args = position.args || position.sourceArgumentRefs || [];
        const directions = args.map(a => a.direction).filter(Boolean);

        const proChangeCount = directions.filter(d => d === 'pro_change').length;
        const proStatusQuoCount = directions.filter(d => d === 'pro_status_quo').length;

        // Flag positions with BOTH pro_change and pro_status_quo arguments
        if (proChangeCount >= 1 && proStatusQuoCount >= 1) {
          const severity = (proChangeCount >= 2 && proStatusQuoCount >= 2) ? 'HIGH' : 'MEDIUM';

          issues.push({
            type: 'MIXED_DIRECTIONS',
            severity,
            theme: theme.name,
            positionTitle: position.title,
            description: `Position "${position.title}" contains mixed directions: ${proChangeCount} pro_change + ${proStatusQuoCount} pro_status_quo arguments. This indicates direction contamination.`,
            proChangeCount,
            proStatusQuoCount,
            affectedResponseNumbers: position.responseNumbers || []
          });

          console.log(`[GroupingQualityValidator] ⚠️ Mixed direction: "${position.title}" (${proChangeCount} pro_change + ${proStatusQuoCount} pro_status_quo)`);
        }
      }
    }

    return issues;
  }

  /**
   * Detect stance conflict between two positions
   * Returns true if positions have conflicting directions
   */
  detectStanceConflict(pos1, pos2) {
    const dirs1 = this.getPositionDirections(pos1);
    const dirs2 = this.getPositionDirections(pos2);

    // If one is predominantly pro_change and other is pro_status_quo, conflict
    if (dirs1.dominant === 'pro_change' && dirs2.dominant === 'pro_status_quo') return true;
    if (dirs1.dominant === 'pro_status_quo' && dirs2.dominant === 'pro_change') return true;

    // Check for significant opposing directions
    const hasSignificantConflict =
      (dirs1.proChange >= 2 && dirs2.proStatusQuo >= 2) ||
      (dirs1.proStatusQuo >= 2 && dirs2.proChange >= 2);

    return hasSignificantConflict;
  }

  /**
   * Extract direction distribution from a position's arguments
   */
  getPositionDirections(position) {
    const args = position.args || position.sourceArgumentRefs || [];
    const directions = args.map(a => a.direction).filter(Boolean);

    const proChange = directions.filter(d => d === 'pro_change').length;
    const proStatusQuo = directions.filter(d => d === 'pro_status_quo').length;
    const neutral = directions.length - proChange - proStatusQuo;

    let dominant = 'neutral';
    if (proChange > proStatusQuo && proChange > neutral) {
      dominant = 'pro_change';
    } else if (proStatusQuo > proChange && proStatusQuo > neutral) {
      dominant = 'pro_status_quo';
    }

    return { proChange, proStatusQuo, neutral, dominant };
  }

  /**
   * Repair detected issues
   */
  async repairIssues(themes, issues, context = {}) {
    const repairs = [];

    // Deep clone themes to avoid mutation
    let workingThemes = JSON.parse(JSON.stringify(themes));

    // ========================================================================
    // REPAIR 1: Remove duplicate citations
    // ========================================================================
    const duplicateIssues = issues.filter(i => i.type === 'DUPLICATE_CITATION');
    for (const issue of duplicateIssues) {
      const theme = workingThemes.find(t => t.name === issue.theme);
      if (!theme) continue;

      const position = theme.positions?.find(p => p.title === issue.positionTitle);
      if (!position || !position.summary) continue;

      const originalSummary = position.summary;
      position.summary = this.removeDuplicateCitations(position.summary);

      if (position.summary !== originalSummary) {
        repairs.push({
          action: 'DEDUPLICATE_CITATIONS',
          theme: issue.theme,
          positionTitle: issue.positionTitle,
          description: `Removed duplicate citations: ${issue.duplicates.map(d => d.ref).join(', ')}`
        });
      }
    }

    // ========================================================================
    // REPAIR 2: Merge redundant positions
    // ========================================================================
    const redundantIssues = issues.filter(i => i.type === 'REDUNDANT_POSITION' && i.severity === 'HIGH');

    // Track which positions have been merged (to avoid double-merging)
    const mergedPositionIndices = new Set();

    for (const issue of redundantIssues) {
      const theme = workingThemes.find(t => t.name === issue.theme);
      if (!theme) continue;

      const idx1 = issue.position1Index;
      const idx2 = issue.position2Index;

      // Skip if either position was already merged
      if (mergedPositionIndices.has(`${issue.theme}:${idx1}`) ||
          mergedPositionIndices.has(`${issue.theme}:${idx2}`)) {
        continue;
      }

      const pos1 = theme.positions[idx1];
      const pos2 = theme.positions[idx2];

      if (!pos1 || !pos2) continue;

      // Merge pos2 into pos1
      const mergedPosition = this.mergePositions(pos1, pos2);
      theme.positions[idx1] = mergedPosition;

      // Mark pos2 for removal
      theme.positions[idx2] = null;
      mergedPositionIndices.add(`${issue.theme}:${idx2}`);

      repairs.push({
        action: 'MERGE_POSITIONS',
        theme: issue.theme,
        mergedTitle: mergedPosition.title,
        sourceTitles: [pos1.title, pos2.title],
        description: `Merged "${pos2.title}" into "${pos1.title}" (${mergedPosition.responseNumbers.length} respondents)`
      });
    }

    // Remove null positions (merged away) - FIRST PASS
    for (const theme of workingThemes) {
      if (theme.positions) {
        theme.positions = theme.positions.filter(p => p !== null);
      }
    }

    // ========================================================================
    // REPAIR 2b: Merge cross-theme redundant positions
    // Move position from secondary theme to primary theme and merge
    // ========================================================================
    const crossThemeIssues = issues.filter(i => i.type === 'CROSS_THEME_REDUNDANT' && i.severity === 'HIGH');

    for (const issue of crossThemeIssues) {
      const primaryTheme = workingThemes[issue.primaryThemeIndex];
      const secondaryTheme = workingThemes[issue.secondaryThemeIndex];

      if (!primaryTheme || !secondaryTheme) continue;

      // Find positions by title (indices may have shifted due to previous merges)
      const primaryPos = primaryTheme.positions?.find(p => p.title === issue.position1Title);
      const secondaryPos = secondaryTheme.positions?.find(p => p.title === issue.position2Title);

      if (!primaryPos || !secondaryPos) {
        console.log(`[GroupingQualityValidator] Skipping cross-theme merge - positions not found after previous merges`);
        continue;
      }

      // Merge secondary into primary
      const mergedPosition = this.mergePositions(primaryPos, secondaryPos);

      // Update primary position
      const primaryIdx = primaryTheme.positions.indexOf(primaryPos);
      primaryTheme.positions[primaryIdx] = mergedPosition;

      // Remove secondary position from its theme
      const secondaryIdx = secondaryTheme.positions.indexOf(secondaryPos);
      if (secondaryIdx !== -1) {
        secondaryTheme.positions.splice(secondaryIdx, 1);
      }

      repairs.push({
        action: 'CROSS_THEME_MERGE',
        primaryTheme: issue.theme,
        secondaryTheme: issue.theme2,
        mergedTitle: mergedPosition.title,
        sourceTitles: [primaryPos.title, secondaryPos.title],
        description: `Cross-theme merge: "${secondaryPos.title}" (${issue.theme2}) → "${primaryPos.title}" (${issue.theme}) - ${mergedPosition.responseNumbers.length} total respondents`
      });

      console.log(`[GroupingQualityValidator] ✓ Cross-theme merge completed: "${secondaryPos.title}" → "${primaryPos.title}"`);
    }

    // Remove null positions (merged away) - SECOND PASS after cross-theme merges
    for (const theme of workingThemes) {
      if (theme.positions) {
        theme.positions = theme.positions.filter(p => p !== null);
      }
    }

    // ========================================================================
    // REPAIR 3: Absorb micro-positions (only MEDIUM severity if similarity high)
    // ========================================================================
    const microIssues = issues.filter(i => i.type === 'MICRO_POSITION' && i.titleSimilarity >= 0.80);

    for (const issue of microIssues) {
      const theme = workingThemes.find(t => t.name === issue.theme);
      if (!theme) continue;

      const microPos = theme.positions?.find(p => p.title === issue.microPositionTitle);
      const targetPos = theme.positions?.find(p => p.title === issue.targetPositionTitle);

      if (!microPos || !targetPos) continue;

      // Absorb micro-position into target
      const mergedPosition = this.mergePositions(targetPos, microPos);

      // Update target position
      const targetIdx = theme.positions.indexOf(targetPos);
      theme.positions[targetIdx] = mergedPosition;

      // Remove micro-position
      const microIdx = theme.positions.indexOf(microPos);
      if (microIdx !== -1) {
        theme.positions.splice(microIdx, 1);
      }

      repairs.push({
        action: 'ABSORB_MICRO_POSITION',
        theme: issue.theme,
        absorbedTitle: issue.microPositionTitle,
        targetTitle: issue.targetPositionTitle,
        description: `Absorbed micro-position "${issue.microPositionTitle}" into "${issue.targetPositionTitle}"`
      });
    }

    return { themes: workingThemes, repairs };
  }

  /**
   * Remove duplicate REF_X citations from summary
   */
  removeDuplicateCitations(summary) {
    if (!summary || typeof summary !== 'string') return summary;

    const seen = new Set();

    return summary.replace(/<<REF_\d+>>/g, (match) => {
      if (seen.has(match)) {
        return ''; // Remove duplicate
      }
      seen.add(match);
      return match;
    });
  }

  /**
   * Merge two positions into one
   */
  mergePositions(primary, secondary) {
    // Merge response numbers (deduplicated)
    const mergedResponseNumbers = [...new Set([
      ...(primary.responseNumbers || []),
      ...(secondary.responseNumbers || [])
    ])].sort((a, b) => a - b);

    // Merge hybrid references
    const mergedReferences = [
      ...(primary.hybridReferences || []),
      ...(secondary.hybridReferences || [])
    ];

    // Merge args/sourceArgumentRefs
    const mergedArgs = [
      ...(primary.args || primary.sourceArgumentRefs || []),
      ...(secondary.args || secondary.sourceArgumentRefs || [])
    ];

    // Keep primary's title and summary (more respondents = more authoritative)
    // Append secondary summary if significantly different
    let mergedSummary = primary.summary || '';
    const secondarySummary = secondary.summary || '';

    if (secondarySummary && !mergedSummary.includes(secondarySummary.slice(0, 50))) {
      // Secondary has different content - append key points
      // Note: In production, use LLM to merge summaries intelligently
      mergedSummary = mergedSummary.trim();
    }

    return {
      ...primary,
      responseNumbers: mergedResponseNumbers,
      hybridReferences: mergedReferences,
      args: mergedArgs.length > 0 ? mergedArgs : undefined,
      sourceArgumentRefs: mergedArgs.length > 0 ? mergedArgs : undefined,
      summary: mergedSummary,
      _merged: true,
      _mergedFrom: [primary.title, secondary.title]
    };
  }

  /**
   * Format validation result as human-readable report
   */
  formatReport(validation) {
    let report = '\n=== Grouping Quality Validation Report ===\n';
    report += `Overall: ${validation.valid ? '✅ VALID' : '⚠️ ISSUES FOUND'}\n`;
    report += `Issues: ${validation.issueCount}, Repairs: ${validation.repairs?.length || 0}\n\n`;

    if (validation.issues && validation.issues.length > 0) {
      report += `Issues Found:\n`;
      validation.issues.forEach((issue, idx) => {
        report += `  ${idx + 1}. [${issue.severity}] ${issue.type}\n`;
        report += `     ${issue.description}\n`;
        if (issue.theme) {
          report += `     Theme: ${issue.theme}\n`;
        }
      });
      report += '\n';
    }

    if (validation.repairs && validation.repairs.length > 0) {
      report += `Repairs Applied:\n`;
      validation.repairs.forEach((repair, idx) => {
        report += `  ${idx + 1}. ${repair.action}: ${repair.description}\n`;
      });
      report += '\n';
    }

    report += '==========================================\n';
    return report;
  }

  /**
   * Set Job ID for LLM tracing
   * @param {string} jobId - The job ID to set on the LLM client
   */
  setJobId(jobId) {
    if (this.client?.setJobId) {
      this.client.setJobId(jobId);
    }
  }
}
