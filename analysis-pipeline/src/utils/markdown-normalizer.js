/**
 * Markdown Normalizer
 * 
 * Normalizes markdown content, specifically handling newline characters
 * in CriticMarkup comments before DOCX conversion.
 */

/**
 * Normalize newline characters in CriticMarkup comments
 * Replaces literal \n strings with actual newlines within {>>...<<} blocks
 * 
 * @param {string} markdown - Markdown string with CriticMarkup
 * @returns {string} Normalized markdown with actual newlines in comments
 */
export function normalizeMarkdownNewlines(markdown) {
  if (!markdown || typeof markdown !== 'string') {
    return markdown;
  }

  // Pattern to match CriticMarkup comment blocks: {>>...<<}
  // Using non-greedy match to handle multiple comment blocks
  const commentPattern = /(\{>>)(.*?)(<<\})/gs;
  
  return markdown.replace(commentPattern, (match, openTag, commentContent, closeTag) => {
    // Replace literal \n with actual newlines within the comment content
    const normalizedContent = commentContent.replace(/\\n/g, '\n');
    return openTag + normalizedContent + closeTag;
  });
}

/**
 * Normalize all escaped characters in markdown
 * Handles literal \n, \t, and escaped quotes throughout the document
 * 
 * @param {string} markdown - Markdown string
 * @returns {string} Normalized markdown with actual characters
 */
export function normalizeEscapedCharacters(markdown) {
  if (!markdown || typeof markdown !== 'string') {
    return markdown;
  }

  // Replace literal \n with actual newlines throughout the document
  let normalized = markdown.replace(/\\n/g, '\n');
  
  // Replace literal \t with actual tabs
  normalized = normalized.replace(/\\t/g, '\t');
  
  // Replace escaped quotes (but preserve them in certain contexts like JSON blocks)
  // Only replace escaped quotes that are not part of code blocks
  const codeBlockPattern = /(```[\s\S]*?```|`[^`]*`)/g;
  const parts = [];
  let lastIndex = 0;
  let match;
  
  // Extract code blocks to preserve them
  while ((match = codeBlockPattern.exec(normalized)) !== null) {
    // Process text before code block
    if (match.index > lastIndex) {
      parts.push({
        type: 'text',
        content: normalized.substring(lastIndex, match.index)
      });
    }
    // Preserve code block as-is
    parts.push({
      type: 'code',
      content: match[0]
    });
    lastIndex = match.index + match[0].length;
  }
  
  // Process remaining text after last code block
  if (lastIndex < normalized.length) {
    parts.push({
      type: 'text',
      content: normalized.substring(lastIndex)
    });
  }
  
  // Now process only non-code parts
  normalized = parts.map(part => {
    if (part.type === 'text') {
      // Replace escaped quotes in regular text
      return part.content
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'");
    }
    return part.content;
  }).join('');
  
  return normalized;
}

/**
 * Normalize all newline-related issues in markdown
 * This is a more comprehensive normalization that handles:
 * - Literal \n throughout the document
 * - Literal \n in CriticMarkup comments (additional pass for safety)
 * - Windows/Mac line endings
 * - Other escaped characters
 * 
 * @param {string} markdown - Markdown string
 * @returns {string} Fully normalized markdown
 */
export function normalizeMarkdown(markdown) {
  if (!markdown || typeof markdown !== 'string') {
    return markdown;
  }

  // First handle all escaped characters throughout the document
  let normalized = normalizeEscapedCharacters(markdown);
  
  // Then do specific CriticMarkup normalization (in case any \n were missed)
  normalized = normalizeMarkdownNewlines(normalized);
  
  // Normalize line endings (Windows/Mac to Unix)
  normalized = normalized.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  
  return normalized;
}








