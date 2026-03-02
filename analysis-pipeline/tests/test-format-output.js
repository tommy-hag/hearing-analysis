/**
 * Test output formatter with case-insensitive reference matching
 */

import { CheckpointManager } from '../src/pipeline/checkpoint-manager.js';
import { OutputFormatter } from '../src/utils/output-formatter.js';

const checkpoint = new CheckpointManager();
const formatter = new OutputFormatter();

console.log('=== Testing Output Formatter ===\n');

// Load extract-citations checkpoint (has filled quotes)
const citedPositions = checkpoint.load(168, 'extract-citations', 'test-new-code');
const considerations = checkpoint.load(168, 'considerations', 'test-new-code');

console.log(`Loaded ${citedPositions.length} themes`);

// Format output
const result = {
  hearingId: 168,
  title: 'Tillæg 6 til lp Grønttorvsområdet - forslag til lokalplan',
  considerations: considerations || 'Ingen særlige overvejelser.',
  topics: citedPositions
};

const markdown = formatter.formatForDocx(result);

console.log('\n=== Checking for unconverted REF tags ===');
const refMatches = markdown.match(/<<REF_\d+>>/g);
if (refMatches) {
  console.log(`Found ${refMatches.length} unconverted REF tags`);
  
  // Find where they are
  const lines = markdown.split('\n');
  lines.forEach((line, idx) => {
    if (line.includes('<<REF_')) {
      console.log(`Line ${idx + 1}: ${line.substring(0, 150)}...`);
    }
  });
} else {
  console.log('✅ No unconverted REF tags found!');
}

console.log('\n=== Checking for CriticMarkup citations ===');
const criticMarkupMatches = markdown.match(/\{==.*?==\}\{>>.*?<<\}/g);
if (criticMarkupMatches) {
  console.log(`Found ${criticMarkupMatches.length} CriticMarkup citations`);
  console.log('Sample citation:');
  console.log(criticMarkupMatches[0].substring(0, 200) + '...');
} else {
  console.log('⚠️  No CriticMarkup citations found!');
}

console.log('\n=== Sample output (first 1000 chars) ===');
console.log(markdown.substring(0, 1000));

console.log('\n=== Test Complete ===');

