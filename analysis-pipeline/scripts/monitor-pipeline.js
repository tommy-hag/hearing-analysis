/**
 * Monitor pipeline progress in real-time
 * Usage: node scripts/monitor-pipeline.js [hearingId]
 */

import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const hearingId = process.argv[2] || 168;
const dbPath = join(__dirname, '../../data/app.sqlite');
const db = new Database(dbPath);

console.log(`Monitoring pipeline for hearing ${hearingId}...\n`);

// Find latest job
const latest = db.prepare(`
  SELECT job_id, status, progress, current_step, created_at, updated_at
  FROM analysis_jobs
  WHERE hearing_id = ?
  ORDER BY created_at DESC
  LIMIT 1
`).get(hearingId);

if (!latest) {
  console.log('No jobs found for this hearing.');
  process.exit(0);
}

console.log(`Job: ${latest.job_id}`);
console.log(`Status: ${latest.status}`);
console.log(`Progress: ${latest.progress}%`);
console.log(`Current Step: ${latest.current_step || 'N/A'}`);
console.log(`Started: ${new Date(latest.created_at).toLocaleString()}`);
console.log(`Last Update: ${new Date(latest.updated_at).toLocaleString()}`);
console.log('\n' + '='.repeat(80) + '\n');

// Show recent events
const events = db.prepare(`
  SELECT level, message, data_json, created_at
  FROM analysis_job_events
  WHERE job_id = ?
  ORDER BY created_at DESC
  LIMIT 20
`).all(latest.job_id);

console.log('Recent Events:');
events.reverse().forEach(event => {
  const time = new Date(event.created_at).toLocaleTimeString();
  const level = event.level.toUpperCase().padEnd(5);
  let msg = `[${time}] ${level} ${event.message}`;
  
  if (event.data_json) {
    try {
      const data = JSON.parse(event.data_json);
      if (data.duration) {
        msg += ` (${(data.duration / 1000).toFixed(1)}s)`;
      }
    } catch (e) {}
  }
  
  console.log(msg);
});

// Show step durations
console.log('\n' + '='.repeat(80) + '\n');
console.log('Step Durations:');

const artifacts = db.prepare(`
  SELECT step_name, created_at, artifact_data
  FROM analysis_job_artifacts
  WHERE job_id = ? AND artifact_type = 'output'
  ORDER BY created_at ASC
`).all(latest.job_id);

const stepTimes = [];
let prevTime = latest.created_at;

artifacts.forEach(art => {
  const stepTime = art.created_at - prevTime;
  stepTimes.push({
    step: art.step_name,
    duration: stepTime
  });
  
  try {
    const data = JSON.parse(art.artifact_data);
    if (data.duration) {
      stepTimes[stepTimes.length - 1].duration = data.duration;
    }
  } catch (e) {}
  
  prevTime = art.created_at;
});

stepTimes.forEach(st => {
  const durationSec = (st.duration / 1000).toFixed(1);
  const bar = '█'.repeat(Math.min(50, Math.round(st.duration / 100)));
  console.log(`${st.step.padEnd(25)} ${durationSec.padStart(6)}s ${bar}`);
});

const totalTime = stepTimes.reduce((sum, st) => sum + st.duration, 0);
console.log('\n' + '-'.repeat(80));
console.log(`Total: ${(totalTime / 1000).toFixed(1)}s`);

db.close();

