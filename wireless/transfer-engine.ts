/**
 * AetherStream Wireless Transfer Engine
 * High-speed peer-to-peer data transport over WebRTC DataChannel.
 * Robust Trickle ICE architecture, signal deduplication, and W3C Perfect Negotiation.
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

export interface SignalPacket {
  id: string;
  type: string;
  payload: any;
  targetId: string;
  fromPeer: PeerDevice;
  timestamp: number;
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

// Direct paths are preferred. TURN is only selected by ICE when host/STUN
// candidates cannot connect (for example, on carrier-grade NAT hotspots).
const STUN_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

const DEFAULT_TURN_URLS = [
  "turn:staticauth.openrelay.metered.ca:80?transport=udp",
  "turn:staticauth.openrelay.metered.ca:80?transport=tcp",
  "turn:staticauth.openrelay.metered.ca:443?transport=udp",
  "turn:staticauth.openrelay.metered.ca:443?transport=tcp",
  "turns:staticauth.openrelay.metered.ca:443?transport=tcp",
];

let cachedIceServers: { servers: RTCIceServer[]; expires: number } | null = null;

/**
 * Builds short-lived TURN REST credentials. Deployments can replace every
 * default through Vite environment variables without committing secrets.
 */
async function buildIceServers(): Promise<RTCIceServer[]> {
  if (cachedIceServers && cachedIceServers.expires > Date.now()) {
    return cachedIceServers.servers;
  }

  // e.g. https://<app>.metered.live/api/v1/turn/credentials?apiKey=<key>
  const credentialsApi = import.meta.env.VITE_TURN_API_URL;
  if (credentialsApi) {
    try {
      const res = await fetch(credentialsApi);
      const servers: RTCIceServer[] = await res.json();
      if (Array.isArray(servers) && servers.length > 0) {
        cachedIceServers = { servers: [...STUN_SERVERS, ...servers], expires: Date.now() + 3600_000 };
        return cachedIceServers.servers;
      }
    } catch (error) {
      console.warn("[WebRTC] TURN credentials API unavailable; using defaults.", error);
    }
  }

  const configuredUrls = import.meta.env.VITE_TURN_URLS?.split(",")
    .map((url: string) => url.trim())
    .filter(Boolean);
  const urls = configuredUrls?.length ? configuredUrls : DEFAULT_TURN_URLS;
  const staticUsername = import.meta.env.VITE_TURN_USERNAME;
  const staticCredential = import.meta.env.VITE_TURN_CREDENTIAL;

  if (staticUsername && staticCredential) {
    return [...STUN_SERVERS, { urls, username: staticUsername, credential: staticCredential }];
  }

  // Open Relay publishes this shared secret specifically for TURN REST auth.
  // VITE_TURN_SHARED_SECRET should be used for a private/self-hosted service.
  const sharedSecret =
    import.meta.env.VITE_TURN_SHARED_SECRET || "openrelayprojectsecret";
  const username = `${Math.floor(Date.now() / 1000) + 24 * 60 * 60}:aetherstream`;

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(sharedSecret),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(username));
    const credential = btoa(String.fromCharCode(...new Uint8Array(signature)));
    return [...STUN_SERVERS, { urls, username, credential }];
  } catch (error) {
    console.warn("[WebRTC] TURN credential generation failed; using STUN only.", error);
    return STUN_SERVERS;
  }
}

/**
 * Chrome/Edge hide LAN IPs behind `.local` mDNS names unless the site holds
 * camera or microphone permission, and Android cannot resolve those names.
 * Holding the permission lets two devices on the same hotspot connect over
 * plain host candidates even when STUN/TURN are unreachable.
 */
export async function hasLocalIpAccess(): Promise<boolean> {
  try {
    const status = await navigator.permissions.query({ name: "camera" as PermissionName });
    return status.state === "granted";
  } catch {
    return false;
  }
}

/** Must be called from a user gesture; the camera is released immediately. */
export async function unlockLocalIpAccess(): Promise<boolean> {
  if (await hasLocalIpAccess()) return true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    stream.getTracks().forEach((track) => track.stop());
    return true;
  } catch {
    return false;
  }
}

