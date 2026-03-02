/**
 * PositionQualityValidator
 * 
 * LLM-based qualitative validation of consolidated positions.
 * Acts as a "quality gate" to catch over-merging or under-merging that
 * embeddings and metrics might miss.
 */

import { OpenAIClientWrapper, getComplexityConfig } from '../utils/openai-client.js';
import { getResponseFormat } from '../utils/json-schemas.js';

export class PositionQualityValidator {
  constructor(options = {}) {
    // Use LIGHT complexity for validation (simple binary checks) - PERFORMANCE OPTIMIZATION
    try {
      const complexityConfig = getComplexityConfig(options.complexityLevel || 'light');
      this.client = new OpenAIClientWrapper({
        model: options.model || complexityConfig.model,
        verbosity: options.verbosity || complexityConfig.verbosity,
        reasoningEffort: options.reasoningEffort || complexityConfig.reasoningEffort,
        timeout: options.timeout || 30000 // Reduced from 60s
      });
    } catch (error) {
      console.warn('[PositionQualityValidator] Failed to initialize LLM client:', error.message);
      this.client = null;
    }

    this.enabled = options.enabled !== false;
    // NEW: Auto-apply fixes by DEFAULT to actually fix issues
    // Set to false explicitly to disable
    this.autoApplyFixes = options.autoApplyFixes !== false; // Changed: default TRUE
    this.batchSize = options.batchSize || 10; // NEW: Batch size for parallel validation
    this.conditionalValidation = options.conditionalValidation !== false; // NEW: Skip if not needed
    
    // For small hearings, always force validation (don't skip)
    this.forceValidationForSmallHearings = options.forceValidationForSmallHearings !== false;
  }

