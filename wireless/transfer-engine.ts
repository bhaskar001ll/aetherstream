/**
 * AetherStream Wireless Transfer Engine
 * High-speed peer-to-peer data transport over WebRTC DataChannel powered by PeerJS.
 */

import Peer, { type DataConnection } from "peerjs";
import {
  MessageType,
  PeerDevice,
  FileMetadata,
  TransferRequestPayload,
  TextSnippetPayload,
  WEBRTC_CHUNK_SIZE,
  BUFFER_HIGH_WATERMARK,
  BUFFER_LOW_WATERMARK,
  InstantQRHandshake,
} from "./protocol";
import { WirelessCrypto } from "./crypto";

export interface TransferProgress {
  fileId: string;
  fileName: string;
  bytesTransferred: number;
  totalBytes: number;
  percent: number;
  speedMBps: number;
  etaSeconds: number;
  state: "idle" | "connecting" | "sending" | "receiving" | "verifying" | "complete" | "error";
  error?: string;
}

export type ProgressCallback = (progress: TransferProgress) => void;
export type PeerUpdateCallback = (peers: PeerDevice[]) => void;
export type IncomingTransferCallback = (
  req: TransferRequestPayload,
  accept: () => void,
  reject: () => void
) => void;
export type SnippetReceivedCallback = (snippet: TextSnippetPayload) => void;
export type ConnectionCallback = (peer: PeerDevice) => void;
export type FileSavedCallback = (name: string, url: string, size: number, sha256: string) => void;

export class WirelessTransferEngine {
  public myDevice: PeerDevice;
  public discoveredPeers: Map<string, PeerDevice> = new Map();

  // PeerJS WebRTC Transport
  private peer: Peer | null = null;
  private activeConnection: DataConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private activePeer: PeerDevice | null = null;
  private isPeerReady: boolean = false;

  // Callbacks
  public onConnected?: ConnectionCallback;
  public onProgress?: ProgressCallback;
  public onPeersUpdated?: PeerUpdateCallback;
  public onIncomingTransfer?: IncomingTransferCallback;
  public onSnippetReceived?: SnippetReceivedCallback;
  public onFileSaved?: FileSavedCallback;

  // Active state
  private broadcastChannel: BroadcastChannel;
  private pollingTimer: any = null;
  private activeSessionKey: CryptoKey | null = null;
  private sessionSecretPassword: string = "";
  private sseRadarSource: EventSource | null = null;
  private lastCloudBroadcast: number = 0;

  // Stream state
  private currentIncomingFile: {
    meta: FileMetadata;
    chunks: Uint8Array[];
    receivedBytes: number;
    fileWriter?: any;
  } | null = null;

  // Speedometer
  private speedSamples: Array<{ time: number; bytes: number }> = [];
  private transferStartTime: number = 0;

  constructor() {
    this.myDevice = this.detectCurrentDevice();
    this.broadcastChannel = new BroadcastChannel("aetherstream_wireless_radar");
    this.setupBroadcastChannel();
    this.setupRadarDiscovery();
    this.startSignalingPoll();
    this.initPeerJs();
  }

  private detectCurrentDevice(): PeerDevice {
    const ua = navigator.userAgent.toLowerCase();
    let os: PeerDevice["os"] = "unknown";
    if (ua.includes("android")) os = "android";
    else if (ua.includes("iphone") || ua.includes("ipad")) os = "ios";
    else if (ua.includes("windows")) os = "windows";
    else if (ua.includes("macintosh")) os = "macos";
    else if (ua.includes("linux")) os = "linux";

    let browser = "Browser";
    if (ua.includes("edg/")) browser = "Edge";
    else if (ua.includes("chrome/")) browser = "Chrome";
    else if (ua.includes("safari/") && !ua.includes("chrome")) browser = "Safari";
    else if (ua.includes("firefox/")) browser = "Firefox";

    // Stored or generated friendly name
    const storedId = localStorage.getItem("aether_device_id");
    const deviceId = storedId || "dev_" + Math.random().toString(36).substring(2, 9);
    localStorage.setItem("aether_device_id", deviceId);

    const friendlyName = `${os.toUpperCase()} (${browser}) · ${deviceId.slice(-4)}`;

    return {
      id: deviceId,
      name: friendlyName,
      os,
      browser,
      lastSeen: Date.now(),
    };
  }

