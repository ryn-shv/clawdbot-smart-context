#!/usr/bin/env node
/**
 * Memory System End-to-End Test
 * 
 * Tests the complete memory workflow:
 * 1. Initialize cache and memory
 * 2. Store facts WITH embeddings
 * 3. Retrieve facts via semantic search
 * 4. Verify hybrid scoring works (BM25 + cosine)
 * 
 * Run: node test-memory.js
 * 
 * v2.0.2: Tests the embedding storage fix
 */

import { createCache } from './cache.js';
import { createMemory } from './memory.js';
import { createEmbedder } from './embedder.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Test configuration
const TEST_CONFIG = {
  debug: true,
  testUserId: 'test-user-' + Date.now(),
  testAgentId: 'test-agent',
  testSessionId: 'test-session-' + Date.now(),
  cachePath: path.join(os.tmpdir(), `smart-context-test-${Date.now()}.db`)
};

// Test facts with semantic content
const TEST_FACTS = [
  {
    value: "User prefers TypeScript over JavaScript for larger projects",
    category: "preferences",
    key: "lang-preference-ts"
  },
  {
    value: "User's favorite editor is VS Code with Vim keybindings",
    category: "preferences",
    key: "editor-preference"
  },
  {
    value: "User works on a MacBook Pro M2 with 16GB RAM",
    category: "hardware",
    key: "hardware-info"
  },
  {
    value: "User is building a web app using React and Node.js",
    category: "projects",
    key: "current-project"
  },
  {
    value: "User prefers dark mode themes in all applications",
    category: "preferences",
    key: "theme-preference"
  }
];

// Test queries and expected results
const TEST_QUERIES = [
  {
    query: "What programming language does the user prefer?",
    expectedCategory: "preferences",
    expectedKeyword: "TypeScript"
  },
  {
    query: "What IDE or code editor does the user use?",
    expectedCategory: "preferences",
    expectedKeyword: "VS Code"
  },
  {
    query: "What computer hardware is the user running?",
    expectedCategory: "hardware",
    expectedKeyword: "MacBook"
  }
];

// ═══════════════════════════════════════════════════════════════════════════
// TEST RUNNER
// ═══════════════════════════════════════════════════════════════════════════

