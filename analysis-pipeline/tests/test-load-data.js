/**
 * Test only the load-data step
 */

import { DataLoader } from '../src/utils/data-loader.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function test() {
  const hearingId = process.argv[2] ? parseInt(process.argv[2], 10) : 168;
  console.log(`Testing load-data step for hearing ${hearingId}...\n`);

  const dataLoader = new DataLoader();
  
  try {
    const data = await dataLoader.loadPublishedHearing(hearingId);

    console.log('\n=== Load Data Result ===');
    console.log(`Hearing ID: ${data.hearing.id}`);
    console.log(`Hearing Title: ${data.hearing.title}`);
    console.log(`Responses: ${data.responses.length}`);
    console.log(`Materials: ${data.materials.length}`);
    
    if (data.responses.length > 0) {
      console.log('\nFirst response:');
      console.log(`  ID: ${data.responses[0].id}`);
      console.log(`  Author: ${data.responses[0].author || data.responses[0].respondentName || 'N/A'}`);
      console.log(`  Text length: ${(data.responses[0].text || '').length} chars`);
      console.log(`  textFrom: ${data.responses[0].textFrom || 'null'}`);
    }
    
    // Show responses with different textFrom values
    const textFromModes = {};
    data.responses.forEach(r => {
      const mode = r.textFrom || 'null';
      textFromModes[mode] = (textFromModes[mode] || 0) + 1;
    });
    if (Object.keys(textFromModes).length > 0) {
      console.log(`\ntextFrom distribution:`);
      Object.entries(textFromModes).forEach(([mode, count]) => {
        console.log(`  ${mode}: ${count}`);
      });
    }
    
    if (data.materials.length > 0) {
      console.log('\nMaterials:');
      data.materials.forEach((m, i) => {
        console.log(`  ${i + 1}. ${m.title}`);
        console.log(`     File path: ${m.filePath ? 'EXISTS' : 'NULL'}`);
        console.log(`     Is PDF: ${m.title.endsWith('.pdf') ? 'Yes' : 'No'}`);
      });
    }

    // Save result - include actual text based on focusMode
    const outputDir = join(__dirname, '../output');
    mkdirSync(outputDir, { recursive: true });

    // Build response data - text field already contains all relevant content based on textFrom
    const sanitizedData = {
      hearing: {
        id: data.hearing.id,
        title: data.hearing.title
        // Removed: status (irrelevant for analysis)
      },
      responses: data.responses.map(r => ({
        id: r.id,
        respondentName: r.respondentName,
        respondentType: r.respondentType || null,
        textFrom: r.textFrom || null,
        text: r.text || '' // All relevant text content (response text, attachment text, or both) based on textFrom
      })),
      materials: data.materials.map(m => ({
        materialId: m.materialId,
        title: m.title,
        filePath: m.filePath || null // Absolute path to PDF file (null if file doesn't exist)
      }))
    };

    writeFileSync(
      join(outputDir, 'load-data-result.json'),
      JSON.stringify(sanitizedData, null, 2),
      'utf-8'
    );

    console.log(`\n✓ Result saved to: ${join(outputDir, 'load-data-result.json')}`);

  } catch (error) {
    console.error('\n✗ Load data failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    dataLoader.close();
  }
}

test();

