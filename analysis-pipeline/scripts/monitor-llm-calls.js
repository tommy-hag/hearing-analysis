#!/usr/bin/env node

/**
 * Monitor LLM calls in the pipeline
 * Usage: node monitor-llm-calls.js <log-file>
 */

import { promises as fs } from 'fs';
import { createReadStream } from 'fs';
import readline from 'readline';

const logFile = process.argv[2];
if (!logFile) {
  console.error('Usage: node monitor-llm-calls.js <log-file>');
  process.exit(1);
}

let lastPosition = 0;
const llmCallPatterns = [
  // OpenAI client patterns
  /\[OpenAIClient\]/,
  /chat\.completions\.create/,
  /embeddings\.create/,
  
  // Component-specific LLM calls
  /\[MaterialSummarizer\].*(?:Summarizing|Generating)/,
  /\[EdgeCaseDetector\].*(?:Screening|Processing)/,
  /\[MicroSummarizer\].*(?:Processing|Transforming|batch)/,
  /\[ThemeExtractor\].*(?:Extracting|Processing)/,
  /\[ThemeMapper\].*(?:Mapping|Processing)/,
  /\[Aggregator\].*(?:Processing|Grouping|theme)/,
  /\[SubPositionExtractor\].*(?:Extracting|Processing)/,
  /\[PositionGrouper\].*(?:Grouping|Processing)/,
  /\[PositionWriter\].*(?:Writing|Generating)/,
  /\[CitationExtractor\].*(?:Extracting|Processing)/,
  
  // Performance and timing
  /completed \(\d+\.\d+s\)/,
  /\[Pipeline\].*(?:completed|failed)/,
  
  // Errors and warnings
  /Error:|ERROR/,
  /Warning:|WARN/,
  /failed|Failed/,
  /timeout|Timeout/,
  /hanging|stuck/,
  
  // Citation registry
  /\[Citation Registry\]/,
  /sourceQuoteRef|CITE_/,
  
  // Dynamic parameters
  /Dynamic (?:parameters|threshold) set/,
  /similarityThreshold.*set/,
  
  // Progress indicators
  /batch \d+\/\d+/,
  /response(?:s)? \d+-\d+/,
  /Processing \d+ (?:themes|arguments|positions)/
];

async function monitorLog() {
  try {
    const stats = await fs.stat(logFile);
    
    if (stats.size > lastPosition) {
      const stream = createReadStream(logFile, {
        start: lastPosition,
        encoding: 'utf8'
      });
      
      const rl = readline.createInterface({
        input: stream,
        crlfDelay: Infinity
      });
      
      for await (const line of rl) {
        const timestamp = new Date().toISOString();
        
        // Check if line matches any LLM call pattern
        const isLLMCall = llmCallPatterns.some(pattern => pattern.test(line));
        
        if (isLLMCall) {
          console.log(`[${timestamp}] ${line.trim()}`);
          
          // Special handling for potential hanging indicators
          if (line.includes('Processing batch') || line.includes('Transforming')) {
            console.log(`[${timestamp}] ⏳ LLM CALL IN PROGRESS - Monitoring for hang...`);
          }
        }
      }
      
      lastPosition = stats.size;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Error reading log file:', error);
    }
  }
}

// Monitor continuously
console.log(`Monitoring LLM calls in: ${logFile}`);
console.log('Press Ctrl+C to stop\n');

setInterval(monitorLog, 500); // Check every 500ms

// Initial check
monitorLog();
