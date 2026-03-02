export function chunkArray(array, chunkSize) {
  if (!Array.isArray(array) || chunkSize <= 0) {
    return [];
  }

  const chunks = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}


