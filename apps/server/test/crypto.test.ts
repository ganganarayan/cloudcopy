import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openJson, openSecret, sealJson, sealSecret } from '../src/security/crypto.js';

describe('crypto seal/open', () => {
  const key = randomBytes(32);

  it('round-trips strings', () => {
    const sealed = sealSecret('hello mega session', key);
    expect(openSecret(sealed, key).toString('utf8')).toBe('hello mega session');
  });

  it('round-trips JSON auth state', () => {
    const state = { session: 'abc123', meta: { email: 'a@b.c' }, expiresAt: 42 };
    expect(openJson(sealJson(state, key), key)).toEqual(state);
  });

  it('produces different ciphertexts for the same plaintext (fresh IV)', () => {
    expect(sealSecret('same', key).equals(sealSecret('same', key))).toBe(false);
  });

  it('rejects tampered ciphertext', () => {
    const sealed = sealSecret('secret', key);
    sealed[sealed.length - 1]! ^= 0xff;
    expect(() => openSecret(sealed, key)).toThrow();
  });

  it('rejects the wrong key', () => {
    const sealed = sealSecret('secret', key);
    expect(() => openSecret(sealed, randomBytes(32))).toThrow();
  });

  it('rejects short keys', () => {
    expect(() => sealSecret('x', randomBytes(16))).toThrow(/32 bytes/);
  });
});
