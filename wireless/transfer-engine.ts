/**
 * AetherStream Wireless Transfer Engine
 * High-speed peer-to-peer data transport over WebRTC DataChannel.
 * Perfect Negotiation architecture with robust STUN connectivity and large-payload SSE signaling.
 */

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

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

export class WirelessTransferEngine {
  public myDevice: PeerDevice;
  public discoveredPeers: Map<string, PeerDevice> = new Map();

  // WebRTC Native Transport
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private activePeer: PeerDevice | null = null;
  private isMakingOffer: boolean = false;
  private gatheredCandidates: RTCIceCandidateInit[] = [];

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
  private sseSignalSource: EventSource | null = null;
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
    this.setupCloudSignaling();
    this.startSignalingPoll();
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
   * Initializes real-time cloud signaling via ntfy.sh SSE & discovery
   * Handles large SDP payloads seamlessly via attachment URL resolution
   */
  private setupCloudSignaling() {
    try {
      if (typeof EventSource !== "undefined") {
        // Direct signaling channel for incoming WebRTC handshakes
        this.sseSignalSource = new EventSource(`https://ntfy.sh/aether_sig_${this.myDevice.id}/sse`);
        this.sseSignalSource.onmessage = async (event) => {
          try {
            const raw = JSON.parse(event.data);
            if (raw.event === "message") {
              let data: any = null;
              if (raw.attachment && raw.attachment.url) {
                // If message exceeded 4096 bytes, ntfy stores it as an attachment
                const fileRes = await fetch(raw.attachment.url);
                data = await fileRes.json();
              } else if (raw.message) {
                data = JSON.parse(raw.message);
              }

              if (data && data.type && data.fromPeer) {
                await this.handleDirectSignal(data.type, data.payload || data.signal, data.fromPeer);
              }
            }
          } catch (e) {
            console.warn("Signal SSE parse notice:", e);
          }
        };

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
      console.warn("Cloud signaling SSE setup note:", e);
    }
  }

  private setupBroadcastChannel() {
    this.broadcastChannel.onmessage = async (event) => {
      const { type, payload, signal, targetId, fromPeer } = event.data || {};
      if (fromPeer && fromPeer.id !== this.myDevice.id) {
        this.registerPeer(fromPeer);
      }
      if (targetId === this.myDevice.id && type && fromPeer) {
        await this.handleDirectSignal(type, payload || signal, fromPeer);
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
        fromPeer: this.myDevice,
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

        // Check local queued signals
        const sigRes = await fetch(`/api/wireless/poll-signals?peerId=${encodeURIComponent(this.myDevice.id)}`);
        if (sigRes.ok) {
          const queuedSignals = await sigRes.json();
          for (const item of queuedSignals) {
            await this.handleDirectSignal(item.type, item.payload || item.signal, item.fromPeer);
          }
        }
      } catch {
        // Dev server API not available or offline — broadcast channel continues working
      }
    }, 2000);
  }

  private async sendSignal(type: string, payload: any, targetId: string) {
    const packet = {
      type,
      payload,
      targetId,
      fromPeer: this.myDevice,
    };

    // 1. BroadcastChannel (same machine/browser tabs)
    try {
      this.broadcastChannel.postMessage(packet);
    } catch {}

    // 2. Real-time Cloud Push via ntfy.sh (sub-100ms delivery across any network)
    try {
      fetch(`https://ntfy.sh/aether_sig_${targetId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(packet),
      }).catch(() => {});
    } catch {}

    // 3. Local Vite dev server fallback if running locally
    try {
      await fetch("/api/wireless/signal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(packet),
      });
    } catch {}
  }

  private createPeerConnection(isInitiator: boolean, remotePeer: PeerDevice): RTCPeerConnection {
    if (this.peerConnection) {
      try {
        this.peerConnection.close();
      } catch {}
    }
    this.gatheredCandidates = [];

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.peerConnection = pc;
    this.activePeer = remotePeer;

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.gatheredCandidates.push(event.candidate.toJSON());
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[WebRTC ICE State] -> ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        console.log(`⚡ WebRTC P2P direct path connected with ${remotePeer.name}!`);
      } else if (pc.iceConnectionState === "failed") {
        console.warn(`[WebRTC ICE Failed] Attempting ICE restart...`);
        try { pc.restartIce(); } catch {}
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[WebRTC Connection State] -> ${pc.connectionState}`);
    };

    if (isInitiator) {
      const dc = pc.createDataChannel("aether-transfer", { ordered: true });
      this.setupDataChannel(dc, remotePeer);
    } else {
      pc.ondatachannel = (event) => {
        this.setupDataChannel(event.channel, remotePeer);
      };
    }

    return pc;
  }

  private setupDataChannel(dc: RTCDataChannel, peer: PeerDevice) {
    this.dataChannel = dc;
    this.activePeer = peer;
    dc.binaryType = "arraybuffer";

    dc.onopen = () => {
      console.log(`⚡ High-speed P2P link ESTABLISHED with ${peer.name}!`);
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
    };

    dc.onclose = () => {
      console.log(`P2P link closed with ${peer.name}`);
      this.disconnect();
    };

    dc.onerror = (err) => {
      console.warn(`P2P channel error with ${peer.name}:`, err);
    };

    dc.onmessage = async (event) => {
      await this.handleIncomingDataChannelMessage(event.data);
    };
  }

