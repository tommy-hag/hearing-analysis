/**
 * Test material summarizer with actual data
 */

import { DataLoader } from '../src/utils/data-loader.js';
import { MaterialSummarizer } from '../src/utils/material-summarizer.js';

async function test() {
  const dataLoader = new DataLoader();
  const materialSummarizer = new MaterialSummarizer();
  
  try {
    const data = await dataLoader.loadPublishedHearing(168);
    
    console.log('Materials loaded:');
    data.materials.forEach((m, i) => {
      console.log(`\nMaterial ${i}:`);
      console.log(`  title: ${m.title}`);
      console.log(`  contentMd length: ${m.contentMd?.length || 'null'}`);
      console.log(`  contentMd preview: ${m.contentMd?.substring(0, 200) || 'null'}`);
    });
    
    console.log('\n\nCalling materialSummarizer.summarize()...');
    const summary = await materialSummarizer.summarize(data.materials);
    
    console.log('\nSummary result:');
    console.log(`  Length: ${summary.length}`);
    console.log(`  Preview: ${summary.substring(0, 500)}`);
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    dataLoader.close();
  }
}

test();



