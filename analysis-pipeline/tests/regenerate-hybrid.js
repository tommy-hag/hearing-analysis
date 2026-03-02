/**
 * Regenerate hybrid-position-writing med korrekt schema
 */

import { CheckpointManager } from '../src/pipeline/checkpoint-manager.js';
import { PositionWriter } from '../src/analysis/position-writer.js';

const cm = new CheckpointManager();
const writer = new PositionWriter();

const validated = cm.load(168, 'validate-positions', 'final-test-final');
const microSummaries = cm.load(168, 'micro-summarize', 'final-test-final');
const embeddings = cm.load(168, 'embedding', 'final-test-final');
const enrichedResponses = cm.load(168, 'enrich-responses', 'final-test-final');

if (!validated || !microSummaries || !embeddings || !enrichedResponses) {
  console.error('Missing checkpoints');
  process.exit(1);
}

console.log('Regenerating hybrid position writing with CORRECT schema...\n');

const result = await writer.writePositions({
  aggregatedThemes: validated,
  microSummaries,
  embeddings,
  rawResponses: enrichedResponses
});

console.log('✅ Done!');
console.log('Positions:', result.reduce((s, t) => s + t.positions.length, 0));

cm.save(168, 'hybrid-position-writing', result, 'corrected');
console.log('\n💾 Saved to: checkpoints/168/corrected/hybrid-position-writing.json');

