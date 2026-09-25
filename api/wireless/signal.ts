// Vercel Serverless Function: /api/wireless/signal
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
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
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
        const item: QueuedSignal = JSON.parse(body);
        if (item && item.targetId) {
          if (!globalSignals.has(item.targetId)) {
            globalSignals.set(item.targetId, []);
          }
          item.timestamp = Date.now();
          globalSignals.get(item.targetId)!.push(item);
        }
      } catch {}

      res.setHeader("Content-Type", "application/json");
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  res.statusCode = 405;
  res.end();
}