  private async waitForIceGathering(pc: RTCPeerConnection, maxWaitMs = 600): Promise<void> {
    if (pc.iceGatheringState === "complete") return;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }, maxWaitMs);

      const check = () => {
        if (pc.iceGatheringState === "complete") {
          clearTimeout(timer);
          pc.removeEventListener("icegatheringstatechange", check);
          resolve();
        }
      };
      pc.addEventListener("icegatheringstatechange", check);
    });
  }

  private async handleDirectSignal(type: string, payload: any, sender: PeerDevice) {
    if (!sender || !sender.id) return;
    this.registerPeer(sender);

    if (type === "OFFER") {
      const isCollision = this.isMakingOffer || (this.peerConnection && this.peerConnection.signalingState !== "stable");
      const isPolite = this.myDevice.id < sender.id;

      if (isCollision && !isPolite) {
        console.log(`[Collision] Impolite peer (${this.myDevice.name}) ignoring offer from ${sender.name}`);
        return;
      }

      console.log(`⚡ Processing WebRTC OFFER from ${sender.name}`);
      this.activePeer = sender;
      const pc = this.createPeerConnection(false, sender);

      await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: payload.sdp }));

      // Apply all bundled candidates
      if (Array.isArray(payload.candidates)) {
        for (const cand of payload.candidates) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(cand));
          } catch {}
        }
      }

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // Wait up to 600ms to gather local host & STUN candidates
      await this.waitForIceGathering(pc, 600);

      const sdp = pc.localDescription?.sdp || answer.sdp;
      await this.sendSignal("ANSWER", {
        sdp,
        candidates: this.gatheredCandidates,
      }, sender.id);
    } else if (type === "ANSWER") {
      if (this.peerConnection && this.peerConnection.signalingState === "have-local-offer") {
        console.log(`⚡ Processing WebRTC ANSWER from ${sender.name}`);
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: payload.sdp }));

        // Apply all bundled candidates
        if (Array.isArray(payload.candidates)) {
          for (const cand of payload.candidates) {
            try {
              await this.peerConnection.addIceCandidate(new RTCIceCandidate(cand));
            } catch {}
          }
        }
      }
    }
  }

  /**
   * Connects to a target peer using WebRTC DataChannel
   */
  public async connectToPeer(targetPeer: PeerDevice): Promise<boolean> {
    if (this.isConnected() && this.activePeer?.id === targetPeer.id) {
      return true;
    }

    console.log(`⚡ Initiating high-speed connection to ${targetPeer.name} (${targetPeer.id})...`);
    this.isMakingOffer = true;
    const pc = this.createPeerConnection(true, targetPeer);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Wait up to 600ms to gather local host & STUN candidates
      await this.waitForIceGathering(pc, 600);

      const sdp = pc.localDescription?.sdp || offer.sdp;
      await this.sendSignal("OFFER", {
        sdp,
        candidates: this.gatheredCandidates,
      }, targetPeer.id);
    } finally {
      this.isMakingOffer = false;
    }

    return new Promise((resolve) => {
      let resolved = false;
      const check = setInterval(() => {
        if (this.dataChannel && this.dataChannel.readyState === "open") {
          clearInterval(check);
          clearTimeout(timeout);
          if (!resolved) {
            resolved = true;
            resolve(true);
          }
        }
      }, 50);

      const timeout = setTimeout(() => {
        clearInterval(check);
        if (!resolved) {
          resolved = true;
          const open = this.isConnected();
          if (!open) {
            console.warn(`Connection attempt to ${targetPeer.name} timed out.`);
          }
          resolve(open);
        }
      }, 25000);
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
    if (!this.isConnected() || !this.dataChannel) {
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

    this.dataChannel.send(
      JSON.stringify({
        type: MessageType.TEXT_SNIPPET,
        payload,
      })
    );
  }

  /**
   * Sends files with high-speed streaming chunking and backpressure control
   */
  public async sendFiles(files: File[], password?: string): Promise<void> {
    if (!this.isConnected() || !this.dataChannel) {
      throw new Error("Wireless channel is not connected. Connect to a peer first.");
    }

    const dc = this.dataChannel;
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

      dc.send(
        JSON.stringify({
          type: MessageType.FILE_METADATA,
          payload: meta,
        })
      );

      // Stream file chunks with optimal backpressure
      let offset = 0;
      let chunkIndex = 0;

      while (offset < file.size) {
        // Backpressure check: wait if buffer exceeds high watermark
        if (dc.bufferedAmount > BUFFER_HIGH_WATERMARK) {
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

        dc.send(frame.buffer);

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
      dc.send(
        JSON.stringify({
          type: MessageType.FILE_COMPLETE,
          payload: { id: meta.id },
        })
      );
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
    return this.dataChannel?.readyState === "open";
  }

  public disconnect() {
    if (this.dataChannel) {
      try {
        this.dataChannel.close();
      } catch {}
      this.dataChannel = null;
    }
    if (this.peerConnection) {
      try {
        this.peerConnection.close();
      } catch {}
      this.peerConnection = null;
    }
    this.activePeer = null;
    this.gatheredCandidates = [];
  }

  public close() {
    if (this.pollingTimer) clearInterval(this.pollingTimer);
    if (this.sseSignalSource) this.sseSignalSource.close();
    if (this.sseRadarSource) this.sseRadarSource.close();
    this.disconnect();
    this.broadcastChannel.close();
  }
}
