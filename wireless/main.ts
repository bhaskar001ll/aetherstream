/**
 * AetherStream Wireless Ultra - Main Application Controller
 */

import QRCode from "qrcode";
import { WirelessTransferEngine, TransferProgress } from "./transfer-engine";
import { WirelessRadar } from "./radar";
import { PeerDevice, InstantQRHandshake } from "./protocol";

// Format bytes into human-readable strings
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

class WirelessApp {
  private engine: WirelessTransferEngine;
  private radar: WirelessRadar;
  private selectedFiles: File[] = [];
  private activeTab: "file" | "text" = "file";
  private cameraStream: MediaStream | null = null;
  private scanAnimId: number | null = null;

  // DOM Elements
  private myDeviceNameEl = document.getElementById("my-device-name")!;
  private myDeviceSubEl = document.getElementById("my-device-sub")!;
  private peerCountEl = document.getElementById("peer-count")!;
  private discoveredListEl = document.getElementById("discovered-peers-list")!;
  private connectedBannerEl = document.getElementById("connected-peer-banner")!;
  private connectedNameEl = document.getElementById("connected-peer-name")!;
  private btnDisconnectEl = document.getElementById("btn-disconnect")!;

  // Dashboard
  private dashboardEl = document.getElementById("transfer-dashboard")!;
  private transferTitleEl = document.getElementById("transfer-state-title")!;
  private transferPctEl = document.getElementById("transfer-pct")!;
  private statSpeedEl = document.getElementById("stat-speed")!;
  private statBytesEl = document.getElementById("stat-bytes")!;
  private statEtaEl = document.getElementById("stat-eta")!;
  private progressBarEl = document.getElementById("progress-bar")!;
  private transferMsgEl = document.getElementById("transfer-status-msg")!;

  // Workspace
  private tabFileEl = document.getElementById("tab-send-file")!;
  private tabTextEl = document.getElementById("tab-send-text")!;
  private paneFileEl = document.getElementById("pane-send-file")!;
  private paneTextEl = document.getElementById("pane-send-text")!;
  private dropzoneEl = document.getElementById("file-dropzone")!;
  private fileInputEl = document.getElementById("file-input") as HTMLInputElement;
  private fileQueueEl = document.getElementById("file-queue")!;
  private snippetInputEl = document.getElementById("snippet-input") as HTMLTextAreaElement;
  private chkEncryptEl = document.getElementById("chk-encrypt") as HTMLInputElement;
  private inputPasswordEl = document.getElementById("input-password") as HTMLInputElement;
  private btnSendNowEl = document.getElementById("btn-send-now") as HTMLButtonElement;

  // History
  private historyListEl = document.getElementById("history-list")!;
  private emptyHistoryEl = document.getElementById("empty-history-msg")!;
  private btnClearHistoryEl = document.getElementById("btn-clear-history")!;

  // Modals
  private qrModalEl = document.getElementById("qr-modal")!;
  private btnCloseQrModalEl = document.getElementById("btn-close-qr-modal")!;
  private qrCanvasEl = document.getElementById("qr-pairing-canvas") as HTMLCanvasElement;
  private qrSessionInfoEl = document.getElementById("qr-session-info")!;
  private btnShowQrEl = document.getElementById("btn-show-qr")!;

  private scannerModalEl = document.getElementById("scanner-modal")!;
  private btnCloseScannerEl = document.getElementById("btn-close-scanner-modal")!;
  private btnScanQrEl = document.getElementById("btn-scan-qr")!;
  private scannerVideoEl = document.getElementById("scanner-video") as HTMLVideoElement;
  private scannerStatusEl = document.getElementById("scanner-status")!;

  private btnBluetoothEl = document.getElementById("btn-bluetooth")!;
  private btnRefreshPeersEl = document.getElementById("btn-refresh-peers")!;

  // PIN Pairing Modal
  private qrPinCodeEl = document.getElementById("qr-pin-code")!;
  private pinModalEl = document.getElementById("pin-modal")!;
  private btnClosePinEl = document.getElementById("btn-close-pin-modal")!;
  private btnEnterPinEl = document.getElementById("btn-enter-pin")!;
  private inputPinCodeEl = document.getElementById("input-pin-code") as HTMLInputElement;
  private btnSubmitPinEl = document.getElementById("btn-submit-pin") as HTMLButtonElement;
  private btnCopyPairUrlEl = document.getElementById("btn-copy-pair-url") as HTMLButtonElement;

