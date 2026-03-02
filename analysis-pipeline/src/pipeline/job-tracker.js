/**
 * Job Tracker
 * 
 * Tracks job status, progress, and artifacts in SQLite.
 * 
 * When used with RunDirectoryManager, debug files are saved to:
 *   output/runs/{hearingId}/{label}/debug/
 * 
 * When used standalone (legacy mode), debug files are saved to:
 *   output/debug-reports/
 */

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../../config/.env') });

export class JobTracker {
  constructor(options = {}) {
    const dbPath = options.dbPath || process.env.DB_PATH || '../data/app.sqlite';
    const artifactsDir = options.artifactsDir
      || process.env.DEBUG_REPORTS_DIR
      || join(__dirname, '../../output/debug-reports');

    this.artifactsDir = artifactsDir;
    this._artifactsDirInitialized = false;
    const absolutePath = resolve(__dirname, '../../..', dbPath);
    
    try {
      this.db = new Database(absolutePath);
      this.initTables();
    } catch (error) {
      throw new Error(`Failed to connect to database: ${error.message}`);
    }
  }

  /**
   * Set a run-specific directory for debug artifacts.
   * When set, debug files will be saved to this directory instead of
   * the default output/debug-reports/ directory.
   * 
   * @param {string} runDebugDir - The directory to save debug artifacts to
   */
  setRunDirectory(runDebugDir) {
    this.artifactsDir = runDebugDir;
    this._artifactsDirInitialized = false;
    this._ensureArtifactsDir();
  }

  /**
   * Ensure artifacts directory exists (lazy to avoid creating legacy folders)
   * @private
   */
  _ensureArtifactsDir() {
    if (this._artifactsDirInitialized) return;
    try {
      mkdirSync(this.artifactsDir, { recursive: true });
      this._artifactsDirInitialized = true;
    } catch (error) {
      console.warn(`[JobTracker] Could not create artifacts directory: ${error.message}`);
    }
  }

  /**
   * Initialize job tracking tables
   */
  initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS analysis_jobs(
        job_id TEXT PRIMARY KEY,
        hearing_id INTEGER,
        status TEXT,
        progress INTEGER,
        current_step TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        completed_at INTEGER,
        error TEXT,
        config_json TEXT
      );

      CREATE TABLE IF NOT EXISTS analysis_job_artifacts(
        artifact_id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT,
        step_name TEXT,
        artifact_type TEXT,
        artifact_data TEXT,
        created_at INTEGER,
        FOREIGN KEY(job_id) REFERENCES analysis_jobs(job_id)
      );

      CREATE TABLE IF NOT EXISTS analysis_job_events(
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT,
        level TEXT,
        message TEXT,
        data_json TEXT,
        created_at INTEGER,
        FOREIGN KEY(job_id) REFERENCES analysis_jobs(job_id)
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_hearing ON analysis_jobs(hearing_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON analysis_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_artifacts_job ON analysis_job_artifacts(job_id, step_name);
      CREATE INDEX IF NOT EXISTS idx_events_job ON analysis_job_events(job_id, created_at);
    `);
  }

  /**
   * Create a new job
   */
  createJob(hearingId, config = {}) {
    const jobId = `job_${hearingId}_${Date.now()}`;
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO analysis_jobs(job_id, hearing_id, status, progress, current_step, created_at, updated_at, config_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      jobId,
      hearingId,
      'created',
      0,
      'initializing',
      now,
      now,
      JSON.stringify(config)
    );

    return jobId;
  }

  /**
   * Update job status
   */
  updateJob(jobId, updates) {
    const allowedFields = ['status', 'progress', 'current_step', 'error'];
    const setParts = [];
    const values = [];

    Object.keys(updates).forEach(key => {
      if (allowedFields.includes(key)) {
        setParts.push(`${key} = ?`);
        values.push(updates[key]);
      }
    });

    if (setParts.length === 0) return;

    setParts.push('updated_at = ?');
    values.push(Date.now());

    if (updates.status === 'completed' || updates.status === 'failed') {
      setParts.push('completed_at = ?');
      values.push(Date.now());
    }

    values.push(jobId);

    this.db.prepare(`
      UPDATE analysis_jobs
      SET ${setParts.join(', ')}
      WHERE job_id = ?
    `).run(...values);
  }

  /**
   * Save artifact for a step
   */
  saveArtifact(jobId, stepName, artifactType, data) {
    const now = Date.now();
    this._ensureArtifactsDir();
    
    // Save to database
    this.db.prepare(`
      INSERT INTO analysis_job_artifacts(job_id, step_name, artifact_type, artifact_data, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      jobId,
      stepName,
      artifactType,
      JSON.stringify(data),
      now
    );

    // Also save to file for easier inspection
    // Use simpler filename when in run directory (files are already in run-specific folder)
    try {
      const filename = `${stepName}.json`;
      const artifactPath = join(this.artifactsDir, filename);
      writeFileSync(artifactPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      console.warn(`[JobTracker] Could not save artifact file: ${error.message}`);
    }
  }

  /**
   * Get artifact for a step
   */
  getArtifact(jobId, stepName) {
    const row = this.db.prepare(`
      SELECT artifact_data
      FROM analysis_job_artifacts
      WHERE job_id = ? AND step_name = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(jobId, stepName);

    if (!row) return null;

    try {
      return JSON.parse(row.artifact_data);
    } catch (error) {
      console.error(`[JobTracker] Failed to parse artifact: ${error.message}`);
      return null;
    }
  }

  /**
   * Log event
   */
  logEvent(jobId, level, message, data = null) {
    this.db.prepare(`
      INSERT INTO analysis_job_events(job_id, level, message, data_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      jobId,
      level,
      message,
      data ? JSON.stringify(data) : null,
      Date.now()
    );
  }

  /**
   * Get job status
   */
  getJobStatus(jobId) {
    return this.db.prepare(`
      SELECT * FROM analysis_jobs WHERE job_id = ?
    `).get(jobId);
  }

  /**
   * Get job events
   */
  getJobEvents(jobId, limit = 100) {
    return this.db.prepare(`
      SELECT * FROM analysis_job_events
      WHERE job_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(jobId, limit);
  }

  /**
   * List all artifacts for a job
   */
  listArtifacts(jobId) {
    return this.db.prepare(`
      SELECT step_name, artifact_type, created_at
      FROM analysis_job_artifacts
      WHERE job_id = ?
      ORDER BY created_at ASC
    `).all(jobId);
  }

  /**
   * Close database connection
   */
  close() {
    if (this.db) {
      this.db.close();
    }
  }
}




