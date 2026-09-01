// worker/crypto.ts
//
// Ed25519 signing for Mode-2 badges/reports. The private key is a Worker secret
// (PKCS8, base64); the public key is published so anyone can verify offline. The
// imported key is cached at isolate scope — it is immutable, so caching is safe
// and avoids re-importing per request.

import type { Env } from './types.ts';

let cachedKey: CryptoKey | null = null;

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function isSigningConfigured(env: Env): boolean {
  return !!env.ED25519_PRIVATE_KEY;
}

async function privateKey(env: Env): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  if (!env.ED25519_PRIVATE_KEY) throw new Error('ED25519_PRIVATE_KEY not configured');
  cachedKey = await crypto.subtle.importKey(
    'pkcs8',
    base64ToBytes(env.ED25519_PRIVATE_KEY) as BufferSource,
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
  return cachedKey;
}

/** Sign a message with Ed25519; returns the signature as base64. */
export async function signEd25519(env: Env, message: string): Promise<string> {
  const key = await privateKey(env);
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(message));
  return bytesToBase64(new Uint8Array(sig));
}

/** Identifier of the signing key (so verifiers know which public key to use). */
export function keyId(env: Env): string {
  return env.TRUSTWRIGHT_KEY_ID || 'k1';
}

/**
 * Length-safe comparison for secrets (admin/stats tokens). Unlike a naive
 * `a.length !== b.length` early return, it folds the length difference into the
 * accumulator, so timing does not reveal the SECRET's length (only the caller's
 * own input length, which they already know). The single shared implementation
 * replaces four hand-rolled copies that each leaked length. JS strings are not
 * perfectly constant-time, so this is defence in depth over already
 * high-entropy, fixed-length tokens.
 */
export function constantTimeEqual(provided: string, secret: string): boolean {
  const m = secret.length;
  let diff = provided.length ^ m;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ (m > 0 ? secret.charCodeAt(i % m) : 0);
  }
  return diff === 0;
}
