/**
 * Test pipeline timing on hearing 168 with 15 responses
 * Measures time spent in each step and identifies bottlenecks
 */

import { PipelineOrchestrator } from '../src/pipeline/pipeline-orchestrator.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Timing helper
const timings = {
  steps: {},
  startTime: null,
  endTime: null
};

function startTiming() {
  timings.startTime = Date.now();
}

function recordStep(stepName, duration) {
  timings.steps[stepName] = {
    duration,
    durationFormatted: formatDuration(duration),
    percentage: 0 // Will calculate after all steps
  };
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(1);
  return `${minutes}m ${seconds}s`;
}

function endTiming() {
  timings.endTime = Date.now();
  const totalDuration = timings.endTime - timings.startTime;
  
  // Calculate percentages
  Object.keys(timings.steps).forEach(step => {
    timings.steps[step].percentage = ((timings.steps[step].duration / totalDuration) * 100).toFixed(1);
  });
  
  return {
    totalDuration,
    totalDurationFormatted: formatDuration(totalDuration),
    steps: timings.steps
  };
}

async function test() {
  console.log('='.repeat(80));
  console.log('Pipeline Timing Test - Hearing 168 (15 responses)');
  console.log('='.repeat(80));
  console.log();

  startTiming();
  
  const orchestrator = new PipelineOrchestrator();
  
  // Override step method to add timing
  const originalStep = orchestrator.step.bind(orchestrator);
  orchestrator.step = async function(stepName, fn, jobId) {
    const stepStart = Date.now();
    console.log(`\n[${new Date().toISOString()}] Starting step: ${stepName}`);
    
    try {
      const result = await originalStep(stepName, fn, jobId);
      const stepDuration = Date.now() - stepStart;
      recordStep(stepName, stepDuration);
      
      console.log(`[${new Date().toISOString()}] Completed step: ${stepName} (${formatDuration(stepDuration)})`);
      return result;
    } catch (error) {
      const stepDuration = Date.now() - stepStart;
      recordStep(stepName, stepDuration);
      console.error(`[${new Date().toISOString()}] Failed step: ${stepName} (${formatDuration(stepDuration)})`);
      throw error;
    }
  };
  
  try {
    const result = await orchestrator.run(168, {
      outputPath: join(__dirname, '../output/hearing-168-analysis.json'),
      markdownPath: join(__dirname, '../output/hearing-168-analysis.md'),
      limitResponses: 15
    });

    const timingResults = endTiming();

    // Print timing summary
    console.log('\n' + '='.repeat(80));
    console.log('TIMING SUMMARY');
    console.log('='.repeat(80));
    console.log(`Total duration: ${timingResults.totalDurationFormatted}`);
    console.log();
    console.log('Step breakdown:');
    console.log('-'.repeat(80));
    
    // Sort steps by duration (descending)
    const sortedSteps = Object.entries(timingResults.steps)
      .sort((a, b) => b[1].duration - a[1].duration);
    
    sortedSteps.forEach(([stepName, data]) => {
      const barLength = Math.round(data.percentage / 2);
      const bar = '█'.repeat(barLength) + '░'.repeat(50 - barLength);
      console.log(`${stepName.padEnd(30)} ${data.durationFormatted.padStart(10)} (${data.percentage.padStart(5)}%) ${bar}`);
    });
    
    console.log('-'.repeat(80));
    console.log();

    // Identify bottlenecks
    console.log('BOTTLENECK ANALYSIS:');
    console.log('-'.repeat(80));
    const bottlenecks = sortedSteps.filter(([_, data]) => parseFloat(data.percentage) > 10);
    if (bottlenecks.length > 0) {
      bottlenecks.forEach(([stepName, data]) => {
        console.log(`⚠️  ${stepName}: ${data.percentage}% of total time (${data.durationFormatted})`);
      });
    } else {
      console.log('No single step takes more than 10% of total time');
    }
    console.log();

    // Save timing results
    const outputDir = join(__dirname, '../output');
    mkdirSync(outputDir, { recursive: true });

    writeFileSync(
      join(outputDir, 'timing-results-168.json'),
      JSON.stringify({
        hearingId: 168,
        responseLimit: 15,
        ...timingResults,
        timestamp: new Date().toISOString()
      }, null, 2),
      'utf-8'
    );

    // Save results
    writeFileSync(
      join(outputDir, 'hearing-168-analysis.json'),
      JSON.stringify(result, null, 2),
      'utf-8'
    );

    const markdown = orchestrator.outputFormatter.formatForDocx(result);
    writeFileSync(
      join(outputDir, 'hearing-168-analysis.md'),
      markdown,
      'utf-8'
    );

    console.log('Analysis complete!');
    console.log(`- Topics: ${result.topics?.length || 0}`);
    console.log(`- Total positions: ${result.topics?.reduce((sum, t) => sum + (t.positions?.length || 0), 0) || 0}`);
    console.log(`- Timing results saved to: ${join(outputDir, 'timing-results-168.json')}`);
    console.log(`- Output saved to: ${outputDir}`);

  } catch (error) {
    const timingResults = endTiming();
    console.error('\nPipeline failed:', error);
    console.error('\nTiming up to failure:');
    console.log(JSON.stringify(timingResults, null, 2));
    process.exit(1);
  } finally {
    orchestrator.close();
  }
}

test();



