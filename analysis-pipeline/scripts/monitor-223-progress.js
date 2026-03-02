#!/usr/bin/env node

/**
 * Enhanced Progress Monitor for Case 223
 * 
 * Polls job status every 30 seconds, detects hangs, shows progress.
 * Usage: node scripts/monitor-223-progress.js
 */

import Database from 'better-sqlite3';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment config
dotenv.config({ path: join(__dirname, '../config/.env') });

const HEARING_ID = 223;
const POLL_INTERVAL_MS = 30000; // 30 seconds
const HANG_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// Use same path resolution as JobTracker
const dbPathRelative = process.env.DB_PATH || '../data/app.sqlite';
const dbPath = resolve(__dirname, '..', '..', dbPathRelative);

let lastUpdateTime = null;
let lastProgress = null;
let iterationCount = 0;

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

function clearScreen() {
  process.stdout.write('\x1b[2J\x1b[0f');
}

function printHeader(iteration) {
  console.log('═'.repeat(80));
  console.log(`  PIPELINE MONITOR - Hearing ${HEARING_ID} - Poll #${iteration}`);
  console.log(`  ${new Date().toLocaleString()}`);
  console.log('═'.repeat(80));
  console.log();
}

function checkForHang(job) {
  if (!lastUpdateTime) {
    lastUpdateTime = job.updated_at;
    lastProgress = job.progress;
    return null;
  }
  
  const timeSinceUpdate = Date.now() - job.updated_at;
  const progressChanged = job.progress !== lastProgress;
  
  if (progressChanged) {
    lastUpdateTime = job.updated_at;
    lastProgress = job.progress;
    return null;
  }
  
  if (timeSinceUpdate > HANG_THRESHOLD_MS && job.status === 'running') {
    return {
      duration: timeSinceUpdate,
      message: `⚠️  WARNING: No progress for ${formatDuration(timeSinceUpdate)}`
    };
  }
  
  return null;
}

function monitorJob() {
  const db = new Database(dbPath, { readonly: true });
  
  try {
    iterationCount++;
    clearScreen();
    printHeader(iterationCount);
    
    // Find latest job
    const job = db.prepare(`
      SELECT job_id, status, progress, current_step, created_at, updated_at
      FROM analysis_jobs
      WHERE hearing_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(HEARING_ID);
    
    if (!job) {
      console.log('❌ No job found for hearing 223.');
      console.log('\nWaiting for job to start...');
      return { continue: true };
    }
    
    // Show job status
    const elapsed = Date.now() - job.created_at;
    const timeSinceUpdate = Date.now() - job.updated_at;
    
    console.log('📊 JOB STATUS');
    console.log('─'.repeat(80));
    console.log(`  Job ID:        ${job.job_id}`);
    console.log(`  Status:        ${job.status.toUpperCase()}`);
    console.log(`  Progress:      ${job.progress}%`);
    console.log(`  Current Step:  ${job.current_step || 'N/A'}`);
    console.log(`  Elapsed:       ${formatDuration(elapsed)}`);
    console.log(`  Last Update:   ${formatDuration(timeSinceUpdate)} ago`);
    console.log();
    
    // Check for hang
    const hangStatus = checkForHang(job);
    if (hangStatus) {
      console.log('⚠️  HANG DETECTION');
      console.log('─'.repeat(80));
      console.log(`  ${hangStatus.message}`);
      console.log(`  Current step: ${job.current_step}`);
      console.log(`  Consider checking logs or restarting from checkpoint.`);
      console.log();
    }
    
    // Show recent events
    const events = db.prepare(`
      SELECT level, message, data_json, created_at
      FROM analysis_job_events
      WHERE job_id = ?
      ORDER BY created_at DESC
      LIMIT 15
    `).all(job.job_id);
    
    if (events.length > 0) {
      console.log('📝 RECENT EVENTS (last 15)');
      console.log('─'.repeat(80));
      events.reverse().forEach(event => {
        const time = new Date(event.created_at).toLocaleTimeString();
        const level = event.level.toUpperCase();
        const icon = level === 'ERROR' ? '❌' : level === 'WARN' ? '⚠️ ' : level === 'INFO' ? 'ℹ️ ' : '  ';
        let msg = `  ${icon} [${time}] ${event.message}`;
        
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
      console.log();
    }
    
    // Show completed steps
    const artifacts = db.prepare(`
      SELECT DISTINCT step_name, created_at
      FROM analysis_job_artifacts
      WHERE job_id = ? AND artifact_type = 'output'
      ORDER BY created_at ASC
    `).all(job.job_id);
    
    if (artifacts.length > 0) {
      console.log('✅ COMPLETED STEPS');
      console.log('─'.repeat(80));
      artifacts.forEach(art => {
        const stepTime = new Date(art.created_at).toLocaleTimeString();
        console.log(`  ✓ ${art.step_name.padEnd(30)} [${stepTime}]`);
      });
      console.log();
    }
    
    // Check if job is complete or failed
    if (job.status === 'completed') {
      console.log('═'.repeat(80));
      console.log('🎉 JOB COMPLETED SUCCESSFULLY!');
      console.log('═'.repeat(80));
      console.log();
      console.log(`Total time: ${formatDuration(elapsed)}`);
      console.log(`Completed steps: ${artifacts.length}`);
      console.log();
      console.log('Next step: Run evaluation script');
      console.log('  node scripts/evaluate-223-results.js');
      console.log();
      return { continue: false, success: true };
    }
    
    if (job.status === 'failed') {
      console.log('═'.repeat(80));
      console.log('❌ JOB FAILED');
      console.log('═'.repeat(80));
      console.log();
      
      // Show error details
      const errorEvents = db.prepare(`
        SELECT message, data_json, created_at
        FROM analysis_job_events
        WHERE job_id = ? AND level = 'error'
        ORDER BY created_at DESC
        LIMIT 5
      `).all(job.job_id);
      
      if (errorEvents.length > 0) {
        console.log('Error details:');
        errorEvents.reverse().forEach(event => {
          console.log(`  - ${event.message}`);
        });
        console.log();
      }
      
      console.log(`Last successful step: ${artifacts.length > 0 ? artifacts[artifacts.length - 1].step_name : 'none'}`);
      console.log(`Failed at step: ${job.current_step}`);
      console.log();
      console.log('To resume from checkpoint:');
      console.log(`  npm run pipeline:run -- 223 --resume=${job.current_step} --checkpoint=first-full-run --save-checkpoints --write`);
      console.log();
      return { continue: false, success: false };
    }
    
    // Continue monitoring
    console.log('─'.repeat(80));
    console.log(`Next poll in ${POLL_INTERVAL_MS / 1000} seconds...`);
    console.log('Press Ctrl+C to stop monitoring');
    console.log();
    
    return { continue: true };
    
  } catch (error) {
    console.error('Error monitoring job:', error);
    return { continue: true };
  } finally {
    db.close();
  }
}

async function main() {
  console.log('Starting pipeline monitor for hearing 223...');
  console.log('Polling every 30 seconds, hang detection enabled (5 min threshold)');
  console.log();
  
  // Initial check
  const result = monitorJob();
  
  if (!result.continue) {
    process.exit(result.success ? 0 : 1);
  }
  
  // Set up polling interval
  const interval = setInterval(() => {
    const result = monitorJob();
    
    if (!result.continue) {
      clearInterval(interval);
      process.exit(result.success ? 0 : 1);
    }
  }, POLL_INTERVAL_MS);
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\nMonitoring stopped by user.');
    clearInterval(interval);
    process.exit(0);
  });
}

main();

