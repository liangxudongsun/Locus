/**
 * Text versions exchanged with the Rust stores. Offsets are UTF-16 code units
 * and never split a surrogate pair, so the backend can map them to UTF-8.
 * `src-tauri/src/text_delta.rs` implements the same hash and delta rules.
 */
export interface TextDelta {
  from: number;
  to: number;
  insert: string;
}

/** cyrb53 over UTF-16 code units, prefixed with the length (both hexadecimal). */
export function textHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hash = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return `${text.length.toString(16)}-${hash.toString(16)}`;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * Longest common prefix by binary search over substring equality. Each probe
 * is a native comparison of a halving range, so the total work stays linear
 * at memcmp speed instead of a per-character JavaScript loop.
 */
function commonPrefix(base: string, next: string, limit: number): number {
  let low = 0;
  let high = limit;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (base.slice(low, mid) === next.slice(low, mid)) low = mid;
    else high = mid - 1;
  }
  return low;
}

function commonSuffix(base: string, next: string, limit: number): number {
  let low = 0;
  let high = limit;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (base.slice(base.length - mid, base.length - low) === next.slice(next.length - mid, next.length - low)) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** The single replaced span that turns `base` into `next`, or null when equal. */
export function singleSpanDelta(base: string, next: string): TextDelta | null {
  if (base === next) return null;
  const limit = Math.min(base.length, next.length);
  let prefix = commonPrefix(base, next, limit);
  if (prefix > 0 && isHighSurrogate(base.charCodeAt(prefix - 1))) prefix -= 1;
  let suffix = commonSuffix(base, next, limit - prefix);
  if (suffix > 0 && isLowSurrogate(base.charCodeAt(base.length - suffix))) suffix -= 1;
  return {
    from: prefix,
    to: base.length - suffix,
    insert: next.slice(prefix, next.length - suffix),
  };
}

export function applyTextDelta(base: string, delta: TextDelta): string {
  if (delta.from < 0 || delta.to < delta.from || delta.to > base.length) {
    throw new Error("Text delta is outside the base text");
  }
  return base.slice(0, delta.from) + delta.insert + base.slice(delta.to);
}
