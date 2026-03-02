/**
 * Title Validator
 *
 * Validates that position titles follow the required grammatical and structural rules:
 * 1. Titles must start with a stance marker (holdningsmarkør)
 * 2. Grammar must be correct (no imperatives after "Støtte til")
 * 3. Titles must not be truncated mid-word
 */

// Valid stance prefixes that position titles should start with
const VALID_PREFIXES = [
  'Støtte til',
  'Modstand mod',
  'Ønske om',
  'Bekymring for',
  'Forslag om',
  'Opfordring til',
  'Krav om'
];

// Common imperative verbs that should not appear after "Støtte til"
const IMPERATIVE_VERBS = [
  'flyt', 'flytte',
  'bevar', 'bevare',
  'ændr', 'ændre',
  'fjern', 'fjerne',
  'byg', 'bygge',
  'riv', 'rive',
  'stop', 'stoppe',
  'lad', 'lade',
  'gør', 'gøre',
  'sæt', 'sætte',
  'tag', 'tage',
  'hold', 'holde',
  'brug', 'bruge'
];

// Weighted/subjective words that break professional tone
const WEIGHTED_WORDS = [
  'kæmpe',       // "kæmpebygning"
  'kæmpe-',
  'massiv',
  'enorm',
  'grim',
  'grimme',
  'forfærdelig',
  'katastrofal',
  'fantastisk',
  'vidunderlig'
];

// Vague terms that indicate insufficient specificity
const VAGUE_ABSTRACT_PATTERNS = [
  /bebyggelses?omfang(?:et)?(?!\s+på)/i,  // "bebyggelsesomfanget" without specifics
  /bygningens\s+omfang(?!\s+på)/i,
  /modstand\s+mod\s+veje(?:\s+i\s|$)/i,   // "Modstand mod veje" (absurd)
  /modstand\s+mod\s+ubebyggede\s+arealer(?:\s+i\s|$)/i,  // "Modstand mod ubebyggede arealer" (absurd)
  /modstand\s+mod\s+trafik(?:\s+i\s|$)/i  // "Modstand mod trafik" without specifics
];

/**
 * Validate that a position title follows the required rules.
 *
 * @param {string} title - The title to validate
 * @returns {{valid: boolean, errors: string[], warnings: string[]}}
 */
