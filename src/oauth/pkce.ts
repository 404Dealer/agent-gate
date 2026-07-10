import { createHash, randomBytes } from 'node:crypto';

const base64url = (value: Buffer): string => value.toString('base64url');

export function createPkceChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier, 'ascii').digest());
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: createPkceChallenge(verifier) };
}
