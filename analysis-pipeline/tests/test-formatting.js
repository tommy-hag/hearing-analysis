
import { OutputFormatter } from '../src/utils/output-formatter.js';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function test() {
  console.log('Testing output formatter...');

  const jsonPath = join(__dirname, '../output/hearing-223-analysis.json');
  const outputPath = join(__dirname, '../output/hearing-223-analysis-test.md');

  try {
    const jsonContent = readFileSync(jsonPath, 'utf-8');
    const analysisResult = JSON.parse(jsonContent);

    const formatter = new OutputFormatter();
    const markdown = formatter.formatForDocx(analysisResult);

    writeFileSync(outputPath, markdown, 'utf-8');
    console.log(`Formatted markdown saved to: ${outputPath}`);

  } catch (error) {
    console.error('Test failed:', error);
  }
}

test();
