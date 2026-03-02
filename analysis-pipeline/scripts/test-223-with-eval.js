#!/usr/bin/env node

/**
 * Test Runner for Hearing 223 with Logging and Evaluation
 * 
 * Runs the full pipeline with comprehensive logging, timing, and error handling.
 * After completion, runs deepeval evaluation.
 */

import { spawn } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { estimatePipelineCosts, formatCostReport } from './cost-tracker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HEARING_ID = 223;
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
const CHECKPOINT_LABEL = `test-med-docx-${TIMESTAMP}`;
const LOG_FILE = join(__dirname, `../pipeline-223-test-${TIMESTAMP}.log`);
const SUMMARY_FILE = join(__dirname, `../output/pipeline-223-test-summary.md`);

// Ensure output directory exists
mkdirSync(join(__dirname, '../output'), { recursive: true });

// Track timing
const timings = {
  startTime: Date.now(),
  stepTimings: {},
  endTime: null,
  totalDuration: null
};

// Track errors
const errors = [];

function log(message, level = 'info') {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
  
  // Write to log file
  writeFileSync(LOG_FILE, logLine, { flag: 'a' });
  
  // Also output to console
  if (level === 'error') {
    console.error(`[${timestamp}] ${message}`);
  } else {
    console.log(`[${timestamp}] ${message}`);
  }
}

function logStepStart(stepName) {
  timings.stepTimings[stepName] = { start: Date.now() };
  log(`Starting step: ${stepName}`, 'info');
}

function logStepEnd(stepName) {
  if (timings.stepTimings[stepName]) {
    timings.stepTimings[stepName].end = Date.now();
    const duration = timings.stepTimings[stepName].end - timings.stepTimings[stepName].start;
    const durationSec = (duration / 1000).toFixed(1);
    log(`Completed step: ${stepName} (${durationSec}s)`, 'info');
  }
}

function logError(error, context = '') {
  const errorMsg = context ? `${context}: ${error.message}` : error.message;
  errors.push({
    timestamp: new Date().toISOString(),
    context,
    message: error.message,
    stack: error.stack
  });
  log(errorMsg, 'error');
  if (error.stack) {
    log(`Stack trace: ${error.stack}`, 'error');
  }
}

async function runPipeline() {
  return new Promise((resolve, reject) => {
    log('═'.repeat(80));
    log('Starting Pipeline Test for Hearing 223');
    log('═'.repeat(80));
    log(`Checkpoint label: ${CHECKPOINT_LABEL}`);
    log(`Log file: ${LOG_FILE}`);
    log('');

    const pipelineScript = join(__dirname, 'run-pipeline.js');
    const args = [
      String(HEARING_ID),
      '--save-checkpoints',
      `--checkpoint=${CHECKPOINT_LABEL}`,
      '--write'
    ];

    log(`Executing: node ${pipelineScript} ${args.join(' ')}`);
    log('');

    const child = spawn('node', [pipelineScript, ...args], {
      cwd: join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let currentStep = null;

    // Track step progress from output
    child.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      
      // Write to log file
      writeFileSync(LOG_FILE, text, { flag: 'a' });
      
      // Parse step information
      const stepMatch = text.match(/\[Pipeline\]\s+(.+?)\s*\.\.\./);
      if (stepMatch) {
        const stepName = stepMatch[1].trim();
        if (currentStep && currentStep !== stepName) {
          logStepEnd(currentStep);
        }
        currentStep = stepName;
        logStepStart(stepName);
      }
      
      // Check for completion
      if (text.includes('Pipeline completed successfully')) {
        if (currentStep) {
          logStepEnd(currentStep);
        }
      }
      
      // Output to console (without timestamps to avoid duplication)
      process.stdout.write(text);
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      
      // Write to log file
      writeFileSync(LOG_FILE, text, { flag: 'a' });
      
      // Check for errors
      if (text.includes('Error') || text.includes('error') || text.includes('Failed')) {
        log(`Pipeline error output: ${text.trim()}`, 'error');
      }
      
      // Output to console
      process.stderr.write(text);
    });

    child.on('close', (code) => {
      if (currentStep) {
        logStepEnd(currentStep);
      }
      
      if (code === 0) {
        log('');
        log('═'.repeat(80));
        log('Pipeline completed successfully');
        log('═'.repeat(80));
        resolve({ stdout, stderr, code });
      } else {
        log('');
        log('═'.repeat(80));
        log(`Pipeline failed with exit code ${code}`);
        log('═'.repeat(80));
        log(`Last stdout: ${stdout.slice(-500)}`);
        log(`Last stderr: ${stderr.slice(-500)}`);
        reject(new Error(`Pipeline exited with code ${code}`));
      }
    });

    child.on('error', (error) => {
      logError(error, 'Pipeline spawn error');
      reject(error);
    });
  });
}

