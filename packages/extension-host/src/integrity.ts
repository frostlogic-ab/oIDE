import { createHash, timingSafeEqual } from 'node:crypto';

const ALGOS = ['sha512', 'sha384', 'sha256'] as const;
export type SriAlgorithm = (typeof ALGOS)[number];

export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrityError';
  }
}

/** Parse an SRI string (`sha512-<base64> sha256-<base64>`), strongest first. Unknown algorithms are ignored. */
export function parseIntegrity(sri: string): Array<{ algorithm: SriAlgorithm; digest: string }> {
  const out: Array<{ algorithm: SriAlgorithm; digest: string }> = [];
  for (const part of sri.trim().split(/\s+/)) {
    const m = /^(sha512|sha384|sha256)-([A-Za-z0-9+/]+={0,2})(\?.*)?$/.exec(part);
    if (m) out.push({ algorithm: m[1] as SriAlgorithm, digest: m[2] as string });
  }
  return out.sort((a, b) => ALGOS.indexOf(a.algorithm) - ALGOS.indexOf(b.algorithm));
}

export function computeIntegrity(data: Uint8Array, algorithm: SriAlgorithm = 'sha512'): string {
  return `${algorithm}-${createHash(algorithm).update(data).digest('base64')}`;
}

/**
 * Check `data` against an SRI string using its strongest supported hash. Returns false for a
 * mismatch or when the string has no supported hash.
 */
export function verifyIntegrity(data: Uint8Array, sri: string): boolean {
  const hashes = parseIntegrity(sri);
  const strongest = hashes[0];
  if (!strongest) return false;
  // Every hash of the strongest algorithm may match (SRI allows several).
  return hashes
    .filter((h) => h.algorithm === strongest.algorithm)
    .some((h) => {
      const expected = Buffer.from(h.digest, 'base64');
      const actual = createHash(h.algorithm).update(data).digest();
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    });
}

export function assertIntegrity(data: Uint8Array, sri: string, what = 'tarball'): void {
  if (!verifyIntegrity(data, sri)) throw new IntegrityError(`${what} does not match its integrity hash`);
}
