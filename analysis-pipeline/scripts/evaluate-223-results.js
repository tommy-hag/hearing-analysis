#!/usr/bin/env node

/**
 * Evaluation Script for Case 223
 * 
 * Compares structural metrics to 168 golden output pattern.
 * Checks topic count, position distribution, citation presence, etc.
 * 
 * Usage: node scripts/evaluate-223-results.js
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import dotenv from 'dotenv';

// Load environment config
dotenv.config({ path: join(__dirname, '../config/.env') });

const HEARING_ID = 223;
const OUTPUT_JSON_PATH = join(__dirname, '../output/hearing-223-analysis.json');
const OUTPUT_MD_PATH = join(__dirname, '../output/hearing-223-analysis.md');
const GOLDEN_MD_PATH = join(__dirname, '../golden-output/168.md');
const REPORT_PATH = join(__dirname, '../output/evaluation-223-report.md');

// Use same path resolution as JobTracker
const dbPathRelative = process.env.DB_PATH || '../data/app.sqlite';
const DB_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', dbPathRelative);

// Golden output 168 reference metrics (from attached file)
const GOLDEN_168_METRICS = {
  responseCount: 24,
  topicCount: 6, // Anvendelse, Trafik og mobilitet, Bil- og Cykelparkering, Omfang og placering, Bebyggelsens ydre fremtræden, Ubebyggede arealer, Andre emner
  positionCount: 21, // Approximate from golden output structure
  avgPositionsPerTopic: 3.5,
  hasCitations: false, // Golden 168 explicitly has no citations
  hasConsiderations: true
};

function parseJsonOutput() {
  if (!existsSync(OUTPUT_JSON_PATH)) {
    console.error(`❌ Output file not found: ${OUTPUT_JSON_PATH}`);
    return null;
  }
  
  const raw = readFileSync(OUTPUT_JSON_PATH, 'utf-8');
  return JSON.parse(raw);
}

function parseMarkdownOutput() {
  if (!existsSync(OUTPUT_MD_PATH)) {
    console.error(`❌ Markdown output not found: ${OUTPUT_MD_PATH}`);
    return null;
  }
  
  return readFileSync(OUTPUT_MD_PATH, 'utf-8');
}

function analyzeJsonStructure(json) {
  const metrics = {
    topicCount: json.topics?.length || 0,
    topics: [],
    totalPositions: 0,
    positionsPerTopic: {},
    avgPositionsPerTopic: 0,
    minPositionsPerTopic: Infinity,
    maxPositionsPerTopic: 0,
    citationStats: {
      totalCitations: 0,
      positionsWithCitations: 0,
      avgCitationsPerPosition: 0
    },
    hasConsiderations: !!json.considerations,
    considerationsLength: json.considerations?.length || 0
  };
  
  if (json.topics) {
    json.topics.forEach(topic => {
      const positionCount = topic.positions?.length || 0;
      metrics.totalPositions += positionCount;
      metrics.positionsPerTopic[topic.title] = positionCount;
      
      if (positionCount < metrics.minPositionsPerTopic) {
        metrics.minPositionsPerTopic = positionCount;
      }
      if (positionCount > metrics.maxPositionsPerTopic) {
        metrics.maxPositionsPerTopic = positionCount;
      }
      
      metrics.topics.push({
        title: topic.title,
        positionCount: positionCount
      });
      
      // Count citations
      if (topic.positions) {
        topic.positions.forEach(position => {
          const citationCount = position.citations?.length || 0;
          metrics.citationStats.totalCitations += citationCount;
          if (citationCount > 0) {
            metrics.citationStats.positionsWithCitations++;
          }
        });
      }
    });
    
    if (metrics.topicCount > 0) {
      metrics.avgPositionsPerTopic = metrics.totalPositions / metrics.topicCount;
    }
    
    if (metrics.totalPositions > 0) {
      metrics.citationStats.avgCitationsPerPosition = 
        metrics.citationStats.totalCitations / metrics.totalPositions;
    }
  }
  
  if (metrics.minPositionsPerTopic === Infinity) {
    metrics.minPositionsPerTopic = 0;
  }
  
  return metrics;
}

function analyzeMarkdownStructure(markdown) {
  const metrics = {
    length: markdown.length,
    lineCount: markdown.split('\n').length,
    h1Count: (markdown.match(/^# /gm) || []).length,
    h2Count: (markdown.match(/^## /gm) || []).length,
    h3Count: (markdown.match(/^### /gm) || []).length,
    hasCriticMarkup: markdown.includes('{==') || markdown.includes('{>>'),
    considerationsSection: markdown.includes('# Overvejelser') || markdown.includes('# Considerations'),
    bulletPoints: (markdown.match(/^- /gm) || []).length
  };
  
  return metrics;
}

function getResponseCount() {
  try {
    const db = new Database(DB_PATH, { readonly: true });
    const result = db.prepare(`
      SELECT COUNT(*) as count
      FROM published_responses
      WHERE hearing_id = ?
    `).get(HEARING_ID);
    db.close();
    return result?.count || 0;
  } catch (error) {
    console.warn('Could not get response count from database:', error.message);
    return null;
  }
}

function getEdgeCaseStats() {
  try {
    const db = new Database(DB_PATH, { readonly: true });
    
    // Get latest job
    const job = db.prepare(`
      SELECT job_id
      FROM analysis_jobs
      WHERE hearing_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(HEARING_ID);
    
    if (!job) {
      db.close();
      return null;
    }
    
    // Get edge case artifact
    const artifact = db.prepare(`
      SELECT artifact_data
      FROM analysis_job_artifacts
      WHERE job_id = ? AND step_name = 'edge-case-screening'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(job.job_id);
    
    db.close();
    
    if (!artifact) {
      return null;
    }
    
    const data = JSON.parse(artifact.artifact_data);
    return {
      totalResponses: data.totalResponses || 0,
      edgeCaseCount: data.edgeCases?.length || 0,
      contentResponses: data.contentResponses?.length || 0,
      edgeCaseTypes: {}
    };
  } catch (error) {
    console.warn('Could not get edge case stats:', error.message);
    return null;
  }
}

function compareToGolden(metrics223) {
  const comparison = {
    responseCountRatio: null,
    topicCountDiff: metrics223.topicCount - GOLDEN_168_METRICS.topicCount,
    positionCountDiff: metrics223.totalPositions - GOLDEN_168_METRICS.positionCount,
    avgPositionsRatio: metrics223.avgPositionsPerTopic / GOLDEN_168_METRICS.avgPositionsPerTopic,
    considerationsMatch: metrics223.hasConsiderations === GOLDEN_168_METRICS.hasConsiderations,
    citationsMatch: (metrics223.citationStats.totalCitations === 0) === !GOLDEN_168_METRICS.hasCitations
  };
  
  const responseCount223 = getResponseCount();
  if (responseCount223) {
    comparison.responseCountRatio = responseCount223 / GOLDEN_168_METRICS.responseCount;
  }
  
  return comparison;
}

function generateReport(metrics223, markdownMetrics, comparison, edgeCaseStats) {
  const lines = [];
  
  lines.push('# Evaluation Report: Case 223');
  lines.push('');
  lines.push(`**Generated:** ${new Date().toLocaleString()}`);
  lines.push('');
  lines.push('## Executive Summary');
  lines.push('');
  
  const responseCount = getResponseCount();
  if (responseCount) {
    lines.push(`- **Responses Processed:** ${responseCount} (vs 24 in golden 168)`);
    lines.push(`- **Scale Factor:** ${(responseCount / 24).toFixed(1)}x larger`);
  }
  lines.push(`- **Topics Generated:** ${metrics223.topicCount} (golden 168: ${GOLDEN_168_METRICS.topicCount})`);
  lines.push(`- **Total Positions:** ${metrics223.totalPositions} (golden 168: ~${GOLDEN_168_METRICS.positionCount})`);
  lines.push(`- **Avg Positions/Topic:** ${metrics223.avgPositionsPerTopic.toFixed(1)} (golden 168: ${GOLDEN_168_METRICS.avgPositionsPerTopic.toFixed(1)})`);
  lines.push('');
  
  lines.push('## Structural Metrics');
  lines.push('');
  lines.push('### JSON Structure');
  lines.push('');
  lines.push(`- **Topic Count:** ${metrics223.topicCount}`);
  lines.push(`- **Total Positions:** ${metrics223.totalPositions}`);
  lines.push(`- **Positions per Topic:**`);
  lines.push(`  - Average: ${metrics223.avgPositionsPerTopic.toFixed(2)}`);
  lines.push(`  - Min: ${metrics223.minPositionsPerTopic}`);
  lines.push(`  - Max: ${metrics223.maxPositionsPerTopic}`);
  lines.push('');
  
  lines.push('### Topics and Positions');
  lines.push('');
  metrics223.topics.forEach(topic => {
    lines.push(`- **${topic.title}**: ${topic.positionCount} positions`);
  });
  lines.push('');
  
  lines.push('### Citation Statistics');
  lines.push('');
  lines.push(`- **Total Citations:** ${metrics223.citationStats.totalCitations}`);
  lines.push(`- **Positions with Citations:** ${metrics223.citationStats.positionsWithCitations} / ${metrics223.totalPositions}`);
  lines.push(`- **Avg Citations per Position:** ${metrics223.citationStats.avgCitationsPerPosition.toFixed(2)}`);
  lines.push('');
  
  if (edgeCaseStats) {
    lines.push('### Edge Case Handling');
    lines.push('');
    lines.push(`- **Total Responses:** ${edgeCaseStats.totalResponses}`);
    lines.push(`- **Edge Cases Detected:** ${edgeCaseStats.edgeCaseCount}`);
    lines.push(`- **Content Responses:** ${edgeCaseStats.contentResponses}`);
    lines.push(`- **Edge Case Rate:** ${((edgeCaseStats.edgeCaseCount / edgeCaseStats.totalResponses) * 100).toFixed(1)}%`);
    lines.push('');
  }
  
  lines.push('### Markdown Output');
  lines.push('');
  lines.push(`- **Total Length:** ${markdownMetrics.length.toLocaleString()} characters`);
  lines.push(`- **Line Count:** ${markdownMetrics.lineCount}`);
  lines.push(`- **H1 Headings:** ${markdownMetrics.h1Count}`);
  lines.push(`- **H2 Headings:** ${markdownMetrics.h2Count}`);
  lines.push(`- **H3 Headings:** ${markdownMetrics.h3Count}`);
  lines.push(`- **Bullet Points:** ${markdownMetrics.bulletPoints}`);
  lines.push(`- **Has CriticMarkup:** ${markdownMetrics.hasCriticMarkup ? 'Yes' : 'No'}`);
  lines.push(`- **Has Considerations:** ${markdownMetrics.considerationsSection ? 'Yes' : 'No'}`);
  lines.push('');
  
  lines.push('## Comparison to Golden 168');
  lines.push('');
  
  if (comparison.responseCountRatio) {
    lines.push(`- **Scale:** ${comparison.responseCountRatio.toFixed(1)}x more responses than 168`);
  }
  lines.push(`- **Topic Count:** ${comparison.topicCountDiff > 0 ? '+' : ''}${comparison.topicCountDiff} topics`);
  lines.push(`- **Position Count:** ${comparison.positionCountDiff > 0 ? '+' : ''}${comparison.positionCountDiff} positions`);
  lines.push(`- **Avg Positions Ratio:** ${comparison.avgPositionsRatio.toFixed(2)}x`);
  lines.push(`- **Considerations Present:** ${comparison.considerationsMatch ? '✅ Match' : '❌ Mismatch'}`);
  lines.push('');
  
  lines.push('## Quality Indicators');
  lines.push('');
  
  // Check for quality indicators
  const qualityChecks = [];
  
  if (metrics223.hasConsiderations) {
    qualityChecks.push('✅ Considerations section present');
  } else {
    qualityChecks.push('❌ Missing considerations section');
  }
  
  if (metrics223.topicCount > 0) {
    qualityChecks.push('✅ Topics generated');
  } else {
    qualityChecks.push('❌ No topics generated');
  }
  
  if (metrics223.totalPositions > 0) {
    qualityChecks.push('✅ Positions generated');
  } else {
    qualityChecks.push('❌ No positions generated');
  }
  
  if (metrics223.avgPositionsPerTopic >= 2) {
    qualityChecks.push('✅ Reasonable positions per topic (≥2)');
  } else {
    qualityChecks.push('⚠️  Low positions per topic (<2)');
  }
  
  if (markdownMetrics.length > 1000) {
    qualityChecks.push('✅ Substantial markdown output');
  } else {
    qualityChecks.push('⚠️  Short markdown output');
  }
  
  if (responseCount && edgeCaseStats) {
    const coverageRate = (edgeCaseStats.contentResponses / responseCount) * 100;
    qualityChecks.push(`${coverageRate > 70 ? '✅' : '⚠️ '} Response coverage: ${coverageRate.toFixed(1)}%`);
  }
  
  qualityChecks.forEach(check => lines.push(`- ${check}`));
  lines.push('');
  
  lines.push('## Scaling Performance Notes');
  lines.push('');
  
  if (comparison.responseCountRatio) {
    const expectedPositions = GOLDEN_168_METRICS.positionCount * comparison.responseCountRatio;
    const actualVsExpected = (metrics223.totalPositions / expectedPositions) * 100;
    
    lines.push(`- Expected positions (linear scaling): ~${expectedPositions.toFixed(0)}`);
    lines.push(`- Actual positions: ${metrics223.totalPositions}`);
    lines.push(`- Scaling efficiency: ${actualVsExpected.toFixed(1)}%`);
    lines.push('');
    
    if (actualVsExpected < 80) {
      lines.push('⚠️  **Note:** Lower than expected position count may indicate aggressive consolidation or different themes.');
    } else if (actualVsExpected > 120) {
      lines.push('⚠️  **Note:** Higher than expected position count may indicate under-consolidation or more diverse responses.');
    } else {
      lines.push('✅ Position count scales appropriately with response volume.');
    }
  }
  
  lines.push('');
  lines.push('## Recommendations');
  lines.push('');
  
  if (!metrics223.hasConsiderations) {
    lines.push('- ❗ Add considerations section');
  }
  
  if (metrics223.avgPositionsPerTopic < 2) {
    lines.push('- ❗ Review theme mapping - may be too granular');
  }
  
  if (metrics223.avgPositionsPerTopic > 10) {
    lines.push('- ❗ Consider more aggressive position consolidation');
  }
  
  if (edgeCaseStats && (edgeCaseStats.edgeCaseCount / edgeCaseStats.totalResponses) > 0.3) {
    lines.push('- ⚠️  High edge case rate (>30%) - review edge case detection');
  }
  
  if (metrics223.citationStats.positionsWithCitations === 0) {
    lines.push('- ℹ️  No citations generated (matching golden 168 pattern)');
  }
  
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('*End of evaluation report*');
  
  return lines.join('\n');
}

function main() {
  console.log('═'.repeat(80));
  console.log('  EVALUATION: Case 223');
  console.log('═'.repeat(80));
  console.log();
  
  // Parse outputs
  console.log('📊 Analyzing JSON output...');
  const json = parseJsonOutput();
  if (!json) {
    console.error('Failed to parse JSON output. Exiting.');
    process.exit(1);
  }
  
  const metrics223 = analyzeJsonStructure(json);
  console.log(`  ✓ Found ${metrics223.topicCount} topics, ${metrics223.totalPositions} positions`);
  console.log();
  
  console.log('📝 Analyzing Markdown output...');
  const markdown = parseMarkdownOutput();
  if (!markdown) {
    console.error('Failed to parse markdown output. Exiting.');
    process.exit(1);
  }
  
  const markdownMetrics = analyzeMarkdownStructure(markdown);
  console.log(`  ✓ ${markdownMetrics.length.toLocaleString()} chars, ${markdownMetrics.lineCount} lines`);
  console.log();
  
  console.log('🔍 Getting edge case statistics...');
  const edgeCaseStats = getEdgeCaseStats();
  if (edgeCaseStats) {
    console.log(`  ✓ ${edgeCaseStats.edgeCaseCount} edge cases, ${edgeCaseStats.contentResponses} content responses`);
  } else {
    console.log('  ⚠️  Could not retrieve edge case stats');
  }
  console.log();
  
  console.log('⚖️  Comparing to golden 168...');
  const comparison = compareToGolden(metrics223);
  console.log(`  ✓ Topic count: ${comparison.topicCountDiff > 0 ? '+' : ''}${comparison.topicCountDiff}`);
  console.log(`  ✓ Position count: ${comparison.positionCountDiff > 0 ? '+' : ''}${comparison.positionCountDiff}`);
  console.log();
  
  console.log('📄 Generating report...');
  const report = generateReport(metrics223, markdownMetrics, comparison, edgeCaseStats);
  writeFileSync(REPORT_PATH, report, 'utf-8');
  console.log(`  ✓ Report saved to: ${REPORT_PATH}`);
  console.log();
  
  // Print summary
  console.log('═'.repeat(80));
  console.log('  SUMMARY');
  console.log('═'.repeat(80));
  console.log();
  console.log(`  Topics:              ${metrics223.topicCount}`);
  console.log(`  Positions:           ${metrics223.totalPositions}`);
  console.log(`  Avg Pos/Topic:       ${metrics223.avgPositionsPerTopic.toFixed(1)}`);
  console.log(`  Has Considerations:  ${metrics223.hasConsiderations ? 'Yes' : 'No'}`);
  console.log(`  Total Citations:     ${metrics223.citationStats.totalCitations}`);
  console.log();
  console.log(`  Response Count:      ${getResponseCount() || 'N/A'}`);
  if (edgeCaseStats) {
    console.log(`  Edge Case Rate:      ${((edgeCaseStats.edgeCaseCount / edgeCaseStats.totalResponses) * 100).toFixed(1)}%`);
  }
  console.log();
  console.log('  Full report: ' + REPORT_PATH);
  console.log();
  console.log('✅ Evaluation complete!');
  console.log();
}

main();

