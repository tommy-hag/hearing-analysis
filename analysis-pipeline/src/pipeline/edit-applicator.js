/**
 * Edit Applicator
 *
 * Handles edit operations on positions and citations during interactive editing.
 * Operations are applied to in-memory position data and logged for undo/redo.
 */

import { v4 as uuidv4 } from 'uuid';

/**
 * Apply an edit operation to positions data
 * @param {Object} positions - Current positions data (themes array)
 * @param {Object} operation - Operation to apply
 * @returns {Object} { success, positions: updatedPositions, inverse: inverseOperation }
 */
export function applyOperation(positions, operation) {
  const { type, ...params } = operation;

  switch (type) {
    case 'MOVE_CITATION':
      return moveCitation(positions, params);
    case 'CREATE_POSITION':
      return createPosition(positions, params);
    case 'MERGE_POSITIONS':
      return mergePositions(positions, params);
    case 'SPLIT_POSITION':
      return splitPosition(positions, params);
    case 'DELETE_POSITION':
      return deletePosition(positions, params);
    case 'UPDATE_POSITION':
      return updatePosition(positions, params);
    case 'CREATE_THEME':
      return createTheme(positions, params);
    case 'DELETE_THEME':
      return deleteTheme(positions, params);
    case 'MARK_NO_OPINION':
      return markNoOpinion(positions, params);
    default:
      return { success: false, error: `Unknown operation type: ${type}` };
  }
}

/**
 * Move a citation (response) from one position to another
 */
function moveCitation(positions, { responseNumber, fromPositionKey, toPositionKey }) {
  const themes = positions.themes || [];

  // Parse position keys (format: "ThemeName::PositionTitle")
  const [fromTheme, fromTitle] = fromPositionKey.split('::');
  const [toTheme, toTitle] = toPositionKey.split('::');

  // Find source position
  let sourcePosition = null;
  let sourceThemeObj = null;
  for (const theme of themes) {
    if (theme.name === fromTheme) {
      sourceThemeObj = theme;
      sourcePosition = (theme.positions || []).find(p => p.title === fromTitle);
      break;
    }
  }

  if (!sourcePosition) {
    return { success: false, error: `Kildeposition ikke fundet: ${fromPositionKey}` };
  }

  if (!sourcePosition.responseNumbers?.includes(responseNumber)) {
    return { success: false, error: `Response ${responseNumber} findes ikke i kildeposition` };
  }

  // Find target position
  let targetPosition = null;
  let targetThemeObj = null;
  for (const theme of themes) {
    if (theme.name === toTheme) {
      targetThemeObj = theme;
      targetPosition = (theme.positions || []).find(p => p.title === toTitle);
      break;
    }
  }

  if (!targetPosition) {
    return { success: false, error: `Målposition ikke fundet: ${toPositionKey}` };
  }

  // Remove from source
  sourcePosition.responseNumbers = sourcePosition.responseNumbers.filter(n => n !== responseNumber);

  // Add to target
  if (!targetPosition.responseNumbers) targetPosition.responseNumbers = [];
  if (!targetPosition.responseNumbers.includes(responseNumber)) {
    targetPosition.responseNumbers.push(responseNumber);
    targetPosition.responseNumbers.sort((a, b) => a - b);
  }

  // Create inverse operation
  const inverse = {
    type: 'MOVE_CITATION',
    responseNumber,
    fromPositionKey: toPositionKey,
    toPositionKey: fromPositionKey
  };

  return { success: true, positions, inverse };
}

/**
 * Create a new position with specified responses
 */
