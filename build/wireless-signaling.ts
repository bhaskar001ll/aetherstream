import { Plugin } from "vite";

interface PeerData {
  id: string;
  name: string;
  os: string;
  browser: string;
  lastSeen: number;
}

interface QueuedSignal {
  type: string;
  signal: any;
  targetId: string;
  fromPeer: PeerData;
  timestamp: number;
}

export function wirelessSignaling(): Plugin {
  const peers = new Map<string, PeerData>();
  const signals = new Map<string, QueuedSignal[]>();

  return {
    name: "wireless-signaling-plugin",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || "";

        // 1. Peer Registration & List
        if (url === "/api/wireless/peers" && req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", () => {
            try {
              const peer: PeerData = JSON.parse(body);
              if (peer && peer.id) {
                peer.lastSeen = Date.now();
                peers.set(peer.id, peer);
              }
            } catch {}

            // Prune peers inactive for > 25 seconds
            const now = Date.now();
            const active: PeerData[] = [];
            for (const [id, p] of peers) {
              if (now - p.lastSeen < 25000) {
                active.push(p);
              } else {
                peers.delete(id);
              }
            }

            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(active));
          });
          return;
        }

        // 2. Signal Routing (Offer / Answer / ICE)
        if (url === "/api/wireless/signal" && req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", () => {
            try {
              const item: QueuedSignal = JSON.parse(body);
              if (item && item.targetId) {
                if (!signals.has(item.targetId)) {
                  signals.set(item.targetId, []);
                }
                item.timestamp = Date.now();
                signals.get(item.targetId)!.push(item);
              }
            } catch {}
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
          });
          return;
        }

        // 3. Poll Signals
        if (url.startsWith("/api/wireless/poll-signals") && req.method === "GET") {
          const parsedUrl = new URL(url, "http://localhost");
          const peerId = parsedUrl.searchParams.get("peerId");
          const queued = (peerId && signals.get(peerId)) || [];
          if (peerId) {
            signals.delete(peerId);
          }
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(queued));
          return;
        }

        next();
      });
    },
  };
}
