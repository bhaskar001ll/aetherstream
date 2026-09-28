/**
 * AetherStream Wireless Protocol Definition
 * High-speed binary framing, control signals, and message schemas.
 */

export const PROTOCOL_VERSION = "2.0";
// One SCTP message. Larger messages mean far fewer main-thread sends on a phone.
export const WEBRTC_CHUNK_SIZE = 256 * 1024;
// Chrome throws "send queue is full" above 16MB. Pause at 8MB, resume at 4MB.
export const BUFFER_HIGH_WATERMARK = 8 * 1024 * 1024;
export const BUFFER_LOW_WATERMARK = 4 * 1024 * 1024;

export enum MessageType {
  DISCOVERY_ANNOUNCE = "DISCOVERY_ANNOUNCE",
  DISCOVERY_QUERY = "DISCOVERY_QUERY",
  PAIR_OFFER = "PAIR_OFFER",
  PAIR_ANSWER = "PAIR_ANSWER",
  TRANSFER_REQUEST = "TRANSFER_REQUEST",
  TRANSFER_ACCEPT = "TRANSFER_ACCEPT",
  TRANSFER_REJECT = "TRANSFER_REJECT",
  FILE_METADATA = "FILE_METADATA",
  CHUNK_ACK = "CHUNK_ACK",
  FILE_COMPLETE = "FILE_COMPLETE",
  TEXT_SNIPPET = "TEXT_SNIPPET",
  CANCEL_TRANSFER = "CANCEL_TRANSFER",
  PING = "PING",
  PONG = "PONG",
}

export interface PeerDevice {
  id: string;
  name: string;
  os: "windows" | "android" | "ios" | "macos" | "linux" | "unknown";
  browser: string;
  address?: string;
  lastSeen: number;
}

export interface FileMetadata {
  id: string;
  name: string;
  size: number;
  type: string;
  totalChunks: number;
  chunkSize: number;
  sha256?: string;
  encrypted: boolean;
  salt?: string; // base64
  iv?: string; // base64
}

export interface TransferRequestPayload {
  transferId: string;
  sender: PeerDevice;
  isSnippet: boolean;
  snippetPreview?: string;
  files: Array<{
    id: string;
    name: string;
    size: number;
    type: string;
  }>;
  totalBytes: number;
  encrypted: boolean;
}

export interface TextSnippetPayload {
  id: string;
  text: string;
  timestamp: number;
  encrypted: boolean;
  salt?: string;
  iv?: string;
}

export interface InstantQRHandshake {
  v: "2.0";
  sid: string; // Session ID
  peer: PeerDevice;
  key?: string; // Ephemeral session PIN / pairing key
}

