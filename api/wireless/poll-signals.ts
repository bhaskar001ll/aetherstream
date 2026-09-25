// Vercel Serverless Function: /api/wireless/poll-signals
import type { IncomingMessage, ServerResponse } from "node:http";

interface QueuedSignal {
  type: string;
  signal: any;
  targetId: string;
  fromPeer: any;
  timestamp: number;
}

const globalSignals = (globalThis as any).__aether_signals || new Map<string, QueuedSignal[]>();
(globalThis as any).__aether_signals = globalSignals;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.statusCode = 200;
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url || "", "http://localhost");
  const peerId = parsedUrl.searchParams.get("peerId");
  const queued = (peerId && globalSignals.get(peerId)) || [];
  if (peerId) {
    globalSignals.delete(peerId);
  }

  res.setHeader("Content-Type", "application/json");
  res.statusCode = 200;
  res.end(JSON.stringify(queued));
}