  /**
   * Validate and optionally fix position structure
   * @param {Array} consolidatedThemes - Themes with consolidated positions
   * @param {Object} context - Context for validation (responseCount, complexity, etc.)
   * @returns {Promise<Object>} Validation result with recommendations
   */
  async validate(consolidatedThemes, context = {}) {
    if (!this.enabled || !this.client) {
      console.log('[PositionQualityValidator] Validation disabled or LLM unavailable, skipping');
      return {
        valid: true,
        issues: [],
        recommendations: []
      };
    }

    const { responseCount, complexity, avgResponseLength, explosionRatio } = context;

    console.log(`[PositionQualityValidator] Starting quality validation (${responseCount} responses, complexity: ${complexity})`);

    // Extract all positions for holistic analysis
    const allPositions = [];
    for (const theme of consolidatedThemes) {
      for (const position of theme.positions || []) {
        allPositions.push({
          theme: theme.name,
          title: position.title,
          summary: (position.summary || '').slice(0, 500), // First 500 chars
          responseNumbers: position.responseNumbers,
          respondentCount: position.responseNumbers.length,
          subPositions: position.subPositions // Include sub-positions for mega-position check
        });
      }
    }

    if (allPositions.length === 0) {
      console.log('[PositionQualityValidator] No positions to validate');
      return { valid: true, issues: [], recommendations: [] };
    }

    // CONDITIONAL VALIDATION: Skip if consolidation was effective
    if (this.conditionalValidation) {
      const shouldSkip = this.shouldSkipValidation(allPositions.length, responseCount, explosionRatio, complexity);
      if (shouldSkip.skip) {
        console.log(`[PositionQualityValidator] ⏩ SKIPPING validation: ${shouldSkip.reason}`);
        return {
          valid: true,
          skipped: true,
          skipReason: shouldSkip.reason,
          issues: [],
          recommendations: []
        };
      }
    }

    console.log(`[PositionQualityValidator] Validating ${allPositions.length} positions across ${consolidatedThemes.length} themes`);

    // QUALITY FIX: HARD CHECK for overlapping respondents within same theme
    // If the same respondent appears in multiple positions about similar topics, they should be merged
    const overlappingRespondentIssues = this.detectOverlappingRespondents(consolidatedThemes);
    if (overlappingRespondentIssues.length > 0) {
      console.warn(`[PositionQualityValidator] ⚠️ Found ${overlappingRespondentIssues.length} positions with overlapping respondents`);
      overlappingRespondentIssues.forEach(issue => {
        console.warn(`  - "${issue.position1}" and "${issue.position2}": shared respondents [${issue.sharedRespondents.join(', ')}]`);
      });
    }

    // QUALITY FIX: HARD CHECK for mega-positions (>10 respondents without sub-structure)
    // These positions lose all nuance and MUST be rejected/split
    // NOTE: Positions WITH sub-positions are acceptable - they have sub-structure
    const megaPositions = allPositions.filter(p =>
      p.respondentCount > 10 &&
      (!p.subPositions || p.subPositions.length === 0)
    );
    const criticalIssues = [];
    
    // Add overlapping respondent issues
    // Note: Within the same theme, respondents CAN have different sub-positions
    // Only mark as HIGH if titles are very similar (likely duplicates)
    for (const issue of overlappingRespondentIssues) {
      // Check if position titles are similar (potential duplicate)
      const titleSimilarity = this.calculateTitleSimilarity(issue.position1, issue.position2);
      // PHASE 2 FIX: Increased thresholds to reduce over-consolidation
      // Was: titleSimilarity > 0.6 || overlapRatio > 0.8
      let isDuplicateCandidate = titleSimilarity > 0.75 || issue.overlapRatio > 0.9;

      // PHASE 2 FIX: Preserve positions with MANY unique responses (give them benefit of doubt)
      // Find the two positions to get their response numbers
      const pos1 = consolidatedThemes.find(t => t.name === issue.theme)?.positions?.find(p => p.title === issue.position1);
      const pos2 = consolidatedThemes.find(t => t.name === issue.theme)?.positions?.find(p => p.title === issue.position2);
      if (pos1 && pos2) {
        const totalUniqueResponses = new Set([
          ...(pos1.responseNumbers || []),
          ...(pos2.responseNumbers || [])
        ]).size;

        // If merged position would have 5+ unique responses, require higher similarity
        if (totalUniqueResponses >= 5 && titleSimilarity < 0.85) {
          isDuplicateCandidate = false;
          console.log(`[PositionQualityValidator] 🛡️ Preserving positions with ${totalUniqueResponses} unique responses (titleSimilarity=${titleSimilarity.toFixed(2)} < 0.85)`);
        }

        // STANCE CONFLICT CHECK: NEVER merge positions with conflicting stances
        // Use argument-level direction to detect stance conflicts
        const pos1Directions = this.getPositionDirections(pos1);
        const pos2Directions = this.getPositionDirections(pos2);
        const hasStanceConflict = this.detectStanceConflict(pos1Directions, pos2Directions);

        if (hasStanceConflict) {
          isDuplicateCandidate = false;
          console.log(`[PositionQualityValidator] 🛡️ STANCE CONFLICT: "${issue.position1}" (${pos1Directions.dominant}) vs "${issue.position2}" (${pos2Directions.dominant}) - preventing merge`);
        }
      }

      criticalIssues.push({
        severity: isDuplicateCandidate ? 'HIGH' : 'INFO',
        type: 'OVERLAPPING_RESPONDENTS',
        theme: issue.theme,
        description: isDuplicateCandidate
          ? `Respondent(er) [${issue.sharedRespondents.join(', ')}] optræder i begge: "${issue.position1}" og "${issue.position2}". Disse bør merges.`
          : `[INFO] Respondent(er) [${issue.sharedRespondents.join(', ')}] har flere holdninger i samme tema: "${issue.position1}" og "${issue.position2}". Kan være intenderet hvis holdningerne er forskellige.`,
        affectedPositions: [issue.idx1, issue.idx2]
      });
    }
    
    if (megaPositions.length > 0) {
      console.error(`[PositionQualityValidator] 🚨 CRITICAL: Found ${megaPositions.length} mega-positions with >10 respondents`);
      megaPositions.forEach(pos => {
        console.error(`  - "${pos.title}" in "${pos.theme}": ${pos.respondentCount} respondents (UNACCEPTABLE)`);
        criticalIssues.push({
          severity: 'CRITICAL',
          type: 'mega-position',
          theme: pos.theme,
          position: pos.title,
          respondentCount: pos.respondentCount,
          description: `Position has ${pos.respondentCount} respondents without sub-structure - loses all nuance. MUST be split into sub-positions.`,
          action: 'REJECT - Position must be split by aggregator before reaching this stage'
        });
      });
      
      // If critical issues found, fail fast without LLM validation
      return {
        valid: false,
        issues: criticalIssues,
        recommendations: [],
        megaPositionsDetected: true
      };
    }

    // Generate merge recommendations for overlapping respondent issues
    const overlappingMergeRecs = overlappingRespondentIssues.map(issue => ({
      action: 'MERGE',
      positionIndices: [issue.idx1, issue.idx2],
      reasoning: `Samme respondenter [${issue.sharedRespondents.join(', ')}] optræder i begge positioner om samme emne. Skal merges.`,
      _autoGenerated: true
    }));

    // BATCHED + PARALLEL VALIDATION for performance
    try {
      const validation = await this.validateBatched(allPositions, context);
      
      // Combine overlapping issues with LLM-detected issues
      const allIssues = [...criticalIssues, ...(validation.issues || [])];
      const allRecommendations = [...overlappingMergeRecs, ...(validation.recommendations || [])];
      
      console.log(`[PositionQualityValidator] Validation complete: ${allIssues.length} issues found (${criticalIssues.length} programmatic, ${validation.issues?.length || 0} LLM)`);
      
      if (allIssues.length > 0) {
        console.warn('[PositionQualityValidator] Issues detected:');
        allIssues.forEach((issue, idx) => {
          console.warn(`  ${idx + 1}. [${issue.severity}] ${issue.type}: ${issue.description}`);
        });
      }

      // Auto-apply fixes if enabled
      // PHASE 2 FIX: Only auto-apply recommendations with high confidence
      const highConfidenceRecs = allRecommendations.filter(rec => {
        // Auto-generated (from overlapping detection with HIGH severity) are already validated
        if (rec._autoGenerated) {
          // But only if corresponding issue was HIGH severity
          const correspondingIssue = allIssues.find(
            issue => issue.type === 'OVERLAPPING_RESPONDENTS' &&
                     issue.severity === 'HIGH' &&
                     issue.affectedPositions?.includes(rec.positionIndices?.[0])
          );
          return correspondingIssue != null;
        }

        // LLM recommendations: only apply HIGH severity
        return rec.severity === 'HIGH';
      });

      if (this.autoApplyFixes && highConfidenceRecs.length > 0) {
        console.log(`[PositionQualityValidator] Auto-applying ${highConfidenceRecs.length}/${allRecommendations.length} high-confidence fixes...`);
        const fixed = this.applyRecommendations(consolidatedThemes, highConfidenceRecs);
        return {
          ...validation,
          issues: allIssues,
          recommendations: allRecommendations,
          fixedThemes: fixed,
          autoFixed: true
        };
      }

      return {
        ...validation,
        issues: allIssues,
        recommendations: allRecommendations,
        autoFixed: false
      };
    } catch (error) {
      console.error('[PositionQualityValidator] Validation failed:', error);
      return {
        valid: false,
        error: error.message,
        issues: [],
        recommendations: []
      };
    }
  }