function createPosition(positions, { themeName, title, responseNumbers, direction }) {
  const themes = positions.themes || [];

  // Find or create theme
  let theme = themes.find(t => t.name === themeName);
  if (!theme) {
    theme = { name: themeName, positions: [] };
    themes.push(theme);
  }

  // Check if position already exists
  if (theme.positions.some(p => p.title === title)) {
    return { success: false, error: `Position "${title}" findes allerede i tema "${themeName}"` };
  }

  // Remove responses from their current positions
  const originalPositions = {};
  for (const num of responseNumbers) {
    for (const t of themes) {
      for (const p of (t.positions || [])) {
        if (p.responseNumbers?.includes(num)) {
          if (!originalPositions[num]) {
            originalPositions[num] = `${t.name}::${p.title}`;
          }
          p.responseNumbers = p.responseNumbers.filter(n => n !== num);
        }
      }
    }
  }

  // Create new position
  const newPosition = {
    id: uuidv4(),
    title,
    direction: direction || 'unknown',
    responseNumbers: responseNumbers.sort((a, b) => a - b),
    createdManually: true
  };

  theme.positions.push(newPosition);

  // Create inverse operation
  const inverse = {
    type: 'DELETE_POSITION',
    positionKey: `${themeName}::${title}`,
    restoreToPositions: originalPositions
  };

  return { success: true, positions, inverse };
}

/**
 * Merge multiple positions into one
 */
function mergePositions(positions, { positionKeys, targetTitle, targetTheme }) {
  const themes = positions.themes || [];

  // Collect all response numbers from positions to merge
  const allResponseNumbers = [];
  const mergedPositions = [];

  for (const key of positionKeys) {
    const [themeName, title] = key.split('::');
    for (const theme of themes) {
      if (theme.name === themeName) {
        const pos = (theme.positions || []).find(p => p.title === title);
        if (pos) {
          mergedPositions.push({ themeName, ...pos });
          allResponseNumbers.push(...(pos.responseNumbers || []));
        }
      }
    }
  }

  if (mergedPositions.length < 2) {
    return { success: false, error: 'Mindst 2 positioner kræves for merge' };
  }

  // Remove all original positions
  for (const key of positionKeys) {
    const [themeName, title] = key.split('::');
    for (const theme of themes) {
      if (theme.name === themeName) {
        theme.positions = (theme.positions || []).filter(p => p.title !== title);
      }
    }
  }

  // Find or create target theme
  const targetThemeName = targetTheme || mergedPositions[0].themeName;
  let theme = themes.find(t => t.name === targetThemeName);
  if (!theme) {
    theme = { name: targetThemeName, positions: [] };
    themes.push(theme);
  }

  // Create merged position
  const finalTitle = targetTitle || mergedPositions.map(p => p.title).join(' + ');
  const uniqueResponses = [...new Set(allResponseNumbers)].sort((a, b) => a - b);

  const mergedPosition = {
    id: uuidv4(),
    title: finalTitle,
    direction: mergedPositions[0].direction,
    responseNumbers: uniqueResponses,
    mergedFrom: positionKeys
  };

  theme.positions.push(mergedPosition);

  // Create inverse operation (split back to original positions)
  const inverse = {
    type: 'UNMERGE_POSITIONS',
    mergedPositionKey: `${targetThemeName}::${finalTitle}`,
    originalPositions: mergedPositions
  };

  return { success: true, positions, inverse };
}

/**
 * Split a position based on sub-positions or response selection
 */
function splitPosition(positions, { positionKey, splits }) {
  const themes = positions.themes || [];
  const [themeName, title] = positionKey.split('::');

  // Find the position
  let sourcePosition = null;
  let sourceTheme = null;
  for (const theme of themes) {
    if (theme.name === themeName) {
      sourceTheme = theme;
      sourcePosition = (theme.positions || []).find(p => p.title === title);
      break;
    }
  }

  if (!sourcePosition) {
    return { success: false, error: `Position ikke fundet: ${positionKey}` };
  }

  // Validate splits cover all responses
  const allSplitResponses = splits.flatMap(s => s.responseNumbers);
  const originalResponses = sourcePosition.responseNumbers || [];

  // Create new positions from splits
  const newPositions = [];
  for (const split of splits) {
    const newPos = {
      id: uuidv4(),
      title: split.title,
      direction: split.direction || sourcePosition.direction,
      responseNumbers: split.responseNumbers.sort((a, b) => a - b),
      splitFrom: positionKey
    };
    newPositions.push(newPos);
    sourceTheme.positions.push(newPos);
  }

  // Remove original position
  sourceTheme.positions = sourceTheme.positions.filter(p => p.title !== title);

  // Create inverse operation
  const inverse = {
    type: 'MERGE_POSITIONS',
    positionKeys: newPositions.map(p => `${themeName}::${p.title}`),
    targetTitle: title,
    targetTheme: themeName
  };

  return { success: true, positions, inverse };
}

