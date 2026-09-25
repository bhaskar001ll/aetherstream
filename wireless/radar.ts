/**
 * AetherStream Wireless Radar
 * Interactive canvas radar displaying nearby discovered local devices.
 */

import { PeerDevice } from "./protocol";

export interface RadarBlip {
  peer: PeerDevice;
  angle: number; // in radians
  distanceRatio: number; // 0.2 to 0.85
  pulse: number;
}

export class WirelessRadar {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private animId: number | null = null;
  private sweepAngle: number = 0;
  private blips: Map<string, RadarBlip> = new Map();
  private onSelectPeer?: (peer: PeerDevice) => void;

  constructor(canvas: HTMLCanvasElement, onSelect?: (peer: PeerDevice) => void) {
    this.canvas = canvas;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not get 2D canvas context");
    this.ctx = context;
    this.onSelectPeer = onSelect;

    this.setupListeners();
    this.start();
  }

  private setupListeners() {
    this.canvas.addEventListener("click", (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) * (this.canvas.width / rect.width);
      const y = (e.clientY - rect.top) * (this.canvas.height / rect.height);
      const cx = this.canvas.width / 2;
      const cy = this.canvas.height / 2;

      for (const blip of this.blips.values()) {
        const radius = (this.canvas.width / 2) * blip.distanceRatio;
        const bx = cx + Math.cos(blip.angle) * radius;
        const by = cy + Math.sin(blip.angle) * radius;
        const dist = Math.hypot(x - bx, y - by);

        if (dist <= 24) {
          if (this.onSelectPeer) {
            this.onSelectPeer(blip.peer);
          }
          break;
        }
      }
    });
  }

  public updatePeers(peers: PeerDevice[]) {
    const currentIds = new Set(peers.map((p) => p.id));
    // Remove expired
    for (const [id] of this.blips) {
      if (!currentIds.has(id)) {
        this.blips.delete(id);
      }
    }

    // Add or keep existing positions so they don't jump around
    peers.forEach((peer, idx) => {
      if (!this.blips.has(peer.id)) {
        // Distribute nicely
        const total = Math.max(peers.length, 1);
        const baseAngle = (idx / total) * Math.PI * 2 + Math.PI / 4;
        const dist = 0.35 + (idx % 3) * 0.2;
        this.blips.set(peer.id, {
          peer,
          angle: baseAngle,
          distanceRatio: dist,
          pulse: 0,
        });
      } else {
        const existing = this.blips.get(peer.id)!;
        existing.peer = peer;
      }
    });
  }

  public start() {
    if (this.animId !== null) return;
    const loop = () => {
      this.draw();
      this.animId = requestAnimationFrame(loop);
    };
    this.animId = requestAnimationFrame(loop);
  }

  public stop() {
    if (this.animId !== null) {
      cancelAnimationFrame(this.animId);
      this.animId = null;
    }
  }

  private draw() {
    const { width, height } = this.canvas;
    const cx = width / 2;
    const cy = height / 2;
    const maxRadius = Math.min(cx, cy) - 10;
    const ctx = this.ctx;

    ctx.clearRect(0, 0, width, height);

    // Dark grid background
    ctx.fillStyle = "rgba(7, 10, 17, 0.95)";
    ctx.fillRect(0, 0, width, height);

    // Draw concentric rings
    const ringCount = 4;
    for (let i = 1; i <= ringCount; i++) {
      const r = (maxRadius / ringCount) * i;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(56, 189, 248, 0.15)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Draw crosshairs
    ctx.beginPath();
    ctx.moveTo(cx - maxRadius, cy);
    ctx.lineTo(cx + maxRadius, cy);
    ctx.moveTo(cx, cy - maxRadius);
    ctx.lineTo(cx, cy + maxRadius);
    ctx.strokeStyle = "rgba(56, 189, 248, 0.15)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Center pulse dot (My device)
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.fillStyle = "#38bdf8";
    ctx.shadowColor = "#38bdf8";
    ctx.shadowBlur = 12;
    ctx.fill();
    ctx.shadowBlur = 0;

    // Sweep line
    this.sweepAngle = (this.sweepAngle + 0.025) % (Math.PI * 2);
    const sweepGradient = ctx.createConicGradient(
      this.sweepAngle,
      cx,
      cy
    );
    sweepGradient.addColorStop(0, "rgba(56, 189, 248, 0.25)");
    sweepGradient.addColorStop(0.1, "rgba(56, 189, 248, 0.05)");
    sweepGradient.addColorStop(0.2, "rgba(56, 189, 248, 0)");
    sweepGradient.addColorStop(1, "rgba(56, 189, 248, 0)");

    ctx.beginPath();
    ctx.arc(cx, cy, maxRadius, 0, Math.PI * 2);
    ctx.fillStyle = sweepGradient;
    ctx.fill();

    // Draw Blips for peers
    for (const blip of this.blips.values()) {
      const radius = maxRadius * blip.distanceRatio;
      const bx = cx + Math.cos(blip.angle) * radius;
      const by = cy + Math.sin(blip.angle) * radius;

      // Calculate sweep proximity for flash pulse
      const angleDiff = Math.abs((this.sweepAngle - blip.angle + Math.PI * 2) % (Math.PI * 2));
      if (angleDiff < 0.15) {
        blip.pulse = 1.0;
      } else {
        blip.pulse = Math.max(0, blip.pulse - 0.02);
      }

      // Outer ripple
      if (blip.pulse > 0) {
        ctx.beginPath();
        ctx.arc(bx, by, 12 + (1 - blip.pulse) * 16, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(34, 197, 94, ${blip.pulse * 0.6})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Inner glowing dot
      ctx.beginPath();
      ctx.arc(bx, by, 8, 0, Math.PI * 2);
      ctx.fillStyle = "#22c55e";
      ctx.shadowColor = "#22c55e";
      ctx.shadowBlur = 10;
      ctx.fill();
      ctx.shadowBlur = 0;

      // Peer label
      ctx.font = "11px Inter, sans-serif";
      ctx.fillStyle = "#f8fafc";
      ctx.textAlign = "center";
      const icon = blip.peer.os === "android" ? "📱 " : blip.peer.os === "ios" ? "📱 " : "💻 ";
      ctx.fillText(icon + blip.peer.name, bx, by + 20);
    }
  }
}