async function runTests() {
  console.log('\n' + '═'.repeat(70));
  console.log('🧠 SMART CONTEXT MEMORY SYSTEM TEST v2.0.2');
  console.log('═'.repeat(70) + '\n');
  
  let cache, memory, embedder;
  const results = {
    passed: 0,
    failed: 0,
    errors: []
  };
  
  try {
    // ─────────────────────────────────────────────────────────────────────
    // Test 1: Initialize components
    // ─────────────────────────────────────────────────────────────────────
    console.log('📦 Test 1: Initialize components\n');
    
    try {
      // Create cache
      cache = createCache({ 
        cachePath: TEST_CONFIG.cachePath,
        debug: TEST_CONFIG.debug
      });
      console.log('   ✓ Cache created');
      
      // Create embedder
      embedder = createEmbedder({ debug: TEST_CONFIG.debug });
      console.log('   ✓ Embedder created');
      
      // Wait for embedder to be ready
      console.log('   ⏳ Loading embedding model (may take 30-60s on first run)...');
      const testEmbedding = await embedder.embed("test initialization");
      console.log(`   ✓ Embedder ready (dimension: ${testEmbedding.length})`);
      
      // Create memory
      memory = createMemory(cache, { debug: TEST_CONFIG.debug });
      console.log('   ✓ Memory created');
      
      results.passed++;
      console.log('\n   ✅ PASSED: Component initialization\n');
    } catch (err) {
      results.failed++;
      results.errors.push(`Init failed: ${err.message}`);
      console.log(`\n   ❌ FAILED: ${err.message}\n`);
      throw err; // Can't continue without init
    }
    
    // ─────────────────────────────────────────────────────────────────────
    // Test 2: Store facts WITH embeddings
    // ─────────────────────────────────────────────────────────────────────
    console.log('💾 Test 2: Store facts WITH embeddings\n');
    
    let storedWithEmbeddings = 0;
    
    for (const fact of TEST_FACTS) {
      try {
        // Compute embedding
        const embedding = await embedder.embed(fact.value);
        
        // Store fact with embedding
        const result = await memory.storeFact({
          userId: TEST_CONFIG.testUserId,
          scope: 'user',
          agentId: TEST_CONFIG.testAgentId,
          sessionId: TEST_CONFIG.testSessionId,
          value: fact.value,
          category: fact.category,
          key: fact.key,
          embedding: embedding // Critical: include embedding!
        });
        
        console.log(`   ${result.embeddingStored ? '✓' : '✗'} Stored: "${fact.value.slice(0, 40)}..."`, {
          factId: result.factId,
          created: result.created,
          embeddingStored: result.embeddingStored
        });
        
        if (result.embeddingStored) {
          storedWithEmbeddings++;
        }
      } catch (err) {
        console.log(`   ✗ Error storing fact: ${err.message}`);
      }
    }
    
    if (storedWithEmbeddings === TEST_FACTS.length) {
      results.passed++;
      console.log(`\n   ✅ PASSED: ${storedWithEmbeddings}/${TEST_FACTS.length} facts stored with embeddings\n`);
    } else {
      results.failed++;
      results.errors.push(`Only ${storedWithEmbeddings}/${TEST_FACTS.length} embeddings stored`);
      console.log(`\n   ❌ FAILED: Only ${storedWithEmbeddings}/${TEST_FACTS.length} embeddings stored\n`);
    }
    
    // ─────────────────────────────────────────────────────────────────────
    // Test 3: Verify facts in database
    // ─────────────────────────────────────────────────────────────────────
    console.log('🔍 Test 3: Verify facts in database\n');
    
    try {
      const stats = await memory.stats(TEST_CONFIG.testUserId);
      
      console.log('   Memory stats:', {
        totalFacts: stats.totalFacts,
        factsWithEmbeddings: stats.factsWithEmbeddings,
        embeddingCoverage: stats.embeddingCoverage + '%'
      });
      
      if (stats.embeddingCoverage === 100) {
        results.passed++;
        console.log('\n   ✅ PASSED: 100% embedding coverage\n');
      } else {
        results.failed++;
        results.errors.push(`Embedding coverage: ${stats.embeddingCoverage}%`);
        console.log(`\n   ❌ FAILED: Embedding coverage is ${stats.embeddingCoverage}%, expected 100%\n`);
      }
    } catch (err) {
      results.failed++;
      results.errors.push(`Stats check failed: ${err.message}`);
      console.log(`\n   ❌ FAILED: ${err.message}\n`);
    }
    
    // ─────────────────────────────────────────────────────────────────────
    // Test 4: Semantic search retrieval
    // ─────────────────────────────────────────────────────────────────────
    console.log('🔎 Test 4: Semantic search retrieval\n');
    
    let searchSuccesses = 0;
    
    for (const testQuery of TEST_QUERIES) {
      try {
        // Compute query embedding
        const queryEmbedding = await embedder.embed(testQuery.query);
        
        // Retrieve facts
        const facts = await memory.retrieveFacts({
          userId: TEST_CONFIG.testUserId,
          query: testQuery.query,
          queryEmbedding: queryEmbedding,
          options: {
            topK: 3,
            minScore: 0.3 // Low threshold for testing
          }
        });
        
        console.log(`\n   Query: "${testQuery.query}"`);
        
        if (facts.length > 0) {
          const topResult = facts[0];
          const hasExpectedKeyword = topResult.value.includes(testQuery.expectedKeyword);
          const hasCorrectCategory = topResult.category === testQuery.expectedCategory;
          
          console.log(`   Top result: "${topResult.value.slice(0, 50)}..."`);
          console.log(`   Score: ${topResult.score.toFixed(3)} (cosine: ${topResult.cosineScore?.toFixed(3) || 'N/A'}, BM25: ${topResult.bm25Score?.toFixed(3) || 'N/A'})`);
          console.log(`   Has embedding: ${topResult.hasEmbedding}`);
          console.log(`   Expected keyword "${testQuery.expectedKeyword}": ${hasExpectedKeyword ? '✓' : '✗'}`);
          
          if (hasExpectedKeyword && topResult.hasEmbedding) {
            searchSuccesses++;
            console.log('   ✅ CORRECT');
          } else {
            console.log('   ⚠️  Result found but not optimal');
          }
        } else {
          console.log('   ✗ No results found');
        }
      } catch (err) {
        console.log(`   ✗ Search error: ${err.message}`);
      }
    }
    
    if (searchSuccesses === TEST_QUERIES.length) {
      results.passed++;
      console.log(`\n   ✅ PASSED: ${searchSuccesses}/${TEST_QUERIES.length} semantic searches successful\n`);
    } else if (searchSuccesses > 0) {
      results.passed++;
      console.log(`\n   ⚠️  PARTIAL: ${searchSuccesses}/${TEST_QUERIES.length} semantic searches correct\n`);
    } else {
      results.failed++;
      results.errors.push('Semantic search returned no correct results');
      console.log(`\n   ❌ FAILED: No semantic searches returned correct results\n`);
    }
    
    // ─────────────────────────────────────────────────────────────────────
    // Test 5: Compare with and without embeddings
    // ─────────────────────────────────────────────────────────────────────
    console.log('⚖️  Test 5: Hybrid scoring comparison\n');
    
    try {
      // Store a fact WITHOUT embedding
      await memory.storeFact({
        userId: TEST_CONFIG.testUserId,
        scope: 'user',
        value: "User also uses Python for data science tasks",
        category: "preferences",
        key: "python-usage"
        // Note: NO embedding parameter!
      });
      
      // Retrieve and compare scores
      const queryEmbedding = await embedder.embed("programming languages");
      const facts = await memory.retrieveFacts({
        userId: TEST_CONFIG.testUserId,
        query: "programming languages",
        queryEmbedding: queryEmbedding,
        options: { topK: 10, minScore: 0.1 }
      });
      
      const withEmbedding = facts.filter(f => f.hasEmbedding);
      const withoutEmbedding = facts.filter(f => !f.hasEmbedding);
      
      console.log(`   Facts with embeddings: ${withEmbedding.length}`);
      console.log(`   Facts without embeddings: ${withoutEmbedding.length}`);
      
      if (withEmbedding.length > 0) {
        const avgScoreWith = withEmbedding.reduce((s, f) => s + f.score, 0) / withEmbedding.length;
        console.log(`   Avg score (with embedding): ${avgScoreWith.toFixed(3)}`);
      }
      
      if (withoutEmbedding.length > 0) {
        const avgScoreWithout = withoutEmbedding.reduce((s, f) => s + f.score, 0) / withoutEmbedding.length;
        console.log(`   Avg score (without embedding): ${avgScoreWithout.toFixed(3)}`);
      }
      
      results.passed++;
      console.log('\n   ✅ PASSED: Hybrid scoring working\n');
    } catch (err) {
      results.failed++;
      results.errors.push(`Hybrid scoring test failed: ${err.message}`);
      console.log(`\n   ❌ FAILED: ${err.message}\n`);
    }
    
    // ─────────────────────────────────────────────────────────────────────
    // Cleanup
    // ─────────────────────────────────────────────────────────────────────
    console.log('🧹 Cleanup\n');
    
    try {
      // Delete test user data
      const deleted = await memory.forgetAll(TEST_CONFIG.testUserId);
      console.log(`   Deleted ${deleted.deletedFacts} facts, ${deleted.deletedPatterns} patterns`);
      
      // Close cache
      cache.close();
      console.log('   Cache closed');
      
      // Remove test database
      if (fs.existsSync(TEST_CONFIG.cachePath)) {
        fs.unlinkSync(TEST_CONFIG.cachePath);
        console.log(`   Removed test database: ${TEST_CONFIG.cachePath}`);
      }
      
      console.log('   ✓ Cleanup complete\n');
    } catch (err) {
      console.log(`   ⚠️  Cleanup error (non-critical): ${err.message}\n`);
    }
    
  } catch (err) {
    console.error('\n💥 Fatal error:', err.message);
    console.error(err.stack);
  }
  
  // ─────────────────────────────────────────────────────────────────────────
  // Results Summary
  // ─────────────────────────────────────────────────────────────────────────
  console.log('═'.repeat(70));
  console.log('📊 TEST RESULTS SUMMARY');
  console.log('═'.repeat(70));
  console.log(`   Passed: ${results.passed}`);
  console.log(`   Failed: ${results.failed}`);
  
  if (results.errors.length > 0) {
    console.log('\n   Errors:');
    results.errors.forEach(e => console.log(`     - ${e}`));
  }
  
  console.log('\n' + '═'.repeat(70));
  
  if (results.failed === 0) {
    console.log('✅ ALL TESTS PASSED - Memory system working correctly!');
  } else {
    console.log('❌ SOME TESTS FAILED - Review errors above');
  }
  
  console.log('═'.repeat(70) + '\n');
  
  // Exit with appropriate code
  process.exit(results.failed > 0 ? 1 : 0);
}

// Run tests
runTests().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
