/**
 * AetherStream Wireless Cryptographic Engine
 * Provides AES-256-GCM encryption, PBKDF2 key derivation, and SHA-256 integrity verification.
 */

export class WirelessCrypto {
  /**
   * Derives an AES-GCM 256-bit CryptoKey from a user password and salt using PBKDF2.
   */
  static async deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
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
        salt: salt as BufferSource,
        iterations: 100000,
        hash: "SHA-256",
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  /**
   * Generates a random cryptographic salt (16 bytes).
   */
  static generateSalt(): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(16));
  }

  /**
   * Generates a random initialization vector (12 bytes for AES-GCM).
   */
  static generateIV(): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(12));
  }

  /**
   * Generates a random secure session passphrase.
   */
  static generateSessionPassword(length: number = 8): string {
    const charset = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    let result = "";
    for (let i = 0; i < length; i++) {
      result += charset[bytes[i] % charset.length];
    }
    return result;
  }

  /**
   * Encrypts a binary chunk with AES-256-GCM.
   */
  static async encryptChunk(
    chunk: Uint8Array,
    key: CryptoKey,
    iv: Uint8Array
  ): Promise<Uint8Array> {
    const ciphertextBuffer = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      chunk as BufferSource
    );
    return new Uint8Array(ciphertextBuffer);
  }

  /**
   * Decrypts a binary chunk with AES-256-GCM.
   */
  static async decryptChunk(
    encryptedChunk: Uint8Array,
    key: CryptoKey,
    iv: Uint8Array
  ): Promise<Uint8Array> {
    const plaintextBuffer = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      encryptedChunk as BufferSource
    );
    return new Uint8Array(plaintextBuffer);
  }

  /**
   * Computes SHA-256 checksum in hex for a buffer.
   */
  static async computeSHA256(buffer: ArrayBuffer | Uint8Array): Promise<string> {
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer as BufferSource);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /**
   * Utility to convert Uint8Array to base64.
   */
  static uint8ToBase64(bytes: Uint8Array): string {
    let binary = "";
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * Utility to convert base64 to Uint8Array.
   */
  static base64ToUint8(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
}
