import test from "node:test";
import assert from "node:assert/strict";
import * as nodeCrypto from "node:crypto";

if (typeof globalThis.crypto === "undefined") {
  (globalThis as any).crypto = nodeCrypto.webcrypto || nodeCrypto;
}

import { WirelessCrypto } from "../wireless/crypto";
import { WEBRTC_CHUNK_SIZE, BUFFER_HIGH_WATERMARK, BUFFER_LOW_WATERMARK } from "../wireless/protocol";

test("wireless crypto: AES-256-GCM encryption and decryption round-trip", async () => {
  const password = "test-secret-password-123";
  const salt = WirelessCrypto.generateSalt();
  const iv = WirelessCrypto.generateIV();

  const key = await WirelessCrypto.deriveKey(password, salt);
  assert.ok(key);

  const plaintext = new TextEncoder().encode("Hello AetherStream Wireless! Fast 100MB/s link.");
  const ciphertext = await WirelessCrypto.encryptChunk(plaintext, key, iv);

  assert.notDeepEqual(ciphertext, plaintext);
  assert.ok(ciphertext.length > plaintext.length); // includes auth tag

  const decrypted = await WirelessCrypto.decryptChunk(ciphertext, key, iv);
  assert.deepEqual(decrypted, plaintext);
  assert.equal(new TextDecoder().decode(decrypted), "Hello AetherStream Wireless! Fast 100MB/s link.");
});

test("wireless crypto: SHA-256 checksum calculation", async () => {
  const data = new TextEncoder().encode("AetherStream Ultra SHA Checksum Verification");
  const hash = await WirelessCrypto.computeSHA256(data);

  // Compare with Node's crypto
  const expectedHash = nodeCrypto.createHash("sha256").update(data).digest("hex");
  assert.equal(hash, expectedHash);
});

test("wireless crypto: session password generator", () => {
  const pwd1 = WirelessCrypto.generateSessionPassword(8);
  const pwd2 = WirelessCrypto.generateSessionPassword(8);

  assert.equal(pwd1.length, 8);
  assert.equal(pwd2.length, 8);
  assert.notEqual(pwd1, pwd2);
});

test("wireless crypto: base64 conversions", () => {
  const original = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
  const b64 = WirelessCrypto.uint8ToBase64(original);
  const restored = WirelessCrypto.base64ToUint8(b64);

  assert.deepEqual(restored, original);
});

test("wireless protocol: constants are optimized for high throughput", () => {
  assert.equal(WEBRTC_CHUNK_SIZE, 64 * 1024); // 64 KB
  assert.ok(BUFFER_HIGH_WATERMARK > WEBRTC_CHUNK_SIZE);
  assert.ok(BUFFER_LOW_WATERMARK < BUFFER_HIGH_WATERMARK);
});
