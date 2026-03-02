/**
 * Debug citation extraction - test with real data from hearing 168
 * Uses existing artifacts instead of running full pipeline
 */

import { CitationExtractor } from '../src/citation/citation-extractor.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function testCitationExtraction() {
  const hearingId = 168;
  console.log(`=== Debug Citation Extraction for Hearing ${hearingId} ===\n`);

  try {
    // Load existing artifacts
    const artifactsDir = join(__dirname, '../output/debug-reports');
    
    // Find latest job for hearing 168
    const fs = await import('fs');
    const files = fs.readdirSync(artifactsDir);
    const jobFiles = files.filter(f => f.startsWith(`job_${hearingId}_`) && f.includes('_aggregate.json'));
    if (jobFiles.length === 0) {
      throw new Error('No aggregate artifacts found. Run test-hearing-168.js first.');
    }
    
    // Use most recent job
    const latestJob = jobFiles.sort().reverse()[0];
    const jobId = latestJob.match(/job_(\d+_\d+)_/)[1];
    console.log(`Using job: ${jobId}\n`);

    // Load aggregation
    const aggregatePath = join(artifactsDir, latestJob);
    const aggregate = JSON.parse(readFileSync(aggregatePath, 'utf-8')).result;
    console.log(`✓ Loaded ${aggregate.length} themes`);

    // Load micro summaries
    const microSummaryPath = join(artifactsDir, `job_${jobId}_micro-summarize.json`);
    const microSummaries = JSON.parse(readFileSync(microSummaryPath, 'utf-8')).result;
    console.log(`✓ Loaded ${microSummaries.length} micro summaries`);

    // Load load-data for response texts
    const loadDataPath = join(artifactsDir, `job_${jobId}_load-data.json`);
    const loadData = JSON.parse(readFileSync(loadDataPath, 'utf-8')).result;
    console.log(`✓ Loaded ${loadData.responses.length} responses\n`);

    // Get first position from first theme
    const firstTheme = aggregate[0];
    if (!firstTheme || !firstTheme.positions || firstTheme.positions.length === 0) {
      throw new Error('No positions found in first theme');
    }

    const firstPosition = firstTheme.positions[0];
    const firstResponseNumber = firstPosition.responseNumbers?.[0];
    
    if (!firstResponseNumber) {
      throw new Error('No response numbers in first position');
    }

    const response = loadData.responses.find(r => r.id === firstResponseNumber);
    if (!response) {
      throw new Error(`Response ${firstResponseNumber} not found`);
    }

    const summary = microSummaries.find(s => s.responseNumber === firstResponseNumber);
    if (!summary || !summary.arguments || summary.arguments.length === 0) {
      throw new Error(`No summary found for response ${firstResponseNumber}`);
    }

    const arg = summary.arguments[0];
    const query = arg.coreContent || arg.concern || firstPosition.summary;
    const responseText = response._enrichedText || response.text || '';
    const highlightContextual = firstPosition.summary;

    console.log('=== Test Citation Extraction ===');
    console.log(`Response Number: ${firstResponseNumber}`);
    console.log(`Query: ${query.substring(0, 100)}...`);
    console.log(`Response Text Length: ${responseText.length} chars`);
    console.log(`Highlight Contextual Length: ${highlightContextual.length} chars\n`);

    // Test LLM call directly first (this is where the problem likely is)
    console.log('\n=== Testing LLM Call Directly (This is where the problem likely is) ===');
    const extractor = new CitationExtractor({ complexityLevel: 'medium' });
    const prompt = extractor.buildPrompt(firstResponseNumber, query, responseText, highlightContextual);
    console.log(`Prompt length: ${prompt.length} chars`);
    console.log(`Prompt preview (first 500 chars):\n${prompt.substring(0, 500)}...\n`);

    const llmStartTime = Date.now();
    try {
      console.log('Calling LLM...');
      const llmResult = await Promise.race([
        extractor.extractWithLLM(firstResponseNumber, query, responseText, highlightContextual),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('LLM timeout after 90s')), 90000)
        )
      ]);
      const llmDuration = Date.now() - llmStartTime;
      console.log(`✓ LLM call succeeded in ${llmDuration}ms`);
      console.log(`Citation: ${llmResult.citation?.substring(0, 200)}...`);
    } catch (error) {
      const llmDuration = Date.now() - llmStartTime;
      console.error(`✗ LLM call failed after ${llmDuration}ms`);
      console.error(`Error message: ${error.message}`);
      console.error(`Error type: ${error.constructor.name}`);
      if (error.code) {
        console.error(`Error code: ${error.code}`);
      }
      if (error.status) {
        console.error(`Error status: ${error.status}`);
      }
      if (error.stack) {
        console.error(`\nStack trace:\n${error.stack}`);
      }
    }

    // Test with different timeout values for full extractCitation
    console.log('\n\n=== Testing Full extractCitation with Different Timeouts ===');
    const timeouts = [60000, 90000];
    
    for (const timeout of timeouts) {
      console.log(`\n--- Testing with ${timeout}ms timeout ---`);
      const extractor2 = new CitationExtractor({ 
        complexityLevel: 'medium',
        timeout: timeout 
      });

      const startTime = Date.now();
      try {
        const result = await Promise.race([
          extractor2.extractCitation(
            firstResponseNumber,
            query,
            responseText,
            highlightContextual,
            [] // no chunks for this test
          ),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`Timeout after ${timeout}ms`)), timeout)
          )
        ]);

        const duration = Date.now() - startTime;
        console.log(`✓ Success in ${duration}ms`);
        console.log(`Found: ${result.found}`);
        if (result.found) {
          console.log(`Method: ${result.method}`);
          console.log(`Citation preview: ${(result.citation || '').substring(0, 100)}...`);
        } else {
          console.log(`Reason: ${result.notes || 'Not found'}`);
        }
        break; // Success, no need to test longer timeouts
      } catch (error) {
        const duration = Date.now() - startTime;
        console.error(`✗ Failed after ${duration}ms: ${error.message}`);
        if (error.message.includes('timeout') || error.message.includes('Timeout')) {
          console.log(`  → Request timed out after ${duration}ms`);
        } else {
          console.error(`  → Error details:`, error);
          // If it's not a timeout, we found the real problem
          break;
        }
      }
    }

  } catch (error) {
    console.error('Test failed:', error);
    console.error(error.stack);
    process.exit(1);
  }
}

testCitationExtraction();
