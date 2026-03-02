#!/usr/bin/env node
/**
 * Test script for the reranker integration
 * 
 * Tests the ModelReranker and HybridRetriever integration.
 */

import { ModelReranker } from '../src/retrieval/model-reranker.js';
import { HybridRetriever } from '../src/retrieval/hybrid-retriever.js';

async function testModelReranker() {
  console.log('=== Testing ModelReranker ===\n');
  
  const reranker = new ModelReranker({
    enabled: true,
    modelName: 'BAAI/bge-reranker-v2-m3'
  });
  
  // Test 1: Check availability
  console.log('1. Checking Python environment and dependencies...');
  const available = await reranker.checkAvailability();
  console.log(`   Status: ${available ? '✅ Available' : '❌ Not available'}\n`);
  
  if (!available) {
    console.log('   Please install dependencies:');
    console.log('   pip install -U FlagEmbedding\n');
    return false;
  }
  
  // Test 2: Warm up model
  console.log('2. Warming up model (first load may take time)...');
  const warmupSuccess = await reranker.warmup();
  console.log(`   Status: ${warmupSuccess ? '✅ Warmed up' : '❌ Failed'}\n`);
  
  // Test 3: Rerank sample data
  console.log('3. Testing reranking with sample data...');
  const query = 'GDPR databeskyttelse';
  const testChunks = [
    {
      chunk: {
        content: 'Artikel 6 i GDPR beskriver de lovlige grundlag for behandling af personoplysninger.',
        chunkId: '1'
      },
      score: 0.7
    },
    {
      chunk: {
        content: 'Vejret i København er solrigt i dag.',
        chunkId: '2'
      },
      score: 0.6
    },
    {
      chunk: {
        content: 'Databeskyttelsesforordningen stiller krav til organisationers sikkerhedsforanstaltninger.',
        chunkId: '3'
      },
      score: 0.8
    }
  ];
  
  try {
    const reranked = await reranker.rerank(query, testChunks);
    console.log(`   Query: "${query}"`);
    console.log('   Results:');
    reranked
      .sort((a, b) => (b.rerankScore || b.score) - (a.rerankScore || a.score))
      .forEach((item, idx) => {
        const content = item.chunk.content.substring(0, 60) + '...';
        console.log(`   ${idx + 1}. Score: ${(item.rerankScore || item.score).toFixed(3)} - ${content}`);
      });
    console.log('   ✅ Reranking successful\n');
    return true;
  } catch (error) {
    console.log(`   ❌ Reranking failed: ${error.message}\n`);
    return false;
  }
}

async function testHybridRetrieverIntegration() {
  console.log('=== Testing HybridRetriever Integration ===\n');
  
  const retriever = new HybridRetriever({
    reRank: true,
    topK: 5,
    reRankTopK: 3
  });
  
  // Create sample chunks with embeddings
  const sampleChunks = [
    {
      content: 'GDPR Artikel 6 beskriver lovligt grundlag for databehandling.',
      chunkId: '1',
      embedding: Array(1536).fill(0).map(() => Math.random()),
      source: 'material-1'
    },
    {
      content: 'Databeskyttelsesforordningen kræver passende tekniske foranstaltninger.',
      chunkId: '2',
      embedding: Array(1536).fill(0).map(() => Math.random()),
      source: 'material-1'
    },
    {
      content: 'Vejret er solrigt i Danmark i dag.',
      chunkId: '3',
      embedding: Array(1536).fill(0).map(() => Math.random()),
      source: 'material-2'
    },
    {
      content: 'Personoplysninger skal beskyttes i henhold til GDPR.',
      chunkId: '4',
      embedding: Array(1536).fill(0).map(() => Math.random()),
      source: 'material-1'
    },
    {
      content: 'Cookie samtykke skal indhentes før brug.',
      chunkId: '5',
      embedding: Array(1536).fill(0).map(() => Math.random()),
      source: 'material-3'
    }
  ];
  
  const query = 'GDPR databeskyttelseskrav';
  
  console.log(`Query: "${query}"`);
  console.log(`Chunks: ${sampleChunks.length}`);
  console.log('Retrieving with reranking enabled...\n');
  
  try {
    const results = await retriever.retrieve(query, sampleChunks, {
      topK: 3,
      reRank: true,
      reRankTopK: 2
    });
    
    console.log(`Results (${results.length}):`);
    results.forEach((item, idx) => {
      const content = item.chunk.content.substring(0, 50) + '...';
      console.log(`${idx + 1}. Score: ${item.score.toFixed(3)} ${item.rerankScore ? `(rerank: ${item.rerankScore.toFixed(3)})` : ''}`);
      console.log(`   ${content}`);
    });
    
    console.log('\n✅ HybridRetriever integration successful');
    return true;
  } catch (error) {
    console.log(`\n❌ Integration test failed: ${error.message}`);
    console.error(error);
    return false;
  }
}

async function main() {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║  Reranker Integration Test Suite      ║');
  console.log('╚════════════════════════════════════════╝\n');
  
  const rerankerSuccess = await testModelReranker();
  
  if (rerankerSuccess) {
    console.log('\n');
    await testHybridRetrieverIntegration();
  }
  
  console.log('\n=== Test Complete ===\n');
}

main().catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});