// High-availability public signaling host (zero quota restrictions)
const SIGNAL_BASE = "https://ntfy.adminforge.de";
const SCTP_MAX_MESSAGE = 262144;

/** Lets one send carry 256KB instead of Chrome's default 64KB SCTP message. */
function widenSctpMessageSize(description: RTCSessionDescriptionInit): RTCSessionDescriptionInit {
  if (!description.sdp) return description;
  return {
    type: description.type,
    sdp: description.sdp.replace(/a=max-message-size:\d+/g, `a=max-message-size:${SCTP_MAX_MESSAGE}`),
  };
}

const PRESENCE_INTERVAL_MS = 20000;
const PEER_EXPIRY_MS = 60000;

export class WirelessTransferEngine {
  public myDevice: PeerDevice;
  public discoveredPeers: Map<string, PeerDevice> = new Map();

  // WebRTC Native Transport
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private activePeer: PeerDevice | null = null;
  private isMakingOffer: boolean = false;
  private gatheredCandidates: RTCIceCandidateInit[] = [];
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private seenSignalIds: Set<string> = new Set();
  private connectionResolver: ((success: boolean) => void) | null = null;

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
  private sseSignalSource: EventSource | null = null;
  private sseRadarSource: EventSource | null = null;
  private ssePinSource: EventSource | null = null;
  private lastCloudBroadcast: number = 0;

  // Stream state
  private currentIncomingFile: {
    meta: FileMetadata;
    chunks: Uint8Array[];
    receivedBytes: number;
  } | null = null;

  // Speedometer
  private speedSamples: Array<{ time: number; bytes: number }> = [];
  private transferStartTime: number = 0;
  private lastUiUpdate: number = 0;
  private lastDelivered: number = 0;

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
   * Initializes real-time cloud signaling via reliable SSE
   */
  private setupCloudSignaling() {
    try {
      if (typeof EventSource !== "undefined") {
        // Direct signaling channel for incoming WebRTC handshakes
        this.sseSignalSource = new EventSource(`${SIGNAL_BASE}/aether_sig_${this.myDevice.id}/sse`);
        this.sseSignalSource.onmessage = async (event) => {
          try {
            const raw = JSON.parse(event.data);
            if (raw.event === "message") {
              let packet: SignalPacket | null = null;
              if (raw.attachment && raw.attachment.url) {
                const fileRes = await fetch(raw.attachment.url);
                packet = await fileRes.json();
              } else if (raw.message) {
                packet = JSON.parse(raw.message);
              }

              if (packet && packet.type && packet.fromPeer) {
                await this.handleDirectSignalPacket(packet);
              }
            }
          } catch (e) {
            console.warn("Signal SSE parse notice:", e);
          }
        };

        // Radar discovery channel
        // Replay recent announcements so peers that joined earlier show up at once
        this.sseRadarSource = new EventSource(
          `${SIGNAL_BASE}/aether_radar_discovery/sse?since=${PEER_EXPIRY_MS / 1000}s`
        );
        this.sseRadarSource.onmessage = (event) => {
          try {
            const raw = JSON.parse(event.data);
            if (raw.event === "message" && raw.message) {
              const peer: PeerDevice = JSON.parse(raw.message);
              if (peer && peer.id && peer.id !== this.myDevice.id) {
                this.registerPeer(peer, raw.time ? raw.time * 1000 : Date.now());
              }
            }
          } catch {}
        };
      }
    } catch (e) {
      console.warn("Cloud signaling SSE setup note:", e);
    }
  }

  /**
   * Listens for PIN-code pairing requests on a specific PIN topic
   */
  public listenForPin(pin: string, onMatched: (peer: PeerDevice) => void) {
    if (this.ssePinSource) {
      this.ssePinSource.close();
      this.ssePinSource = null;
    }
    try {
      this.ssePinSource = new EventSource(`${SIGNAL_BASE}/aether_pin_${pin.toUpperCase()}/sse`);
      this.ssePinSource.onmessage = async (event) => {
        try {
          const raw = JSON.parse(event.data);
          if (raw.event === "message" && raw.message) {
            const data = JSON.parse(raw.message);
            if (data && data.peer && data.peer.id !== this.myDevice.id) {
              this.registerPeer(data.peer);
              onMatched(data.peer);
              await this.sendSignal("PIN_ACK", { sessionPin: pin }, data.peer.id);
            }
          }
        } catch {}
      };
    } catch {}
  }

