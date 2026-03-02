/**
 * View artifacts from a pipeline run
 * Usage: node scripts/view-artifacts.js [jobId]
 */

import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Connect to database
const dbPath = join(__dirname, '../../data/app.sqlite');
const db = new Database(dbPath);

// Get job ID from args or find latest
let jobId = process.argv[2];

if (!jobId) {
  // Find latest job for hearing 168
  const latest = db.prepare(`
    SELECT job_id, hearing_id, status, created_at
    FROM analysis_jobs
    WHERE hearing_id = 168
    ORDER BY created_at DESC
    LIMIT 1
  `).get();
  
  if (latest) {
    jobId = latest.job_id;
    console.log(`Using latest job: ${jobId}`);
    console.log(`Status: ${latest.status}, Created: ${new Date(latest.created_at).toISOString()}\n`);
  } else {
    console.error('No jobs found for hearing 168');
    process.exit(1);
  }
}

// Get job status
const job = db.prepare('SELECT * FROM analysis_jobs WHERE job_id = ?').get(jobId);
if (!job) {
  console.error(`Job ${jobId} not found`);
  process.exit(1);
}

console.log('='.repeat(80));
console.log(`Job: ${jobId}`);
console.log(`Hearing: ${job.hearing_id}`);
console.log(`Status: ${job.status}`);
console.log(`Progress: ${job.progress}%`);
console.log(`Current Step: ${job.current_step || 'N/A'}`);
console.log(`Created: ${new Date(job.created_at).toISOString()}`);
console.log(`Updated: ${new Date(job.updated_at).toISOString()}`);
if (job.completed_at) {
  console.log(`Completed: ${new Date(job.completed_at).toISOString()}`);
}
if (job.error) {
  console.log(`Error: ${job.error}`);
}
console.log('='.repeat(80));
console.log();

// List all steps
const artifacts = db.prepare(`
  SELECT step_name, artifact_type, created_at
  FROM analysis_job_artifacts
  WHERE job_id = ?
  ORDER BY created_at ASC
`).all(jobId);

console.log('Pipeline Steps:');
console.log('-'.repeat(80));
artifacts.forEach((art, idx) => {
  const time = new Date(art.created_at).toISOString();
  console.log(`${idx + 1}. ${art.step_name} (${art.artifact_type}) - ${time}`);
});
console.log('-'.repeat(80));
console.log();

// Show events
const events = db.prepare(`
  SELECT level, message, data_json, created_at
  FROM analysis_job_events
  WHERE job_id = ?
  ORDER BY created_at ASC
  LIMIT 50
`).all(jobId);

console.log('Recent Events:');
console.log('-'.repeat(80));
events.forEach(event => {
  const time = new Date(event.created_at).toISOString();
  const level = event.level.toUpperCase().padEnd(5);
  console.log(`[${time}] ${level} ${event.message}`);
  if (event.data_json) {
    try {
      const data = JSON.parse(event.data_json);
      if (Object.keys(data).length > 0) {
        console.log(`         Data: ${JSON.stringify(data)}`);
      }
    } catch (e) {}
  }
});
console.log('-'.repeat(80));
console.log();

// Show artifact files
const artifactsDir = join(__dirname, '../output/debug-reports');
try {
  const files = readdirSync(artifactsDir)
    .filter(f => f.startsWith(jobId))
    .sort();
  
  if (files.length > 0) {
    console.log('Artifact Files:');
    console.log('-'.repeat(80));
    files.forEach(file => {
      const filePath = join(artifactsDir, file);
      const stats = readFileSync(filePath, 'utf-8');
      const size = (stats.length / 1024).toFixed(2);
      console.log(`  ${file} (${size} KB)`);
    });
    console.log('-'.repeat(80));
    console.log();
    console.log(`To view an artifact: cat output/debug-reports/${files[0]}`);
  }
} catch (e) {
  console.log('Artifacts directory not found or empty');
}

db.close();

