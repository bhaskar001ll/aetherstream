export async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptPayload(password: string, plaintext: Uint8Array): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  
  const key = await deriveKey(password, salt);
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv },
    key,
    plaintext
  );
  
  const ciphertext = new Uint8Array(ciphertextBuffer);
  
  // Format: [16-byte salt] [12-byte IV] [ciphertext + 16-byte auth tag]
  const output = new Uint8Array(salt.length + iv.length + ciphertext.length);
  output.set(salt, 0);
  output.set(iv, salt.length);
  output.set(ciphertext, salt.length + iv.length);
  
  return output;
}

export async function decryptPayload(password: string, encrypted: Uint8Array): Promise<Uint8Array> {
  if (encrypted.length < 28) { // 16 salt + 12 IV
    throw new Error("Encrypted payload is too short or invalid.");
  }
  
  const salt = encrypted.slice(0, 16);
  const iv = encrypted.slice(16, 28);
  const ciphertext = encrypted.slice(28);
  
  const key = await deriveKey(password, salt);
  const plaintextBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv },
    key,
    ciphertext
  );
  
  return new Uint8Array(plaintextBuffer);
}