  /**
   * Determine if validation should be skipped (CONDITIONAL VALIDATION)
   * @returns {Object} { skip: boolean, reason: string }
   */
  shouldSkipValidation(positionCount, responseCount, explosionRatio, complexity) {
    // NEW: NEVER skip for small hearings with over-fragmentation
    // These are exactly the hearings that need validation most!
    if (this.forceValidationForSmallHearings && responseCount <= 20) {
      const positionsPerResponse = positionCount / Math.max(1, responseCount);
      
      // If we have many positions relative to responses, force validation
      if (positionsPerResponse > 1.0) {
        console.log(`[PositionQualityValidator] 🔍 FORCING validation for small hearing: ${positionCount} positions / ${responseCount} responses = ${positionsPerResponse.toFixed(1)} ratio`);
        return { skip: false, reason: null };
      }
    }
    
    // Skip for tiny hearings ONLY if consolidation looks good
    if (responseCount <= 5 && positionCount <= responseCount) {
      return { skip: true, reason: 'Tiny hearing (<= 5 responses) with good consolidation - validation not needed' };
    }
    
    // Skip if explosion ratio is GOOD (effective consolidation already happened)
    if (explosionRatio !== undefined && explosionRatio < 0.40) {
      return { skip: true, reason: `Good consolidation (ratio=${(explosionRatio*100).toFixed(1)}% < 40%) - validation not needed` };
    }
    
    // Skip for very_complex hearings (too many positions, validation becomes impractical)
    if (complexity && complexity.includes('very_complex')) {
      return { skip: true, reason: 'Very complex hearing - validation impractical for large position count' };
    }
    
    // Skip if position count is very low (nothing to validate)
    if (positionCount <= 3) {
      return { skip: true, reason: 'Very few positions (<=3) - validation not needed' };
    }
    
    // Validate for all other cases
    return { skip: false, reason: null };
  }

