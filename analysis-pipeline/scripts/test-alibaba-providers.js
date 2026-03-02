#!/usr/bin/env node

/**
 * Test script for Alibaba Cloud embedding and reranking providers
 *
 * Tests:
 * 1. API connectivity
 * 2. Embedding generation
 * 3. Batch embedding
 * 4. Dimension verification
 * 5. Usage tracking
 * 6. Reranking (when available)
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: join(__dirname, '../config/.env') });

// Test configuration
const TEST_TEXTS = [
  'Dette er en test af embeddings på dansk.',
  'Høringssvar vedrørende lokalplan for byudvikling.',
  'Borgerne ønsker mere grønne områder i byen.',
  'Trafik og parkering er vigtige emner for beboerne.',
  'Bevaringsværdige bygninger skal beskyttes.'
];

const TEST_QUERY = 'Hvilke emner er vigtige for borgerne?';

async function testAlibabaEmbedding() {
  console.log('\n========================================');
  console.log('Testing Alibaba Cloud Embedding Provider');
  console.log('========================================\n');

  // Check API key
  const apiKey = process.env.ALIBABA_API_KEY || process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    console.log('❌ ALIBABA_API_KEY not found in environment');
    console.log('   Please set ALIBABA_API_KEY in config/.env');
    return false;
  }
  console.log('✅ API key found');

  try {
    // Import the provider
    const { AlibabaEmbeddingProvider } = await import('../src/embedding/providers/alibaba-embedding-provider.js');

    // Create provider instance
    console.log('\nInitializing Alibaba embedding provider...');
    const provider = new AlibabaEmbeddingProvider({
      dimensions: 2048
    });

    console.log(`   Model: ${provider.model}`);
    console.log(`   Dimensions: ${provider.getDimensions()}`);

    // Test single embedding
    console.log('\n1. Testing single text embedding...');
    const startSingle = Date.now();
    const singleEmbedding = await provider.embedQuery(TEST_TEXTS[0]);
    const singleTime = Date.now() - startSingle;

    if (singleEmbedding && singleEmbedding.length > 0) {
      console.log(`   ✅ Single embedding successful (${singleTime}ms)`);
      console.log(`   Embedding length: ${singleEmbedding.length}`);
      console.log(`   First 5 values: [${singleEmbedding.slice(0, 5).map(v => v.toFixed(4)).join(', ')}...]`);

      // Verify dimensions
      if (singleEmbedding.length === 2048) {
        console.log('   ✅ Dimension verification passed (2048)');
      } else {
        console.log(`   ⚠️ Unexpected dimension: ${singleEmbedding.length} (expected 2048)`);
      }
    } else {
      console.log('   ❌ Single embedding failed - empty result');
      return false;
    }

    // Test batch embedding
    console.log('\n2. Testing batch embedding (5 texts)...');
    const startBatch = Date.now();
    const batchEmbeddings = await provider.embedBatch(TEST_TEXTS);
    const batchTime = Date.now() - startBatch;

    if (batchEmbeddings && batchEmbeddings.length === TEST_TEXTS.length) {
      console.log(`   ✅ Batch embedding successful (${batchTime}ms)`);
      console.log(`   Returned ${batchEmbeddings.length} embeddings`);

      // Verify all embeddings have correct dimension
      const allCorrectDim = batchEmbeddings.every(e => e && e.length === 2048);
      if (allCorrectDim) {
        console.log('   ✅ All embeddings have correct dimension (2048)');
      } else {
        console.log('   ⚠️ Some embeddings have incorrect dimension');
      }
    } else {
      console.log('   ❌ Batch embedding failed');
      return false;
    }

    // Test usage tracking
    console.log('\n3. Testing usage tracking...');
    const usage = provider.getUsage();
    console.log(`   Total tokens: ${usage.totalTokens}`);
    console.log(`   Total calls: ${usage.totalCalls}`);
    console.log(`   Total texts: ${usage.totalTexts}`);
    console.log(`   Model: ${usage.model}`);
    console.log(`   Provider: ${usage.provider}`);

    if (usage.totalTokens > 0 && usage.totalCalls > 0) {
      console.log('   ✅ Usage tracking working');
    } else {
      console.log('   ⚠️ Usage tracking may not be working correctly');
    }

    // Calculate cosine similarity between two embeddings
    console.log('\n4. Testing cosine similarity...');
    const cosineSim = (a, b) => {
      let dot = 0, normA = 0, normB = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
      }
      return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    };

    // Similarity between similar texts (should be high)
    const sim12 = cosineSim(batchEmbeddings[1], batchEmbeddings[2]); // lokalplan vs grønne områder
    // Similarity between dissimilar texts
    const sim13 = cosineSim(batchEmbeddings[0], batchEmbeddings[3]); // test vs trafik

    console.log(`   Similarity (lokalplan ↔ grønne områder): ${sim12.toFixed(4)}`);
    console.log(`   Similarity (test ↔ trafik): ${sim13.toFixed(4)}`);

    if (sim12 > 0.5) {
      console.log('   ✅ Related texts have reasonable similarity');
    }

    console.log('\n✅ Alibaba embedding provider tests PASSED');
    return true;

  } catch (error) {
    console.log(`\n❌ Test failed with error: ${error.message}`);
    console.log('\nFull error:');
    console.log(error);
    return false;
  }
}

async function testEmbeddingServiceWithAlibaba() {
  console.log('\n========================================');
  console.log('Testing EmbeddingService with Alibaba');
  console.log('========================================\n');

  try {
    const { EmbeddingService } = await import('../src/embedding/embedding-service.js');

    // Create EmbeddingService with alibaba provider
    console.log('Creating EmbeddingService with provider=alibaba...');
    const service = new EmbeddingService({ provider: 'alibaba' });

    console.log(`   Provider: ${service.getProviderName()}`);
    console.log(`   Dimensions: ${service.getDimensions()}`);

    // Test embedding
    console.log('\nTesting embedBatch through EmbeddingService...');
    const embeddings = await service.embedBatch(TEST_TEXTS.slice(0, 2));

    if (embeddings && embeddings.length === 2) {
      console.log(`   ✅ EmbeddingService delegation working`);
      console.log(`   Embedding 1 length: ${embeddings[0].length}`);
      console.log(`   Embedding 2 length: ${embeddings[1].length}`);
    } else {
      console.log('   ❌ EmbeddingService delegation failed');
      return false;
    }

    // Check usage
    const usage = service.getUsage();
    console.log(`\n   Usage: ${usage.totalTokens} tokens, ${usage.totalCalls} calls`);

    console.log('\n✅ EmbeddingService with Alibaba tests PASSED');
    return true;

  } catch (error) {
    console.log(`\n❌ Test failed with error: ${error.message}`);
    console.log(error.stack);
    return false;
  }
}

async function testProviderFactory() {
  console.log('\n========================================');
  console.log('Testing Embedding Provider Factory');
  console.log('========================================\n');

  try {
    const {
      getEmbeddingProvider,
      getEmbeddingProviderName,
      getEmbeddingDimensions,
      isProviderAvailable,
      listProviders
    } = await import('../src/embedding/embedding-provider-factory.js');

    // List all providers
    console.log('Available providers:');
    const providers = listProviders();
    for (const p of providers) {
      const status = p.available ? '✅' : '❌';
      console.log(`   ${status} ${p.name}: model=${p.model}, dim=${p.dimensions}`);
    }

    // Test provider creation
    console.log('\nTesting provider creation...');

    // OpenAI provider
    if (isProviderAvailable('openai')) {
      const openaiProvider = await getEmbeddingProvider({ provider: 'openai' });
      console.log(`   ✅ OpenAI provider created: ${openaiProvider.getProviderName()}`);
    }

    // Alibaba provider
    if (isProviderAvailable('alibaba')) {
      const alibabaProvider = await getEmbeddingProvider({ provider: 'alibaba' });
      console.log(`   ✅ Alibaba provider created: ${alibabaProvider.getProviderName()}`);
    }

    console.log('\n✅ Provider factory tests PASSED');
    return true;

  } catch (error) {
    console.log(`\n❌ Test failed with error: ${error.message}`);
    return false;
  }
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║       Alibaba Cloud Provider Test Suite                ║');
  console.log('╚════════════════════════════════════════════════════════╝');

  let allPassed = true;

  // Test 1: Direct Alibaba embedding provider
  const embeddingPassed = await testAlibabaEmbedding();
  allPassed = allPassed && embeddingPassed;

  // Test 2: EmbeddingService with Alibaba
  if (embeddingPassed) {
    const servicePassed = await testEmbeddingServiceWithAlibaba();
    allPassed = allPassed && servicePassed;
  }

  // Test 3: Provider factory
  const factoryPassed = await testProviderFactory();
  allPassed = allPassed && factoryPassed;

  // Summary
  console.log('\n========================================');
  console.log('TEST SUMMARY');
  console.log('========================================');

  if (allPassed) {
    console.log('\n✅ All tests PASSED');
    console.log('\nYou can now use Alibaba Cloud embeddings by setting:');
    console.log('   EMBEDDING_PROVIDER=alibaba');
    console.log('in your config/.env file.');
  } else {
    console.log('\n❌ Some tests FAILED');
    console.log('\nPlease check the error messages above.');
  }

  process.exit(allPassed ? 0 : 1);
}

main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