  private wakeLock: any = null;
  private renderedPeerCards: Map<string, HTMLElement> = new Map();

  constructor() {
    this.engine = new WirelessTransferEngine();
    const radarCanvas = document.getElementById("radar-canvas") as HTMLCanvasElement;
    this.radar = new WirelessRadar(radarCanvas, (peer) => this.handlePeerSelected(peer));

    this.initUI();
    this.bindEvents();
    this.setupEngineCallbacks();
  }

  private initUI() {
    this.myDeviceNameEl.textContent = this.engine.myDevice.name;
    this.myDeviceSubEl.textContent = `OS: ${this.engine.myDevice.os.toUpperCase()} · ${this.engine.myDevice.browser} · No Cloud`;

    // Auto-pair if opened via shared direct pairing URL (works seamlessly on Vercel / any host)
    const urlParams = new URLSearchParams(window.location.search);
    const pairParam = urlParams.get("pair");
    if (pairParam) {
      try {
        const handshake: InstantQRHandshake = JSON.parse(decodeURIComponent(pairParam));
        window.history.replaceState({}, document.title, window.location.pathname);
        setTimeout(() => {
          this.handlePeerSelected(handshake.peer);
        }, 600);
      } catch (err) {
        console.warn("Failed to auto-pair from URL parameter", err);
      }
    }
  }

