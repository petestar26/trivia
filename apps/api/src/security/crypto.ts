import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '@socialplay/config';
import { ApiError } from '../middleware';

/**
 * Envelope encryption for TOTP shared secrets at rest (W-0).
 *
 * The repository had no encryption/key-management helper before W-0, so
 * this is the smallest secure mechanism consistent with its conventions:
 * AES-256-GCM (authenticated encryption) with a key supplied through the
 * existing zod-validated config layer, not a bespoke key store.
 *
 * Fails CLOSED: if SECURITY_TOTP_ENCRYPTION_KEY is unset, every call
 * throws rather than falling back to plaintext storage. This is why the
 * config field is optional — an operator who never enables TOTP is
 * unaffected, but TOTP can never silently persist an unencrypted secret.
 *
 * Format: "v1:<iv-hex>:<authTag-hex>:<ciphertext-hex>". The version prefix
 * exists so the scheme can be rotated later without ambiguity.
 */

const SCHEME_VERSION = 'v1';
const IV_BYTES = 12; // GCM standard nonce length
const ALGORITHM = 'aes-256-gcm';

function getKey(): Buffer {
  const hex = config.SECURITY_TOTP_ENCRYPTION_KEY;
  if (!hex) {
    // Deliberately does not reveal configuration internals to the client.
    throw ApiError.serviceUnavailable('Two-factor authentication is not available on this server');
  }
  return Buffer.from(hex, 'hex');
}

/** True when the server is configured to store TOTP secrets securely. */
export function isTotpEncryptionConfigured(): boolean {
  return Boolean(config.SECURITY_TOTP_ENCRYPTION_KEY);
}

/**
 * Encrypts a TOTP shared secret for storage.
 *
 * The plaintext secret must never be logged, audited, or returned by any
 * API response after enrollment has started.
 */
export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${SCHEME_VERSION}:${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/**
 * Decrypts a stored TOTP secret.
 *
 * GCM authentication means a tampered or truncated ciphertext throws
 * rather than yielding attacker-influenced plaintext.
 */
export function decryptSecret(encoded: string): string {
  const key = getKey();
  const parts = encoded.split(':');
  if (parts.length !== 4 || parts[0] !== SCHEME_VERSION) {
    throw ApiError.internal('Stored credential is unreadable');
  }
  const [, ivHex, authTagHex, ciphertextHex] = parts;

  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextHex, 'hex')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch {
    // Never surface the underlying crypto error — it can leak whether the
    // failure was key mismatch, tag mismatch, or malformed input.
    throw ApiError.internal('Stored credential is unreadable');
  }
}