  /**
   * Submits a PIN to match with another device
   */
  public async submitPinPair(pin: string): Promise<void> {
    const payload = {
      peer: this.myDevice,
      timestamp: Date.now(),
    };
    try {
      await fetch(`${SIGNAL_BASE}/aether_pin_${pin.toUpperCase()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {}
  }

  private setupBroadcastChannel() {
    this.broadcastChannel.onmessage = async (event) => {
      const packet: SignalPacket = event.data;
      if (packet && packet.fromPeer && packet.fromPeer.id !== this.myDevice.id) {
        this.registerPeer(packet.fromPeer);
      }
      if (packet && packet.targetId === this.myDevice.id && packet.type && packet.fromPeer) {
        await this.handleDirectSignalPacket(packet);
      }
    };

    this.broadcastPresence();
  }

  public broadcastPresence() {
    // 1. Same-machine broadcast
    try {
      this.broadcastChannel.postMessage({
        id: `pres_${Date.now()}`,
        type: MessageType.DISCOVERY_ANNOUNCE,
        fromPeer: this.myDevice,
        targetId: "",
        payload: null,
        timestamp: Date.now(),
      });
    } catch {}

    // 2. Cloud radar presence (rate-limited; must stay below PEER_EXPIRY_MS)
    const now = Date.now();
    if (now - this.lastCloudBroadcast > PRESENCE_INTERVAL_MS) {
      this.lastCloudBroadcast = now;
      try {
        fetch(`${SIGNAL_BASE}/aether_radar_discovery`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(this.myDevice),
        }).catch(() => {});
      } catch {}
    }
  }

  private registerPeer(peer: PeerDevice, seenAt: number = Date.now()) {
    const known = this.discoveredPeers.get(peer.id);
    peer.lastSeen = Math.max(seenAt, known?.lastSeen ?? 0);
    this.discoveredPeers.set(peer.id, peer);
    this.notifyPeersUpdated();
  }

  private notifyPeersUpdated() {
    const now = Date.now();
    const active: PeerDevice[] = [];
    for (const [id, peer] of this.discoveredPeers) {
      if (now - peer.lastSeen < PEER_EXPIRY_MS || peer.id === this.activePeer?.id) {
        active.push(peer);
      } else {
        this.discoveredPeers.delete(id);
      }
    }
    if (this.onPeersUpdated) {
      this.onPeersUpdated(active);
    }
  }

  private startSignalingPoll() {
    this.pollingTimer = setInterval(async () => {
      this.broadcastPresence();
      this.notifyPeersUpdated();
    }, 2500);
  }

  /**
   * Sends an encrypted or direct WebRTC signaling packet
   */
  private async sendSignal(type: string, payload: any, targetId: string) {
    const packet: SignalPacket = {
      id: `sig_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      type,
      payload,
      targetId,
      fromPeer: this.myDevice,
      timestamp: Date.now(),
    };

    // Mark our own signal as seen
    this.seenSignalIds.add(packet.id);

    // 1. BroadcastChannel (fast local tabs)
    try {
      this.broadcastChannel.postMessage(packet);
    } catch {}

    // 2. Real-time Cloud Push via reliable SSE host
    try {
      fetch(`${SIGNAL_BASE}/aether_sig_${targetId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(packet),
      }).catch(() => {});
    } catch {}
  }

  /**
   * Creates or configures the RTCPeerConnection
   */
  private async createPeerConnection(
    isInitiator: boolean,
    remotePeer: PeerDevice
  ): Promise<RTCPeerConnection> {
    // If existing connection is already open and connected to this peer, reuse
    if (this.peerConnection && this.isConnected() && this.activePeer?.id === remotePeer.id) {
      return this.peerConnection;
    }

    if (this.peerConnection) {
      try {
        this.peerConnection.close();
      } catch {}
      this.peerConnection = null;
    }

    this.gatheredCandidates = [];
    // Trickled candidates can overtake the offer; the answerer still needs them.
    if (isInitiator) {
      this.pendingCandidates = [];
    }

    const pc = new RTCPeerConnection({
      iceServers: await buildIceServers(),
      iceCandidatePoolSize: 4,
    });
    this.peerConnection = pc;
    this.activePeer = remotePeer;

    // Real-time Trickle ICE: stream every candidate immediately
    pc.onicecandidate = (event) => {
      if (event.candidate && this.activePeer) {
        const candJson = event.candidate.toJSON();
        console.log(
          `[WebRTC ICE Candidate] ${event.candidate.type || "unknown"} / ` +
            `${event.candidate.protocol || "unknown"}`
        );
        this.gatheredCandidates.push(candJson);
        this.sendSignal("ICE_CANDIDATE", candJson, this.activePeer.id);
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[WebRTC ICE State] -> ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        console.log(`⚡ WebRTC path connected with ${remotePeer.name}!`);
        this.logSelectedCandidatePair(pc);
      } else if (pc.iceConnectionState === "failed") {
        console.warn(`[WebRTC ICE Failed] Connection path failed.`);
        if (this.connectionResolver) {
          this.connectionResolver(false);
          this.connectionResolver = null;
        }
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[WebRTC Connection State] -> ${pc.connectionState}`);
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        if (this.connectionResolver) {
          this.connectionResolver(false);
          this.connectionResolver = null;
        }
      }
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

  /** Local candidate types gathered for the current attempt. */
  public getIceSummary(): { maskedHost: number; host: number; srflx: number; relay: number } {
    const summary = { maskedHost: 0, host: 0, srflx: 0, relay: 0 };
    for (const cand of this.gatheredCandidates) {
      const line = cand.candidate || "";
      if (line.includes(" typ relay")) summary.relay++;
      else if (line.includes(" typ srflx")) summary.srflx++;
      else if (line.includes(" typ host")) {
        if (line.includes(".local ")) summary.maskedHost++;
        else summary.host++;
      }
    }
    return summary;
  }

  private async logSelectedCandidatePair(pc: RTCPeerConnection) {
    try {
      const stats = await pc.getStats();
      for (const report of stats.values()) {
        if (report.type !== "candidate-pair" || !report.selected) continue;
        const local = stats.get(report.localCandidateId);
        const remote = stats.get(report.remoteCandidateId);
        console.log(
          `[WebRTC Path] ${local?.candidateType || "unknown"} -> ` +
            `${remote?.candidateType || "unknown"} (${local?.protocol || "unknown"})`
        );
        return;
      }
    } catch (error) {
      console.debug("[WebRTC] Candidate-pair diagnostics unavailable.", error);
    }
  }

  private setupDataChannel(dc: RTCDataChannel, peer: PeerDevice) {
    this.dataChannel = dc;
    this.activePeer = peer;
    dc.binaryType = "arraybuffer";

    dc.onopen = () => {
      console.log(`⚡ High-speed P2P link ESTABLISHED with ${peer.name}!`);
      if (this.connectionResolver) {
        this.connectionResolver(true);
        this.connectionResolver = null;
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

  /**
   * Waits up to maxWaitMs for initial ICE gathering, returning early if complete
   */
  private async waitForIceGathering(pc: RTCPeerConnection, maxWaitMs = 1200): Promise<void> {
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

  /**
   * Entry point for incoming signals with deduplication
   */
  private async handleDirectSignalPacket(packet: SignalPacket) {
    if (this.seenSignalIds.has(packet.id)) return;
    this.seenSignalIds.add(packet.id);

    // Keep set bounded
    if (this.seenSignalIds.size > 200) {
      const iter = this.seenSignalIds.values();
      for (let i = 0; i < 50; i++) {
        const val = iter.next().value;
        if (val) this.seenSignalIds.delete(val);
      }
    }

    await this.handleDirectSignal(packet.type, packet.payload, packet.fromPeer);
  }

  private async handleDirectSignal(type: string, payload: any, sender: PeerDevice) {
    if (!sender || !sender.id) return;
    this.registerPeer(sender);

    if (type === "OFFER") {
      const isCollision =
        this.isMakingOffer ||
        (this.peerConnection && this.peerConnection.signalingState !== "stable");
      const isPolite = this.myDevice.id < sender.id;

      if (isCollision && !isPolite) {
        console.log(`[Collision] Impolite peer (${this.myDevice.name}) ignoring offer from ${sender.name}`);
        return;
      }

      console.log(`⚡ Processing WebRTC OFFER from ${sender.name}`);
      this.activePeer = sender;

      let pc = this.peerConnection;
      if (!pc || (isCollision && isPolite)) {
        pc = await this.createPeerConnection(false, sender);
      }

      // If polite and collision, rollback local description
      if (pc.signalingState !== "stable") {
        try {
          await pc.setLocalDescription({ type: "rollback" });
        } catch {}
      }

      await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: payload.sdp }));

      // Drain bundled candidates
      if (Array.isArray(payload.candidates)) {
        for (const cand of payload.candidates) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(cand));
          } catch {}
        }
      }

      // Drain pending trickle candidates
      if (this.pendingCandidates.length > 0) {
        for (const cand of this.pendingCandidates) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(cand));
          } catch {}
        }
        this.pendingCandidates = [];
      }

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(widenSctpMessageSize(answer));

      // Wait up to 1200ms to bundle initial host + STUN candidates
      await this.waitForIceGathering(pc, 1200);

      const sdp = pc.localDescription?.sdp || answer.sdp;
      await this.sendSignal(
        "ANSWER",
        {
          sdp,
          candidates: this.gatheredCandidates,
        },
        sender.id
      );
    } else if (type === "ANSWER") {
      if (this.peerConnection && this.peerConnection.signalingState === "have-local-offer") {
        console.log(`⚡ Processing WebRTC ANSWER from ${sender.name}`);
        await this.peerConnection.setRemoteDescription(
          new RTCSessionDescription({ type: "answer", sdp: payload.sdp })
        );

        // Apply bundled candidates
        if (Array.isArray(payload.candidates)) {
          for (const cand of payload.candidates) {
            try {
              await this.peerConnection.addIceCandidate(new RTCIceCandidate(cand));
            } catch {}
          }
        }

        // Apply pending trickle candidates
        if (this.pendingCandidates.length > 0) {
          for (const cand of this.pendingCandidates) {
            try {
              await this.peerConnection.addIceCandidate(new RTCIceCandidate(cand));
            } catch {}
          }
          this.pendingCandidates = [];
        }
      }
    } else if (type === "ICE_CANDIDATE") {
      if (payload) {
        if (this.peerConnection && this.peerConnection.remoteDescription) {
          try {
            await this.peerConnection.addIceCandidate(new RTCIceCandidate(payload));
          } catch (e) {
            console.warn("Could not add ICE candidate:", e);
          }
        } else {
          this.pendingCandidates.push(payload);
        }
      }
    } else if (type === "PIN_ACK") {
      console.log(`⚡ PIN handshake confirmed with ${sender.name}`);
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
    const pc = await this.createPeerConnection(true, targetPeer);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(widenSctpMessageSize(offer));

      // Wait up to 1200ms to bundle initial candidates
      await this.waitForIceGathering(pc, 1200);

      const sdp = pc.localDescription?.sdp || offer.sdp;
      await this.sendSignal(
        "OFFER",
        {
          sdp,
          candidates: this.gatheredCandidates,
        },
        targetPeer.id
      );
    } finally {
      this.isMakingOffer = false;
    }

    return new Promise((resolve) => {
      if (this.isConnected()) {
        resolve(true);
        return;
      }

      let checkTimer: any = null;
      let timeoutTimer: any = null;

      const finish = (result: boolean) => {
        if (checkTimer) clearInterval(checkTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        this.connectionResolver = null;
        resolve(result);
      };

      this.connectionResolver = finish;

      // Check on dataChannel readyState
      checkTimer = setInterval(() => {
        if (this.isConnected()) {
          finish(true);
        }
      }, 50);

      timeoutTimer = setTimeout(() => {
        const open = this.isConnected();
        if (!open) {
          console.warn(`Connection attempt to ${targetPeer.name} timed out.`);
        }
        finish(open);
      }, 30000);
    });
  }

  /**
   * Generates a 1-Second Instant QR Handshake payload
   */
  public async generateQRHandshake(): Promise<InstantQRHandshake> {
    const sid = "aeth_" + Math.random().toString(36).substring(2, 10);
    const sessionPin = WirelessCrypto.generateSessionPassword(6);

    return {
      v: "2.0",
      sid,
      peer: this.myDevice,
      key: sessionPin,
    };
  }


  /**
   * Connects using an Instant QR code scanned by the camera
   */
  public async connectWithQR(handshake: InstantQRHandshake): Promise<boolean> {
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
    let bytesAccepted = 0;

    this.speedSamples = [];
    this.transferStartTime = Date.now();
    this.lastDelivered = 0;
    this.lastUiUpdate = 0;

    let maxMessage = this.peerConnection?.sctp?.maxMessageSize || 64 * 1024;
    if (maxMessage > SCTP_MAX_MESSAGE) maxMessage = SCTP_MAX_MESSAGE;
    const plainSize = Math.min(
      WEBRTC_CHUNK_SIZE,
      Math.max(16 * 1024, maxMessage - 4 - (password ? 16 : 0))
    );

    for (let fIdx = 0; fIdx < files.length; fIdx++) {
      const file = files[fIdx];
      const totalChunks = Math.ceil(file.size / plainSize);
      const salt = password ? WirelessCrypto.generateSalt() : undefined;
      const iv = password ? WirelessCrypto.generateIV() : undefined;
      const key = password && salt ? await WirelessCrypto.deriveKey(password, salt) : null;

      this.emitProgress({
        fileId: file.name,
        fileName: file.name,
        bytesTransferred: this.lastDelivered,
        totalBytes: totalBytesAll,
        percent: Math.round((this.lastDelivered / totalBytesAll) * 100),
        speedMBps: 0,
        etaSeconds: 0,
        state: "verifying",
      });

      // Read the file once. Per-chunk file.slice().arrayBuffer() was capping phones near 1 MB/s.
      const fileBytes = new Uint8Array(await file.arrayBuffer());
      const fileSha256 = await WirelessCrypto.computeSHA256(fileBytes);

      const meta: FileMetadata = {
        id: "f_" + Math.random().toString(36).substring(2, 9),
        name: file.name,
        size: file.size,
        type: file.type || "application/octet-stream",
        totalChunks,
        chunkSize: plainSize,
        sha256: fileSha256,
        encrypted: !!password,
        salt: salt ? WirelessCrypto.uint8ToBase64(salt) : undefined,
        iv: iv ? WirelessCrypto.uint8ToBase64(iv) : undefined,
      };

      const tick = () => this.reportSendProgress(dc, bytesAccepted, totalBytesAll, file.name);
      await this.sendWhenReady(
        dc,
        JSON.stringify({
          type: MessageType.FILE_METADATA,
          payload: meta,
        }),
        tick
      );

      const frame = new Uint8Array(4 + plainSize + (password ? 16 : 0));
      const view = new DataView(frame.buffer);
      let offset = 0;
      let chunkIndex = 0;

      while (offset < fileBytes.length) {
        const end = Math.min(offset + plainSize, fileBytes.length);
        let piece: Uint8Array = fileBytes.subarray(offset, end);
        if (key && iv) {
          piece = await WirelessCrypto.encryptChunk(piece, key, iv);
        }

        view.setUint32(0, chunkIndex, false);
        frame.set(piece, 4);
        // send() copies, so the frame buffer can be reused on the next chunk.
        await this.sendWhenReady(dc, frame.subarray(0, 4 + piece.length), tick);

        bytesAccepted += end - offset;
        offset = end;
        chunkIndex++;
        tick();
      }

      // Wait until the bytes have actually left, so the sender meter matches the receiver.
      await this.waitForFlush(dc, tick);
      await this.sendWhenReady(
        dc,
        JSON.stringify({
          type: MessageType.FILE_COMPLETE,
          payload: { id: meta.id },
        }),
        tick
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

  /** Bytes handed to SCTP, not bytes still sitting in bufferedAmount. */
  private reportSendProgress(
    dc: RTCDataChannel,
    bytesAccepted: number,
    totalBytes: number,
    fileName: string,
    force = false
  ) {
    const now = Date.now();
    if (!force && now - this.lastUiUpdate < 120) return;
    this.lastUiUpdate = now;
    const delivered = Math.min(
      totalBytes,
      Math.max(this.lastDelivered, bytesAccepted - dc.bufferedAmount)
    );
    this.lastDelivered = delivered;
    this.recordSpeedSample(delivered);
    const { speedMBps, etaSeconds } = this.calculateSpeedAndETA(delivered, totalBytes);
    this.emitProgress({
      fileId: fileName,
      fileName,
      bytesTransferred: delivered,
      totalBytes,
      percent: Math.min(99, Math.round((delivered / Math.max(1, totalBytes)) * 100)),
      speedMBps,
      etaSeconds,
      state: "sending",
    });
  }

  /** Chrome rejects send() once the queue reaches 16MB, so pause before that. */
  private async sendWhenReady(
    dc: RTCDataChannel,
    data: string | ArrayBufferView,
    tick: () => void
  ): Promise<void> {
    const size = typeof data === "string" ? data.length : data.byteLength;
    if (dc.bufferedAmount + size > BUFFER_HIGH_WATERMARK) {
      await this.waitForSendWindow(dc, tick);
    }
    try {
      dc.send(data as any);
    } catch (err) {
      const full = /send queue is full/i.test(String((err as Error)?.message || err));
      if (!full || dc.readyState !== "open") throw err;
      await this.waitForSendWindow(dc, tick);
      dc.send(data as any);
    }
  }

  private waitForSendWindow(dc: RTCDataChannel, tick: () => void): Promise<void> {
    if (dc.bufferedAmount <= BUFFER_LOW_WATERMARK) return Promise.resolve();
    dc.bufferedAmountLowThreshold = BUFFER_LOW_WATERMARK;
    return this.waitForBuffer(dc, () => dc.bufferedAmount <= BUFFER_LOW_WATERMARK, tick);
  }

  private waitForFlush(dc: RTCDataChannel, tick: () => void): Promise<void> {
    if (dc.bufferedAmount === 0) return Promise.resolve();
    dc.bufferedAmountLowThreshold = 0;
    return this.waitForBuffer(dc, () => dc.bufferedAmount === 0, tick);
  }

  private waitForBuffer(
    dc: RTCDataChannel,
    ready: () => boolean,
    tick: () => void
  ): Promise<void> {
    if (dc.readyState !== "open") {
      return Promise.reject(new Error("Wireless channel closed while sending."));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        dc.removeEventListener("bufferedamountlow", onLow);
        dc.removeEventListener("close", onClose);
        if (error) reject(error);
        else resolve();
      };
      const onLow = () => {
        tick();
        if (ready()) finish();
      };
      const onClose = () => finish(new Error("Wireless channel closed while sending."));
      const timer = setInterval(() => {
        tick();
        if (dc.readyState !== "open") onClose();
        else if (ready()) finish();
      }, 100);
      dc.addEventListener("bufferedamountlow", onLow);
      dc.addEventListener("close", onClose);
      if (ready()) finish();
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
          this.lastUiUpdate = 0;
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
      const payloadLength = data.byteLength - 4;
      // Copy the payload out so the message buffer can be released immediately.
      this.currentIncomingFile.chunks[chunkIndex] = new Uint8Array(data.slice(4));
      this.currentIncomingFile.receivedBytes += payloadLength;

      const now = Date.now();
      if (now - this.lastUiUpdate < 120) return;
      this.lastUiUpdate = now;

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

    const blob = new Blob(chunks, { type: meta.type });
    const fullBuffer = await blob.arrayBuffer();

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
    this.pendingCandidates = [];
    if (this.connectionResolver) {
      this.connectionResolver(false);
      this.connectionResolver = null;
    }
  }

  public close() {
    if (this.pollingTimer) clearInterval(this.pollingTimer);
    if (this.sseSignalSource) this.sseSignalSource.close();
    if (this.sseRadarSource) this.sseRadarSource.close();
    if (this.ssePinSource) this.ssePinSource.close();
    this.disconnect();
    this.broadcastChannel.close();
  }
}