  /**
   * Batched parallel validation for performance
   * Splits positions into batches and validates them in parallel
   */
  async validateBatched(positions, context) {
    const { responseCount, complexity, avgResponseLength } = context;
    
    // For small position counts, use single-batch validation
    if (positions.length <= this.batchSize) {
      console.log(`[PositionQualityValidator] Small position count (${positions.length}), using single validation call`);
      return await this.llmValidate(positions, context);
    }
    
    // Split into batches
    const batches = [];
    for (let i = 0; i < positions.length; i += this.batchSize) {
      batches.push(positions.slice(i, i + this.batchSize));
    }
    
    console.log(`[PositionQualityValidator] Batching ${positions.length} positions into ${batches.length} batches (${this.batchSize} per batch)`);
    
    // Validate all batches in PARALLEL
    const batchValidationPromises = batches.map(async (batch, idx) => {
      console.log(`[PositionQualityValidator] Validating batch ${idx + 1}/${batches.length} (${batch.length} positions)...`);
      try {
        return await this.llmValidate(batch, context);
      } catch (error) {
        console.warn(`[PositionQualityValidator] Batch ${idx + 1} validation failed:`, error.message);
        return { valid: true, issues: [], recommendations: [] }; // Skip failed batches
      }
    });
    
    const batchResults = await Promise.all(batchValidationPromises);
    
    // Aggregate results from all batches
    const aggregatedValidation = {
      valid: batchResults.every(r => r.valid),
      overallAssessment: `Validated ${batches.length} batches in parallel`,
      issues: batchResults.flatMap(r => r.issues || []),
      recommendations: batchResults.flatMap(r => r.recommendations || []),
      expectedPositionCount: Math.round(
        batchResults.reduce((sum, r) => sum + (r.expectedPositionCount || 0), 0) / batches.length
      )
    };
    
    console.log(`[PositionQualityValidator] Batch validation complete: ${aggregatedValidation.issues.length} total issues across ${batches.length} batches`);
    
    return aggregatedValidation;
  }

