/**
 * Normalize a BLOB value read from D1 into a Uint8Array.
 *
 * Production Cloudflare D1 returns BLOB columns as ArrayBuffer. Local wrangler
 * (miniflare) sometimes returns them as a CSV string of decimal byte values
 * ("255,216,255,224,..."), which silently corrupts binary payloads unless
 * parsed back. This helper handles both shapes plus Uint8Array/Node Buffer.
 */
export function toBytes(data) {
  if (data == null) return new Uint8Array(0);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'string') {
    const parts = data.split(',');
    const bytes = new Uint8Array(parts.length);
    for (let i = 0; i < parts.length; i++) bytes[i] = parts[i] | 0;
    return bytes;
  }
  if (typeof data === 'object') {
    // Buffer.toJSON() shape: { type: 'Buffer', data: [...] }
    if (Array.isArray(data.data)) return Uint8Array.from(data.data);
    // Plain array of bytes.
    if (Array.isArray(data)) return Uint8Array.from(data);
    // Object with numeric keys (common local-D1 serialization of a Uint8Array).
    if (typeof data.length === 'number') return Uint8Array.from(data);
    const keys = Object.keys(data);
    if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
      const bytes = new Uint8Array(keys.length);
      for (const k of keys) bytes[+k] = data[k] | 0;
      return bytes;
    }
  }
  throw new Error('Unsupported BLOB shape: ' + typeof data);
}