async function runDeepeval() {
  log('');
  log('═'.repeat(80));
  log('Starting Deepeval Evaluation');
  log('═'.repeat(80));
  log('');

  return new Promise((resolve, reject) => {
    const evalScript = join(__dirname, '../tests/evaluation/test_hearing_223.py');
    
    if (!existsSync(evalScript)) {
      log('Deepeval script not found, skipping evaluation', 'warn');
      resolve(null);
      return;
    }

    log(`Executing: python3 ${evalScript}`);
    log('');

    const child = spawn('python3', [evalScript], {
      cwd: join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONPATH: join(__dirname, '../venv/lib/python3.12/site-packages')
      }
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      writeFileSync(LOG_FILE, text, { flag: 'a' });
      process.stdout.write(text);
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      writeFileSync(LOG_FILE, text, { flag: 'a' });
      process.stderr.write(text);
    });

    child.on('close', (code) => {
      if (code === 0) {
        log('');
        log('Deepeval evaluation completed successfully');
        log('');
        resolve({ stdout, stderr, code });
      } else {
        log(`Deepeval evaluation failed with exit code ${code}`, 'warn');
        log(`stderr: ${stderr.slice(-500)}`, 'warn');
        // Don't reject - evaluation failure shouldn't fail the whole test
        resolve({ stdout, stderr, code, error: true });
      }
    });

    child.on('error', (error) => {
      logError(error, 'Deepeval spawn error');
      // Don't reject - evaluation failure shouldn't fail the whole test
      resolve({ error: error.message });
    });
  });
}