/**
 * Delete a position (orphan responses can be reassigned)
 */
function deletePosition(positions, { positionKey, restoreToPositions }) {
  const themes = positions.themes || [];
  const [themeName, title] = positionKey.split('::');

  // Find the position
  let deletedPosition = null;
  for (const theme of themes) {
    if (theme.name === themeName) {
      deletedPosition = (theme.positions || []).find(p => p.title === title);
      if (deletedPosition) {
        theme.positions = theme.positions.filter(p => p.title !== title);
      }
      break;
    }
  }

  if (!deletedPosition) {
    return { success: false, error: `Position ikke fundet: ${positionKey}` };
  }

  // If restoreToPositions provided, move responses back
  if (restoreToPositions) {
    for (const [numStr, targetKey] of Object.entries(restoreToPositions)) {
      const num = parseInt(numStr, 10);
      const [targetTheme, targetTitle] = targetKey.split('::');
      for (const theme of themes) {
        if (theme.name === targetTheme) {
          const pos = (theme.positions || []).find(p => p.title === targetTitle);
          if (pos) {
            if (!pos.responseNumbers) pos.responseNumbers = [];
            if (!pos.responseNumbers.includes(num)) {
              pos.responseNumbers.push(num);
              pos.responseNumbers.sort((a, b) => a - b);
            }
          }
        }
      }
    }
  }

  // Create inverse operation
  const inverse = {
    type: 'CREATE_POSITION',
    themeName,
    title,
    responseNumbers: deletedPosition.responseNumbers || [],
    direction: deletedPosition.direction
  };

  return { success: true, positions, inverse };
}

/**
 * Update position metadata (title, direction, etc.)
 */
function updatePosition(positions, { positionKey, updates }) {
  const themes = positions.themes || [];
  const [themeName, title] = positionKey.split('::');

  // Find the position
  let position = null;
  for (const theme of themes) {
    if (theme.name === themeName) {
      position = (theme.positions || []).find(p => p.title === title);
      break;
    }
  }

  if (!position) {
    return { success: false, error: `Position ikke fundet: ${positionKey}` };
  }

  // Store old values for inverse
  const oldValues = {};
  for (const key of Object.keys(updates)) {
    oldValues[key] = position[key];
  }

  // Apply updates
  Object.assign(position, updates);

  // Create inverse operation
  const inverse = {
    type: 'UPDATE_POSITION',
    positionKey: updates.title ? `${themeName}::${updates.title}` : positionKey,
    updates: oldValues
  };

  return { success: true, positions, inverse };
}

/**
 * Create a new theme
 */
function createTheme(positions, { themeName }) {
  const themes = positions.themes || [];

  if (themes.some(t => t.name === themeName)) {
    return { success: false, error: `Tema "${themeName}" findes allerede` };
  }

  themes.push({ name: themeName, positions: [] });

  const inverse = {
    type: 'DELETE_THEME',
    themeName
  };

  return { success: true, positions, inverse };
}

/**
 * Delete an empty theme
 */
function deleteTheme(positions, { themeName }) {
  const themes = positions.themes || [];
  const theme = themes.find(t => t.name === themeName);

  if (!theme) {
    return { success: false, error: `Tema ikke fundet: ${themeName}` };
  }

  if (theme.positions?.length > 0) {
    return { success: false, error: `Kan ikke slette tema med positioner` };
  }

  positions.themes = themes.filter(t => t.name !== themeName);

  const inverse = {
    type: 'CREATE_THEME',
    themeName
  };

  return { success: true, positions, inverse };
}

