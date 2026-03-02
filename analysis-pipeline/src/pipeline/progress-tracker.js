import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * ProgressTracker
 * 
 * Tracks and persists pipeline progress for monitoring long-running jobs.
 * Updates a progress.json file after each step completion.
 * 
 * Features:
 * - Real-time progress updates
 * - Step timing tracking
 * - Warnings/errors collection
 * - Data statistics
 */
export class ProgressTracker {
  constructor(options = {}) {
    this.runDir = options.runDir;
    this.hearingId = options.hearingId;
    this.label = options.label;
    this.startTime = Date.now();
    
    // Progress state
    this.state = {
      status: 'running',
      hearingId: this.hearingId,
      label: this.label,
      startTime: new Date().toISOString(),
      currentStep: null,
      completedSteps: [],
      totalSteps: 0,
      progress: 0,
      lastUpdate: null,
      
      // Timing
      stepTimings: {},
      estimatedTimeRemaining: null,
      
      // Warnings and errors
      warnings: [],
      errors: [],
      
      // Data statistics
      dataStats: {
        responseCount: 0,
        materialCount: 0,
        chunkCount: 0,
        themeCount: 0,
        positionCount: 0,
        avgResponseLength: 0
      },
      
      // Validation results
      validationResults: {
        citationValidation: null,
        formatValidation: null,
        qualityValidation: null,
        coverageValidation: null
      }
    };
  }

  /**
   * Set total number of steps
   */
  setTotalSteps(total) {
    this.state.totalSteps = total;
    this._save();
  }

  /**
   * Start a new step
   */
  startStep(stepName) {
    this.state.currentStep = stepName;
    this.state.stepTimings[stepName] = {
      startTime: Date.now(),
      endTime: null,
      duration: null
    };
    this.state.lastUpdate = new Date().toISOString();
    this._save();
  }

  /**
   * Complete current step
   */
  completeStep(stepName, result = null) {
    const timing = this.state.stepTimings[stepName];
    if (timing) {
      timing.endTime = Date.now();
      timing.duration = (timing.endTime - timing.startTime) / 1000; // seconds
    }
    
    if (!this.state.completedSteps.includes(stepName)) {
      this.state.completedSteps.push(stepName);
    }
    
    // Calculate progress percentage
    this.state.progress = Math.round(
      (this.state.completedSteps.length / this.state.totalSteps) * 100
    );
    
    // Estimate remaining time based on average step duration
    this._estimateRemainingTime();
    
    this.state.lastUpdate = new Date().toISOString();
    this._save();
  }

  /**
   * Add a warning
   */
  addWarning(warning) {
    this.state.warnings.push({
      timestamp: new Date().toISOString(),
      step: this.state.currentStep,
      ...warning
    });
    this._save();
  }

  /**
   * Add an error
   */
  addError(error) {
    this.state.errors.push({
      timestamp: new Date().toISOString(),
      step: this.state.currentStep,
      message: error.message || String(error),
      stack: error.stack
    });
    this._save();
  }

  /**
   * Update data statistics
   */
  updateDataStats(stats) {
    this.state.dataStats = {
      ...this.state.dataStats,
      ...stats
    };
    this._save();
  }

  /**
   * Update validation results
   */
  updateValidation(type, result) {
    this.state.validationResults[type] = {
      timestamp: new Date().toISOString(),
      valid: result.valid,
      errorCount: result.errorCount || result.errors?.length || 0,
      warningCount: result.warningCount || result.warnings?.length || 0,
      summary: result.summary || null
    };
    this._save();
  }

  /**
   * Mark pipeline as completed
   */
  complete() {
    this.state.status = 'completed';
    this.state.endTime = new Date().toISOString();
    this.state.totalDuration = (Date.now() - this.startTime) / 1000;
    this.state.progress = 100;
    this._save();
  }

  /**
   * Mark pipeline as failed
   */
  fail(error) {
    this.state.status = 'failed';
    this.state.endTime = new Date().toISOString();
    this.state.totalDuration = (Date.now() - this.startTime) / 1000;
    this.addError(error);
    this._save();
  }

  /**
   * Get current state
   */
  getState() {
    return { ...this.state };
  }

  /**
   * Estimate remaining time
   */
  _estimateRemainingTime() {
    const completedCount = this.state.completedSteps.length;
    if (completedCount === 0) {
      this.state.estimatedTimeRemaining = null;
      return;
    }

    // Calculate average duration of completed steps
    const durations = Object.values(this.state.stepTimings)
      .filter(t => t.duration !== null)
      .map(t => t.duration);
    
    if (durations.length === 0) {
      this.state.estimatedTimeRemaining = null;
      return;
    }

    const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
    const remainingSteps = this.state.totalSteps - completedCount;
    const estimatedSeconds = avgDuration * remainingSteps;

    this.state.estimatedTimeRemaining = this._formatDuration(estimatedSeconds);
  }

  /**
   * Format duration in human readable format
   */
  _formatDuration(seconds) {
    if (!seconds || !Number.isFinite(seconds)) return null;
    
    if (seconds < 60) {
      return `${Math.round(seconds)}s`;
    } else if (seconds < 3600) {
      const mins = Math.floor(seconds / 60);
      const secs = Math.round(seconds % 60);
      return `${mins}m ${secs}s`;
    } else {
      const hours = Math.floor(seconds / 3600);
      const mins = Math.floor((seconds % 3600) / 60);
      return `${hours}h ${mins}m`;
    }
  }

  /**
   * Save state to progress.json
   */
  _save() {
    if (!this.runDir) return;
    
    try {
      const progressPath = join(this.runDir, 'progress.json');
      writeFileSync(progressPath, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (err) {
      // Silently fail - don't crash pipeline for progress tracking
    }
  }
}

