/**
 * Force checkpoint and check for GDPR data
 */

import Database from 'better-sqlite3';
import { resolve } from 'path';

const dbPath = resolve('/home/laqzww/gdpr/data/app.sqlite');

try {
  const db = new Database(dbPath);
  
  console.log(`=== Force checkpoint and check GDPR data ===\n`);
  
  // Force checkpoint multiple times
  db.pragma('wal_checkpoint(FULL)');
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.pragma('wal_checkpoint(FULL)');
  console.log(`✓ Checkpoint completed`);
  
  const hearingId = 168;
  
  // Check published_responses
  const publishedCount = db.prepare(`
    SELECT COUNT(*) as count
    FROM published_responses
    WHERE hearing_id = ?
  `).get(hearingId);
  
  console.log(`\npublished_responses for hearing ${hearingId}: ${publishedCount.count} rows`);
  
  if (publishedCount.count > 0) {
    const sample = db.prepare(`
      SELECT response_id, text_md, LENGTH(text_md) as md_len, respondent_name
      FROM published_responses
      WHERE hearing_id = ?
      LIMIT 1
    `).get(hearingId);
    
    console.log(`\nSample published response:`);
    console.log(`  ID: ${sample.response_id}`);
    console.log(`  Text MD length: ${sample.md_len}`);
    console.log(`  Respondent name: ${sample.respondent_name || 'null'}`);
    console.log(`  Contains "Peter Munk": ${(sample.text_md || '').includes('Peter Munk')}`);
    console.log(`  Contains "Borger": ${(sample.text_md || '').includes('Borger')}`);
  }
  
  // Check prepared_responses
  const preparedCount = db.prepare(`
    SELECT COUNT(*) as count
    FROM prepared_responses
    WHERE hearing_id = ?
  `).get(hearingId);
  
  console.log(`\nprepared_responses for hearing ${hearingId}: ${preparedCount.count} rows`);
  
  // Check published_attachments
  const attachmentCount = db.prepare(`
    SELECT COUNT(*) as count
    FROM published_attachments
    WHERE hearing_id = ? AND content_md IS NOT NULL AND content_md != ''
  `).get(hearingId);
  
  console.log(`\npublished_attachments with markdown: ${attachmentCount.count} rows`);
  
  if (attachmentCount.count > 0) {
    const sample = db.prepare(`
      SELECT response_id, attachment_id, original_filename, LENGTH(content_md) as md_len
      FROM published_attachments
      WHERE hearing_id = ? AND content_md IS NOT NULL AND content_md != ''
      LIMIT 1
    `).get(hearingId);
    
    console.log(`\nSample published attachment:`);
    console.log(`  Response ID: ${sample.response_id}`);
    console.log(`  Filename: ${sample.original_filename}`);
    console.log(`  Markdown length: ${sample.md_len} chars`);
  }
  
  db.close();
} catch (e) {
  console.error(`Error: ${e.message}`);
  console.error(e.stack);
}

