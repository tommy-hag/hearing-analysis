/**
 * Step Logger
 *
 * Standardized logging utility for pipeline steps.
 * Provides consistent formatting for metrics, decisions, and progress tracking.
 */

/**
 * StepLogger - Per-module logger for standardized output
 */
export class StepLogger {
  constructor(moduleName) {
    this.moduleName = moduleName;
    this.startTime = null;
    this.warnings = [];
    this.stepCount = 0;
  }

  /**
   * Log step entry with input summary
   * @param {Object} inputSummary - Key-value pairs describing inputs
   * @example log.start({ items: 24, themes: 10 })
   * // Output: [ModuleName] Starting: items=24, themes=10
   */
  start(inputSummary = {}) {
    this.startTime = Date.now();
    this.warnings = [];
    this.stepCount++;

    const summaryParts = Object.entries(inputSummary)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');

    console.log(`[${this.moduleName}] Starting${summaryParts ? `: ${summaryParts}` : ''}`);
  }

  /**
   * Log step completion with output summary
   * @param {Object} outputSummary - Key-value pairs describing outputs
   * @example log.complete({ positions: 25, reordered: 12 })
   * // Output: [ModuleName] Completed in 5.2s: positions=25, reordered=12
   */
  complete(outputSummary = {}) {
    const duration = this.startTime ? ((Date.now() - this.startTime) / 1000).toFixed(1) : '?';

    const summaryParts = Object.entries(outputSummary)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');

    // Log aggregated warnings if any
    if (this.warnings.length > 0) {
      const warningGroups = this._groupWarnings();
      for (const [type, count] of Object.entries(warningGroups)) {
        if (count > 3) {
          console.log(`[${this.moduleName}] WARN: ${type} (${count} occurrences)`);
        }
      }
    }

    console.log(`[${this.moduleName}] Completed in ${duration}s${summaryParts ? `: ${summaryParts}` : ''}`);
    this.startTime = null;
  }

  /**
   * Log a metric with optional context
   * @param {string} name - Metric name
   * @param {number|string} value - Metric value
   * @param {string} [context] - Additional context
   * @example log.metric('Batch size', 50, '5 batches')
   * // Output: [ModuleName] Batch size: 50 (5 batches)
   */
  metric(name, value, context = null) {
    const contextStr = context ? ` (${context})` : '';
    console.log(`[${this.moduleName}] ${name}: ${value}${contextStr}`);
  }

  /**
   * Log a percentage metric
   * @param {string} name - Metric name
   * @param {number} count - Numerator
   * @param {number} total - Denominator
   * @example log.percentage('Valid quotes', 95, 100)
   * // Output: [ModuleName] Valid quotes: 95/100 (95.0%)
   */
  percentage(name, count, total) {
    const pct = total > 0 ? ((count / total) * 100).toFixed(1) : '0.0';
    console.log(`[${this.moduleName}] ${name}: ${count}/${total} (${pct}%)`);
  }

  /**
   * Log a distribution breakdown
   * @param {string} name - Distribution name
   * @param {Object} breakdown - Key-value pairs of the distribution
   * @example log.distribution('Types', { authorities: 3, citizens: 21 })
   * // Output: [ModuleName] Types: authorities=3, citizens=21
   */
  distribution(name, breakdown) {
    const parts = Object.entries(breakdown)
      .filter(([, value]) => value > 0)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');

    if (parts) {
      console.log(`[${this.moduleName}] ${name}: ${parts}`);
    }
  }

  /**
   * Log a decision with reason and optional details
   * @param {string} type - Decision type (e.g., 'filtered', 'merged', 'skipped')
   * @param {string} reason - Human-readable reason
   * @param {Object} [details] - Additional details for debugging
   * @example log.decision('filtered', 'Below threshold', { score: 0.65 })
   * // Output: [ModuleName] DECISION[filtered]: Below threshold | {score: 0.65}
   */
  decision(type, reason, details = null) {
    const detailsStr = details ? ` | ${JSON.stringify(details)}` : '';
    console.log(`[${this.moduleName}] DECISION[${type}]: ${reason}${detailsStr}`);
  }

  /**
   * Log a warning (aggregated at complete())
   * @param {string} message - Warning message
   * @param {Object} [context] - Additional context
   */
  warn(message, context = null) {
    this.warnings.push({ message, context });

    // Only log immediately if under threshold to avoid spam
    if (this.warnings.filter(w => w.message === message).length <= 3) {
      const contextStr = context ? ` | ${JSON.stringify(context)}` : '';
      console.log(`[${this.moduleName}] WARN: ${message}${contextStr}`);
    }
  }

  /**
   * Log progress update
   * @param {number} current - Current item number
   * @param {number} total - Total items
   * @param {string} [item] - Current item name/description
   * @example log.progress(10, 50, 'Processing chunk')
   * // Output: [ModuleName] Progress: 10/50 (20%) - Processing chunk
   */
  progress(current, total, item = null) {
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    const itemStr = item ? ` - ${item}` : '';
    console.log(`[${this.moduleName}] Progress: ${current}/${total} (${pct}%)${itemStr}`);
  }

  /**
   * Log informational message
   * @param {string} message - Info message
   */
  info(message) {
    console.log(`[${this.moduleName}] ${message}`);
  }

