function base64DataValue(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 97 + 26;
  if (code >= 48 && code <= 57) return code - 48 + 52;
  return code === 43 ? 62 : code === 47 ? 63 : -1;
}

function inspectCanonicalBase64(value: string): {
  base64: string;
  canonicalPadBits: boolean;
} | null {
  let output: Buffer | undefined;
  let outputLength = 0;
  let padding = 0;
  let lastDataValue = 0;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 32) {
      if (!output) {
        output = Buffer.allocUnsafe(value.length - 1);
        for (let copyIndex = 0; copyIndex < index; copyIndex += 1) {
          output[copyIndex] = value.charCodeAt(copyIndex);
        }
        outputLength = index;
      }
      continue;
    }
    if (code === 61) {
      padding += 1;
      if (padding > 2) return null;
    } else {
      const dataValue = base64DataValue(code);
      if (padding > 0 || dataValue < 0) return null;
      lastDataValue = dataValue;
    }
    if (output) {
      output[outputLength] = code;
      outputLength += 1;
    }
  }

  const cleanedLength = output ? outputLength : value.length;
  if (cleanedLength === 0) return null;
  const remainder = cleanedLength % 4;
  if (remainder !== 0 && (padding > 0 || remainder === 1)) return null;
  const effectivePadding = remainder === 0 ? padding : 4 - remainder;
  const padBitMask = effectivePadding === 2 ? 15 : effectivePadding === 1 ? 3 : 0;
  const cleaned = output ? output.subarray(0, outputLength).toString('latin1') : value;

  return {
    base64: remainder === 0 ? cleaned : cleaned + '='.repeat(4 - remainder),
    canonicalPadBits: (lastDataValue & padBitMask) === 0,
  };
}

/** Normalize whitespace and validate alphabet, padding, length, and pad bits. */
export function canonicalizeBase64(value: string): string | undefined {
  const inspected = inspectCanonicalBase64(value);
  return inspected?.canonicalPadBits ? inspected.base64 : undefined;
}

function findFirstAsciiWhitespace(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 32) return index;
  }
  return -1;
}

/** Estimate decoded bytes without allocating a cleaned copy of the payload. */
export function estimateBase64DecodedBytes(value: string): number {
  let effectiveLength = value.length;
  const firstWhitespace = findFirstAsciiWhitespace(value);
  if (firstWhitespace !== -1) {
    for (let index = firstWhitespace; index < value.length; index += 1) {
      if (value.charCodeAt(index) <= 32) effectiveLength -= 1;
    }
  }
  if (effectiveLength === 0) return 0;

  let padding = 0;
  let end = value.length - 1;
  while (end >= 0 && value.charCodeAt(end) <= 32) end -= 1;
  if (end >= 0 && value[end] === '=') {
    padding = 1;
    end -= 1;
    while (end >= 0 && value.charCodeAt(end) <= 32) end -= 1;
    if (end >= 0 && value[end] === '=') padding = 2;
  }

  return Math.max(0, Math.floor((effectiveLength * 3) / 4) - padding);
}
