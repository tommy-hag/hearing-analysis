
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

/**
 * LLM Tracer - Flight Recorder for AI Pipeline
 * 
 * Provides comprehensive logging of all LLM interactions.
 * 
 * When used with RunDirectoryManager, LLM call logs are saved to:
 *   output/runs/{hearingId}/{label}/llm-calls/
 * 
 * Each LLM call is saved as a separate JSON file for easier debugging:
 *   {step}-{timestamp}.json
 *   
 * When used standalone (legacy mode), logs are appended to a .jsonl file.
 */
export class LLMTracer {
  constructor(options = {}) {
    this.jobId = options.jobId || `job_${Date.now()}`;
    this.baseDir = options.baseDir || 'output/llm-traces';
    this.failuresDir = join(this.baseDir, 'failures');
    this.initialized = false;
    this.enabled = options.enabled !== false; // Enabled by default
    
    // Track if using run directory mode (separate JSON files per call)
    this._runDirectoryMode = false;
    this._runDirectory = null;
    this._callCounter = 0;
  }

  /**
   * Set a run-specific directory for LLM call logs.
   * When set, each LLM call will be saved as a separate JSON file
   * instead of being appended to a .jsonl file.
   * 
   * @param {string} runLLMCallsDir - The directory to save LLM call logs to
   */
  setRunDirectory(runLLMCallsDir) {
    this._runDirectoryMode = true;
    this._runDirectory = runLLMCallsDir;
    this.failuresDir = join(runLLMCallsDir, 'failures');
    
    try {
      mkdirSync(runLLMCallsDir, { recursive: true });
      mkdirSync(this.failuresDir, { recursive: true });
      this.initialized = true;
    } catch (err) {
      console.warn(`[LLMTracer] Could not create run LLM calls directory: ${err.message}`);
    }
  }

  /**
   * Initialize directories
   */
  async init() {
    if (!this.enabled || this.initialized) return;
    
    try {
      await mkdir(this.baseDir, { recursive: true });
      await mkdir(this.failuresDir, { recursive: true });
      this.initialized = true;
    } catch (err) {
      console.warn(`[LLMTracer] Failed to initialize directories: ${err.message}`);
      this.enabled = false; // Disable if we can't write
    }
  }

  /**
   * Generate a filename for an LLM call log
   * @param {string} step - The pipeline step name
   * @param {string} type - The event type (request, response, etc.)
   * @returns {string} The filename
   */
  _generateFilename(step, type) {
    this._callCounter++;
    const timestamp = Date.now();
    const stepSafe = (step || 'unknown').replace(/[^a-z0-9_-]/gi, '_');
    const typeSafe = (type || 'event').replace(/[^a-z0-9_-]/gi, '_');
    return `${String(this._callCounter).padStart(4, '0')}-${stepSafe}-${typeSafe}.json`;
  }

  /**
   * Log an LLM interaction event
   * @param {string} type - 'request', 'response', 'error', 'validation_failure'
   * @param {Object} payload - The data to log
   * @param {Object} metadata - Context (step, position, duration)
   */
  async logEvent(type, payload, metadata = {}) {
    if (!this.enabled) return;
    if (!this.initialized) await this.init();

    const entry = {
      timestamp: new Date().toISOString(),
      type,
      jobId: this.jobId,
      ...metadata,
      payload
    };

    try {
      if (this._runDirectoryMode && this._runDirectory) {
        // Save as separate JSON file
        const filename = this._generateFilename(metadata.step, type);
        const filePath = join(this._runDirectory, filename);
        await writeFile(filePath, JSON.stringify(entry, null, 2), 'utf8');
      } else {
        // Legacy: append to .jsonl file
        const { appendFile } = await import('fs/promises');
        const traceFile = join(this.baseDir, `${this.jobId}.jsonl`);
        await appendFile(traceFile, JSON.stringify(entry) + '\n', 'utf8');
      }
    } catch (err) {
      console.warn(`[LLMTracer] Write failed: ${err.message}`);
    }
  }

  /**
   * Capture a failure snapshot
   * Saves a standalone JSON file with full context for debugging.
   * 
   * @param {string} contextName - e.g., "PositionWriter-Validation"
   * @param {Error|Object} error - The error or validation issues
   * @param {Object} fullContext - The prompt, input, raw response, etc.
   * @returns {string} Path to the saved snapshot
   */
  async logFailure(contextName, error, fullContext) {
    if (!this.enabled) return;
    if (!this.initialized) await this.init();

    const timestamp = Date.now();
    const filename = `failure-${contextName}-${timestamp}.json`
      .replace(/[^a-z0-9_.-]/gi, '_'); // Sanitize
    
    const filePath = join(this.failuresDir, filename);

    const snapshot = {
      jobId: this.jobId,
      timestamp: new Date().toISOString(),
      context: contextName,
      error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
      data: fullContext
    };

    try {
      await writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
      
      // Also log this failure as an event
      await this.logEvent('failure_snapshot', {
        snapshotPath: filePath,
        errorSummary: snapshot.error.message || 'Validation Failure'
      }, { context: contextName });
      
      return filePath;
    } catch (err) {
      console.warn(`[LLMTracer] Snapshot failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Get the current output directory
   * @returns {string}
   */
  getDirectory() {
    return this._runDirectoryMode && this._runDirectory 
      ? this._runDirectory 
      : this.baseDir;
  }
}

// Singleton instance for global access if needed, though dependency injection is preferred
export const globalTracer = new LLMTracer();

