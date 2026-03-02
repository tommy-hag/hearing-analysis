/**
 * Test pipeline on hearing 223
 */

import { PipelineOrchestrator } from '../src/pipeline/pipeline-orchestrator.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function test() {
  console.log('Starting analysis pipeline test for hearing 223...');

  const orchestrator = new PipelineOrchestrator();
  
  try {
    const result = await orchestrator.run(223, {
      outputPath: join(__dirname, '../output/hearing-223-analysis.json'),
      markdownPath: join(__dirname, '../output/hearing-223-analysis.md')
    });

    // Save results
    const outputDir = join(__dirname, '../output');
    mkdirSync(outputDir, { recursive: true });

    // Save JSON
    writeFileSync(
      join(outputDir, 'hearing-223-analysis.json'),
      JSON.stringify(result, null, 2),
      'utf-8'
    );

    // Save markdown
    const markdown = orchestrator.outputFormatter.formatForDocx(result);
    writeFileSync(
      join(outputDir, 'hearing-223-analysis.md'),
      markdown,
      'utf-8'
    );

    console.log('Analysis complete!');
    console.log(`- Topics: ${result.topics?.length || 0}`);
    console.log(`- Total positions: ${result.topics?.reduce((sum, t) => sum + (t.positions?.length || 0), 0) || 0}`);
    console.log(`- Output saved to: ${outputDir}`);

  } catch (error) {
    console.error('Pipeline failed:', error);
    process.exit(1);
  } finally {
    orchestrator.close();
  }
}

test();




