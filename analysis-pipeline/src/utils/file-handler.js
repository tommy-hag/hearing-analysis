/**
 * File Handler
 * 
 * Handles edge cases for PDF, DOCX, images, and encoding issues.
 * Note: This is a basic implementation - full file conversion would require
 * integration with existing convertFileToMarkdown functionality.
 */

import { readFileSync, existsSync } from 'fs';
import { extname } from 'path';

export class FileHandler {
  /**
   * Process file and return structured content
   * @param {string} filePath - Path to file
   * @param {Object} options - Processing options
   * @returns {Promise<Object>} Structured content with metadata
   */
  async processFile(filePath, options = {}) {
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileExtension = extname(filePath).toLowerCase();
    const result = {
      filePath: filePath,
      extension: fileExtension,
      contentType: this.detectContentType(fileExtension),
      content: null,
      contentMd: null,
      encoding: 'utf-8',
      error: null,
      edgeCaseFlags: {
        hasImages: false,
        hasTables: false,
        encodingIssues: false,
        conversionIssues: false
      }
    };

    try {
      // For markdown/text files, read directly
      if (['.md', '.txt', '.text'].includes(fileExtension)) {
        result.content = readFileSync(filePath, 'utf-8');
        result.contentMd = result.content;
        return result;
      }

      // For other file types, note that conversion is needed
      // In production, this would call convertFileToMarkdown
      result.edgeCaseFlags.conversionIssues = true;
      result.error = `File type ${fileExtension} requires conversion (not implemented in this module)`;
      
      return result;
    } catch (error) {
      // Try different encodings
      try {
        result.content = readFileSync(filePath, 'latin1');
        result.encoding = 'latin1';
        result.edgeCaseFlags.encodingIssues = true;
        result.contentMd = result.content;
        return result;
      } catch (err) {
        result.error = `Failed to read file: ${error.message}`;
        return result;
      }
    }
  }

  /**
   * Detect content type from extension
   */
  detectContentType(extension) {
    const typeMap = {
      '.pdf': 'application/pdf',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.doc': 'application/msword',
      '.md': 'text/markdown',
      '.txt': 'text/plain',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif'
    };

    return typeMap[extension.toLowerCase()] || 'application/octet-stream';
  }

  /**
   * Check if file is analyzable (has text content)
   */
  isAnalyzable(filePath) {
    const extension = extname(filePath).toLowerCase();
    
    // Text-based formats are analyzable
    if (['.md', '.txt', '.text'].includes(extension)) {
      return true;
    }

    // PDF and DOCX can be converted (if conversion is available)
    if (['.pdf', '.docx', '.doc'].includes(extension)) {
      return true; // Assuming conversion is available
    }

    // Images are not directly analyzable (would need OCR)
    if (['.jpg', '.jpeg', '.png', '.gif'].includes(extension)) {
      return false;
    }

    return false;
  }
}




