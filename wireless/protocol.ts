/**
 * AetherStream Wireless Protocol Definition
 * High-speed binary framing, control signals, and message schemas.
 */

export const PROTOCOL_VERSION = "2.0";
export const WEBRTC_CHUNK_SIZE = 64 * 1024; // 64 KB per DataChannel packet (optimal for SCTP throughput)
export const BUFFER_HIGH_WATERMARK = 4 * 1024 * 1024; // 4 MB backpressure threshold
export const BUFFER_LOW_WATERMARK = 512 * 1024; // 512 KB resume threshold

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
  host?: string; // Local IP/hostname
  port?: number;
  peer: PeerDevice;
  signalUrl?: string;
  sdpOffer?: string; // Compact compressed SDP if applicable
  key?: string; // Ephemeral public key / token
}
