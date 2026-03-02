import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * CheckpointManager
 *
 * Handles saving and loading raw pipeline artifacts so that
 * developers can resume execution from intermediate steps without
 * recomputing the entire pipeline. Intended to support "Jupyter-style"
 * iterative development workflows.
 * 
 * When used with RunDirectoryManager, checkpoints are saved to:
 *   output/runs/{hearingId}/{label}/checkpoints/
 * 
 * When used standalone (legacy mode), checkpoints are saved to:
 *   output/checkpoints/{hearingId}/{label}/
 */
export class CheckpointManager {
  /**
   * @param {Object} options
   * @param {string} [options.checkpointDir] - Base directory for checkpoints
   */
  constructor(options = {}) {
    const defaultDir = join(__dirname, '../../output/checkpoints');
    this.baseDir = options.checkpointDir
      || process.env.PIPELINE_CHECKPOINT_DIR
      || defaultDir;

    // Track if using run directory mode (flat structure)
    this._runDirectoryMode = false;
    this._runDirectory = null;

    // Lazy-init legacy base directory to avoid creating unused folders
    this._baseDirInitialized = false;
  }

  /**
   * Ensure the legacy base directory exists (only when actually needed)
   * @private
   */
  _ensureBaseDir() {
    if (this._baseDirInitialized) return;
    mkdirSync(this.baseDir, { recursive: true });
    this._baseDirInitialized = true;
  }

  /**
   * Set a run-specific directory for checkpoints.
   * When set, checkpoints will be saved directly to this directory
   * (flat structure) instead of the hierarchical {hearingId}/{label}/ structure.
   * 
   * @param {string} runCheckpointsDir - The directory to save checkpoints to
   */
  setRunDirectory(runCheckpointsDir) {
    this._runDirectoryMode = true;
    this._runDirectory = runCheckpointsDir;
    mkdirSync(runCheckpointsDir, { recursive: true });
  }

  /**
   * Build directory path for a given hearing/label combination.
   */
  directoryFor(hearingId, label = 'default') {
    // Use run directory if set (flat structure)
    if (this._runDirectoryMode && this._runDirectory) {
      return this._runDirectory;
    }
    
    // Legacy hierarchical structure
    this._ensureBaseDir();
    const dir = join(this.baseDir, String(hearingId), label);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Build file path for a checkpointed step.
   */
  pathFor(hearingId, label, stepName) {
    return join(this.directoryFor(hearingId, label), `${stepName}.json`);
  }

  /**
   * Persist raw step output to disk.
   * @param {number|string} hearingId
   * @param {string} stepName
   * @param {*} data
   * @param {string} [label='default']
   */
  save(hearingId, stepName, data, label = 'default') {
    const filePath = this.pathFor(hearingId, label, stepName);
    const serialized = JSON.stringify(data, null, 2);
    writeFileSync(filePath, serialized, 'utf-8');
  }

  /**
   * Load raw step output from disk.
   * Checks multiple locations: run directory structure, then legacy structure.
   * @param {number|string} hearingId
   * @param {string} stepName
   * @param {string} [label='default']
   * @returns {*|null}
   */
  load(hearingId, stepName, label = 'default') {
    // Build list of paths to check (in order of priority)
    const pathsToCheck = [];
    
    // 1. If in run directory mode and label matches current run, use that
    if (this._runDirectoryMode && this._runDirectory) {
      pathsToCheck.push(join(this._runDirectory, `${stepName}.json`));
    }
    
    // 2. Check run directory structure for the specified label
    // output/runs/{hearingId}/{label}/checkpoints/{stepName}.json
    const runDirPath = join(__dirname, '../../output/runs', String(hearingId), label, 'checkpoints', `${stepName}.json`);
    pathsToCheck.push(runDirPath);
    
    // 3. Check legacy structure
    // output/checkpoints/{hearingId}/{label}/{stepName}.json
    const legacyPath = join(this.baseDir, String(hearingId), label, `${stepName}.json`);
    pathsToCheck.push(legacyPath);
    
    // Try each path in order
    for (const filePath of pathsToCheck) {
      if (existsSync(filePath)) {
        const raw = readFileSync(filePath, 'utf-8');
        return JSON.parse(raw);
      }
    }
    
    return null;
  }

  /**
   * Return a list of step files that exist for a hearing/label.
   * @param {number|string} hearingId
   * @param {string} [label='default']
   * @returns {string[]} e.g. ['load-data', 'chunking']
   */
  listAvailableSteps(hearingId, label = 'default') {
    const dir = this.directoryFor(hearingId, label);
    if (!existsSync(dir)) {
      return [];
    }

    return readdirSync(dir)
      .filter(file => file.endsWith('.json'))
      .map(file => file.replace(/\.json$/, ''))
      .sort();
  }

  /**
   * Get the current checkpoint directory path
   * @returns {string}
   */
  getDirectory() {
    return this._runDirectoryMode && this._runDirectory 
      ? this._runDirectory 
      : this.baseDir;
  }

  /**
   * Copy checkpoints from a source label to the current run directory.
   * Used when resuming from a baseline - ensures the target run is self-contained.
   * 
   * @param {number|string} hearingId
   * @param {string} sourceLabel - Source checkpoint label to copy from
   * @param {string[]} stepNames - List of step names to copy
   * @returns {{ copied: string[], skipped: string[], failed: string[] }}
   */
  copyFromBaseline(hearingId, sourceLabel, stepNames) {
    const result = { copied: [], skipped: [], failed: [] };
    
    if (!this._runDirectoryMode || !this._runDirectory) {
      console.warn('[CheckpointManager] copyFromBaseline requires run directory mode');
      return result;
    }

    for (const stepName of stepNames) {
      try {
        // Check if already exists in target
        const targetPath = join(this._runDirectory, `${stepName}.json`);
        if (existsSync(targetPath)) {
          result.skipped.push(stepName);
          continue;
        }

        // Load from source (uses the load() method which checks multiple locations)
        const data = this.load(hearingId, stepName, sourceLabel);
        
        if (data === null || data === undefined) {
          result.failed.push(stepName);
          continue;
        }

        // Save to current run directory
        const serialized = JSON.stringify(data, null, 2);
        writeFileSync(targetPath, serialized, 'utf-8');
        result.copied.push(stepName);
        
      } catch (error) {
        console.warn(`[CheckpointManager] Failed to copy ${stepName}: ${error.message}`);
        result.failed.push(stepName);
      }
    }

    return result;
  }
}


