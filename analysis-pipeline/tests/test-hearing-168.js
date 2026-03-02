/**
 * Test pipeline on hearing 168
 */

import { PipelineOrchestrator } from '../src/pipeline/pipeline-orchestrator.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function test() {
  console.log('Starting analysis pipeline test for hearing 168...');
  const testLimit = process.env.TEST_LIMIT_RESPONSES ? parseInt(process.env.TEST_LIMIT_RESPONSES, 10) : 0;
  if (testLimit > 0) {
    console.log(`Test limit: processing first ${testLimit} responses only`);
  }

  const orchestrator = new PipelineOrchestrator();
  
  try {
    const result = await orchestrator.run(168, {
      outputPath: join(__dirname, '../output/hearing-168-analysis.json'),
      markdownPath: join(__dirname, '../output/hearing-168-analysis.md')
      // limitResponses is now controlled via TEST_LIMIT_RESPONSES in .env
    });

    // Save results
    const outputDir = join(__dirname, '../output');
    mkdirSync(outputDir, { recursive: true });

    // Save JSON
    writeFileSync(
      join(outputDir, 'hearing-168-analysis.json'),
      JSON.stringify(result, null, 2),
      'utf-8'
    );

    // Save markdown
    const markdown = orchestrator.outputFormatter.formatForDocx(result);
    writeFileSync(
      join(outputDir, 'hearing-168-analysis.md'),
      markdown,
      'utf-8'
    );

    console.log('Analysis complete!');
    console.log(`- Topics: ${result.topics?.length || 0}`);
    console.log(`- Total positions: ${result.topics?.reduce((sum, t) => sum + (t.positions?.length || 0), 0) || 0}`);
    console.log(`- Output saved to: ${outputDir}`);
    console.log('\n✅ Pipeline test completed successfully!');

  } catch (error) {
    console.error('Pipeline failed:', error);
    process.exit(1);
  } finally {
    orchestrator.close();
  }
}

test();

