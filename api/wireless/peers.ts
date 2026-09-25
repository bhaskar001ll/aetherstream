// Vercel Serverless Function: /api/wireless/peers
import type { IncomingMessage, ServerResponse } from "node:http";

interface PeerData {
  id: string;
  name: string;
  os: string;
  browser: string;
  lastSeen: number;
}

// In-memory store (shared across warm lambdas)
const globalStore = (globalThis as any).__aether_peers || new Map<string, PeerData>();
(globalThis as any).__aether_peers = globalStore;

export default async function handler(req: IncomingMessage & { body?: any }, res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.statusCode = 200;
    res.end();
    return;
  }

  if (req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const peer: PeerData = JSON.parse(body);
        if (peer && peer.id) {
          peer.lastSeen = Date.now();
          globalStore.set(peer.id, peer);
        }
      } catch {}

      // Clean inactive peers (> 25s)
      const now = Date.now();
      const active: PeerData[] = [];
      for (const [id, p] of globalStore) {
        if (now - p.lastSeen < 25000) {
          active.push(p);
        } else {
          globalStore.delete(id);
        }
      }

      res.setHeader("Content-Type", "application/json");
      res.statusCode = 200;
      res.end(JSON.stringify(active));
    });
    return;
  }

  // GET: list active peers
  const now = Date.now();
  const active: PeerData[] = [];
  for (const [id, p] of globalStore) {
    if (now - p.lastSeen < 25000) {
      active.push(p);
    } else {
      globalStore.delete(id);
    }
  }

  res.setHeader("Content-Type", "application/json");
  res.statusCode = 200;
  res.end(JSON.stringify(active));
}