function generateSummary() {
  timings.endTime = Date.now();
  timings.totalDuration = timings.endTime - timings.startTime;
  const totalDurationSec = (timings.totalDuration / 1000).toFixed(1);
  const totalDurationMin = (timings.totalDuration / 60000).toFixed(1);

  // Try to load checkpoint artifacts for cost estimation
  let costEstimate = null;
  try {
    const checkpointDir = join(__dirname, `../output/checkpoints/${HEARING_ID}/${CHECKPOINT_LABEL}`);
    if (existsSync(checkpointDir)) {
      const artifacts = {};
      
      // Load key artifacts if available
      const artifactFiles = ['chunking.json', 'micro-summarize.json', 'hybrid-position-writing.json'];
      for (const file of artifactFiles) {
        const filePath = join(checkpointDir, file);
        if (existsSync(filePath)) {
          try {
            const key = file.replace('.json', '');
            artifacts[key] = JSON.parse(readFileSync(filePath, 'utf-8'));
          } catch (e) {
            // Skip if can't parse
          }
        }
      }
      
      if (Object.keys(artifacts).length > 0) {
        costEstimate = estimatePipelineCosts(artifacts);
      }
    }
  } catch (error) {
    log(`Could not estimate costs: ${error.message}`, 'warn');
  }

  const summary = {
    timestamp: new Date().toISOString(),
    hearingId: HEARING_ID,
    checkpointLabel: CHECKPOINT_LABEL,
    logFile: LOG_FILE,
    timings: {
      startTime: new Date(timings.startTime).toISOString(),
      endTime: new Date(timings.endTime).toISOString(),
      totalDurationSeconds: parseFloat(totalDurationSec),
      totalDurationMinutes: parseFloat(totalDurationMin),
      stepTimings: {}
    },
    costEstimate: costEstimate,
    errors: errors.length > 0 ? errors : null,
    success: errors.length === 0
  };

  // Convert step timings to seconds
  for (const [step, timing] of Object.entries(timings.stepTimings)) {
    if (timing.end) {
      summary.timings.stepTimings[step] = {
        durationSeconds: ((timing.end - timing.start) / 1000).toFixed(1),
        durationMs: timing.end - timing.start
      };
    } else {
      summary.timings.stepTimings[step] = {
        status: 'incomplete',
        startTime: new Date(timing.start).toISOString()
      };
    }
  }

  // Generate markdown report
  const reportLines = [];
  reportLines.push('# Pipeline Test Summary: Hearing 223');
  reportLines.push('');
  reportLines.push(`**Test Run:** ${CHECKPOINT_LABEL}`);
  reportLines.push(`**Start Time:** ${summary.timings.startTime}`);
  reportLines.push(`**End Time:** ${summary.timings.endTime}`);
  reportLines.push(`**Total Duration:** ${totalDurationMin} minutes (${totalDurationSec} seconds)`);
  reportLines.push(`**Status:** ${summary.success ? '✅ Success' : '❌ Failed'}`);
  reportLines.push('');
  reportLines.push(`**Log File:** \`${LOG_FILE}\``);
  reportLines.push('');

  if (Object.keys(summary.timings.stepTimings).length > 0) {
    reportLines.push('## Step Timings');
    reportLines.push('');
    reportLines.push('| Step | Duration (s) | Status |');
    reportLines.push('|------|---------------|--------|');
    
    for (const [step, timing] of Object.entries(summary.timings.stepTimings)) {
      const duration = timing.durationSeconds || 'N/A';
      const status = timing.status || '✅ Complete';
      reportLines.push(`| ${step} | ${duration} | ${status} |`);
    }
    reportLines.push('');
  }

  if (summary.costEstimate) {
    reportLines.push('## Cost Estimation');
    reportLines.push('');
    const costReport = formatCostReport(summary.costEstimate, summary.timings);
    // Extract the cost breakdown section
    const costLines = costReport.split('\n');
    const costStart = costLines.findIndex(l => l.includes('## Cost Breakdown'));
    if (costStart >= 0) {
      const costEnd = costLines.findIndex((l, i) => i > costStart && l.startsWith('##'));
      const costSection = costLines.slice(costStart, costEnd > 0 ? costEnd : costLines.length);
      reportLines.push(...costSection);
      reportLines.push('');
    }
  }

  if (errors.length > 0) {
    reportLines.push('## Errors');
    reportLines.push('');
    for (const error of errors) {
      reportLines.push(`### ${error.context || 'Unknown'}`);
      reportLines.push(`**Time:** ${error.timestamp}`);
      reportLines.push(`**Message:** ${error.message}`);
      if (error.stack) {
        reportLines.push('```');
        reportLines.push(error.stack);
        reportLines.push('```');
      }
      reportLines.push('');
    }
  }

  reportLines.push('## Next Steps');
  reportLines.push('');
  reportLines.push('1. Review the log file for detailed output');
  reportLines.push('2. Check checkpoints in `output/checkpoints/223/' + CHECKPOINT_LABEL + '/`');
  reportLines.push('3. Review deepeval evaluation report (if evaluation ran)');
  reportLines.push('4. Check final output files in `output/`');
  reportLines.push('');

  const reportText = reportLines.join('\n');
  writeFileSync(SUMMARY_FILE, reportText, 'utf-8');
  
  log('');
  log('═'.repeat(80));
  log('Test Summary Generated');
  log('═'.repeat(80));
  log(`Summary file: ${SUMMARY_FILE}`);
  log('');

  return summary;
}

async function main() {
  try {
    // Run pipeline
    await runPipeline();
    
    // Run evaluation
    await runDeepeval();
    
    // Generate summary
    const summary = generateSummary();
    
    log('');
    log('═'.repeat(80));
    log('Test Complete');
    log('═'.repeat(80));
    log(`Total time: ${summary.timings.totalDurationMinutes} minutes`);
    log(`Summary: ${SUMMARY_FILE}`);
    log(`Log: ${LOG_FILE}`);
    log('');
    
    process.exit(0);
  } catch (error) {
    logError(error, 'Main execution');
    generateSummary();
    process.exit(1);
  }
}

main();

