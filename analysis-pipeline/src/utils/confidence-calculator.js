/**
 * Confidence Calculator
 *
 * Calculates confidence/priority scores for positions and responses
 * to help users focus review efforts on items most likely to need attention.
 */

/**
 * Calculate confidence score for a position
 * @param {Object} position - Position object with responseNumbers, direction, etc.
 * @param {Object} metadata - Additional metadata (embedding similarities, validation results)
 * @returns {Object} { overall: 0.0-1.0, reviewPriority: 'high'|'medium'|'low', components: {...} }
 */
export function calculatePositionConfidence(position, metadata = {}) {
  const weights = {
    embeddingSimilarity: 0.30,
    directionConsistency: 0.25,
    citationCoverage: 0.20,
    respondentCount: 0.15,
    llmValidation: 0.10
  };

  const components = {};
  let score = 0;

  // 1. Embedding similarity (0-1): Higher = more coherent group
  const avgSimilarity = metadata.avgEmbeddingSimilarity ?? 0.75;
  components.embeddingSimilarity = avgSimilarity;
  score += weights.embeddingSimilarity * avgSimilarity;

  // 2. Direction consistency (0-1): Are all respondents same direction?
  const directionBreakdown = position.directionBreakdown || inferDirectionBreakdown(position);
  if (directionBreakdown) {
    const total = Object.values(directionBreakdown).reduce((a, b) => a + b, 0);
    const max = Math.max(...Object.values(directionBreakdown));
    const consistency = total > 0 ? max / total : 1;
    components.directionConsistency = consistency;
    score += weights.directionConsistency * consistency;
  } else {
    components.directionConsistency = 1;
    score += weights.directionConsistency;
  }

  // 3. Citation coverage (0-1): What % of respondents have citations?
  const respondentCount = position.responseNumbers?.length || 1;
  const citedCount = Object.keys(position.citationMap || {}).length ||
                     (position.hybridReferences?.length || 0);
  const coverage = Math.min(1, citedCount / respondentCount);
  components.citationCoverage = coverage;
  score += weights.citationCoverage * coverage;

  // 4. Respondent count factor: Very small (<3) or very large (>20) groups are flagged
  let countScore;
  if (respondentCount >= 3 && respondentCount <= 15) {
    countScore = 1.0;  // Optimal range
  } else if (respondentCount < 3) {
    countScore = 0.7;  // Too small - might be noise
  } else if (respondentCount <= 25) {
    countScore = 0.9;  // Slightly large
  } else {
    countScore = 0.7;  // Very large - might need splitting
  }
  components.respondentCount = countScore;
  components.respondentCountRaw = respondentCount;
  score += weights.respondentCount * countScore;

  // 5. LLM validation confidence (if available)
  const llmConfidence = metadata.llmMergeConfidence ?? 0.8;
  components.llmValidation = llmConfidence;
  score += weights.llmValidation * llmConfidence;

  // Determine review priority
  let reviewPriority;
  if (score < 0.6) {
    reviewPriority = 'high';
  } else if (score < 0.75) {
    reviewPriority = 'medium';
  } else {
    reviewPriority = 'low';
  }

  // Generate flags for specific issues
  const flags = [];
  if (components.directionConsistency < 0.8) {
    flags.push('mixed_directions');
  }
  if (components.embeddingSimilarity < 0.7) {
    flags.push('low_embedding_similarity');
  }
  if (respondentCount < 3) {
    flags.push('very_small_group');
  }
  if (respondentCount > 20) {
    flags.push('large_group');
  }
  if (components.citationCoverage < 0.5) {
    flags.push('low_citation_coverage');
  }

  return {
    overall: Math.round(score * 100) / 100,
    reviewPriority,
    components,
    flags
  };
}

/**
 * Calculate confidence score for a response
 * @param {Object} response - Response object
 * @param {Object} microSummary - Micro-summary for this response
 * @param {Object} positionAssignment - Which position(s) this response is assigned to
 * @returns {Object} { overall: 0.0-1.0, reviewPriority: 'high'|'medium'|'low', components: {...} }
 */