  /**
   * Initializes PeerJS cloud signaling broker over persistent WebSockets
   */
  private initPeerJs() {
    try {
      if (this.peer && !this.peer.destroyed) {
        try {
          this.peer.destroy();
        } catch {}
      }

      this.peer = new Peer(this.myDevice.id, {
        debug: 1,
        config: {
          iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" },
            { urls: "stun:stun2.l.google.com:19302" },
            { urls: "stun:stun.cloudflare.com:3478" },
          ],
        },
      });

      this.peer.on("open", (id: string) => {
        console.log("⚡ AetherStream WebRTC Signaling Connected. Peer ID:", id);
        this.isPeerReady = true;
      });

      this.peer.on("connection", (conn: DataConnection) => {
        console.log("⚡ Incoming peer connection from:", conn.peer);
        this.handleIncomingConnection(conn);
      });

      this.peer.on("disconnected", () => {
        console.log("PeerJS broker disconnected. Attempting automatic reconnect...");
        this.isPeerReady = false;
        try {
          this.peer?.reconnect();
        } catch {}
      });

      this.peer.on("error", (err: any) => {
        console.warn("PeerJS broker event:", err.type, err.message);
        if (err.type === "unavailable-id") {
          const freshId = "dev_" + Math.random().toString(36).substring(2, 9);
          this.myDevice.id = freshId;
          localStorage.setItem("aether_device_id", freshId);
          this.peer?.destroy();
          this.peer = null;
          this.initPeerJs();
        }
      });
    } catch (err) {
      console.warn("Failed to initialize PeerJS:", err);
    }
  }

  private async ensurePeerReady(): Promise<boolean> {
    if (!this.peer || this.peer.destroyed) {
      this.initPeerJs();
    }

    if (this.peer?.open) return true;

    return new Promise((resolve) => {
      let timer: any;
      const onOpen = () => {
        clearTimeout(timer);
        this.peer?.off("open", onOpen);
        resolve(true);
      };

      timer = setTimeout(() => {
        this.peer?.off("open", onOpen);
        resolve(!!this.peer?.open);
      }, 5000);

      this.peer?.once("open", onOpen);
    });
  }

  private handleIncomingConnection(conn: DataConnection) {
    const remotePeer: PeerDevice = this.discoveredPeers.get(conn.peer) || {
      id: conn.peer,
      name: conn.metadata?.name || `Remote (${conn.peer.slice(-4)})`,
      os: conn.metadata?.os || "unknown",
      browser: conn.metadata?.browser || "Browser",
      lastSeen: Date.now(),
    };

    this.registerPeer(remotePeer);
    this.activePeer = remotePeer;
    this.activeConnection = conn;

    conn.on("open", () => {
      console.log("⚡ Incoming P2P link ready from:", remotePeer.name);
      this.setupActiveConnection(conn, remotePeer);
    });

    conn.on("data", async (data: any) => {
      await this.handleIncomingDataChannelMessage(data);
    });

    conn.on("close", () => {
      console.log(`P2P link closed with ${remotePeer.name}`);
      this.disconnect();
    });

    conn.on("error", (err: any) => {
      console.warn(`Incoming P2P error from ${remotePeer.name}:`, err);
    });
  }

  private setupActiveConnection(conn: DataConnection, peer: PeerDevice) {
    this.activeConnection = conn;
    this.activePeer = peer;

    const dc = (conn as any).dataChannel as RTCDataChannel | undefined;
    if (dc) {
      this.dataChannel = dc;
      dc.binaryType = "arraybuffer";
    }

    if (this.onConnected) {
      this.onConnected(peer);
    }

    this.emitProgress({
      fileId: "",
      fileName: "",
      bytesTransferred: 0,
      totalBytes: 0,
      percent: 0,
      speedMBps: 0,
      etaSeconds: 0,
      state: "idle",
    });
  }

  private setupRadarDiscovery() {
    try {
      if (typeof EventSource !== "undefined") {
        // Radar discovery channel to see other active devices on cloud / LAN
        this.sseRadarSource = new EventSource("https://ntfy.sh/aether_radar_discovery/sse");
        this.sseRadarSource.onmessage = (event) => {
          try {
            const raw = JSON.parse(event.data);
            if (raw.event === "message" && raw.message) {
              const peer: PeerDevice = JSON.parse(raw.message);
              if (peer && peer.id && peer.id !== this.myDevice.id) {
                this.registerPeer(peer);
              }
            }
          } catch {}
        };
      }
    } catch (e) {
      console.warn("Radar SSE setup note:", e);
    }
  }

  private setupBroadcastChannel() {
    this.broadcastChannel.onmessage = (event) => {
      const { peer } = event.data || {};
      if (peer && peer.id !== this.myDevice.id) {
        this.registerPeer(peer);
      }
    };

    // Broadcast presence immediately
    this.broadcastPresence();
  }

  private broadcastPresence() {
    // 1. Local tab broadcast
    try {
      this.broadcastChannel.postMessage({
        type: MessageType.DISCOVERY_ANNOUNCE,
        peer: this.myDevice,
      });
    } catch {}

    // 2. Cloud radar presence (rate-limited to every 8 seconds)
    const now = Date.now();
    if (now - this.lastCloudBroadcast > 8000) {
      this.lastCloudBroadcast = now;
      try {
        fetch("https://ntfy.sh/aether_radar_discovery", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(this.myDevice),
        }).catch(() => {});
      } catch {}
    }
  }

  private registerPeer(peer: PeerDevice) {
    peer.lastSeen = Date.now();
    this.discoveredPeers.set(peer.id, peer);
    this.notifyPeersUpdated();
  }

  private notifyPeersUpdated() {
    const now = Date.now();
    const active: PeerDevice[] = [];
    for (const [id, peer] of this.discoveredPeers) {
      if (now - peer.lastSeen < 25000) {
        active.push(peer);
      } else {
        this.discoveredPeers.delete(id);
      }
    }
    if (this.onPeersUpdated) {
      this.onPeersUpdated(active);
    }
  }

  /**
   * Periodic polling of local server signaling endpoint (/api/wireless/peers)
   */
  private startSignalingPoll() {
    this.pollingTimer = setInterval(async () => {
      this.broadcastPresence();
      this.notifyPeersUpdated();

      try {
        const res = await fetch("/api/wireless/peers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(this.myDevice),
        });
        if (res.ok) {
          const peers: PeerDevice[] = await res.json();
          for (const p of peers) {
            if (p.id !== this.myDevice.id) {
              this.registerPeer(p);
            }
          }
        }
      } catch {
        // Dev server API not available or offline — broadcast channel continues working
      }
    }, 2000);
  }

  /**
   * Connects to a target peer using WebRTC DataChannel via PeerJS
   */
  public async connectToPeer(targetPeer: PeerDevice): Promise<boolean> {
    if (this.isConnected() && this.activePeer?.id === targetPeer.id) {
      return true;
    }

    await this.ensurePeerReady();

    if (!this.peer || this.peer.destroyed) {
      this.initPeerJs();
      await this.ensurePeerReady();
    }

    return new Promise((resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          const open = this.isConnected();
          if (!open) {
            console.warn(`Connection attempt to ${targetPeer.name} timed out.`);
          }
          resolve(open);
        }
      }, 25000);

      try {
        console.log(`⚡ Initiating high-speed connection to ${targetPeer.name} (${targetPeer.id})...`);
        const conn = this.peer!.connect(targetPeer.id, {
          reliable: true,
          serialization: "none",
          metadata: {
            id: this.myDevice.id,
            name: this.myDevice.name,
            os: this.myDevice.os,
            browser: this.myDevice.browser,
          },
        });

        this.activeConnection = conn;
        this.activePeer = targetPeer;

        conn.on("open", () => {
          console.log(`⚡ High-speed P2P link ESTABLISHED with ${targetPeer.name}!`);
          this.setupActiveConnection(conn, targetPeer);
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve(true);
          }
        });

        conn.on("data", async (data: any) => {
          await this.handleIncomingDataChannelMessage(data);
        });

        conn.on("close", () => {
          console.log(`P2P link closed with ${targetPeer.name}`);
          this.disconnect();
        });

        conn.on("error", (err: any) => {
          console.warn(`P2P link error with ${targetPeer.name}:`, err);
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve(false);
          }
        });
      } catch (err) {
        console.error("connectToPeer exception:", err);
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve(false);
        }
      }
    });
  }

  /**
   * Generates a 1-Second Instant QR Handshake payload
   */
  public async generateQRHandshake(): Promise<InstantQRHandshake> {
    const sid = "aeth_" + Math.random().toString(36).substring(2, 10);
    this.sessionSecretPassword = WirelessCrypto.generateSessionPassword(8);

    return {
      v: "2.0",
      sid,
      peer: this.myDevice,
      key: this.sessionSecretPassword,
      signalUrl: window.location.origin,
    };
  }

  /**
   * Connects using an Instant QR code scanned by the camera
   */
  public async connectWithQR(handshake: InstantQRHandshake): Promise<boolean> {
    this.sessionSecretPassword = handshake.key || "";
    this.registerPeer(handshake.peer);
    return this.connectToPeer(handshake.peer);
  }

  /**
   * Sends a text snippet
   */
  public async sendSnippet(text: string, password?: string): Promise<void> {
    if (!this.isConnected()) {
      throw new Error("Wireless channel is not connected. Connect to a peer first.");
    }

    let isEncrypted = false;
    let saltB64: string | undefined;
    let ivB64: string | undefined;
    let finalText = text;

    if (password) {
      const salt = WirelessCrypto.generateSalt();
      const iv = WirelessCrypto.generateIV();
      const key = await WirelessCrypto.deriveKey(password, salt);
      const enc = new TextEncoder();
      const cipher = await WirelessCrypto.encryptChunk(enc.encode(text), key, iv);
      finalText = WirelessCrypto.uint8ToBase64(cipher);
      saltB64 = WirelessCrypto.uint8ToBase64(salt);
      ivB64 = WirelessCrypto.uint8ToBase64(iv);
      isEncrypted = true;
    }

    const payload: TextSnippetPayload = {
      id: "snip_" + Date.now(),
      text: finalText,
      timestamp: Date.now(),
      encrypted: isEncrypted,
      salt: saltB64,
      iv: ivB64,
    };

    const str = JSON.stringify({
      type: MessageType.TEXT_SNIPPET,
      payload,
    });

    if (this.dataChannel && this.dataChannel.readyState === "open") {
      this.dataChannel.send(str);
    } else if (this.activeConnection && this.activeConnection.open) {
      this.activeConnection.send(str);
    }
  }

  /**
   * Sends files with high-speed streaming chunking and backpressure control
   */
  public async sendFiles(files: File[], password?: string): Promise<void> {
    if (!this.isConnected()) {
      throw new Error("Wireless channel is not connected. Connect to a peer first.");
    }

    const dc = this.dataChannel;
    const conn = this.activeConnection;
    const totalBytesAll = files.reduce((acc, f) => acc + f.size, 0);
    let bytesSentTotal = 0;

    this.speedSamples = [];
    this.transferStartTime = Date.now();

    for (let fIdx = 0; fIdx < files.length; fIdx++) {
      const file = files[fIdx];
      const totalChunks = Math.ceil(file.size / WEBRTC_CHUNK_SIZE);
      const salt = password ? WirelessCrypto.generateSalt() : undefined;
      const iv = password ? WirelessCrypto.generateIV() : undefined;
      const key = password && salt ? await WirelessCrypto.deriveKey(password, salt) : null;

      // Compute SHA-256 for integrity verification
      this.emitProgress({
        fileId: file.name,
        fileName: file.name,
        bytesTransferred: bytesSentTotal,
        totalBytes: totalBytesAll,
        percent: Math.round((bytesSentTotal / totalBytesAll) * 100),
        speedMBps: 0,
        etaSeconds: 0,
        state: "verifying",
      });

      const fullBuffer = await file.arrayBuffer();
      const fileSha256 = await WirelessCrypto.computeSHA256(fullBuffer);

      // Send File Metadata
      const meta: FileMetadata = {
        id: "f_" + Math.random().toString(36).substring(2, 9),
        name: file.name,
        size: file.size,
        type: file.type || "application/octet-stream",
        totalChunks,
        chunkSize: WEBRTC_CHUNK_SIZE,
        sha256: fileSha256,
        encrypted: !!password,
        salt: salt ? WirelessCrypto.uint8ToBase64(salt) : undefined,
        iv: iv ? WirelessCrypto.uint8ToBase64(iv) : undefined,
      };

      const metaStr = JSON.stringify({
        type: MessageType.FILE_METADATA,
        payload: meta,
      });

      if (dc && dc.readyState === "open") {
        dc.send(metaStr);
      } else if (conn && conn.open) {
        conn.send(metaStr);
      }

      // Stream file chunks with optimal backpressure
      let offset = 0;
      let chunkIndex = 0;

      while (offset < file.size) {
        // Backpressure check: wait if buffer exceeds high watermark
        if (dc && dc.bufferedAmount > BUFFER_HIGH_WATERMARK) {
          await this.waitForBufferDrain(dc);
        }

        const slice = file.slice(offset, offset + WEBRTC_CHUNK_SIZE);
        const sliceBuffer = await slice.arrayBuffer();
        let chunkBytes = new Uint8Array(sliceBuffer);

        if (key && iv) {
          chunkBytes = await WirelessCrypto.encryptChunk(chunkBytes, key, iv);
        }

        // Frame: [4 bytes chunkIndex] [binary data]
        const frame = new Uint8Array(4 + chunkBytes.length);
        const view = new DataView(frame.buffer);
        view.setUint32(0, chunkIndex, false);
        frame.set(chunkBytes, 4);

        if (dc && dc.readyState === "open") {
          dc.send(frame.buffer);
        } else if (conn && conn.open) {
          conn.send(frame.buffer);
        }

        offset += sliceBuffer.byteLength;
        bytesSentTotal += sliceBuffer.byteLength;
        chunkIndex++;

        // Update Speedometer & ETA
        this.recordSpeedSample(bytesSentTotal);
        const { speedMBps, etaSeconds } = this.calculateSpeedAndETA(
          bytesSentTotal,
          totalBytesAll
        );

        this.emitProgress({
          fileId: file.name,
          fileName: file.name,
          bytesTransferred: bytesSentTotal,
          totalBytes: totalBytesAll,
          percent: Math.min(99, Math.round((bytesSentTotal / totalBytesAll) * 100)),
          speedMBps,
          etaSeconds,
          state: "sending",
        });
      }

      // Signal file completion
      const completeStr = JSON.stringify({
        type: MessageType.FILE_COMPLETE,
        payload: { id: meta.id },
      });

      if (dc && dc.readyState === "open") {
        dc.send(completeStr);
      } else if (conn && conn.open) {
        conn.send(completeStr);
      }
    }

    this.emitProgress({
      fileId: "all",
      fileName: `${files.length} file(s)`,
      bytesTransferred: totalBytesAll,
      totalBytes: totalBytesAll,
      percent: 100,
      speedMBps: 0,
      etaSeconds: 0,
      state: "complete",
    });
  }

  private waitForBufferDrain(dc: RTCDataChannel): Promise<void> {
    return new Promise((resolve) => {
      dc.bufferedAmountLowThreshold = BUFFER_LOW_WATERMARK;
      const onLow = () => {
        dc.removeEventListener("bufferedamountlow", onLow);
        resolve();
      };
      dc.addEventListener("bufferedamountlow", onLow);
    });
  }

  private async handleIncomingDataChannelMessage(data: any) {
    if (data instanceof Blob) {
      data = await data.arrayBuffer();
    }

    if (typeof data === "string") {
      try {
        const msg = JSON.parse(data);
        if (msg.type === MessageType.TEXT_SNIPPET) {
          if (this.onSnippetReceived) {
            this.onSnippetReceived(msg.payload);
          }
        } else if (msg.type === MessageType.FILE_METADATA) {
          const meta: FileMetadata = msg.payload;
          this.currentIncomingFile = {
            meta,
            chunks: [],
            receivedBytes: 0,
          };
          this.speedSamples = [];
          this.transferStartTime = Date.now();
          this.emitProgress({
            fileId: meta.id,
            fileName: meta.name,
            bytesTransferred: 0,
            totalBytes: meta.size,
            percent: 0,
            speedMBps: 0,
            etaSeconds: 0,
            state: "receiving",
          });
        } else if (msg.type === MessageType.FILE_COMPLETE) {
          await this.finalizeIncomingFile();
        }
      } catch (err) {
        console.error("Error parsing control message", err);
      }
    } else if (data instanceof ArrayBuffer) {
      if (!this.currentIncomingFile) return;

      const view = new DataView(data);
      const chunkIndex = view.getUint32(0, false);
      const chunkBytes = new Uint8Array(data, 4);

      this.currentIncomingFile.chunks[chunkIndex] = chunkBytes;
      this.currentIncomingFile.receivedBytes += chunkBytes.byteLength;

      this.recordSpeedSample(this.currentIncomingFile.receivedBytes);
      const { speedMBps, etaSeconds } = this.calculateSpeedAndETA(
        this.currentIncomingFile.receivedBytes,
        this.currentIncomingFile.meta.size
      );

      this.emitProgress({
        fileId: this.currentIncomingFile.meta.id,
        fileName: this.currentIncomingFile.meta.name,
        bytesTransferred: this.currentIncomingFile.receivedBytes,
        totalBytes: this.currentIncomingFile.meta.size,
        percent: Math.min(
          99,
          Math.round(
            (this.currentIncomingFile.receivedBytes / this.currentIncomingFile.meta.size) * 100
          )
        ),
        speedMBps,
        etaSeconds,
        state: "receiving",
      });
    }
  }

  private async finalizeIncomingFile() {
    if (!this.currentIncomingFile) return;
    const { meta, chunks } = this.currentIncomingFile;

    this.emitProgress({
      fileId: meta.id,
      fileName: meta.name,
      bytesTransferred: meta.size,
      totalBytes: meta.size,
      percent: 99,
      speedMBps: 0,
      etaSeconds: 0,
      state: "verifying",
    });

    // Assemble blob
    const blob = new Blob(chunks, { type: meta.type });
    const fullBuffer = await blob.arrayBuffer();

    // Verify SHA-256
    const calculatedHash = await WirelessCrypto.computeSHA256(fullBuffer);
    if (meta.sha256 && calculatedHash !== meta.sha256) {
      this.emitProgress({
        fileId: meta.id,
        fileName: meta.name,
        bytesTransferred: meta.size,
        totalBytes: meta.size,
        percent: 0,
        speedMBps: 0,
        etaSeconds: 0,
        state: "error",
        error: "SHA-256 integrity verification mismatch!",
      });
      return;
    }

    const downloadUrl = URL.createObjectURL(blob);

    if (this.onFileSaved) {
      this.onFileSaved(meta.name, downloadUrl, meta.size, calculatedHash);
    }

    this.emitProgress({
      fileId: meta.id,
      fileName: meta.name,
      bytesTransferred: meta.size,
      totalBytes: meta.size,
      percent: 100,
      speedMBps: 0,
      etaSeconds: 0,
      state: "complete",
    });

    this.currentIncomingFile = null;
  }

  private recordSpeedSample(currentBytes: number) {
    const now = Date.now();
    this.speedSamples.push({ time: now, bytes: currentBytes });
    // Keep last 2 seconds
    this.speedSamples = this.speedSamples.filter((s) => now - s.time <= 2000);
  }

  private calculateSpeedAndETA(
    currentBytes: number,
    totalBytes: number
  ): { speedMBps: number; etaSeconds: number } {
    if (this.speedSamples.length < 2) {
      return { speedMBps: 0, etaSeconds: 0 };
    }
    const oldest = this.speedSamples[0];
    const newest = this.speedSamples[this.speedSamples.length - 1];
    const deltaMs = newest.time - oldest.time;
    const deltaBytes = newest.bytes - oldest.bytes;

    if (deltaMs <= 0 || deltaBytes <= 0) {
      return { speedMBps: 0, etaSeconds: 0 };
    }

    const bytesPerSec = (deltaBytes / deltaMs) * 1000;
    const speedMBps = parseFloat((bytesPerSec / (1024 * 1024)).toFixed(1));

    const remainingBytes = Math.max(0, totalBytes - currentBytes);
    const etaSeconds = bytesPerSec > 0 ? Math.ceil(remainingBytes / bytesPerSec) : 0;

    return { speedMBps, etaSeconds };
  }

  private emitProgress(p: TransferProgress) {
    if (this.onProgress) {
      this.onProgress(p);
    }
  }

  public getConnectedPeer(): PeerDevice | null {
    return this.activePeer;
  }

  public isConnected(): boolean {
    if (this.dataChannel && this.dataChannel.readyState === "open") return true;
    if (this.activeConnection && this.activeConnection.open) return true;
    return false;
  }

  public disconnect() {
    if (this.dataChannel) {
      try {
        this.dataChannel.close();
      } catch {}
      this.dataChannel = null;
    }
    if (this.activeConnection) {
      try {
        this.activeConnection.close();
      } catch {}
      this.activeConnection = null;
    }
    this.activePeer = null;
  }

  public close() {
    if (this.pollingTimer) clearInterval(this.pollingTimer);
    if (this.sseRadarSource) this.sseRadarSource.close();
    this.disconnect();
    this.broadcastChannel.close();
    if (this.peer) {
      try {
        this.peer.destroy();
      } catch {}
      this.peer = null;
    }
  }
}
