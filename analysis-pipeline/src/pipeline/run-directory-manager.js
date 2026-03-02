import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { mkdirSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * RunDirectoryManager
 * 
 * Central module for managing run-specific output directories.
 * Consolidates all debugging output (checkpoints, logs, LLM calls, final output)
 * into a single directory per pipeline run.
 * 
 * Directory structure:
 * output/runs/{hearingId}/{label}/
 * ├── checkpoints/           # Step JSON files (load-data.json, etc.)
 * ├── llm-calls/            # Separate JSON per LLM call
 * ├── debug/                # Debug reports
 * ├── hearing-{hearingId}-analysis.json
 * ├── hearing-{hearingId}-analysis.md
 * └── hearing-{hearingId}-analysis.docx
 */
export class RunDirectoryManager {
  /**
   * @param {Object} options
   * @param {number|string} options.hearingId - The hearing ID
   * @param {string} [options.label='default'] - Checkpoint/run label
   * @param {string} [options.baseDir] - Base directory for runs (defaults to output/runs)
   */
  constructor(options = {}) {
    if (!options.hearingId) {
      throw new Error('hearingId is required');
    }

    this.hearingId = String(options.hearingId);
    this.label = options.label || 'default';
    
    const defaultBaseDir = join(__dirname, '../../output/runs');
    this.baseDir = options.baseDir
      || process.env.PIPELINE_RUNS_DIR
      || defaultBaseDir;

    // Build the run directory path
    this.runDir = join(this.baseDir, this.hearingId, this.label);
    
    // Subdirectory paths
    this.checkpointsDir = join(this.runDir, 'checkpoints');
    this.llmCallsDir = join(this.runDir, 'llm-calls');
    this.debugDir = join(this.runDir, 'debug');
    this.stepLogsDir = join(this.runDir, 'step-logs');

    // Track if directories have been created
    this._initialized = false;
  }

  /**
   * Initialize all directories (creates them if they don't exist)
   * @returns {RunDirectoryManager} Returns self for chaining
   */
  init() {
    if (this._initialized) return this;

    mkdirSync(this.runDir, { recursive: true });
    mkdirSync(this.checkpointsDir, { recursive: true });
    mkdirSync(this.llmCallsDir, { recursive: true });
    mkdirSync(this.debugDir, { recursive: true });
    mkdirSync(this.stepLogsDir, { recursive: true });

    this._initialized = true;
    return this;
  }

  /**
   * Get the root run directory
   * @returns {string}
   */
  getRunDir() {
    return this.runDir;
  }

  /**
   * Get the checkpoints directory
   * @returns {string}
   */
  getCheckpointsDir() {
    return this.checkpointsDir;
  }

  /**
   * Get the LLM calls directory
   * @returns {string}
   */
  getLLMCallsDir() {
    return this.llmCallsDir;
  }

  /**
   * Get the debug directory
   * @returns {string}
   */
  getDebugDir() {
    return this.debugDir;
  }

  /**
   * Get the step-logs directory
   * @returns {string}
   */
  getStepLogsDir() {
    return this.stepLogsDir;
  }

  /**
   * Get path for a step log markdown file
   * @param {number} stepNumber - Step number (1-based)
   * @param {string} stepName - Name of the pipeline step
   * @returns {string}
   */
  getStepLogPath(stepNumber, stepName) {
    const paddedNumber = String(stepNumber).padStart(2, '0');
    return join(this.stepLogsDir, `${paddedNumber}-${stepName}.md`);
  }

  /**
   * Get path for a checkpoint file
   * @param {string} stepName - Name of the pipeline step
   * @returns {string}
   */
  getCheckpointPath(stepName) {
    return join(this.checkpointsDir, `${stepName}.json`);
  }

  /**
   * Get path for an LLM call log file
   * @param {string} callId - Unique identifier for the LLM call
   * @returns {string}
   */
  getLLMCallPath(callId) {
    return join(this.llmCallsDir, `${callId}.json`);
  }

  /**
   * Get path for a debug report file
   * @param {string} reportName - Name of the debug report
   * @returns {string}
   */
  getDebugReportPath(reportName) {
    return join(this.debugDir, `${reportName}.json`);
  }

  /**
   * Get path for final JSON output
   * @returns {string}
   */
  getFinalJsonPath() {
    return join(this.runDir, `hearing-${this.hearingId}-analysis.json`);
  }

  /**
   * Get path for final Markdown output
   * @returns {string}
   */
  getFinalMarkdownPath() {
    return join(this.runDir, `hearing-${this.hearingId}-analysis.md`);
  }

  /**
   * Get path for final DOCX output
   * @returns {string}
   */
  getFinalDocxPath() {
    return join(this.runDir, `hearing-${this.hearingId}-analysis.docx`);
  }

  /**
   * Get path for terminal log file
   * @returns {string}
   */
  getTerminalLogPath() {
    return join(this.runDir, 'terminal.log');
  }

  /**
   * Get path for run summary JSON file
   * @returns {string}
   */
  getRunSummaryJsonPath() {
    return join(this.runDir, 'run-summary.json');
  }

  /**
   * Get path for run summary Markdown file
   * @returns {string}
   */
  getRunSummaryMdPath() {
    return join(this.runDir, 'run-summary.md');
  }

  /**
   * Check if the run directory exists
   * @returns {boolean}
   */
  exists() {
    return existsSync(this.runDir);
  }

  /**
   * Get a summary of all paths for logging
   * @returns {Object}
   */
  getPaths() {
    return {
      runDir: this.runDir,
      checkpointsDir: this.checkpointsDir,
      llmCallsDir: this.llmCallsDir,
      debugDir: this.debugDir,
      stepLogsDir: this.stepLogsDir,
      terminalLog: this.getTerminalLogPath(),
      runSummaryJson: this.getRunSummaryJsonPath(),
      runSummaryMd: this.getRunSummaryMdPath(),
      finalJson: this.getFinalJsonPath(),
      finalMarkdown: this.getFinalMarkdownPath(),
      finalDocx: this.getFinalDocxPath()
    };
  }

  /**
   * Log the paths configuration
   */
  logPaths() {
    console.log(`[RunDirectoryManager] Run directory: ${this.runDir}`);
    console.log(`[RunDirectoryManager]   ├── checkpoints/`);
    console.log(`[RunDirectoryManager]   ├── llm-calls/`);
    console.log(`[RunDirectoryManager]   ├── debug/`);
    console.log(`[RunDirectoryManager]   ├── step-logs/`);
    console.log(`[RunDirectoryManager]   ├── terminal.log`);
    console.log(`[RunDirectoryManager]   ├── run-summary.*`);
    console.log(`[RunDirectoryManager]   └── hearing-${this.hearingId}-analysis.*`);
  }
}