  /**
   * Group warnings by message for aggregation
   * @private
   */
  _groupWarnings() {
    const groups = {};
    for (const warning of this.warnings) {
      groups[warning.message] = (groups[warning.message] || 0) + 1;
    }
    return groups;
  }
}

/**
 * Phase definitions for the pipeline
 */
export const PIPELINE_PHASES = {
  'Data Loading': {
    steps: ['load-data', 'material-summary', 'analyze-material', 'extract-substance', 'embed-substance', 'edge-case-screening', 'enrich-responses'],
    description: 'Load and prepare hearing data'
  },
  'Embedding': {
    steps: ['chunking', 'embedding', 'calculate-dynamic-parameters'],
    description: 'Generate vector embeddings'
  },
  'Analysis': {
    steps: ['micro-summarize', 'citation-registry', 'validate-quote-sources', 'embed-arguments', 'similarity-analysis', 'theme-mapping', 'validate-legal-scope'],
    description: 'Extract and analyze arguments'
  },
  'Aggregation': {
    steps: ['aggregate', 'consolidate-positions', 'extract-sub-positions', 'group-positions', 'validate-positions', 'sort-positions'],
    description: 'Group arguments into positions'
  },
  'Output': {
    steps: ['hybrid-position-writing', 'validate-writer-output', 'extract-citations', 'validate-citations', 'validate-coverage', 'considerations', 'format-output', 'build-docx'],
    description: 'Generate final output'
  }
};

/**
 * Get phase for a given step
 * @param {string} stepName - Step name
 * @returns {string|null} Phase name or null
 */
export function getPhaseForStep(stepName) {
  for (const [phaseName, phase] of Object.entries(PIPELINE_PHASES)) {
    if (phase.steps.includes(stepName)) {
      return phaseName;
    }
  }
  return null;
}

/**
 * Log phase start banner
 * @param {string} phaseName - Phase name
 * @param {number} stepCount - Number of steps in phase
 * @param {Array<string>} stepNames - List of step names
 */
export function logPhaseStart(phaseName, stepCount, stepNames) {
  console.log('\n============================================================');
  console.log(`[Pipeline] PHASE: ${phaseName} (${stepCount} steps)`);
  console.log(`[Pipeline] Steps: ${stepNames.join(' → ')}`);
  console.log('============================================================');
}

/**
 * Log phase completion summary
 * @param {string} phaseName - Phase name
 * @param {number} duration - Duration in ms
 * @param {Object} [summary] - Summary statistics
 */
export function logPhaseComplete(phaseName, duration, summary = {}) {
  const durationSec = (duration / 1000).toFixed(1);

  const summaryParts = Object.entries(summary)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');

  console.log(`[Pipeline] PHASE COMPLETE: ${phaseName} (${durationSec}s)`);
  if (summaryParts) {
    console.log(`[Pipeline] Phase summary: ${summaryParts}`);
  }
  console.log('------------------------------------------------------------');
}

/**
 * Format a checkpoint skip message with context
 * @param {string} stepName - Step name
 * @param {Object} artifact - Loaded artifact
 * @param {string} sourceLabel - Source checkpoint label
 * @returns {string} Formatted skip message
 */
export function formatSkipMessage(stepName, artifact, sourceLabel) {
  const contextParts = [];

  // Extract useful context from different artifact types
  if (artifact) {
    if (stepName === 'load-data') {
      const responses = artifact.responses?.length || 0;
      const materials = artifact.materials?.length || 0;
      contextParts.push(`${responses} responses`, `${materials} material${materials !== 1 ? 's' : ''}`);
    } else if (stepName === 'chunking') {
      const chunks = Array.isArray(artifact) ? artifact.length : (artifact.chunks?.length || 0);
      contextParts.push(`${chunks} chunks`);
    } else if (stepName === 'embedding') {
      const embeddings = Array.isArray(artifact) ? artifact.length : (artifact.embedded?.length || 0);
      contextParts.push(`${embeddings} embeddings`);
    } else if (stepName === 'micro-summarize') {
      const summaries = Array.isArray(artifact) ? artifact.length : 0;
      const totalArgs = Array.isArray(artifact)
        ? artifact.reduce((sum, s) => sum + (s.arguments?.length || 0), 0)
        : 0;
      contextParts.push(`${summaries} summaries`, `${totalArgs} arguments`);
    } else if (stepName === 'aggregate') {
      const themes = Array.isArray(artifact) ? artifact.length : 0;
      const positions = Array.isArray(artifact)
        ? artifact.reduce((sum, t) => sum + (t.positions?.length || 0), 0)
        : 0;
      contextParts.push(`${themes} themes`, `${positions} positions`);
    } else if (stepName === 'theme-mapping') {
      const themes = artifact?.themes?.length || 0;
      contextParts.push(`${themes} themes`);
    } else if (Array.isArray(artifact)) {
      contextParts.push(`${artifact.length} items`);
    } else if (typeof artifact === 'object' && artifact !== null) {
      const keys = Object.keys(artifact).length;
      contextParts.push(`${keys} keys`);
    }
  }

  const stepDisplayName = stepName.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  const contextStr = contextParts.length > 0 ? ` (${contextParts.join(', ')})` : '';

  return `⏩ ${stepDisplayName}${contextStr} - loaded from "${sourceLabel}"`;
}