export function validatePositionTitle(title) {
  const errors = [];
  const warnings = [];

  if (!title || typeof title !== 'string') {
    errors.push('Title is empty or not a string');
    return { valid: false, errors, warnings };
  }

  // Check for valid stance prefix
  const hasValidPrefix = VALID_PREFIXES.some(prefix =>
    title.startsWith(prefix)
  );

  if (!hasValidPrefix) {
    // Check if it starts with something that looks like a stance but isn't in the list
    const startsWithStance = /^(støtte|modstand|ønske|bekymring|forslag|opfordring|krav)\b/i.test(title);
    if (startsWithStance) {
      warnings.push(`Title starts with stance word but not in standard format: "${title.slice(0, 50)}..."`);
    } else {
      errors.push(`Missing stance marker (holdningsmarkør): "${title.slice(0, 50)}..."`);
    }
  }

  // Check for truncation indicators
  if (title.endsWith('/') || title.endsWith('/.') || title.endsWith('/...')) {
    errors.push(`Title appears truncated (ends with /): "${title.slice(-30)}"`);
  }

  // Check for mid-word truncation (word ending with . that isn't a common abbreviation)
  const lastWord = title.split(' ').pop() || '';
  const commonAbbreviations = ['m.', 'nr.', 'ca.', 'fx.', 'etc.', 'mv.', 'pkt.', 'stk.', 'jf.', 'bl.a.'];
  if (lastWord.endsWith('.') && !commonAbbreviations.some(abbr => lastWord.endsWith(abbr))) {
    // Check if it looks like a truncated word (short, not a full sentence ending)
    if (lastWord.length > 1 && lastWord.length < 12 && !/[.!?]$/.test(title.slice(0, -1))) {
      warnings.push(`Title may be truncated mid-word: "...${title.slice(-30)}"`);
    }
  }

  // Check for imperative after "Støtte til"
  const støtteTilMatch = title.match(/^Støtte til\s+(\w+)/i);
  if (støtteTilMatch) {
    const wordAfterPrefix = støtteTilMatch[1].toLowerCase();
    if (IMPERATIVE_VERBS.includes(wordAfterPrefix)) {
      errors.push(`Imperative verb after "Støtte til": "${title.slice(0, 60)}..." (use noun form, e.g., "flytning" not "flyt")`);
    }
  }

  // Check for other stance prefixes with imperatives
  const modstandModMatch = title.match(/^Modstand mod\s+(\w+)/i);
  if (modstandModMatch) {
    const wordAfterPrefix = modstandModMatch[1].toLowerCase();
    if (IMPERATIVE_VERBS.includes(wordAfterPrefix)) {
      errors.push(`Imperative verb after "Modstand mod": "${title.slice(0, 60)}..." (use noun form)`);
    }
  }

  // Check for colon pattern that should have been cleaned
  if (title.includes(':') && /^(støtte|modstand|bekymring|ønske):/i.test(title)) {
    warnings.push(`Title has colon pattern that should be cleaned: "${title.slice(0, 50)}..."`);
  }

  // Check for forbidden "og" pattern (two holdninger joined)
  if (title.includes(' og ')) {
    // Pattern: two stance markers joined by "og"
    const multipleStancePattern = /(modstand|bekymring|ønske|støtte|forslag|krav|opfordring)\s+.*\s+og\s+.*(modstand|bekymring|ønske|støtte|forslag|krav|opfordring)/i;
    if (multipleStancePattern.test(title)) {
      errors.push(`Title combines multiple positions with "og": "${title.slice(0, 60)}..."`);
    } else {
      // Check for late "og" which often indicates merged concepts
      const ogIndex = title.toLowerCase().indexOf(' og ');
      // "og" after first 25 chars is suspicious (likely two concepts)
      // But allow compound objects like "bygning og have" early in title
      if (ogIndex > 25) {
        warnings.push(`Title contains "og" late in text - verify it's not two merged positions: "${title.slice(0, 60)}..."`);
      }
    }
  }

  // Check for vague terms that indicate poor title quality
  const vagueTerms = ['generel', 'diverse', 'afklaring', 'overvejelser', 'gennemsigtighed', 'forhold'];
  for (const term of vagueTerms) {
    if (title.toLowerCase().includes(term)) {
      warnings.push(`Title contains vague term "${term}": "${title.slice(0, 50)}..."`);
    }
  }

  // Check for weighted/subjective words that break professional tone
  for (const word of WEIGHTED_WORDS) {
    if (title.toLowerCase().includes(word.toLowerCase())) {
      errors.push(`Title contains weighted/subjective word "${word}" - use neutral alternative: "${title.slice(0, 60)}..."`);
    }
  }

  // Check for vague/abstract patterns that need specificity
  for (const pattern of VAGUE_ABSTRACT_PATTERNS) {
    if (pattern.test(title)) {
      warnings.push(`Title is too vague/abstract - needs specificity (height, area, location): "${title.slice(0, 60)}..."`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Auto-fix common title problems.
 *
 * @param {string} title - The title to fix
 * @param {string} direction - The position direction ('pro_change', 'pro_status_quo', 'neutral')
 * @returns {string} Fixed title
 */
export function autoFixTitle(title, direction) {
  if (!title) return title;

  let fixed = title;

  // Fix titles starting with infinitive (e.g., "Bevare X" → "Ønske om bevaring af X")
  const infinitiveStarts = [
    { pattern: /^Bevare\s+(.+)/i, replacement: 'Ønske om bevaring af $1' },
    { pattern: /^Bevar\s+(.+)/i, replacement: 'Ønske om bevaring af $1' },
    { pattern: /^Flytte?\s+(.+)/i, replacement: 'Ønske om flytning af $1' },
    { pattern: /^Ændre?\s+(.+)/i, replacement: 'Ønske om ændring af $1' },
    { pattern: /^Fjerne?\s+(.+)/i, replacement: 'Ønske om fjernelse af $1' },
    { pattern: /^Stoppe?\s+(.+)/i, replacement: 'Modstand mod $1' },
    { pattern: /^Sikre?\s+(.+)/i, replacement: 'Ønske om sikring af $1' }
  ];

  for (const { pattern, replacement } of infinitiveStarts) {
    if (pattern.test(fixed)) {
      fixed = fixed.replace(pattern, replacement);
      console.log(`[TitleValidator] Auto-fixed infinitive title: "${title}" → "${fixed}"`);
      break;
    }
  }

  // Fix truncated endings
  if (fixed.endsWith('/') || fixed.endsWith('/.')) {
    // Remove the truncation marker
    fixed = fixed.replace(/\/\.?$/, '');
    console.log(`[TitleValidator] Removed truncation marker: "${title}" → "${fixed}"`);
  }

  // Fix titles that start with noun but lack stance marker
  // (e.g., "Bevarelse af stibroen" → "Ønske om bevarelse af stibroen")
  const hasStancePrefix = VALID_PREFIXES.some(prefix =>
    fixed.toLowerCase().startsWith(prefix.toLowerCase())
  );

  if (!hasStancePrefix) {
    // Determine appropriate prefix based on direction
    let prefix = 'Ønske om'; // Default
    if (direction === 'pro_status_quo') {
      // Status quo positions often express concerns or desire to preserve
      const concernPatterns = /^(bekymring|frygt|risiko|problem)/i;
      if (concernPatterns.test(fixed.trim())) {
        prefix = 'Bekymring for';
      }
    } else if (direction === 'contra') {
      prefix = 'Modstand mod';
    }

    // Make first char lowercase when adding prefix
    const fixedLower = fixed.charAt(0).toLowerCase() + fixed.slice(1);
    fixed = `${prefix} ${fixedLower}`;
    console.log(`[TitleValidator] Auto-fixed missing stance marker: "${title}" → "${fixed}"`);
  }

  return fixed;
}

/**
 * Validate all position titles in a themes array.
 *
 * @param {Array} themes - Array of theme objects with positions
 * @returns {{valid: boolean, issues: Array<{theme: string, title: string, errors: string[], warnings: string[]}>}}
 */
export function validateAllTitles(themes) {
  const issues = [];

  for (const theme of themes) {
    for (const position of (theme.positions || [])) {
      const validation = validatePositionTitle(position.title);

      if (!validation.valid || validation.warnings.length > 0) {
        issues.push({
          theme: theme.name,
          title: position.title,
          direction: position._direction,
          errors: validation.errors,
          warnings: validation.warnings
        });
      }
    }
  }

  return {
    valid: issues.filter(i => i.errors.length > 0).length === 0,
    issues
  };
}

export default {
  validatePositionTitle,
  autoFixTitle,
  validateAllTitles,
  VALID_PREFIXES,
  IMPERATIVE_VERBS
};