  /**
   * LLM-based qualitative validation
   */
  async llmValidate(positions, context) {
    const prompt = this.buildValidationPrompt(positions, context);

    const response = await this.client.createCompletion({
      messages: [
        {
          role: 'system',
          content: 'Du er ekspert i kvalitativ validering af høringssvar-analyser.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      response_format: getResponseFormat('qualityValidationReport')
    });

    let content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('No content in LLM response');
    }

    // Clean and parse JSON
    content = content.trim();
    if (content.startsWith('```json')) {
      content = content.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
    } else if (content.startsWith('```')) {
      content = content.replace(/^```\s*/i, '').replace(/\s*```$/i, '');
    }
    content = content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

    return JSON.parse(content);
  }

  /**
   * Build validation prompt
   */
  buildValidationPrompt(positions, context) {
    const { responseCount, complexity, avgResponseLength } = context;

    const positionsText = positions.map((pos, idx) => {
      return `${idx + 1}. [${pos.theme}] ${pos.title} (${pos.respondentCount} resp)
${pos.summary}`;
    }).join('\n\n');

    return `Vurder om disse ${positions.length} holdninger er korrekt struktureret (${responseCount} respondenter total, complexity: ${complexity}).

# Holdninger
${positionsText}

# Opgave
Identificer KUN problemer INDEN FOR samme tema:
1. **OVER-MERGED**: Holdninger med forskellige kernebudskaber merged sammen (INDEN FOR samme tema)
2. **UNDER-MERGED**: Samme holdning gentaget flere gange INDEN FOR samme tema

# 🚨 KRITISK REGEL: ALDRIG MERGE PÅ TVÆRS AF TEMAER
Tema-tilhørsforhold afspejler HVOR i dokumentet emnet REGULERES (hvilken §).
- Boldbane reguleres i § 8 (Ubebyggede arealer) - IKKE i Støj selvom folk klager over støj
- Bygningshøjde reguleres i § 6 (Bebyggelsens omfang) - IKKE i Trafik
- Holdninger i FORSKELLIGE temaer skal ALTID forblive separate

# Princip
Fokus på KERNEBUDSKAB inden for hvert tema. Respektér tema-grænserne.

Returnér JSON:
{
  "valid": true/false,
  "overallAssessment": "1 sætning",
  "issues": [{"type": "OVER_MERGED|UNDER_MERGED", "severity": "HIGH|MEDIUM|LOW", "description": "...", "affectedPositions": [1,2]}],
  "recommendations": [{"action": "MERGE|SPLIT", "positionIndices": [1,2], "reasoning": "..."}],
  "expectedPositionCount": ${positions.length}
}`;
  }

  /**
   * Apply recommendations to fix positions - ACTUALLY MERGES POSITIONS
   * CRITICAL: Only merges positions within the SAME theme to preserve regulatory structure
   * @param {Array} themes - Themes with positions
   * @param {Array} recommendations - Recommendations from validation
   * @returns {Array} Fixed themes with merged positions
   */
  applyRecommendations(themes, recommendations) {
    console.log(`[PositionQualityValidator] 🔧 Applying ${recommendations.length} recommendations...`);
    
    if (!recommendations || recommendations.length === 0) {
      return themes;
    }
    
    // Build a flat list of all positions with their theme context
    const allPositions = [];
    themes.forEach((theme, themeIdx) => {
      (theme.positions || []).forEach((position, posIdx) => {
        allPositions.push({
          themeIdx,
          posIdx,
          theme: theme.name,
          position,
          globalIdx: allPositions.length
        });
      });
    });
    
    // CRITICAL: Filter out any cross-theme merge recommendations
    // Theme assignments reflect regulatory structure and must be preserved
    const filteredRecommendations = recommendations.filter(rec => {
      if (rec.action !== 'MERGE') return true; // Keep non-merge recommendations
      
      const indices = rec.positionIndices || rec.positions || [];
      if (indices.length < 2) return true;
      
      // Check if all positions are in the same theme
      const positionsToCheck = indices
        .map(i => allPositions[i - 1] || allPositions[i])
        .filter(p => p);
      
      if (positionsToCheck.length < 2) return true;
      
      const firstTheme = positionsToCheck[0]?.theme;
      const allSameTheme = positionsToCheck.every(p => p.theme === firstTheme);
      
      if (!allSameTheme) {
        console.log(`[PositionQualityValidator] ⛔ REJECTED cross-theme merge: positions [${indices.join(', ')}] span multiple themes`);
        return false; // Filter out cross-theme merges
      }
      
      return true;
    });
    
    if (filteredRecommendations.length < recommendations.length) {
      const rejectedCount = recommendations.length - filteredRecommendations.length;
      console.log(`[PositionQualityValidator] 🛡️ Filtered out ${rejectedCount} cross-theme merge recommendations`);
    }
    
    recommendations = filteredRecommendations;
    
    // Track which positions to remove after merging
    const positionsToRemove = new Set();
    
    // Process MERGE recommendations
    const mergeRecs = recommendations.filter(r => r.action === 'MERGE');
    
    for (const rec of mergeRecs) {
      const indices = rec.positionIndices || rec.positions || [];
      if (indices.length < 2) continue;
      
      // Get the positions to merge (convert 1-indexed from prompt to 0-indexed)
      const positionsToMerge = indices
        .map(i => allPositions[i - 1] || allPositions[i]) // Handle both 0 and 1 indexed
        .filter(p => p && !positionsToRemove.has(p.globalIdx));
      
      if (positionsToMerge.length < 2) {
        console.log(`[PositionQualityValidator] Skipping merge - not enough valid positions for indices [${indices.join(', ')}]`);
        continue;
      }
      
      // Merge into the first position
      const targetPos = positionsToMerge[0].position;
      const mergedResponseNumbers = new Set(targetPos.responseNumbers || []);
      const mergedCitationMap = [...(targetPos.citationMap || [])];
      let mergedSummary = targetPos.summary || '';
      
      for (let i = 1; i < positionsToMerge.length; i++) {
        const sourcePos = positionsToMerge[i].position;
        
        // Merge response numbers
        (sourcePos.responseNumbers || []).forEach(num => mergedResponseNumbers.add(num));
        
        // Merge citation maps
        if (sourcePos.citationMap) {
          mergedCitationMap.push(...sourcePos.citationMap);
        }
        
        // Append summary points (simplified merge)
        if (sourcePos.summary && !mergedSummary.includes(sourcePos.summary)) {
          mergedSummary += ' ' + sourcePos.summary;
        }
        
        // Mark for removal
        positionsToRemove.add(positionsToMerge[i].globalIdx);
      }
      
      // Update the target position
      targetPos.responseNumbers = [...mergedResponseNumbers].sort((a, b) => a - b);
      targetPos.citationMap = mergedCitationMap;
      targetPos.summary = mergedSummary;
      targetPos._mergedFrom = indices;
      targetPos._mergeReason = rec.reasoning;
      
      // Recalculate respondent breakdown
      targetPos.respondentBreakdown = {
        ...targetPos.respondentBreakdown,
        total: targetPos.responseNumbers.length
      };
      
      console.log(`[PositionQualityValidator] ✅ Merged positions [${indices.join(', ')}] → ${targetPos.responseNumbers.length} respondents. Reason: ${rec.reasoning}`);
    }
    
    // Remove merged positions from themes
    const fixedThemes = themes.map((theme, themeIdx) => {
      const fixedPositions = (theme.positions || []).filter((_, posIdx) => {
        const globalIdx = allPositions.findIndex(p => p.themeIdx === themeIdx && p.posIdx === posIdx);
        return !positionsToRemove.has(globalIdx);
      });
      
      return {
        ...theme,
        positions: fixedPositions,
        _autoMerged: fixedPositions.length !== (theme.positions || []).length
      };
    });
    
    const removedCount = positionsToRemove.size;
    if (removedCount > 0) {
      console.log(`[PositionQualityValidator] 🎯 Auto-merge complete: removed ${removedCount} redundant positions`);
    }
    
    return fixedThemes;
  }

  /**
   * Format validation result as human-readable report
   */
  formatReport(validation) {
    let report = `\n=== Position Quality Validation Report ===\n`;
    report += `Overall: ${validation.valid ? '✅ VALID' : '⚠️ ISSUES FOUND'}\n`;
    report += `Assessment: ${validation.overallAssessment || 'N/A'}\n\n`;

    if (validation.issues && validation.issues.length > 0) {
      report += `Issues Found (${validation.issues.length}):\n`;
      validation.issues.forEach((issue, idx) => {
        report += `  ${idx + 1}. [${issue.severity}] ${issue.type}\n`;
        report += `     ${issue.description}\n`;
        if (issue.affectedPositions) {
          report += `     Affected positions: ${issue.affectedPositions.join(', ')}\n`;
        }
      });
      report += `\n`;
    }

    if (validation.recommendations && validation.recommendations.length > 0) {
      report += `Recommendations (${validation.recommendations.length}):\n`;
      validation.recommendations.forEach((rec, idx) => {
        const positions = rec.positions || rec.positionIndices || [];
        report += `  ${idx + 1}. ${rec.action} positions ${positions.join(', ')}\n`;
        report += `     Reasoning: ${rec.reasoning}\n`;
      });
      report += `\n`;
    }

    if (validation.expectedPositionCount !== undefined) {
      report += `Expected position count: ${validation.expectedPositionCount}\n`;
    }

    report += `\n==========================================\n`;
    return report;
  }

  /**
   * Calculate similarity between two position titles (simple word overlap)
   * Used to determine if overlapping respondents are a real issue or intentional
   * @param {string} title1 - First position title
   * @param {string} title2 - Second position title
   * @returns {number} Similarity score between 0 and 1
   */
  calculateTitleSimilarity(title1, title2) {
    if (!title1 || !title2) return 0;

    const normalize = (text) => text.toLowerCase().replace(/[^a-zæøå0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
    const words1 = new Set(normalize(title1));
    const words2 = new Set(normalize(title2));

    if (words1.size === 0 || words2.size === 0) return 0;

    // Calculate Jaccard similarity
    const intersection = [...words1].filter(w => words2.has(w)).length;
    const union = new Set([...words1, ...words2]).size;

    return intersection / union;
  }

  /**
   * Detect positions within the same theme that have overlapping respondents
   * This is a critical issue - same respondent should not appear in multiple positions about the same topic
   * @param {Array} themes - Themes with positions
   * @returns {Array} List of overlapping respondent issues
   */
  detectOverlappingRespondents(themes) {
    const issues = [];
    
    for (const theme of themes) {
      const positions = theme.positions || [];
      if (positions.length < 2) continue;
      
      // Compare each pair of positions within the theme
      for (let i = 0; i < positions.length; i++) {
        for (let j = i + 1; j < positions.length; j++) {
          const pos1 = positions[i];
          const pos2 = positions[j];
          
          const respondents1 = new Set(pos1.responseNumbers || []);
          const respondents2 = new Set(pos2.responseNumbers || []);
          
          // Find overlapping respondents
          const shared = [...respondents1].filter(r => respondents2.has(r));
          
          // If >50% of the smaller position's respondents overlap, it's a problem
          const smallerSize = Math.min(respondents1.size, respondents2.size);
          const overlapRatio = shared.length / Math.max(1, smallerSize);

          // CRITICAL: If BOTH positions are from THE SAME SINGLE respondent, this is INTENTIONAL
          // Micro-summarizer splits one respondent's concerns into distinct positions
          // so other respondents can join each specific position later. DO NOT FLAG.
          if (respondents1.size === 1 && respondents2.size === 1 && shared.length === 1) {
            // Single respondent with multiple distinct concerns - this is expected and valid
            continue;
          }

          if (shared.length > 0 && overlapRatio >= 0.5) {
            issues.push({
              theme: theme.name,
              position1: pos1.title,
              position2: pos2.title,
              sharedRespondents: shared,
              overlapRatio,
              idx1: i + 1,
              idx2: j + 1
            });
          }
        }
      }
    }

    return issues;
  }

  /**
   * Extract direction distribution from a position's arguments
   * @param {Object} position - Position object with args or sourceArgumentRefs
   * @returns {Object} { proChange: number, proStatusQuo: number, neutral: number, dominant: string }
   */
  getPositionDirections(position) {
    const args = position.args || position.sourceArgumentRefs || [];
    const directions = args.map(a => a.direction).filter(Boolean);

    const proChange = directions.filter(d => d === 'pro_change').length;
    const proStatusQuo = directions.filter(d => d === 'pro_status_quo').length;
    const neutral = directions.length - proChange - proStatusQuo;

    // Determine dominant direction
    let dominant = 'neutral';
    if (proChange > proStatusQuo && proChange > neutral) {
      dominant = 'pro_change';
    } else if (proStatusQuo > proChange && proStatusQuo > neutral) {
      dominant = 'pro_status_quo';
    }

    return { proChange, proStatusQuo, neutral, dominant };
  }

  /**
   * Detect if two positions have conflicting stances that should prevent merge
   * @param {Object} dirs1 - Direction distribution from getPositionDirections
   * @param {Object} dirs2 - Direction distribution from getPositionDirections
   * @returns {boolean} True if positions have conflicting stances
   */
  detectStanceConflict(dirs1, dirs2) {
    // If one position is predominantly pro_change and the other is pro_status_quo, they conflict
    if (dirs1.dominant === 'pro_change' && dirs2.dominant === 'pro_status_quo') {
      return true;
    }
    if (dirs1.dominant === 'pro_status_quo' && dirs2.dominant === 'pro_change') {
      return true;
    }

    // Also check if there's significant presence of opposing directions even if not dominant
    // e.g., pos1 has 3 pro_change args, pos2 has 2 pro_status_quo args - should not merge
    const hasSignificantProChange1 = dirs1.proChange >= 2;
    const hasSignificantProStatusQuo1 = dirs1.proStatusQuo >= 2;
    const hasSignificantProChange2 = dirs2.proChange >= 2;
    const hasSignificantProStatusQuo2 = dirs2.proStatusQuo >= 2;

    if ((hasSignificantProChange1 && hasSignificantProStatusQuo2) ||
        (hasSignificantProStatusQuo1 && hasSignificantProChange2)) {
      return true;
    }

    return false;
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

