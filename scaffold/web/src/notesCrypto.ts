// End-to-end encryption for private notes, using the browser's Web Crypto API.
//
// Agents of a workspace agree on a "team passphrase" outside the app (for
// example told in person). Each browser turns the passphrase into an AES key.
// The passphrase and the key never leave the browser; the server only gets
// the encrypted note. See PROTOCOL.md.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

// passphrase -> AES-256 key. PBKDF2 makes guessing the passphrase slow.
// The salt is the workspace id, so the same passphrase gives a different key
// in a different workspace.
export async function deriveKey(passphrase: string, workspace: string): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: encoder.encode('switchboard-notes:' + workspace), iterations: 200_000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptNote(key: CryptoKey, text: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // new random iv for every note
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(text));
  return { ciphertext: toBase64(new Uint8Array(encrypted)), iv: toBase64(iv) };
}

// Returns null if the key is wrong (AES-GCM detects it).
export async function decryptNote(key: CryptoKey, ciphertext: string, iv: string): Promise<string | null> {
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv) }, key, fromBase64(ciphertext));
    return decoder.decode(plain);
  } catch {
    return null;
  }
}
