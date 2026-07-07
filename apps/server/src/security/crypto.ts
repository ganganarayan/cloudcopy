import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM sealing for provider credentials at rest.
 * Layout: [1-byte version][12-byte IV][16-byte auth tag][ciphertext]
 */
const VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function sealSecret(plaintext: Buffer | string, key: Buffer): Buffer {
  if (key.length !== 32) throw new Error('sealSecret: key must be 32 bytes');
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, ciphertext]);
}

export function openSecret(sealed: Buffer, key: Buffer): Buffer {
  if (key.length !== 32) throw new Error('openSecret: key must be 32 bytes');
  if (sealed.length < 1 + IV_LENGTH + TAG_LENGTH) throw new Error('openSecret: sealed blob too short');
  if (sealed[0] !== VERSION) throw new Error(`openSecret: unsupported version ${sealed[0]}`);
  const iv = sealed.subarray(1, 1 + IV_LENGTH);
  const tag = sealed.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + TAG_LENGTH);
  const ciphertext = sealed.subarray(1 + IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function sealJson(value: unknown, key: Buffer): Buffer {
  return sealSecret(JSON.stringify(value), key);
}

export function openJson<T>(sealed: Buffer, key: Buffer): T {
  return JSON.parse(openSecret(sealed, key).toString('utf8')) as T;
}
