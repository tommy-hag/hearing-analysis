/**
 * Test script for the new argument-aligned chunking strategy
 * 
 * Run with: node test/chunking-test.js
 */

import { StructuredChunker } from '../src/chunking/structured-chunker.js';
import { ArgumentChunker } from '../src/chunking/argument-chunker.js';
import { MaterialChunker } from '../src/chunking/material-chunker.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load config
const configPath = join(__dirname, '../config/pipeline-config.json');
const config = JSON.parse(readFileSync(configPath, 'utf-8'));

console.log('=== Chunking Strategy Test ===\n');
console.log('Config:', JSON.stringify(config.chunking, null, 2));
console.log('Material Config:', JSON.stringify(config.materialChunking, null, 2));
console.log('\n');

// Test cases
const testCases = [
  {
    name: 'Short response (should skip chunking)',
    text: 'Bevar Palads.',
    metadata: { responseNumber: 1, documentType: 'response', source: 'response:1' }
  },
  {
    name: 'Medium response (under threshold)',
    text: 'Palads er kulturhistorie og bevaringsværdigt. Det er Københavns gamle minder og noget der skal vernes om. Palads skal bevares i hele sin form også, hvad gælder de indre dele. Gamle bygninger bliver revet ned, og der bliver bygget nyt i hele København. Det er afsindig trist og uforståeligt, lad Palads blive i sin fulde form inde og ude. Det fortjener københavn!',
    metadata: { responseNumber: 3, documentType: 'response', source: 'response:3' }
  },
  {
    name: 'Long response (over threshold)',
    text: `Palads er københavnsk og dansk kultur- og arkitekturarv. Københavnerne har talt, og vi, borgerne af byen, ønsker en fuld fredning og bevarelse af et af de mest ikoniske og kulturhistorisk vigtige landemærker i Danmarks hovedstad. 

Hvorfor har I så travlt med at genskabe effekterne af københavns store brande? Smadre københavnsk? Der er lige præcis nul gode grunde til at blive ved med at rasere solide og smukke bygningsværker, som er definerende for Københavns identitet, og som vi aldrig vil kunne genskabe.

Ét er hele den kulturelle, historiske og menneskelige vinkel, noget andet er klima- og ressourcekrisen. Vi er i 2025, og tiden, hvor vi på nogen måde skal nære idéer om at rive noget som helst eksisterende ned, er ovre.

Hvad fanden har I gang i? I knuser byen, I knuser vores hjerter, og I knuser fremtidige generationers håb.`,
    metadata: { responseNumber: 2, documentType: 'response', source: 'response:2' }
  },
  {
    name: 'Material with markdown headers',
    text: `# Lokalplan for Palads

## 1. Formål
Lokalplanen har til formål at muliggøre udvikling af området omkring Palads.

## 2. Anvendelse
Området kan anvendes til:
- Biograf
- Hotel
- Kontor

### 2.1 Detailhandel
Der kan etableres detailhandel i stueetagen.

## 3. Bebyggelse
Bebyggelsesprocenten må ikke overstige 400%.`,
    metadata: { materialId: 1, documentType: 'material', source: 'material:1' }
  }
];

// Initialize chunker with config
const chunker = new StructuredChunker({
  ...config.chunking,
  materialMinChunkSize: config.materialChunking?.minChunkSize || 400,
  materialMaxChunkSize: config.materialChunking?.maxChunkSize || 1500,
  headerDepthWeight: config.materialChunking?.headerDepthWeight !== false,
  includeParentContext: config.materialChunking?.includeParentContext !== false,
  materialOverlap: config.materialChunking?.chunkOverlap || 100
});

// Run tests
for (const testCase of testCases) {
  console.log(`\n--- ${testCase.name} ---`);
  console.log(`Text length: ${testCase.text.length} chars`);
  console.log(`Threshold: ${config.chunking.shortResponseThreshold} chars`);
  
  const chunks = chunker.chunk(testCase.text, testCase.metadata);
  
  console.log(`Chunks created: ${chunks.length}`);
  
  chunks.forEach((chunk, i) => {
    console.log(`\nChunk ${i + 1}:`);
    console.log(`  - ID: ${chunk.chunkId}`);
    console.log(`  - Type: ${chunk.chunkType || chunk.documentType}`);
    console.log(`  - Tokens: ${chunk.tokenCount}`);
    console.log(`  - Content preview: ${chunk.content.substring(0, 100)}...`);
    if (chunk.metadata?.skippedChunking) {
      console.log(`  - Skipped chunking: YES`);
    }
    if (chunk.parentSection) {
      console.log(`  - Parent section: ${chunk.parentSection}`);
    }
  });
}

// Test ArgumentChunker
console.log('\n\n=== ArgumentChunker Test ===\n');

const argumentChunker = new ArgumentChunker(config.argumentChunking || {});

const mockMicroSummary = {
  responseNumber: 2,
  arguments: [
    {
      what: 'Krav om fuld fredning og bevarelse af Palads',
      why: 'fordi Palads er københavnsk og dansk kultur- og arkitekturarv',
      how: 'Gennem fuld fredning og bevarelse af bygningen',
      sourceQuote: 'Københavnerne har talt, og vi, borgerne af byen, ønsker en fuld fredning og bevarelse',
      relevantThemes: ['Bevaringsværdi']
    },
    {
      what: 'Argument imod nedrivning af klimamæssige hensyn',
      why: 'fordi vi er i 2025 og tiden for at rive eksisterende bygninger ned er ovre',
      how: 'Ikke specificeret',
      sourceQuote: 'Vi er i 2025, og tiden, hvor vi på nogen måde skal nære idéer om at rive noget som helst eksisterende ned, er ovre.',
      relevantThemes: ['Miljøforhold']
    }
  ]
};

const mockResponse = {
  id: 2,
  text: testCases[2].text
};

const argChunks = argumentChunker.chunkFromArguments(mockMicroSummary, mockResponse);

console.log(`Created ${argChunks.length} argument-aligned chunks:`);
argChunks.forEach((chunk, i) => {
  console.log(`\nArgument Chunk ${i + 1}:`);
  console.log(`  - ID: ${chunk.chunkId}`);
  console.log(`  - Type: ${chunk.chunkType}`);
  console.log(`  - Tokens: ${chunk.tokenCount}`);
  console.log(`  - Themes: ${chunk.metadata?.themes?.join(', ') || 'none'}`);
  console.log(`  - Content:\n${chunk.content.split('\n').map(l => '      ' + l).join('\n')}`);
});

// Summary
console.log('\n\n=== Summary ===');
console.log('Strategy:', config.chunking.responseStrategy);
console.log('Short response threshold:', config.chunking.shortResponseThreshold, 'chars');
console.log('Material chunk size:', config.materialChunking?.minChunkSize, '-', config.materialChunking?.maxChunkSize, 'chars');
console.log('\nTest completed successfully!');