/**
 * Mark responses as "no opinion" (move to special category)
 */
function markNoOpinion(positions, { responseNumbers }) {
  const themes = positions.themes || [];
  const noOpinionTheme = 'Ingen holdning';

  // Track where responses came from
  const originalPositions = {};

  // Remove from current positions
  for (const num of responseNumbers) {
    for (const theme of themes) {
      for (const pos of (theme.positions || [])) {
        if (pos.responseNumbers?.includes(num)) {
          if (!originalPositions[num]) {
            originalPositions[num] = `${theme.name}::${pos.title}`;
          }
          pos.responseNumbers = pos.responseNumbers.filter(n => n !== num);
        }
      }
    }
  }

  // Find or create "Ingen holdning" theme
  let noOpinion = themes.find(t => t.name === noOpinionTheme);
  if (!noOpinion) {
    noOpinion = { name: noOpinionTheme, positions: [] };
    themes.push(noOpinion);
  }

  // Find or create "Ikke relevant" position
  let irPos = noOpinion.positions.find(p => p.title === 'Ikke relevant');
  if (!irPos) {
    irPos = {
      id: uuidv4(),
      title: 'Ikke relevant',
      direction: 'neutral',
      responseNumbers: []
    };
    noOpinion.positions.push(irPos);
  }

  // Add responses
  for (const num of responseNumbers) {
    if (!irPos.responseNumbers.includes(num)) {
      irPos.responseNumbers.push(num);
    }
  }
  irPos.responseNumbers.sort((a, b) => a - b);

  // Create inverse operation
  const inverse = {
    type: 'RESTORE_FROM_NO_OPINION',
    responseNumbers,
    restoreToPositions: originalPositions
  };

  return { success: true, positions, inverse };
}

/**
 * Validate an operation before applying
 */
export function validateOperation(positions, operation) {
  const { type, ...params } = operation;

  switch (type) {
    case 'MOVE_CITATION':
      if (!params.responseNumber || !params.fromPositionKey || !params.toPositionKey) {
        return { valid: false, error: 'Mangler påkrævede felter for MOVE_CITATION' };
      }
      break;
    case 'CREATE_POSITION':
      if (!params.themeName || !params.title || !params.responseNumbers?.length) {
        return { valid: false, error: 'Mangler påkrævede felter for CREATE_POSITION' };
      }
      break;
    case 'MERGE_POSITIONS':
      if (!params.positionKeys || params.positionKeys.length < 2) {
        return { valid: false, error: 'Mindst 2 positioner kræves for MERGE_POSITIONS' };
      }
      break;
    case 'SPLIT_POSITION':
      if (!params.positionKey || !params.splits?.length) {
        return { valid: false, error: 'Mangler påkrævede felter for SPLIT_POSITION' };
      }
      break;
    case 'DELETE_POSITION':
      if (!params.positionKey) {
        return { valid: false, error: 'Mangler positionKey for DELETE_POSITION' };
      }
      break;
    case 'MARK_NO_OPINION':
      if (!params.responseNumbers?.length) {
        return { valid: false, error: 'Mangler responseNumbers for MARK_NO_OPINION' };
      }
      break;
    default:
      return { valid: false, error: `Ukendt operation type: ${type}` };
  }

  return { valid: true };
}

/**
 * Apply multiple operations in sequence
 */
export function applyOperations(positions, operations) {
  const inverses = [];
  let currentPositions = positions;

  for (const op of operations) {
    const result = applyOperation(currentPositions, op);
    if (!result.success) {
      // Rollback previous operations
      for (const inv of inverses.reverse()) {
        applyOperation(currentPositions, inv);
      }
      return { success: false, error: result.error, rolledBack: true };
    }
    inverses.push(result.inverse);
    currentPositions = result.positions;
  }

  return { success: true, positions: currentPositions, inverses };
}

export default {
  applyOperation,
  validateOperation,
  applyOperations
};