export function calculateResponseConfidence(response, microSummary, positionAssignment = {}) {
  const components = {};
  let score = 0;

  // 1. Has micro-summary? (0.3)
  const hasMicroSummary = microSummary && microSummary.arguments?.length > 0;
  components.hasMicroSummary = hasMicroSummary ? 1 : 0;
  score += 0.3 * (hasMicroSummary ? 1 : 0);

  // 2. Is assigned to a position? (0.25)
  const isAssigned = positionAssignment.positionId != null;
  components.isAssigned = isAssigned ? 1 : 0;
  score += 0.25 * (isAssigned ? 1 : 0);

  // 3. Citation quality (0.2)
  let citationQuality = 0;
  if (microSummary?.arguments) {
    const args = microSummary.arguments;
    const withQuotes = args.filter(a => a.quote && a.quote.length > 20).length;
    citationQuality = args.length > 0 ? withQuotes / args.length : 0;
  }
  components.citationQuality = citationQuality;
  score += 0.2 * citationQuality;

  // 4. Response length/complexity (0.15)
  const textLength = response.text?.length || response.textMd?.length || 0;
  let lengthScore;
  if (textLength < 50) {
    lengthScore = 0.5;  // Very short - might be unclear
  } else if (textLength < 200) {
    lengthScore = 0.8;  // Short but okay
  } else if (textLength < 2000) {
    lengthScore = 1.0;  // Good length
  } else {
    lengthScore = 0.9;  // Long - might have multiple topics
  }
  components.lengthScore = lengthScore;
  components.textLength = textLength;
  score += 0.15 * lengthScore;

  // 5. Direction clarity (0.1)
  const direction = microSummary?.direction || positionAssignment.direction;
  const hasDirection = direction && direction !== 'unknown' && direction !== 'neutral';
  components.hasDirection = hasDirection ? 1 : 0.7;
  score += 0.1 * (hasDirection ? 1 : 0.7);

  // Determine review priority
  let reviewPriority;
  if (score < 0.5) {
    reviewPriority = 'high';
  } else if (score < 0.7) {
    reviewPriority = 'medium';
  } else {
    reviewPriority = 'low';
  }

  // Generate flags
  const flags = [];
  if (!hasMicroSummary) {
    flags.push('no_micro_summary');
  }
  if (!isAssigned) {
    flags.push('unassigned');
  }
  if (citationQuality < 0.5) {
    flags.push('weak_citations');
  }
  if (textLength < 50) {
    flags.push('very_short');
  }
  if (textLength > 3000) {
    flags.push('very_long');
  }

  return {
    overall: Math.round(score * 100) / 100,
    reviewPriority,
    components,
    flags
  };
}

/**
 * Calculate aggregate confidence for all positions in themes
 * @param {Array} themes - Array of theme objects with positions
 * @param {Object} metadata - Additional metadata for positions
 * @returns {Array} Enhanced themes with confidence scores
 */
export function calculateThemeConfidences(themes, metadata = {}) {
  return themes.map(theme => ({
    ...theme,
    positions: (theme.positions || []).map(position => {
      const posKey = `${theme.name}::${position.title}`;
      const positionMetadata = metadata[posKey] || {};
      const confidence = calculatePositionConfidence(position, positionMetadata);

      return {
        ...position,
        confidence
      };
    })
  }));
}

/**
 * Get positions sorted by review priority (highest priority first)
 * @param {Array} themes - Array of theme objects with positions
 * @returns {Array} Flat list of positions sorted by priority
 */
export function getReviewQueue(themes) {
  const allPositions = [];

  for (const theme of themes) {
    for (const position of (theme.positions || [])) {
      const confidence = position.confidence || calculatePositionConfidence(position, {});
      allPositions.push({
        key: `${theme.name}::${position.title}`,
        themeName: theme.name,
        title: position.title,
        respondentCount: position.responseNumbers?.length || 0,
        confidence,
        reason: getReviewReason(confidence)
      });
    }
  }

  // Sort by priority (high first), then by score (lowest first)
  return allPositions.sort((a, b) => {
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    const priorityDiff = priorityOrder[a.confidence.reviewPriority] - priorityOrder[b.confidence.reviewPriority];
    if (priorityDiff !== 0) return priorityDiff;
    return a.confidence.overall - b.confidence.overall;
  });
}

/**
 * Generate human-readable review reason from confidence data
 */
function getReviewReason(confidence) {
  const { flags, components } = confidence;

  if (flags.includes('mixed_directions')) {
    return 'Blandet FOR/IMOD holdninger i samme position';
  }
  if (flags.includes('low_embedding_similarity')) {
    return 'Lav semantisk lighed mellem respondenter';
  }
  if (flags.includes('large_group')) {
    return `Stor gruppe (${components.respondentCountRaw} respondenter) - overvej opdeling`;
  }
  if (flags.includes('very_small_group')) {
    return 'Meget lille gruppe - tjek om det er relevant';
  }
  if (flags.includes('low_citation_coverage')) {
    return 'Mange respondenter uden citater';
  }

  return confidence.reviewPriority === 'high'
    ? 'Generelt lav konfidence - kræver gennemgang'
    : null;
}

/**
 * Infer direction breakdown from position data
 */
function inferDirectionBreakdown(position) {
  // If direction is explicitly set on position
  if (position.direction) {
    return { [position.direction]: position.responseNumbers?.length || 1 };
  }

  // If we have source argument refs with directions
  if (position.sourceArgumentRefs) {
    const breakdown = {};
    for (const ref of position.sourceArgumentRefs) {
      const dir = ref.direction || 'unknown';
      breakdown[dir] = (breakdown[dir] || 0) + 1;
    }
    return breakdown;
  }

  return null;
}

export default {
  calculatePositionConfidence,
  calculateResponseConfidence,
  calculateThemeConfidences,
  getReviewQueue
};