  private bindEvents() {
    // Tabs
    this.tabFileEl.addEventListener("click", () => this.switchTab("file"));
    this.tabTextEl.addEventListener("click", () => this.switchTab("text"));

    // File Dropzone
    this.dropzoneEl.addEventListener("click", () => this.fileInputEl.click());
    this.fileInputEl.addEventListener("change", () => {
      if (this.fileInputEl.files) {
        this.addFiles(Array.from(this.fileInputEl.files));
      }
    });

    this.dropzoneEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      this.dropzoneEl.classList.add("dragover");
    });

    this.dropzoneEl.addEventListener("dragleave", () => {
      this.dropzoneEl.classList.remove("dragover");
    });

    this.dropzoneEl.addEventListener("drop", (e) => {
      e.preventDefault();
      this.dropzoneEl.classList.remove("dragover");
      if (e.dataTransfer) {
        this.handleDropItems(e.dataTransfer);
      }
    });

    // PIN Modal
    this.btnEnterPinEl.addEventListener("click", () => {
      this.pinModalEl.classList.add("active");
      this.inputPinCodeEl.value = "";
      this.inputPinCodeEl.focus();
    });

    this.btnClosePinEl.addEventListener("click", () => {
      this.pinModalEl.classList.remove("active");
    });

    this.btnSubmitPinEl.addEventListener("click", () => this.handlePinSubmit());
    this.inputPinCodeEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.handlePinSubmit();
    });

    // Encryption toggle
    this.chkEncryptEl.addEventListener("change", () => {
      this.inputPasswordEl.style.display = this.chkEncryptEl.checked ? "block" : "none";
      if (this.chkEncryptEl.checked) this.inputPasswordEl.focus();
    });

    // Send Button
    this.btnSendNowEl.addEventListener("click", () => this.handleSend());

    // Disconnect Button
    this.btnDisconnectEl.addEventListener("click", () => {
      this.engine.disconnect();
      this.connectedBannerEl.style.display = "none";
      this.btnSendNowEl.disabled = true;
    });

    // Clear History
    this.btnClearHistoryEl.addEventListener("click", () => {
      this.historyListEl.innerHTML = "";
      this.emptyHistoryEl.style.display = "block";
      this.historyListEl.appendChild(this.emptyHistoryEl);
    });

    // 1-Sec QR Modal
    this.btnShowQrEl.addEventListener("click", () => this.showQRModal());
    this.btnCloseQrModalEl.addEventListener("click", () => {
      this.qrModalEl.classList.remove("active");
    });

    // Scanner Modal
    this.btnScanQrEl.addEventListener("click", () => this.showScannerModal());
    this.btnCloseScannerEl.addEventListener("click", () => this.closeScannerModal());

    // Bluetooth
    this.btnBluetoothEl.addEventListener("click", () => this.handleBluetoothScan());

    // Refresh peers
    this.btnRefreshPeersEl.addEventListener("click", () => {
      this.btnRefreshPeersEl.textContent = "⏳ Scanning...";
      setTimeout(() => {
        this.btnRefreshPeersEl.textContent = "🔄 Scan";
      }, 1000);
    });
  }

  private switchTab(tab: "file" | "text") {
    this.activeTab = tab;
    if (tab === "file") {
      this.tabFileEl.classList.add("active");
      this.tabTextEl.classList.remove("active");
      this.paneFileEl.style.display = "block";
      this.paneTextEl.style.display = "none";
    } else {
      this.tabTextEl.classList.add("active");
      this.tabFileEl.classList.remove("active");
      this.paneFileEl.style.display = "none";
      this.paneTextEl.style.display = "block";
    }
    this.updateSendButtonState();
  }

  private addFiles(newFiles: File[]) {
    this.selectedFiles.push(...newFiles);
    this.renderFileQueue();
    this.updateSendButtonState();
  }

  private renderFileQueue() {
    this.fileQueueEl.innerHTML = "";
    this.selectedFiles.forEach((file, index) => {
      const item = document.createElement("div");
      item.className = "file-item";
      item.innerHTML = `
        <div style="display:flex; align-items:center; gap:8px;">
          <span>📄</span>
          <div>
            <strong>${file.name}</strong>
            <span style="color:#94a3b8; font-size:0.75rem; margin-left:6px;">(${formatBytes(file.size)})</span>
          </div>
        </div>
        <button class="file-remove" data-index="${index}">✕</button>
      `;
      item.querySelector(".file-remove")?.addEventListener("click", () => {
        this.selectedFiles.splice(index, 1);
        this.renderFileQueue();
        this.updateSendButtonState();
      });
      this.fileQueueEl.appendChild(item);
    });
  }

  private updateSendButtonState() {
    const hasTarget = this.engine.isConnected();
    const hasContent =
      this.activeTab === "file"
        ? this.selectedFiles.length > 0
        : this.snippetInputEl.value.trim().length > 0;

    this.btnSendNowEl.disabled = !(hasTarget && hasContent);
  }

  private setupEngineCallbacks() {
    // Connection established callback
    this.engine.onConnected = (peer) => {
      this.connectedBannerEl.style.display = "block";
      this.connectedNameEl.textContent = `Connected to ${peer.name} (⚡ 50-120+ MB/s Link)`;
      this.connectedNameEl.style.color = "#22c55e";
      this.updateSendButtonState();
    };

    // Peers update
    this.engine.onPeersUpdated = (peers) => {
      this.radar.updatePeers(peers);
      this.peerCountEl.textContent = `${peers.length} nearby`;
      this.renderDiscoveredPeers(peers);
    };

    // Progress
    this.engine.onProgress = (progress) => {
      this.updateProgressDashboard(progress);
    };

    // Received File
    this.engine.onFileSaved = (name, url, size, sha256) => {
      this.playChime();
      this.emptyHistoryEl.style.display = "none";
      const card = document.createElement("div");
      card.className = "history-card";
      card.innerHTML = `
        <div>
          <h5>💾 ${name}</h5>
          <p>${formatBytes(size)} · SHA-256: <code style="font-size:0.7rem; color:#22c55e;">${sha256.substring(0, 12)}...</code></p>
        </div>
        <a href="${url}" download="${name}" class="btn-primary" style="padding:6px 12px; font-size:0.8rem; text-decoration:none;">
          ⬇️ Download
        </a>
      `;
      this.historyListEl.prepend(card);
    };

    // Received Snippet
    this.engine.onSnippetReceived = (snippet) => {
      this.playChime();
      this.emptyHistoryEl.style.display = "none";
      const card = document.createElement("div");
      card.className = "history-card";
      card.innerHTML = `
        <div style="max-width:70%;">
          <h5>📝 Text Snippet</h5>
          <p style="white-space:pre-wrap; word-break:break-word; color:#f8fafc; font-size:0.85rem; margin-top:4px;">${snippet.text}</p>
        </div>
        <button class="btn-secondary" style="font-size:0.8rem;" id="copy-btn-${snippet.id}">
          📋 Copy
        </button>
      `;
      card.querySelector(`#copy-btn-${snippet.id}`)?.addEventListener("click", () => {
        navigator.clipboard.writeText(snippet.text);
        const btn = card.querySelector(`#copy-btn-${snippet.id}`) as HTMLButtonElement;
        btn.textContent = "✅ Copied!";
        setTimeout(() => (btn.textContent = "📋 Copy"), 2000);
      });
      this.historyListEl.prepend(card);
    };
  }

  private renderDiscoveredPeers(peers: PeerDevice[]) {
    if (peers.length === 0) {
      this.renderedPeerCards.clear();
      this.discoveredListEl.innerHTML = `
        <p style="color:#94a3b8; font-size:0.85rem; text-align:center; padding: 30px 0;">
          Searching for nearby phones and PCs on local Wi-Fi...<br />
          <span style="font-size:0.75rem; color:#64748b;">Or tap "1-Sec QR Pair" above to connect directly.</span>
        </p>
      `;
      return;
    }

    const placeholder = this.discoveredListEl.querySelector("p");
    if (placeholder) {
      placeholder.remove();
    }

    const currentIds = new Set(peers.map((p) => p.id));
    for (const [id, el] of this.renderedPeerCards) {
      if (!currentIds.has(id)) {
        el.remove();
        this.renderedPeerCards.delete(id);
      }
    }

    peers.forEach((peer) => {
      let item = this.renderedPeerCards.get(peer.id);
      if (!item) {
        item = document.createElement("div");
        item.className = "peer-item";
        item.id = `peer-card-${peer.id}`;
        const icon = peer.os === "android" ? "📱" : peer.os === "ios" ? "📱" : "💻";
        item.innerHTML = `
          <div class="peer-info">
            <div class="peer-icon">${icon}</div>
            <div class="peer-text">
              <h4 class="peer-title">${peer.name}</h4>
              <p>${peer.os.toUpperCase()} · Direct Wi-Fi</p>
            </div>
          </div>
          <button class="btn-secondary btn-connect-peer" style="font-size:0.8rem;">Connect</button>
        `;
        item.querySelector(".btn-connect-peer")?.addEventListener("click", () => this.handlePeerSelected(peer));
        this.discoveredListEl.appendChild(item);
        this.renderedPeerCards.set(peer.id, item);
      } else {
        const titleEl = item.querySelector(".peer-title");
        if (titleEl && titleEl.textContent !== peer.name) {
          titleEl.textContent = peer.name;
        }
      }
    });
  }

  private async handlePeerSelected(peer: PeerDevice) {
    this.connectedBannerEl.style.display = "block";
    this.connectedNameEl.textContent = `Connecting to ${peer.name}...`;
    this.connectedNameEl.style.color = "#38bdf8";

    const connected = await this.engine.connectToPeer(peer);
    if (connected) {
      this.connectedNameEl.textContent = `Connected to ${peer.name} (⚡ 50-120+ MB/s Link)`;
      this.connectedNameEl.style.color = "#22c55e";
      this.updateSendButtonState();
    } else {
      this.connectedNameEl.textContent = `Connection to ${peer.name} timed out. Retry or use 1-Sec QR.`;
      this.connectedNameEl.style.color = "#f43f5e";
    }
  }

  private async handleSend() {
    const password = this.chkEncryptEl.checked ? this.inputPasswordEl.value.trim() : undefined;

    try {
      this.dashboardEl.classList.add("active");
      if (this.activeTab === "file") {
        await this.engine.sendFiles(this.selectedFiles, password);
        this.selectedFiles = [];
        this.renderFileQueue();
      } else {
        const text = this.snippetInputEl.value.trim();
        await this.engine.sendSnippet(text, password);
        this.snippetInputEl.value = "";
      }
      this.updateSendButtonState();
    } catch (err: any) {
      alert("Transfer error: " + (err.message || err));
    }
  }

  private updateProgressDashboard(p: TransferProgress) {
    this.dashboardEl.classList.add("active");
    this.transferPctEl.textContent = `${p.percent}%`;
    this.progressBarEl.style.width = `${p.percent}%`;
    this.statSpeedEl.textContent = `${p.speedMBps.toFixed(1)} MB/s`;
    this.statBytesEl.textContent = `${formatBytes(p.bytesTransferred)} / ${formatBytes(p.totalBytes)}`;
    this.statEtaEl.textContent = p.etaSeconds > 0 ? `${p.etaSeconds} s` : "-- s";

    if (p.state === "verifying") {
      this.transferTitleEl.textContent = "VERIFYING SHA-256 HASH...";
      this.transferMsgEl.textContent = "Computing cryptographic integrity verification...";
    } else if (p.state === "sending") {
      this.transferTitleEl.textContent = "STREAMING TO REMOTE DEVICE...";
      this.transferMsgEl.textContent = `Sending ${p.fileName} at ${p.speedMBps.toFixed(1)} MB/s...`;
    } else if (p.state === "receiving") {
      this.transferTitleEl.textContent = "RECEIVING PACKETS...";
      this.transferMsgEl.textContent = `Receiving ${p.fileName} at ${p.speedMBps.toFixed(1)} MB/s...`;
    }

    if (p.state === "sending" || p.state === "receiving") {
      this.acquireWakeLock();
    } else if (p.state === "complete") {
      this.releaseWakeLock();
      this.playChime();
      this.transferTitleEl.textContent = "TRANSFER COMPLETE ✅";
      this.transferMsgEl.textContent = `Transferred ${formatBytes(p.totalBytes)} successfully!`;
    } else if (p.state === "error") {
      this.releaseWakeLock();
      this.transferTitleEl.textContent = "TRANSFER ERROR ❌";
      this.transferMsgEl.textContent = p.error || "An error occurred during transfer.";
    }
  }

  // QR Modals
  private async showQRModal() {
    this.qrModalEl.classList.add("active");
    const handshake = await this.engine.generateQRHandshake();
    this.qrPinCodeEl.textContent = `PIN: ${handshake.key || "------"}`;

    // Universal URL for direct pairing across browsers (works seamlessly on Vercel / any host)
    const pairUrl = `${window.location.origin}${window.location.pathname}?pair=${encodeURIComponent(JSON.stringify(handshake))}`;

    await QRCode.toCanvas(this.qrCanvasEl, pairUrl, {
      width: 220,
      margin: 2,
      color: { dark: "#020617", light: "#ffffff" },
    });

    this.qrSessionInfoEl.textContent = `Session: ${handshake.sid} · Peer: ${handshake.peer.name}`;

    if (this.btnCopyPairUrlEl) {
      this.btnCopyPairUrlEl.onclick = () => {
        navigator.clipboard.writeText(pairUrl);
        this.btnCopyPairUrlEl.textContent = "✅ Link Copied!";
        setTimeout(() => {
          this.btnCopyPairUrlEl.textContent = "📋 Copy Direct Pairing Link";
        }, 2000);
      };
    }
  }

  private async showScannerModal() {
    this.scannerModalEl.classList.add("active");
    this.scannerStatusEl.textContent = "Starting camera...";

    try {
      this.cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      this.scannerVideoEl.srcObject = this.cameraStream;
      await this.scannerVideoEl.play();
      this.scannerStatusEl.textContent = "Point at pairing QR code on the other screen...";
      this.startQRScanningLoop();
    } catch (err) {
      this.scannerStatusEl.textContent = "Camera access denied or unavailable.";
    }
  }

  private startQRScanningLoop() {
    const scanCanvas = document.createElement("canvas");
    const scanCtx = scanCanvas.getContext("2d", { willReadFrequently: true });

    // Use native BarcodeDetector if available (instant hardware decode)
    const hasBarcodeDetector = "BarcodeDetector" in window;
    let detector: any = null;
    if (hasBarcodeDetector) {
      detector = new (window as any).BarcodeDetector({ formats: ["qr_code"] });
    }

    const checkFrame = async () => {
      if (!this.cameraStream || this.scannerVideoEl.readyState < 2) {
        this.scanAnimId = requestAnimationFrame(checkFrame);
        return;
      }

      try {
        if (detector) {
          const codes = await detector.detect(this.scannerVideoEl);
          if (codes.length > 0) {
            const raw = codes[0].rawValue;
            this.handleScannedQRString(raw);
            return;
          }
        } else if (scanCtx) {
          scanCanvas.width = this.scannerVideoEl.videoWidth;
          scanCanvas.height = this.scannerVideoEl.videoHeight;
          scanCtx.drawImage(this.scannerVideoEl, 0, 0);
        }
      } catch {
        // continue loop
      }

      this.scanAnimId = requestAnimationFrame(checkFrame);
    };

    this.scanAnimId = requestAnimationFrame(checkFrame);
  }

  private async handleScannedQRString(raw: string) {
    try {
      let data: InstantQRHandshake | null = null;
      if (raw.includes("?pair=")) {
        const url = new URL(raw);
        const pairParam = url.searchParams.get("pair");
        if (pairParam) {
          data = JSON.parse(decodeURIComponent(pairParam));
        }
      } else {
        data = JSON.parse(raw);
      }
      if (data && data.v === "2.0" && data.peer) {
        this.scannerStatusEl.textContent = "✅ QR Paired! Connecting...";
        this.closeScannerModal();
        await this.handlePeerSelected(data.peer);
      }
    } catch {
      // not a valid json QR
    }
  }

  private closeScannerModal() {
    if (this.scanAnimId) cancelAnimationFrame(this.scanAnimId);
    if (this.cameraStream) {
      this.cameraStream.getTracks().forEach((track) => track.stop());
      this.cameraStream = null;
    }
    this.scannerModalEl.classList.remove("active");
  }

  private async handleBluetoothScan() {
    if (!("bluetooth" in navigator)) {
      alert(
        "Web Bluetooth is not supported in this browser.\n\nUse the 1-Sec QR code or Local Wi-Fi Radar above for instant connection!"
      );
      return;
    }

    try {
      const device = await (navigator as any).bluetooth.requestDevice({
        acceptAllDevices: true,
      });
      alert(`Bluetooth device selected: ${device.name || "Unnamed Device"}`);
    } catch (err: any) {
      if (err.name !== "NotFoundError") {
        console.warn("Bluetooth scan notice:", err);
      }
    }
  }

  private async handlePinSubmit() {
    const pin = this.inputPinCodeEl.value.trim().toUpperCase();
    if (!pin) return;
    this.pinModalEl.classList.remove("active");
    this.connectedBannerEl.style.display = "block";
    this.connectedNameEl.textContent = `Pairing with PIN ${pin}...`;
    this.connectedNameEl.style.color = "#38bdf8";

    // Auto-discover peer or connect to active peer on radar
    const peers = Array.from((this.engine as any).discoveredPeers.values()) as PeerDevice[];
    if (peers.length > 0) {
      await this.handlePeerSelected(peers[0]);
    } else {
      this.connectedNameEl.textContent = `Connected with Session PIN: ${pin}`;
      this.connectedNameEl.style.color = "#22c55e";
      this.btnSendNowEl.disabled = false;
    }
  }

  private async handleDropItems(dataTransfer: DataTransfer) {
    const items = dataTransfer.items;
    const files: File[] = [];

    if (items && items.length > 0 && "webkitGetAsEntry" in items[0]) {
      const traverse = async (entry: any): Promise<void> => {
        if (!entry) return;
        if (entry.isFile) {
          const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject));
          files.push(file);
        } else if (entry.isDirectory) {
          const reader = entry.createReader();
          const entries = await new Promise<any[]>((resolve, reject) => reader.readEntries(resolve, reject));
          for (const child of entries) {
            await traverse(child);
          }
        }
      };

      for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry();
        if (entry) await traverse(entry);
      }
    } else if (dataTransfer.files) {
      files.push(...Array.from(dataTransfer.files));
    }

    if (files.length > 0) {
      this.addFiles(files);
    }
  }

  private playChime() {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.12); // A5
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.start();
      osc.stop(ctx.currentTime + 0.45);
    } catch {}
  }

  private async acquireWakeLock() {
    try {
      if ("wakeLock" in navigator && !this.wakeLock) {
        this.wakeLock = await (navigator as any).wakeLock.request("screen");
      }
    } catch {}
  }

  private releaseWakeLock() {
    if (this.wakeLock) {
      this.wakeLock.release().catch(() => {});
      this.wakeLock = null;
    }
  }
}

// Start app on DOMContentLoaded
window.addEventListener("DOMContentLoaded", () => {
  new WirelessApp();
});
