/**
 * Output Formatter
 * 
 * Formats analysis result as markdown with CriticMarkup for build_docx integration.
 */

import { DanishNumberFormatter } from './danish-number-formatter.js';

export class OutputFormatter {
  /**
   * Compress an array of sorted numbers into a compact range string.
   * E.g., [1, 2, 3, 5, 7, 8, 9, 10] → "1-3, 5, 7-10"
   * @param {number[]} numbers - Sorted array of numbers
   * @returns {string} Compressed range string
   */
  static compressNumberRange(numbers) {
    if (!numbers || numbers.length === 0) return '';
    if (numbers.length === 1) return String(numbers[0]);
    
    // Ensure numbers are sorted and unique
    const sorted = [...new Set(numbers)].sort((a, b) => a - b);
    
    const ranges = [];
    let rangeStart = sorted[0];
    let rangeEnd = sorted[0];
    
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === rangeEnd + 1) {
        // Continue the current range
        rangeEnd = sorted[i];
      } else {
        // End current range and start a new one
        if (rangeStart === rangeEnd) {
          ranges.push(String(rangeStart));
        } else {
          ranges.push(`${rangeStart}-${rangeEnd}`);
        }
        rangeStart = sorted[i];
        rangeEnd = sorted[i];
      }
    }
    
    // Don't forget the last range
    if (rangeStart === rangeEnd) {
      ranges.push(String(rangeStart));
    } else {
      ranges.push(`${rangeStart}-${rangeEnd}`);
    }
    
    return ranges.join(', ');
  }

  /**
   * Clean quote text by removing "rough cut" artifacts.
   * Safety net for quotes that slip through earlier cleaning.
   * @param {string} quote - Raw quote text
   * @returns {string} Cleaned quote text
   * @private
   */
  cleanQuoteForOutput(quote) {
    if (!quote || typeof quote !== 'string') return quote;
    
    let cleaned = quote.trim();
    
    // Patterns for "rough cut" artifacts at the start of quotes
    const roughCutPatterns = [
      // Punctuation at start (period, comma, colon, semicolon, exclamation, question mark)
      /^[.,:;!?\s]+/,
      // List numbers: "1)", "2.", "1.", "a)", "b.", with optional tab/space
      /^(\d+[\)\.\s][\t\s]*)/,
      /^([a-zæøå][\)\.\s][\t\s]*)/i,
      // Bullet points: "•", "-", "–", "—", "●", "○"
      /^([-•●○–—]\s*)/,
      // Tabs at start
      /^[\t]+/,
    ];
    
    // Apply patterns iteratively until no more changes
    let previousLength;
    do {
      previousLength = cleaned.length;
      for (const pattern of roughCutPatterns) {
        cleaned = cleaned.replace(pattern, '');
      }
      cleaned = cleaned.trim();
    } while (cleaned.length < previousLength && cleaned.length > 0);
    
    // Capitalize first letter if we removed something
    if (cleaned.length > 0 && cleaned !== quote.trim()) {
      cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    }
    
    return cleaned;
  }

  /**
   * Format analysis result for DOCX
   * @param {Object} analysisResult - Analysis result with topics and considerations
   * @returns {string} Markdown string with CriticMarkup
   */
  formatForDocx(analysisResult) {
    const { considerations, topics } = analysisResult;

    let markdown = '';

    // Ensure topics exists (handle edge case where it might be undefined)
    if (!topics || !Array.isArray(topics)) {
      console.warn('[OutputFormatter] No topics provided, returning empty markdown');
      return markdown;
    }

    // Filter out empty topics (no positions)
    const topicsWithPositions = topics.filter(topic =>
      topic.positions && topic.positions.length > 0
    );

    // Format each topic
    topicsWithPositions.forEach((topic, topicIdx) => {
      // Topic heading - highlight the topic name when adding considerations
      if (topicIdx === 0 && considerations && considerations.trim()) {
        // First topic with considerations: highlight the topic name
        markdown += `# {==${topic.name}==} {>>${considerations}<<}`;
      } else {
        // Other topics: just the name
        markdown += `# ${topic.name}`;
      }
      markdown += '\n';

      // Format each position
      topic.positions.forEach((position, posIdx) => {
        // Check if this is a sub-position (skip, will be formatted under master)
        if (position._isSubPosition) {
          return; // Skip sub-positions, they're formatted under master
        }

        // Position title - format: "## (N, LU/O) Titel" or "## (N) Titel"
        const responseCount = position.responseNumbers?.length || 0;
        const breakdown = position.respondentBreakdown || {};
        const hasLU = breakdown.localCommittees && breakdown.localCommittees.length > 0;
        const hasO = breakdown.organizations && breakdown.organizations.length > 0;
        const hasPublicAuth = breakdown.publicAuthorities && breakdown.publicAuthorities.length > 0;

        // Remove existing prefix from title if present (e.g., "(1) Titel" -> "Titel")
        let cleanTitle = position.title || '';
        cleanTitle = cleanTitle.replace(/^\(\d+(?:,\s*(?:LU|O))?\)\s*/, '');

        let titlePrefix = `(${responseCount}`;
        if (hasLU) titlePrefix += ', LU';
        if (hasO) titlePrefix += ', O';
        if (hasPublicAuth && !hasLU && !hasO) titlePrefix += ', O'; // Public authorities count as O
        titlePrefix += ')';

        // Position title - no special handling for sub-positions
        markdown += `## ${titlePrefix} ${cleanTitle}\n`;

        // Add response numbers as "Henvendelse X" or "Henvendelse X, Y og Z"
        if (position.responseNumbers && position.responseNumbers.length > 0) {
          // Create a COPY to avoid mutating original array
          const responseNums = [...position.responseNumbers].sort((a, b) => a - b);
          let responseText = 'Henvendelse';
          if (responseNums.length === 1) {
            responseText += ` ${responseNums[0]}`;
          } else if (responseNums.length === 2) {
            responseText += ` ${responseNums[0]} og ${responseNums[1]}`;
          } else {
            const last = responseNums.pop();
            responseText += ` ${responseNums.join(', ')} og ${last}`;
          }
          markdown += `${responseText}\n`;
        }

        // Summary with citations
        if (position.criticMarkupSummary) {
          // Use the pre-formatted CriticMarkup summary if available
          // Post-process: replace semicolons with periods and capitalize next word
          let cleanedSummary = position.criticMarkupSummary.replace(/;\s*([a-zæøå])/g, (match, p1) => `. ${p1.toUpperCase()}`);
          // Post-process: Remove forbidden parenthetical references (nr. X, Y)
          cleanedSummary = this.removeParentheticalReferences(cleanedSummary);
          markdown += cleanedSummary;
        } else if (position.summary) {
          let summaryText = position.summary;
          // Post-process: replace semicolons with periods and capitalize next word
          summaryText = summaryText.replace(/;\s*([a-zæøå])/g, (match, p1) => `. ${p1.toUpperCase()}`);
          // Post-process: Remove forbidden parenthetical references (nr. X, Y)
          summaryText = this.removeParentheticalReferences(summaryText);

          // Convert hybridReferences to CriticMarkup
          if (position.hybridReferences && position.hybridReferences.length > 0) {
            // Build a map of placeholder -> comment
            const placeholderMap = new Map();

            for (const ref of position.hybridReferences) {
              const placeholder = `<<${ref.id}>>`;

              // REMOVE ENTIRELY: If this reference is a duplicate of a previous one,
              // it should be removed entirely from the output. The LLM should have used
              // a pronoun instead of a new label. We remove both label and placeholder.
              if (ref.removeFromOutput) {
                // Mark for complete removal: remove both the label AND the placeholder
                placeholderMap.set(placeholder, { removeEntirely: true, label: ref.label });
                console.log(`[OutputFormatter] 🗑️ Marking ${ref.id} for complete removal (duplicate reference)`);
                continue;
              }

              // SKIP ANNOTATION: If this reference is marked to skip citation extraction AND has no notes,
              // it means this is a subsequent reference in a single-respondent position.
              // These should produce NO comment annotation - just remove the placeholder and keep the label.
              if (ref.skipCitationExtraction && (!ref.notes || !ref.notes.trim())) {
                // Mark for placeholder removal without annotation (empty comment = no {>><<} block)
                placeholderMap.set(placeholder, { comment: '', label: ref.label, skipAnnotation: true });
                console.log(`[OutputFormatter] Marking ${ref.id} for annotation-free rendering (single-respondent subsequent reference)`);
                continue;
              }

              // Build CriticMarkup comment from quotes
              let comment = '';

              // CRITICAL FIX: Always show ALL respondent numbers, not just those with quotes
              // This ensures "Seks borgere" actually shows 6 henvendelse references
              const allRespondentNumbers = (ref.respondents || []).sort((a, b) => a - b);
              const respondentsWithQuotes = new Set(
                (ref.quotes || [])
                  .filter(q => q.quote && q.quote.trim() && !q.quote.includes('[MANGLER'))
                  .map(q => q.responseNumber)
              );
              
              // For >15 respondents: always generate compressed list from array (ignore pre-set notes)
              if (allRespondentNumbers.length > 15) {
                comment = `Svarnumre: ${OutputFormatter.compressNumberRange(allRespondentNumbers)}`;
              }
              // For ≤15 respondents: use individual quotes where available
              else if (ref.quotes && Array.isArray(ref.quotes) && ref.quotes.length > 0) {
                let lastResponseNumber = null;
                
                // Show quotes for respondents that have them
                for (const quoteObj of ref.quotes) {
                  if (quoteObj.quote && quoteObj.quote.trim() && !quoteObj.quote.includes('[MANGLER')) {
                    if (comment) comment += '\n\n';

                    // Only add header if it's different from the previous one
                    if (quoteObj.responseNumber !== lastResponseNumber) {
                      // KONSISTENT FORMAT: Altid "Henvendelse X" for alle respondenter
                      // Dette sikrer ensartet citering uanset respondenttype
                      const header = `**Henvendelse ${quoteObj.responseNumber}**`;
                      comment += `${header}\n`;
                      lastResponseNumber = quoteObj.responseNumber;
                    }

                    // SAFETY NET: Clean quote before output (remove rough cuts like ". " or "1)")
                    const cleanedQuote = this.cleanQuoteForOutput(quoteObj.quote);
                    comment += `*"${cleanedQuote}"*`;
                  }
                }
                
                // NOTE: "Samme holdning" fallback REMOVED - programmatic quote filling in
                // PositionWriter.fillQuotesProgrammatically() now ensures all respondents
                // have quotes for groups <= 15, so this fallback is no longer needed.
              }
              // Fallback: use notes
              else if (ref.notes && ref.notes.trim()) {
                comment = ref.notes;
              }
              // Last resort: list all respondents if no quotes and no notes
              else if (allRespondentNumbers.length > 0) {
                comment = `Henvendelse ${OutputFormatter.compressNumberRange(allRespondentNumbers)}`;
              }

              // SAFETY NET: If comment is still empty (e.g. all quotes were [MANGLER]), 
              // create a fallback comment to ensure the <<REF_X>> placeholder is removed.
              if (!comment) {
                const respondentText = ref.respondents && ref.respondents.length > 0
                  ? `Henvendelse ${OutputFormatter.compressNumberRange(ref.respondents)}`
                  : 'Kilde';
                comment = `${respondentText}\n*[Citat kunne ikke verificeres automatisk]*`;
              }

              if (comment) {
                placeholderMap.set(placeholder, { comment, label: ref.label });
              }
            }

            // Replace placeholders from right to left to preserve indices
            // Find all placeholders with their positions
            const placeholders = [];
            const placeholderRegex = /<<REF_(?:NO_OPINION_)?\d+>>/g;
            let match;
            while ((match = placeholderRegex.exec(summaryText)) !== null) {
              placeholders.push({ placeholder: match[0], index: match.index, length: match[0].length });
            }

            // Sort by index ascending first to identify consecutive groups
            placeholders.sort((a, b) => a.index - b.index);

            // Group consecutive placeholders (no text between them)
            let placeholderGroups = [];
            let currentGroup = [];

            for (let i = 0; i < placeholders.length; i++) {
              const ph = placeholders[i];
              
              if (currentGroup.length === 0) {
                currentGroup.push(ph);
              } else {
                const lastInGroup = currentGroup[currentGroup.length - 1];
                const expectedNextIndex = lastInGroup.index + lastInGroup.length;
                
                // Check if this placeholder immediately follows the previous one
                if (ph.index === expectedNextIndex) {
                  currentGroup.push(ph);
                } else {
                  // Gap found - save current group and start new one
                  placeholderGroups.push(currentGroup);
                  currentGroup = [ph];
                }
              }
            }
            
            // Don't forget the last group
            if (currentGroup.length > 0) {
              placeholderGroups.push(currentGroup);
            }

            // Sort groups by start index descending (process from end to preserve indices)
            placeholderGroups.sort((a, b) => b[0].index - a[0].index);

            // SPECIAL CASE: If text starts with "Der" and has multiple references,
            // add combined citation on "Der" FIRST, then let normal processing add sub-position citations
            const textStartsWithDer = summaryText.trim().match(/^Der\s+/i);
            let allCommentsForDer = null;
            
            if (textStartsWithDer && placeholderGroups.length > 1) {
              // Collect ALL comments for "Der" (master-position)
              allCommentsForDer = [];
              for (const group of placeholderGroups) {
                for (const ph of group) {
                  const refData = placeholderMap.get(ph.placeholder);
                  if (refData && refData.comment) {
                    allCommentsForDer.push(refData.comment);
                  }
                }
              }
            }

            // Track which placeholders have been processed (to avoid duplicates)
            const processedPlaceholders = new Set();

            // Replace each group of placeholders
            for (const group of placeholderGroups) {
              // Calculate combined span of this group
              const groupStart = group[0].index;
              const lastPh = group[group.length - 1];
              const groupEnd = lastPh.index + lastPh.length;

              // Merge all comments from this group
              const mergedComments = [];
              const mergedRespondents = new Set();
              let allSkipAnnotation = true; // Track if ALL refs in group should skip annotation
              
              let shouldRemoveEntirely = false;
              let labelToRemove = null;
              
              for (const { placeholder } of group) {
                if (processedPlaceholders.has(placeholder)) continue;
                processedPlaceholders.add(placeholder);
                
                const refData = placeholderMap.get(placeholder);
                if (refData) {
                  // REMOVE ENTIRELY: This reference is a duplicate and should be completely removed
                  if (refData.removeEntirely) {
                    shouldRemoveEntirely = true;
                    labelToRemove = refData.label;
                    continue;
                  }
                  if (refData.comment) {
                    mergedComments.push(refData.comment);
                  }
                  // If any ref in the group does NOT have skipAnnotation, we need to show annotation
                  if (!refData.skipAnnotation) {
                    allSkipAnnotation = false;
                  }
                }
                // Track respondents for label detection
                const refDef = position.hybridReferences?.find(r => `<<${r.id}>>` === placeholder);
                if (refDef && refDef.respondents) {
                  refDef.respondents.forEach(r => mergedRespondents.add(r));
                }
              }

              // REMOVE ENTIRELY: If this group should be completely removed (duplicate reference),
              // remove both the label AND the placeholder from the text
              if (shouldRemoveEntirely) {
                let beforeGroup = summaryText.substring(0, groupStart);
                let afterGroup = summaryText.substring(groupEnd);

                // Also try to remove the label before the placeholder
                if (labelToRemove) {
                  const labelLower = labelToRemove.toLowerCase();
                  const beforeLower = beforeGroup.toLowerCase();
                  const labelIndex = beforeLower.lastIndexOf(labelLower);

                  if (labelIndex !== -1 && (groupStart - labelIndex) <= labelToRemove.length + 5) {
                    // Remove label and any trailing space
                    beforeGroup = beforeGroup.substring(0, labelIndex);
                    console.log(`[OutputFormatter] 🗑️ Removed duplicate label "${labelToRemove}" and placeholder`);
                  }
                }

                // Handle orphan "Der" sentences: ". Der<<REF>>" → ", og "
                // This happens when LLM writes "Der<<REF_2>> fremhæver..." after a previous sentence,
                // and REF_2 is a duplicate reference (same respondents as REF_1)
                const derSentencePattern = /\.\s*Der\s*$/i;
                if (derSentencePattern.test(beforeGroup)) {
                  beforeGroup = beforeGroup.replace(derSentencePattern, ', og ');
                  // Lowercase next word if it starts with capital (unless proper noun)
                  const afterTrimmed = afterGroup.trimStart();
                  if (/^[A-ZÆØÅ][a-zæøå]/.test(afterTrimmed)) {
                    afterGroup = afterTrimmed.charAt(0).toLowerCase() + afterTrimmed.slice(1);
                  } else {
                    afterGroup = afterTrimmed;
                  }
                  console.log(`[OutputFormatter] 🔧 Merged orphan "Der" sentence (duplicate reference removed)`);
                }

                summaryText = beforeGroup + afterGroup;
                continue;
              }

              // SKIP ANNOTATION: If all refs in this group should skip annotation,
              // just remove the placeholder(s) without adding CriticMarkup
              if (allSkipAnnotation && mergedComments.length === 0) {
                let beforeGroup = summaryText.substring(0, groupStart);
                const afterGroup = summaryText.substring(groupEnd);

                // Special case: If placeholder was preceded by ". Der" (sentence with "Der" as subject),
                // merge with previous sentence instead of leaving orphan "Der"
                // ". Der<<REF_X>> fremhæver" → ", og fremhæver"
                const derSentencePattern = /\.\s*Der\s*$/i;
                if (derSentencePattern.test(beforeGroup)) {
                  beforeGroup = beforeGroup.replace(derSentencePattern, ', og ');
                  // Lowercase next word if it starts with capital (unless proper noun)
                  const afterTrimmed = afterGroup.trimStart();
                  if (/^[A-ZÆØÅ][a-zæøå]/.test(afterTrimmed)) {
                    summaryText = beforeGroup + afterTrimmed.charAt(0).toLowerCase() + afterTrimmed.slice(1);
                  } else {
                    summaryText = beforeGroup + afterTrimmed;
                  }
                  console.log(`[OutputFormatter] 🔧 Merged orphan "Der<<REF>>" sentence`);
                } else {
                  summaryText = beforeGroup + afterGroup;
                }
                continue;
              }

              if (mergedComments.length === 0) {
                // No comments to show - remove placeholder and handle orphan "Der"
                let beforeGroup = summaryText.substring(0, groupStart);
                const afterGroup = summaryText.substring(groupEnd);

                console.log(`[OutputFormatter] DEBUG: mergedComments empty for group at ${groupStart}, beforeGroup ends with: "${beforeGroup.slice(-30)}"`);

                // Special case: If placeholder was preceded by ". Der" (sentence with "Der" as subject),
                // merge with previous sentence instead of leaving orphan "Der"
                const derSentencePattern = /\.\s*Der\s*$/i;
                if (derSentencePattern.test(beforeGroup)) {
                  beforeGroup = beforeGroup.replace(derSentencePattern, ', og ');
                  const afterTrimmed = afterGroup.trimStart();
                  if (/^[A-ZÆØÅ][a-zæøå]/.test(afterTrimmed)) {
                    summaryText = beforeGroup + afterTrimmed.charAt(0).toLowerCase() + afterTrimmed.slice(1);
                  } else {
                    summaryText = beforeGroup + afterTrimmed;
                  }
                  console.log(`[OutputFormatter] 🔧 Merged orphan "Der<<REF>>" sentence (no comments)`);
                } else {
                  summaryText = beforeGroup + afterGroup;
                }
                continue;
              }

              // Combine comments with double newline separator
              const combinedComment = mergedComments.join('\n\n');

              // Find the label before the group
              const beforeGroup = summaryText.substring(0, groupStart);
              const afterGroup = summaryText.substring(groupEnd);

              // Try to find a matching label
              // For merged groups, generate expected label from respondent count
              let detectedLabel = null;
              const respondentCount = mergedRespondents.size;
              
              // Try respondent-count based label matching first
              const expectedLabels = this.generateExpectedLabels(respondentCount);
              for (const expectedLabel of expectedLabels) {
                const labelLower = expectedLabel.toLowerCase();
                const beforeLower = beforeGroup.toLowerCase();
                const labelIndex = beforeLower.lastIndexOf(labelLower);
                
                if (labelIndex !== -1 && groupStart - labelIndex === expectedLabel.length) {
                  detectedLabel = summaryText.substring(labelIndex, groupStart);
                  break;
                }
              }

              // Fallback: Use first reference's label if available
              if (!detectedLabel && group.length === 1) {
                const singleRefData = placeholderMap.get(group[0].placeholder);
                if (singleRefData && singleRefData.label) {
                  const labelLower = singleRefData.label.toLowerCase();
                  const beforeLower = beforeGroup.toLowerCase();
                  const labelIndex = beforeLower.lastIndexOf(labelLower);
                  
                  if (labelIndex !== -1 && groupStart - labelIndex === singleRefData.label.length) {
                    detectedLabel = summaryText.substring(labelIndex, groupStart);
                  }
                }
              }

              // Fallback: regex-based detection
              if (!detectedLabel) {
                const fallbackRegex = /(?:^|[.,;:\n>])\s*((?:[A-ZÆØÅa-zæøå0-9-]+[ -])*(?:borgere?|respondenter?|høringssvar|henvendelser?|indsigere?|lokaludvalg|myndigheder?|foreninger?|organisationer?|selskaber?|virksomheder?|beboere?|naboer?|lejere?|ejere?|parter?|aktører?|folk|personer?|vedkommende|ansøger?|udvalg|styrelse|forvaltning|råd|nævn)(?: (?:og|samt) (?:[A-ZÆØÅa-zæøå0-9-]+[ -])*(?:borgere?|respondenter?|...))?)$/i;
                const matchResult = beforeGroup.match(fallbackRegex);
                if (matchResult && matchResult[1] && matchResult[1].length < 60) {
                  detectedLabel = matchResult[1].trim();
                }
              }

              // Build the CriticMarkup
              if (detectedLabel) {
                const labelStart = groupStart - detectedLabel.length;
                const beforeLabel = summaryText.substring(0, labelStart);
                
                // CHECK: Does the TEXT start with "Der"?
                // Only move to "Der" if this is the ONLY reference group (to avoid nesting)
                // This ensures "Der fremhæves... Én borger påpeger..." becomes "{==Der==} fremhæves..."
                const sentenceStartLabel = this.findSentenceStartLabel(beforeLabel);
                
                // Check if text starts with "Der" - if so, we should move citation there
                // BUT: For multi-reference texts, DON'T move - keep at sub-position labels
                // (combined citation on "Der" is added in post-processing)
                const shouldMoveToDer = sentenceStartLabel && 
                  sentenceStartLabel.label === 'Der' && 
                  detectedLabel.toLowerCase() !== 'der' &&
                  placeholderGroups.length === 1; // Only for single-ref positions
                
                if (shouldMoveToDer) {
                  // Move citation to "Der" at text start
                  const beforeSentence = summaryText.substring(0, sentenceStartLabel.insertionPoint);
                  const textBetweenDerAndRef = beforeLabel.substring(sentenceStartLabel.insertionPoint + sentenceStartLabel.label.length);
                  
                  // Build: [before sentence] + {==Der==}{>>citation<<} + [text between Der and label] + [label] + [after original ref]
                  summaryText = beforeSentence + 
                    `{==${sentenceStartLabel.label}==}{>>${combinedComment}<<}` + 
                    textBetweenDerAndRef + detectedLabel + afterGroup;
                  
                  console.log(`[OutputFormatter] 🔧 Moved citation from "${detectedLabel}" to sentence-start "Der"`);
                } else {
                  // Use the detected label as-is
                  const finalLabel = this.ensureCorrectCapitalization(detectedLabel, beforeLabel);
                  summaryText = beforeLabel + `{==${finalLabel}==}{>>${combinedComment}<<}` + afterGroup;
                }
              } else {
                // SPECIAL CASE: If beforeGroup is exactly "Der" (or whitespace + "Der") at text start,
                // this is a master-position pattern "Der<<REF_X>>..." and we should use "Der" as the label.
                // This handles cases where there's no whitespace between "Der" and the placeholder.
                const trimmedBeforeGroup = beforeGroup.trim();
                if (trimmedBeforeGroup.toLowerCase() === 'der' && groupStart <= 4) {
                  // The entire beforeGroup is just "Der" at text start - use it as the label
                  const labelStart = beforeGroup.lastIndexOf('Der');
                  const beforeLabel = summaryText.substring(0, labelStart >= 0 ? labelStart : 0);
                  const finalLabel = this.ensureCorrectCapitalization('Der', beforeLabel);
                  summaryText = beforeLabel + `{==${finalLabel}==}{>>${combinedComment}<<}` + afterGroup;
                  console.log(`[OutputFormatter] 🔧 Used "Der" as master-position label (Der<<REF_X>> pattern)`);
                  continue; // Skip to next placeholder group
                }

                // FALLBACK: No label found immediately before reference
                // Try to find a label at sentence start and MOVE the citation there
                // Only do this if there's ONE reference group (to avoid nesting issues)
                // For multi-ref positions, don't use fallback that moves to sentence start
                // (combined citation on "Der" is added in post-processing)
                const fallbackLabel = placeholderGroups.length === 1
                  ? this.findFallbackLabel(beforeGroup, group, placeholderMap)
                  : { label: null, insertionPoint: null, textBetween: null };
                
                if (fallbackLabel.label && fallbackLabel.insertionPoint !== null) {
                  // Found a label at sentence start - MOVE citation to right after it
                  // 
                  // Original: "Der fremhæves et ønske...<<REF_1>>. Det understreges..."
                  // Result:   "{==Der==}{>>citat<<} fremhæves et ønske... Det understreges..."
                  //
                  // Structure: [beforeSentence] + {==label==}{>>citation<<} + [textBetween] + [afterOriginalRef]
                  
                  const beforeSentence = summaryText.substring(0, fallbackLabel.insertionPoint);
                  const afterOriginalRef = summaryText.substring(groupEnd);
                  
                  // textBetween contains text from after label to original ref position (already trimmed at start)
                  let textBetween = fallbackLabel.textBetween || '';
                  
                  // Clean up: remove any leading/trailing issues
                  textBetween = textBetween.trimEnd();
                  let afterRef = afterOriginalRef;
                  
                  // Handle punctuation at the join point
                  // If textBetween ends with content and afterRef starts with punctuation, that's fine
                  // If textBetween is empty or ends weird, clean up
                  if (textBetween && afterRef) {
                    // Ensure space before afterRef if it doesn't start with punctuation
                    if (!afterRef.match(/^[.,;:!?\s]/)) {
                      afterRef = ' ' + afterRef;
                    }
                  }
                  
                  // Build final text
                  summaryText = beforeSentence + `{==${fallbackLabel.label}==}{>>${combinedComment}<<} ` + textBetween + afterRef;
                  console.log(`[OutputFormatter] 🔧 Fallback: moved citation to after "${fallbackLabel.label}"`);
                } else {
                  // No sentence-start label found - use data label as inline highlight
                  const refData = placeholderMap.get(group[0]?.placeholder);
                  let dataLabel = refData?.label || 'Vedkommende';

                  console.log(`[OutputFormatter] DEBUG else-block: placeholder=${group[0]?.placeholder}, dataLabel=${dataLabel}, beforeGroup ends with: "${beforeGroup.slice(-30)}"`);

                  // Special case: If text before placeholder is ". Der", we're dealing with orphan "Der"
                  // that should be merged with previous sentence instead of adding new label
                  const beforeGroup2 = summaryText.substring(0, groupStart);
                  const derOrphanPattern = /\.\s*Der\s*$/i;
                  if (derOrphanPattern.test(beforeGroup2)) {
                    // Merge with previous sentence: ". Der<<REF>>" → ", og "
                    const beforeWithoutDer = beforeGroup2.replace(derOrphanPattern, ', og ');
                    const afterTrimmed = afterGroup.trimStart();
                    if (/^[A-ZÆØÅ][a-zæøå]/.test(afterTrimmed)) {
                      summaryText = beforeWithoutDer + afterTrimmed.charAt(0).toLowerCase() + afterTrimmed.slice(1);
                    } else {
                      summaryText = beforeWithoutDer + afterTrimmed;
                    }
                    console.log(`[OutputFormatter] 🔧 Merged orphan "Der" sentence (multi-ref, no label found)`);
                    continue;
                  }

                  // Ensure correct capitalization based on context
                  dataLabel = this.ensureCorrectCapitalization(dataLabel, beforeGroup2);

                  // Ensure spacing before label if text doesn't end with whitespace/punctuation
                  // Fixes concatenation issues like "Paladsén borger" → "Palads. Én borger"
                  let separator = '';
                  const lastChar = beforeGroup2.slice(-1);
                  if (lastChar && !/[\s.,;:!?\n]/.test(lastChar)) {
                    separator = '. ';
                    // Capitalize label after inserted period
                    dataLabel = dataLabel.charAt(0).toUpperCase() + dataLabel.slice(1);
                  }

                  // Insert the label as highlight right before the comment at original position
                  summaryText = beforeGroup2 + separator + `{==${dataLabel}==}{>>${combinedComment}<<}` + afterGroup;
                  console.log(`[OutputFormatter] 🔧 Fallback: used data label "${dataLabel}" for citation${separator ? ' (added separator)' : ''}`);
                }
              }
            }
            
            // POST-PROCESSING: Add combined citation on "Der" for multi-ref positions
            // This runs AFTER individual sub-position citations are added
            if (allCommentsForDer && allCommentsForDer.length > 1) {
              const derMatch = summaryText.match(/^(\s*)(Der)\s+/i);
              if (derMatch) {
                const leadingSpace = derMatch[1];
                const derLabel = derMatch[2];
                const afterDer = summaryText.substring(derMatch[0].length);
                const combinedComment = allCommentsForDer.join('\n\n');
                
                summaryText = leadingSpace + `{==${derLabel}==}{>>${combinedComment}<<} ` + afterDer;
                console.log(`[OutputFormatter] 🔧 Added combined ${allCommentsForDer.length} citations on "Der" (master-position)`);
              }
            }

          }

          // Add citations as CriticMarkup (old system)
          if (position.citations && position.citations.length > 0) {
            // Group citations by highlightContextual (multiple citations for same reference get combined)
            const citationGroups = new Map();
            position.citations.forEach(citation => {
              const key = (citation.highlightContextual || citation.highlight || '').toLowerCase();
              if (!citationGroups.has(key)) {
                citationGroups.set(key, {
                  highlight: citation.highlight,
                  highlightContextual: citation.highlightContextual || citation.highlight,
                  comments: []
                });
              }
              if (citation.comment) {
                citationGroups.get(key).comments.push(citation.comment);
              }
            });

            // Convert to array and sort by position in text (process later ones first to preserve offsets)
            const groupedCitations = Array.from(citationGroups.values()).sort((a, b) => {
              const aPos = summaryText.toLowerCase().indexOf((a.highlightContextual || a.highlight || '').toLowerCase());
              const bPos = summaryText.toLowerCase().indexOf((b.highlightContextual || b.highlight || '').toLowerCase());
              return bPos - aPos; // Process from end to start
            });

            groupedCitations.forEach(group => {
              const highlight = group.highlight || '';
              const highlightContextual = group.highlightContextual || highlight;
              // Combine all comments for this group into one CriticMarkup block
              const combinedComment = group.comments.join('\n');

              // First, find where highlightContextual appears in summary
              const contextualLower = highlightContextual.toLowerCase();
              const summaryLower = summaryText.toLowerCase();
              const contextualIndex = summaryLower.indexOf(contextualLower);

              if (contextualIndex !== -1) {
                // Find where highlight appears within highlightContextual
                const highlightLower = highlight.toLowerCase();
                const contextualText = summaryText.substring(contextualIndex, contextualIndex + highlightContextual.length);
                const highlightIndexInContextual = contextualText.toLowerCase().indexOf(highlightLower);

                if (highlightIndexInContextual !== -1) {
                  // Replace only the highlight part, not the entire highlightContextual
                  const actualHighlightStart = contextualIndex + highlightIndexInContextual;
                  const actualHighlightEnd = actualHighlightStart + highlight.length;
                  const beforeHighlight = summaryText.substring(0, actualHighlightStart);
                  const highlightText = summaryText.substring(actualHighlightStart, actualHighlightEnd);
                  const afterHighlight = summaryText.substring(actualHighlightEnd);

                  summaryText = beforeHighlight + `{==${highlightText}==}{>>${combinedComment}<<}` + afterHighlight;
                } else {
                  // Fallback: if highlight not found, use highlightContextual
                  const beforeContextual = summaryText.substring(0, contextualIndex);
                  const contextualText = summaryText.substring(contextualIndex, contextualIndex + highlightContextual.length);
                  const afterContextual = summaryText.substring(contextualIndex + highlightContextual.length);

                  summaryText = beforeContextual + `{==${contextualText}==}{>>${combinedComment}<<}` + afterContextual;
                }
              }
            });
          }

          markdown += `${summaryText}\n\n`;
        }

        // Sub-positions are NOT rendered as separate sections
        // They are used internally by PositionWriter to create a detailed, cohesive summary
        // The summary above already includes all sub-arguments in one coherent narrative

        // Add spacing between positions
        if (posIdx < topic.positions.length - 1) {
          markdown += '\n';
        }
      });

      // Add spacing between topics
      if (topicIdx < topics.length - 1) {
        markdown += '\n';
      }
    });

    // POST-PROCESSING: Transform consecutive identical labels
    // "Én borger" → "En anden borger" → "En tredje borger" etc.
    markdown = DanishNumberFormatter.transformConsecutiveLabels(markdown);

    // POST-PROCESSING: Clean up empty citation placeholders
    // Handles cases where <<REF_X>> couldn't be resolved and left empty spaces
    markdown = this.cleanEmptyPlaceholders(markdown);

    // DIAGNOSTICS: Detect any remaining label concatenation issues
    this.detectLabelConcatenation(markdown);

    return markdown;
  }

  /**
   * Clean up empty citation placeholders from text
   * Handles cases where REF_X placeholders couldn't be resolved and left artifacts
   * @param {string} text - The text to clean
   * @returns {string} Cleaned text
   */
  cleanEmptyPlaceholders(text) {
    if (!text) return text;

    let cleaned = text;
    let changesMade = 0;

    // Pattern 1: "som  og ." (double space with "og" before punctuation)
    const emptyListPattern = /som\s+og\s*\./gi;
    if (emptyListPattern.test(cleaned)) {
      changesMade++;
      cleaned = cleaned.replace(emptyListPattern, '.');
    }

    // Pattern 2: Orphan "og" before punctuation (e.g., "dette og." or ", og.")
    const orphanOgPattern = /\s+og\s*([.,;:!?])/gi;
    if (/\s+og\s*[.,;:!?]/.test(cleaned)) {
      changesMade++;
      cleaned = cleaned.replace(orphanOgPattern, '$1');
    }

    // Pattern 3: Double spaces (left by removed placeholders)
    // Note: Use [ \t] instead of \s to preserve newlines for section headers
    cleaned = cleaned.replace(/[ \t]{2,}/g, ' ');

    // Pattern 4: Empty CriticMarkup blocks {==  ==}{>>  <<}
    cleaned = cleaned.replace(/\{==\s*==\}\{>>\s*<<\}/g, '');

    // Pattern 5: Space before punctuation
    cleaned = cleaned.replace(/\s+([.,;:!?])/g, '$1');

    // Pattern 6: Unresolved <<REF_X>> placeholders still in text
    // Special handling for "Der<<REF_X>>" mid-sentence - remove "Der" too and merge sentences
    // ". Der<<REF_X>> fremhæver" → ", og fremhæver" (merge with previous sentence)
    const derRefPattern = /\.\s*Der<<REF_\d+>>\s*/gi;
    const derRefMatches = cleaned.match(derRefPattern);
    if (derRefMatches && derRefMatches.length > 0) {
      console.warn(`[OutputFormatter] ⚠️ Found ${derRefMatches.length} unresolved "Der<<REF_X>>" patterns - merging sentences`);
      changesMade += derRefMatches.length;
      // Replace ". Der<<REF_X>> " with ", og " to merge sentences grammatically
      cleaned = cleaned.replace(/\.\s*Der<<REF_\d+>>\s*/gi, ', og ');
      // Ensure next word is lowercase after merge (unless proper noun)
      cleaned = cleaned.replace(/, og ([A-ZÆØÅ])(?=[a-zæøå])/g, (match, char) => `, og ${char.toLowerCase()}`);
    }

    // Now handle any remaining unresolved <<REF_X>> placeholders
    const unresolvedRefs = cleaned.match(/<<REF_\d+>>/g);
    if (unresolvedRefs && unresolvedRefs.length > 0) {
      console.warn(`[OutputFormatter] ⚠️ Found ${unresolvedRefs.length} unresolved REF placeholders - removing`);
      changesMade += unresolvedRefs.length;
      cleaned = cleaned.replace(/<<REF_\d+>>/g, '');
    }

    // Pattern 7: Multiple consecutive punctuation (e.g., ",.." or ".,")
    cleaned = cleaned.replace(/([.,;:!?])\s*[.,;:!?]+/g, '$1');

    // Pattern 8: Malformed borger<< patterns (e.g., "én borger<<én borger<<")
    // These are LLM errors where it starts << but doesn't complete with REF_X>>
    // Extended to include "enkelt" for patterns like "En enkelt borger<<"
    const malformedBorgerPattern = /(\b(?:én|en|to|tre|fire|fem|seks|syv|otte|ni|ti|elleve|tolv|\d+)(?:\s+enkelt)?\s+borger(?:e)?)\s*<<(?!REF_)/gi;
    const malformedMatches = cleaned.match(malformedBorgerPattern);
    if (malformedMatches && malformedMatches.length > 0) {
      console.warn(`[OutputFormatter] ⚠️ Found ${malformedMatches.length} malformed borger<< patterns - cleaning`);
      changesMade += malformedMatches.length;
      // Remove the << and any text up to the next {==, <<, punctuation, or end of sentence
      cleaned = cleaned.replace(/(\b(?:én|en|to|tre|fire|fem|seks|syv|otte|ni|ti|elleve|tolv|\d+)(?:\s+enkelt)?\s+borger(?:e)?)\s*<<(?!REF_)([^{<]*?)(?=[.,:;!?\s]|\{==|<<|$)/gi, '$1 ');
    }

    // Pattern 8b: Catch-all for ANY borger<< not followed by REF_ (safety net)
    // This catches edge cases missed by more specific patterns
    const anyBorgerPattern = /\bborger(?:e|en|ne)?\s*<<(?!REF_)/gi;
    if (anyBorgerPattern.test(cleaned)) {
      const matches = cleaned.match(/\bborger(?:e|en|ne)?\s*<<(?!REF_)/gi);
      if (matches && matches.length > 0) {
        console.warn(`[OutputFormatter] ⚠️ Found ${matches.length} remaining borger<< patterns - cleaning`);
        changesMade += matches.length;
        cleaned = cleaned.replace(/\bborger(?:e|en|ne)?(\s*)<<(?!REF_)/gi, 'borger$1');
      }
    }

    // Pattern 9: "Der<<" or "Der <<" followed by text (not REF_)
    // Handles both "Der<<én borger" and "Der <<én borger" patterns
    const derPattern = /\bDer\s*<<(?!REF_)/gi;
    if (derPattern.test(cleaned)) {
      changesMade++;
      // First, just remove the << part, keeping "Der " and what follows
      cleaned = cleaned.replace(/\bDer\s*<<(?!REF_)/gi, 'Der ');
    }

    // Pattern 10: Repeated label chains ending in << OR {== (post-resolution)
    // Handles: "én borger<<én borger<<én borger<<" AND "Én borger<<én borger{==" (after REF resolved)
    // Note: Don't use \b word boundary - it fails with Unicode chars like "É"
    const chainPattern = /((?:én|en|to|tre|fire|fem|seks|syv|otte|ni|ti|elleve|tolv|\d+)(?:\s+enkelt)?\s+borger(?:e)?)(<<(?:én|en|to|tre|fire|fem|seks|syv|otte|ni|ti|elleve|tolv|\d+)?(?:\s+enkelt)?\s*borger(?:e)?)+(?:<<|\{==)/gi;
    const chainMatches = cleaned.match(chainPattern);
    if (chainMatches && chainMatches.length > 0) {
      console.warn(`[OutputFormatter] ⚠️ Found ${chainMatches.length} borger<< chain patterns - cleaning`);
      changesMade += chainMatches.length;
      // Keep first label, remove the repeated chain, preserve terminator
      cleaned = cleaned.replace(chainPattern, (match, firstLabel) => {
        // Preserve the {== if that's what the chain ended with
        if (match.endsWith('{==')) {
          return firstLabel + ' {==';
        }
        return firstLabel;
      });
    }

    // Pattern 11: General malformed << patterns (space before <<, or << not followed by REF_)
    // Catches patterns like "Der <<én borger" or "292 borgere <<én borger"
    const generalMalformedPattern = /\s+<<(?!REF_)([^<{]*?)(?=[.,:;!?\s]|\{==|<<|$)/g;
    const generalMatches = cleaned.match(generalMalformedPattern);
    if (generalMatches && generalMatches.length > 0) {
      console.warn(`[OutputFormatter] ⚠️ Found ${generalMatches.length} general malformed << patterns - cleaning`);
      changesMade += generalMatches.length;
      cleaned = cleaned.replace(/\s+<<(?!REF_)([^<{]*?)(?=[.,:;!?\s]|\{==|<<|$)/g, ' ');
    }

    // Final cleanup: double spaces again after pattern removal
    // Note: Use [ \t] instead of \s to preserve newlines for section headers
    cleaned = cleaned.replace(/[ \t]{2,}/g, ' ');

    if (changesMade > 0) {
      console.log(`[OutputFormatter] 🧹 Cleaned ${changesMade} empty placeholder artifacts`);
    }

    // Pattern 12: Remove redundant plain-text labels before CriticMarkup labels
    // "Tre borgere {==to borgere==}" → "{==To borgere==}"
    cleaned = this.removeRedundantPlainLabels(cleaned);

    // Pattern 13: Remove redundant "Der" before ANY CriticMarkup label at text/sentence start
    // "Der{==fire borgere==}" → "{==Fire borgere==}"
    // "Der{==H.H. EJENDOMSINVEST APS==}" → "{==H.H. EJENDOMSINVEST APS==}"
    // Only at text start, line start, or after sentence-ending punctuation
    const redundantDerPattern = /(^|\n|[.!?]\s*)Der\s*(\{==[^=]+==\})/gim;
    const derMatches = cleaned.match(redundantDerPattern);
    if (derMatches && derMatches.length > 0) {
      cleaned = cleaned.replace(redundantDerPattern, (match, before, criticMarkup) => {
        // Capitalize the first letter inside {== ==} if lowercase
        const capitalized = criticMarkup.replace(/(\{==)([a-zæøå])/, (m, prefix, char) => prefix + char.toUpperCase());
        return before + capitalized;
      });
      console.log(`[OutputFormatter] 🧹 Removed ${derMatches.length} redundant "Der" before CriticMarkup label(s)`);
    }

    // Pattern 14: Capitalize CriticMarkup labels at sentence start
    // ". {==én borger" → ". {==Én borger"
    cleaned = cleaned.replace(/([.!?]\s*)(\{==)([a-zæøå])/g, (match, punct, prefix, char) => {
      return punct + prefix + char.toUpperCase();
    });

    return cleaned.trim();
  }

  /**
   * Format as JSON (for debugging/inspection)
   */
  formatAsJSON(analysisResult) {
    return JSON.stringify(analysisResult, null, 2);
  }

  /**
   * Validate output format
   */
  validateOutput(analysisResult) {
    const errors = [];

    if (!analysisResult.topics || !Array.isArray(analysisResult.topics)) {
      errors.push('Missing or invalid topics array');
    }

    if (!analysisResult.considerations || typeof analysisResult.considerations !== 'string') {
      errors.push('Missing or invalid considerations field');
    }

    analysisResult.topics?.forEach((topic, topicIdx) => {
      if (!topic.name) {
        errors.push(`Topic ${topicIdx}: Missing name`);
      }

      if (!topic.positions || !Array.isArray(topic.positions)) {
        errors.push(`Topic ${topicIdx}: Missing or invalid positions array`);
      }

      topic.positions?.forEach((position, posIdx) => {
        if (!position.title) {
          errors.push(`Topic ${topicIdx}, Position ${posIdx}: Missing title`);
        }

        if (!position.responseNumbers || !Array.isArray(position.responseNumbers)) {
          errors.push(`Topic ${topicIdx}, Position ${posIdx}: Missing or invalid responseNumbers`);
        }

        if (!position.summary) {
          errors.push(`Topic ${topicIdx}, Position ${posIdx}: Missing summary`);
        }

        if (!position.respondentBreakdown || !position.respondentBreakdown.total) {
          errors.push(`Topic ${topicIdx}, Position ${posIdx}: Missing or invalid respondentBreakdown`);
        }

        // Check citation count matches responseNumbers count
        const citationCount = position.citations?.length || 0;
        const responseCount = position.responseNumbers?.length || 0;
        if (citationCount < responseCount) {
          errors.push(`Topic ${topicIdx}, Position ${posIdx}: Citation count (${citationCount}) < response count (${responseCount})`);
        }
      });
    });

    return {
      valid: errors.length === 0,
      errors: errors
    };
  }

  /**
   * Remove forbidden parenthetical references from summary text
   * Catches patterns like "To borgere (nr. 19 og 56)" and removes the parenthetical part
   * @param {string} text - The text to clean
   * @returns {string} Cleaned text
   */
  removeParentheticalReferences(text) {
    if (!text) return text;
    
    // Pattern 1: "X borgere (nr. Y, Z)" or "X borgere (nr. Y og Z)"
    let cleaned = text.replace(/\s*\(nr\.\s*[\d,\s]+(?:og\s*\d+)?\)/gi, '');
    
    // Pattern 2: "borgere (henvendelse X, Y)" 
    cleaned = cleaned.replace(/\s*\(henvendelse\s*[\d,\s]+(?:og\s*\d+)?\)/gi, '');
    
    // Pattern 3: "borger (nr. X)" - single respondent
    cleaned = cleaned.replace(/\s*\(nr\.\s*\d+\)/gi, '');
    
    // Pattern 4: Catch any remaining "(nr. anything)" patterns
    cleaned = cleaned.replace(/\s*\(nr\.[^)]+\)/gi, '');
    
    // Pattern 5: "borgere (X og Y)" or "borgere (X, Y)" - numbers without "nr."
    // Only match if preceded by "borgere" or "borger" to avoid false positives
    cleaned = cleaned.replace(/(borger[e]?)\s*\((\d+(?:\s*,\s*\d+)*(?:\s+og\s+\d+)?)\)/gi, '$1');
    
    // Pattern 6: "borger (X)" - single number in parens after borger
    cleaned = cleaned.replace(/(borger)\s*\((\d+)\)/gi, '$1');
    
    // Pattern 7: META-COMMENTS - Remove categorizing/thematic parentheses before references
    // Catches: "163 borgere (nænsom transformation){==" or "86 borgere (offentlig adgang){=="
    // These are LLM-generated meta-comments that should not appear in output
    cleaned = cleaned.replace(/(\d+\s+borger[e]?)\s*\([^)]{3,50}\)(\{==)/gi, '$1$2');
    
    // Pattern 8: META-COMMENTS before <<REF_X>> placeholders (pre-CriticMarkup stage)
    // Catches: "163 borgere (nænsom transformation)<<REF_" 
    cleaned = cleaned.replace(/(\d+\s+borger[e]?)\s*\([^)]{3,50}\)(<<REF_)/gi, '$1$2');
    
    // Pattern 9: META-COMMENTS with word-based labels
    // Catches: "Tre borgere (kategori)<<REF_" or "Én borger (type)<<REF_"
    cleaned = cleaned.replace(/((?:én|en|to|tre|fire|fem|seks|syv|otte|ni|ti|elleve|tolv)\s+borger[e]?)\s*\([^)]{3,50}\)(<<REF_|\{==)/gi, '$1$2');
    
    // Pattern 10: Generic meta-comments in parentheses that look like annotations
    // Catches: "(her følger en uddybelse)", "(dette er gruppen der...)", "(samlet holdning)"
    // Only remove if it looks like a meta-comment (starts with common meta-words)
    cleaned = cleaned.replace(/\s*\((her\s+(?:kommer|følger)|dette\s+er|samlet|gruppen?\s+(?:der|som)|kategori|type)[^)]*\)/gi, '');
    
    // Log if we made changes
    if (cleaned !== text) {
      console.log(`[OutputFormatter] 🧹 Removed parenthetical reference(s) or meta-comment(s) from output`);
    }
    
    return cleaned;
  }

  /**
   * Generate expected label variations for a respondent count
   * Used to match labels like "To borgere", "3 borgere", etc.
   * @param {number} count - Number of respondents
   * @returns {string[]} Array of possible label variations
   */
  generateExpectedLabels(count) {
    const labels = [];
    
    // Danish number words
    const numberWords = {
      1: ['én', 'en', 'et', 'én enkelt', 'en enkelt'],
      2: ['to', 'et par'],
      3: ['tre'],
      4: ['fire'],
      5: ['fem'],
      6: ['seks'],
      7: ['syv'],
      8: ['otte'],
      9: ['ni'],
      10: ['ti'],
      11: ['elleve'],
      12: ['tolv'],
      13: ['tretten'],
      14: ['fjorten'],
      15: ['femten']
    };
    
    // Common respondent types
    const types = ['borgere', 'borger', 'respondenter', 'respondent', 'henvendelser', 'henvendelse'];
    
    // Generate combinations
    for (const type of types) {
      // Numeric form: "2 borgere"
      labels.push(`${count} ${type}`);
      
      // Word form: "to borgere"
      if (numberWords[count]) {
        for (const word of numberWords[count]) {
          labels.push(`${word} ${type}`);
          // Capitalized form: "To borgere"
          labels.push(`${word.charAt(0).toUpperCase()}${word.slice(1)} ${type}`);
        }
      }
    }
    
    // Also try compound patterns like "to-tre borgere"
    if (count >= 2 && count <= 5) {
      const compoundPatterns = [
        `${count}-${count+1} borgere`,
        `${count} til ${count+1} borgere`
      ];
      labels.push(...compoundPatterns);
    }
    
    return labels;
  }

  /**
   * Find a fallback label (pronoun) to highlight when no explicit label is found.
   * 
   * ROBUST APPROACH: When reference is misplaced (e.g., mid-sentence), we MOVE 
   * the citation to be right after the sentence-start label (e.g., "Der").
   * This ensures consistent formatting: "[Label]<<citat>> resten af sætningen..."
   * 
   * @param {string} beforeGroup - Text before the placeholder group
   * @param {Array} group - Array of placeholder objects in this group
   * @param {Map} placeholderMap - Map of placeholder -> {comment, label}
   * @returns {Object} { label: string|null, insertionPoint: number|null, textBetween: string|null }
   */
  findFallbackLabel(beforeGroup, group, placeholderMap) {
    // Common Danish pronouns/labels that can be highlighted as the subject
    // These are checked at sentence start and the citation is MOVED to right after them
    const pronounPatterns = [
      // "Der" - most common for master-positions, check FIRST for priority
      { pattern: /(?:^|[.!?]\s+)(Der)\s+/gi, captureGroup: 1 },
      // "Vedkommende" - formal pronoun
      { pattern: /(?:^|[.!?]\s+)(Vedkommende)\s+/gi, captureGroup: 1 },
      // "Borgeren" - specific reference
      { pattern: /(?:^|[.!?]\s+)(Borgeren)\s+/gi, captureGroup: 1 },
      // "Denne" - demonstrative pronoun
      { pattern: /(?:^|[.!?]\s+)(Denne)\s+/gi, captureGroup: 1 },
      // "De" (plural they) - but only at sentence start, not "De samme" etc.
      { pattern: /(?:^|[.!?]\s+)(De)\s+(?!samme|fleste)/gi, captureGroup: 1 },
      // Numbered patterns for sub-positions: "X borgere", "X respondenter"
      { pattern: /(?:^|[.!?]\s+)(\d+\s+(?:borgere?|respondenter?))\s+/gi, captureGroup: 1 },
      { pattern: /(?:^|[.!?]\s+)(Én\s+borger)\s+/gi, captureGroup: 1 },
      { pattern: /(?:^|[.!?]\s+)(To\s+borgere)\s+/gi, captureGroup: 1 },
      { pattern: /(?:^|[.!?]\s+)(Tre\s+borgere)\s+/gi, captureGroup: 1 },
    ];

    // Find the start of the current sentence
    const sentenceBreaks = ['.', '!', '?'];
    let sentenceStart = 0;
    for (let i = beforeGroup.length - 1; i >= 0; i--) {
      if (sentenceBreaks.includes(beforeGroup[i])) {
        sentenceStart = i + 1;
        break;
      }
    }
    
    // Skip leading whitespace after sentence break
    while (sentenceStart < beforeGroup.length && /\s/.test(beforeGroup[sentenceStart])) {
      sentenceStart++;
    }
    
    const currentSentence = beforeGroup.substring(sentenceStart);
    
    // Try to find a label at the start of the current sentence
    for (const { pattern, captureGroup } of pronounPatterns) {
      // Reset regex state
      pattern.lastIndex = 0;
      
      const match = pattern.exec(currentSentence);
      if (match && match[captureGroup]) {
        const pronoun = match[captureGroup];
        const matchIndexInSentence = match.index + (match[0].indexOf(pronoun));
        
        // Only use labels that are AT THE START of the sentence (within first few chars)
        if (matchIndexInSentence > 5) {
          continue; // Not at sentence start
        }
        
        const insertionPoint = sentenceStart + matchIndexInSentence;
        
        // Calculate what text comes BETWEEN the label and the original reference position
        // This text will be placed AFTER the citation
        const labelEndInSentence = matchIndexInSentence + pronoun.length;
        const textBetween = currentSentence.substring(labelEndInSentence).trimStart();
        
        console.log(`[OutputFormatter] 🔧 Found label "${pronoun}" at sentence start - moving citation`);
        
        return {
          label: pronoun,
          insertionPoint: insertionPoint,
          textBetween: textBetween // Text between label and original ref position
        };
      }
    }

    // No suitable label found at sentence start - return null to trigger data-label fallback
    return { label: null, insertionPoint: null, textBetween: null };
  }

  /**
   * Find if the TEXT (not just current sentence) starts with "Der".
   * Used to determine if we should move a citation to the beginning.
   * 
   * This handles cases where LLM writes:
   *   "Der fremhæves et ønske... [PUNKTUM] Én borger<<REF_1>> påpeger..."
   * And we want to move the citation to "Der" at the start.
   * 
   * @param {string} textBeforeLabel - Text before the detected label
   * @returns {Object|null} { label, insertionPoint } or null
   */
  findSentenceStartLabel(textBeforeLabel) {
    // Skip leading whitespace at the very start
    let textStart = 0;
    while (textStart < textBeforeLabel.length && /\s/.test(textBeforeLabel[textStart])) {
      textStart++;
    }
    
    const textFromStart = textBeforeLabel.substring(textStart);
    
    // Check if the TEXT starts with "Der" (at the very beginning)
    const derMatch = textFromStart.match(/^(Der)\s+/i);
    if (derMatch) {
      return {
        label: derMatch[1],
        insertionPoint: textStart
      };
    }
    
    return null;
  }

  /**
   * Ensure correct capitalization of a label based on its context.
   * Labels should be capitalized at sentence start, lowercase mid-sentence (unless proper nouns).
   * 
   * @param {string} label - The label to check
   * @param {string} beforeLabel - Text before the label
   * @returns {string} - Label with correct capitalization
   */
  ensureCorrectCapitalization(label, beforeLabel) {
    if (!label) return label;
    
    // Check if this is a proper noun / named entity (organization, etc.)
    // These should always keep their capitalization
    const isProperNoun = /^[A-ZÆØÅ].*(?:udvalg|forening|organisation|selskab|forvaltning|styrelse|råd|nævn|kommune|region|ministerium)$/i.test(label) ||
                         /^[A-ZÆØÅ][a-zæøå]+\s+[A-ZÆØÅ]/.test(label) || // Multiple capitalized words
                         label.match(/^(?:Brug|Valby|Vanløse|København|Børne|Teknik|Kultur)/); // Common org prefixes
    
    if (isProperNoun) {
      // Proper nouns keep their capitalization
      return label;
    }
    
    // Check if we're at sentence start
    const trimmedBefore = beforeLabel.trimEnd();
    const atSentenceStart = trimmedBefore.length === 0 || 
                            trimmedBefore.endsWith('.') || 
                            trimmedBefore.endsWith('!') || 
                            trimmedBefore.endsWith('?') ||
                            trimmedBefore.endsWith('\n');
    
    if (atSentenceStart) {
      // Capitalize first letter at sentence start
      return label.charAt(0).toUpperCase() + label.slice(1);
    } else {
      // Mid-sentence - lowercase unless it's a number-word combination at start
      // "tre borgere" should stay lowercase mid-sentence
      // But "Én borger" -> "én borger" mid-sentence
      const startsWithNumber = /^(?:én|to|tre|fire|fem|seks|syv|otte|ni|ti|elleve|tolv|\d+)\s/i.test(label);
      if (startsWithNumber) {
        return label.charAt(0).toLowerCase() + label.slice(1);
      }
      return label;
    }
  }

  /**
   * Fjerner redundante plain-text labels der står før CriticMarkup labels.
   * "Tre borgere {==tre borgere==}" → "{==Tre borgere==}"
   * "Tre borgere {==to borgere==}" → "{==to borgere==}"
   * CriticMarkup-labelen er altid autoritativ.
   *
   * @param {string} markdown - The markdown text to clean
   * @returns {string} Cleaned markdown
   */
  removeRedundantPlainLabels(markdown) {
    if (!markdown) return markdown;

    const numberWords = 'én|en|to|tre|fire|fem|seks|syv|otte|ni|ti|elleve|tolv|\\d+';
    // Match plain-text label immediately before CriticMarkup label (with optional whitespace)
    // Captures: "Tre borgere {==to borgere==}" → groups: "Tre borgere", "to borgere"
    const redundantPattern = new RegExp(
      `((?:${numberWords})\\s+borger(?:e)?)\\s*\\{==((?:${numberWords})\\s+borger(?:e)?)==\\}`,
      'gi'
    );

    let changeCount = 0;
    const cleaned = markdown.replace(redundantPattern, (match, plainText, markup) => {
      changeCount++;
      // Preserve the capitalization from the plain text if the CriticMarkup label is lowercase
      // This ensures sentence-start capitalization is maintained
      const shouldCapitalize = /^[A-ZÆØÅ]/.test(plainText) && /^[a-zæøå]/.test(markup);
      const finalMarkup = shouldCapitalize
        ? markup.charAt(0).toUpperCase() + markup.slice(1)
        : markup;
      console.log(`[OutputFormatter] 🧹 Removed redundant plain label: "${plainText}" before {==${markup}==}`);
      return `{==${finalMarkup}==}`;
    });

    if (changeCount > 0) {
      console.log(`[OutputFormatter] 🧹 Removed ${changeCount} redundant plain-text label(s)`);
    }

    return cleaned;
  }

  /**
   * Detect potential label concatenation issues in CriticMarkup output.
   * Warns about patterns like "Palads{==" where text runs directly into CriticMarkup.
   *
   * @param {string} markdown - The markdown with CriticMarkup to analyze
   * @returns {Object[]} Array of warnings with position and context
   */
  detectLabelConcatenation(markdown) {
    if (!markdown) return [];

    const warnings = [];
    // Pattern: lowercase letter immediately followed by {== (no whitespace/punctuation)
    const concatenationPattern = /([a-zæøå])\{==/gi;
    let match;

    while ((match = concatenationPattern.exec(markdown)) !== null) {
      warnings.push({
        position: match.index,
        context: markdown.substring(Math.max(0, match.index - 30), match.index + 50),
        char: match[1]
      });
    }

    if (warnings.length > 0) {
      console.warn(`[OutputFormatter] ⚠️ Detected ${warnings.length} potential label concatenation issue(s):`);
      warnings.forEach((w, i) => {
        console.warn(`  ${i + 1}. Position ${w.position}: "...${w.context.trim()}..."`);
      });
    }

    return warnings;
  }
}


