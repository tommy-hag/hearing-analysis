#!/usr/bin/env node

/**
 * Intelligent Monitor for Hearing 223 Test
 * 
 * Monitors pipeline progress, detects errors, and can resume from checkpoints.
 * Does NOT automatically fix errors - only detects and reports with resume suggestions.
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HEARING_ID = 223;
const CHECKPOINT_BASE = join(__dirname, `../output/checkpoints/${HEARING_ID}`);

// Step order for resume detection
const STEP_ORDER = [
  'load-data',
  'material-summary',
  'edge-case-screening',
  'enrich-responses',
  'chunking',
  'embedding',
  'calculate-dynamic-parameters',
  'micro-summarize',
  'theme-mapping',
  'aggregate',
  'consolidate-positions',
  'validate-positions',
  'sort-positions',
  'extract-citations',
  'hybrid-position-writing',
  'validate-coverage',
  'considerations',
  'format-output',
  'build-docx'
];

function findLatestLogFile() {
  const logDir = join(__dirname, '..');
  if (!existsSync(logDir)) return null;
  
  try {
    const files = readdirSync(logDir)
      .filter(f => f.startsWith('pipeline-223-test-') && f.endsWith('.log'))
      .map(f => join(logDir, f))
      .filter(f => existsSync(f));
    
    if (files.length === 0) return null;
    
    // Sort by modification time, newest first
    files.sort((a, b) => statSync(b).mtime - statSync(a).mtime);
    return files[0];
  } catch (error) {
    return null;
  }
}

function findLatestCheckpoint() {
  if (!existsSync(CHECKPOINT_BASE)) return null;
  
  try {
    const checkpoints = readdirSync(CHECKPOINT_BASE)
      .filter(d => d.startsWith('test-med-docx-'))
      .map(d => join(CHECKPOINT_BASE, d))
      .filter(d => {
        try {
          return statSync(d).isDirectory();
        } catch {
          return false;
        }
      });
    
    if (checkpoints.length === 0) return null;
    
    // Sort by modification time, newest first
    checkpoints.sort((a, b) => statSync(b).mtime - statSync(a).mtime);
    return checkpoints[0];
  } catch (error) {
    return null;
  }
}

function getLastCompletedStep(checkpointDir) {
  if (!checkpointDir || !existsSync(checkpointDir)) return null;
  
  // Check which steps have checkpoints
  let lastStep = null;
  let lastIndex = -1;
  
  for (let i = 0; i < STEP_ORDER.length; i++) {
    const step = STEP_ORDER[i];
    const checkpointFile = join(checkpointDir, `${step}.json`);
    if (existsSync(checkpointFile)) {
      lastStep = step;
      lastIndex = i;
    }
  }
  
  return { step: lastStep, index: lastIndex };
}

function checkForErrors(logFile) {
  if (!logFile || !existsSync(logFile)) return null;
  
  const logContent = readFileSync(logFile, 'utf-8');
  const lines = logContent.split('\n');
  
  const errors = [];
  const errorPatterns = [
    /Error:/i,
    /Failed/i,
    /Exception:/i,
    /✗.*failed/i,
    /Pipeline run failed/i,
    /ECONNREFUSED/i,
    /ETIMEDOUT/i,
    /timeout/i,
    /Rate limit/i
  ];
  
  // Check last 100 lines for errors
  const recentLines = lines.slice(-100);
  recentLines.forEach((line, idx) => {
    for (const pattern of errorPatterns) {
      if (pattern.test(line)) {
        errors.push({
          line: line.trim(),
          lineNumber: lines.length - 100 + idx,
          context: recentLines.slice(Math.max(0, idx - 2), idx + 3).join('\n')
        });
        break;
      }
    }
  });
  
  return errors.length > 0 ? errors : null;
}

function checkProcessStatus() {
  return new Promise((resolve) => {
    const check = spawn('pgrep', ['-f', 'test-223-with-eval'], { stdio: 'pipe' });
    let output = '';
    
    check.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    check.on('close', (code) => {
      const pids = output.trim().split('\n').filter(Boolean);
      resolve({
        running: pids.length > 0,
        pids: pids
      });
    });
    
    check.on('error', () => {
      resolve({ running: false, pids: [] });
    });
  });
}

function getResumeCommand(checkpointLabel, lastStep) {
  if (!lastStep || lastStep.index < 0) return null;
  
  // Find next step to resume from
  const nextStepIndex = lastStep.index + 1;
  if (nextStepIndex >= STEP_ORDER.length) return null;
  
  const resumeStep = STEP_ORDER[nextStepIndex];
  
  return `npm run pipeline:run -- ${HEARING_ID} --resume=${resumeStep} --checkpoint=${checkpointLabel} --save-checkpoints --write`;
}

async function monitor() {
  console.log('═'.repeat(80));
  console.log('  HEARING 223 TEST MONITOR');
  console.log('═'.repeat(80));
  console.log('');
  
  // Check process status
  const processStatus = await checkProcessStatus();
  console.log(`Process Status: ${processStatus.running ? '✅ Running' : '❌ Not Running'}`);
  if (processStatus.pids.length > 0) {
    console.log(`  PIDs: ${processStatus.pids.join(', ')}`);
  }
  console.log('');
  
  // Find latest log
  const logFile = findLatestLogFile();
  if (logFile) {
    console.log(`📄 Log File: ${logFile}`);
    const logStats = statSync(logFile);
    console.log(`  Last modified: ${logStats.mtime.toISOString()}`);
    console.log(`  Size: ${(logStats.size / 1024).toFixed(1)} KB`);
    console.log('');
    
    // Check for errors
    const errors = checkForErrors(logFile);
    if (errors) {
      console.log('⚠️  ERRORS DETECTED:');
      console.log('');
      errors.slice(0, 5).forEach((err, idx) => {
        console.log(`Error ${idx + 1} (line ${err.lineNumber}):`);
        console.log(`  ${err.line}`);
        console.log('');
      });
      
      if (errors.length > 5) {
        console.log(`  ... and ${errors.length - 5} more errors`);
        console.log('');
      }
    } else {
      console.log('✅ No errors detected in recent log');
      console.log('');
    }
  } else {
    console.log('⚠️  No log file found');
    console.log('');
  }
  
  // Check checkpoint status
  const checkpointDir = findLatestCheckpoint();
  if (checkpointDir) {
    const checkpointLabel = checkpointDir.split('/').pop();
    console.log(`📁 Latest Checkpoint: ${checkpointLabel}`);
    
    const lastStep = getLastCompletedStep(checkpointDir);
    if (lastStep.step) {
      const stepIndex = lastStep.index + 1;
      console.log(`  Last completed step: ${lastStep.step} (${stepIndex}/${STEP_ORDER.length})`);
      
      if (stepIndex < STEP_ORDER.length) {
        const nextStep = STEP_ORDER[stepIndex];
        console.log(`  Next step: ${nextStep}`);
      } else {
        console.log(`  ✅ All steps completed!`);
      }
      console.log('');
      
      // Show resume command if needed
      if (!processStatus.running && stepIndex < STEP_ORDER.length) {
        const resumeCmd = getResumeCommand(checkpointLabel, lastStep);
        if (resumeCmd) {
          console.log('💡 Resume Command:');
          console.log(`  ${resumeCmd}`);
          console.log('');
        }
      }
    } else {
      console.log('  ⚠️  No completed steps found');
      console.log('');
    }
  } else {
    console.log('⚠️  No checkpoint directory found');
    console.log('');
  }
  
  // Show recent log tail
  if (logFile) {
    console.log('═'.repeat(80));
    console.log('Recent Log Output (last 15 lines):');
    console.log('═'.repeat(80));
    const logContent = readFileSync(logFile, 'utf-8');
    const lines = logContent.split('\n');
    lines.slice(-15).forEach(line => {
      if (line.trim()) console.log(line);
    });
    console.log('═'.repeat(80));
  }
  
  // Summary
  console.log('');
  console.log('Summary:');
  if (processStatus.running) {
    console.log('  ✅ Pipeline is running');
  } else if (checkpointDir) {
    const lastStep = getLastCompletedStep(checkpointDir);
    if (lastStep.step && lastStep.index < STEP_ORDER.length - 1) {
      console.log('  ⚠️  Pipeline stopped - can resume from checkpoint');
      const resumeCmd = getResumeCommand(checkpointDir.split('/').pop(), lastStep);
      if (resumeCmd) {
        console.log(`  💡 Run: ${resumeCmd}`);
      }
    } else {
      console.log('  ✅ Pipeline completed or no progress to resume');
    }
  } else {
    console.log('  ❌ No pipeline process or checkpoint found');
  }
  console.log('');
}

// Run monitor
monitor().catch(error => {
  console.error('Monitor error:', error);
  process.exit(1);
});

