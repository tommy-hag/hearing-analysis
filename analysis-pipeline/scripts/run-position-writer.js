#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';
import { PositionWriter } from '../src/analysis/position-writer.js';

function loadJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf-8'));
}

async function main() {
  const hearingId = parseInt(process.argv[2], 10);
  const checkpointLabel = process.argv[3] ?? 'baseline';
  const basePath = resolve(`output/checkpoints/${hearingId}/${checkpointLabel}`);

  const aggregation = loadJson(join(basePath, 'aggregate.json'));
  const microSummaries = loadJson(join(basePath, 'micro-summarize.json'));
  const embeddings = loadJson(join(basePath, 'embedding.json'));
  const enrichedResponses = loadJson(join(basePath, 'enrich-responses.json'));

  const writer = new PositionWriter();
  const result = await writer.writePositions({
    aggregatedThemes: aggregation,
    microSummaries,
    embeddings,
    rawResponses: enrichedResponses
  });

  const outputPath = resolve(`output/checkpoints/${hearingId}/${checkpointLabel}/hybrid-positions.json`);
  writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`Hybrid positions written to ${outputPath}`);
}

main().catch(error => {
  console.error('Hybrid position writing failed:', error);
  process.exit(1);
});


