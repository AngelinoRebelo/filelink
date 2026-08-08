const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");
const QRCode = require("qrcode");

const PORT = process.env.PORT || 3000;
const ROOM_TTL_MS = 2 * 60 * 60 * 1000; // 2h
const RECONNECT_GRACE_MS = 45000; // keep peer during brief mobile WS drops
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const app = express();
app.set("trust proxy", 1);
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

/** @type {Map<string, { code: string, createdAt: number, peers: Map<string, any> }>} */
const rooms = new Map();

app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

app.get("/api/qr", async (req, res) => {
  const data = String(req.query.data || "");
  if (!/^https?:\/\//i.test(data) || data.length > 2048) {
    return res.status(400).json({ error: "URL inválida para QR" });
  }

  try {
    res.type("image/png");
    await QRCode.toFileStream(res, data, {
      type: "png",
      width: 280,
      margin: 1,
      errorCorrectionLevel: "M",
      color: {
        dark: "#0b1f1a",
        light: "#e8f3ee",
      },
    });
  } catch {
    if (!res.headersSent) {
      res.status(500).json({ error: "Falha ao gerar QR" });
    }
  }
});

function generateRoomCode() {
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return code;
}

function createRoom() {
  let code = generateRoomCode();
  while (rooms.has(code)) code = generateRoomCode();
  const room = {
    code,
    createdAt: Date.now(),
    peers: new Map(),
  };
  rooms.set(code, room);
  return room;
}

function getRoom(code) {
  if (!code) return null;
  return rooms.get(String(code).toUpperCase()) || null;
}

function sanitizeDeviceName(name) {
  const cleaned = String(name || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return cleaned || "Aparelho";
}

function isSocketOpen(ws) {
  return Boolean(ws && ws.readyState === ws.OPEN);
}

function peerList(room, excludeId = null) {
  return [...room.peers.entries()]
    .filter(([id]) => id !== excludeId)
    .map(([id, peer]) => ({
      id,
      name: peer.deviceName || "Aparelho",
      online: isSocketOpen(peer.ws),
    }));
}

function send(ws, type, payload = {}) {
  if (isSocketOpen(ws)) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

function broadcast(room, type, payload = {}, excludeId = null) {
  for (const [id, peer] of room.peers) {
    if (id === excludeId) continue;
    send(peer.ws, type, payload);
  }
}

function getPeerSocket(room, peerId) {
  const peer = room.peers.get(peerId);
  if (!peer || !isSocketOpen(peer.ws)) return null;
  return peer.ws;
}

function clearPeerTimer(peer) {
  if (peer?.removeTimer) {
    clearTimeout(peer.removeTimer);
    peer.removeTimer = null;
  }
}

function hardRemovePeer(room, peerId) {
  const peer = room.peers.get(peerId);
  if (!peer) return;
  clearPeerTimer(peer);
  room.peers.delete(peerId);
  broadcast(room, "peer-left", { peerId });

  if (room.peers.size === 0) {
    rooms.delete(room.code);
  } else {
    broadcast(room, "peers", { peers: peerList(room) });
  }
}

function attachPeer(room, peerId, ws, deviceName) {
  const existing = room.peers.get(peerId);
  clearPeerTimer(existing);

  const peer = existing || {
    id: peerId,
    deviceName: deviceName || "Aparelho",
    ws: null,
    disconnectedAt: null,
    removeTimer: null,
  };

  peer.ws = ws;
  peer.deviceName = deviceName || peer.deviceName || "Aparelho";
  peer.disconnectedAt = null;
  room.peers.set(peerId, peer);

  ws.roomCode = room.code;
  ws.peerId = peerId;
  ws.deviceName = peer.deviceName;
  return peer;
}

function softDisconnect(ws) {
  const { roomCode, peerId } = ws;
  if (!roomCode || !peerId) return;

  const room = getRoom(roomCode);
  if (!room) return;

  const peer = room.peers.get(peerId);
  if (!peer || peer.ws !== ws) return;

  peer.ws = null;
  peer.disconnectedAt = Date.now();
  clearPeerTimer(peer);
  peer.removeTimer = setTimeout(() => {
    const current = room.peers.get(peerId);
    if (!current || isSocketOpen(current.ws)) return;
    hardRemovePeer(room, peerId);
  }, RECONNECT_GRACE_MS);

  broadcast(room, "peer-away", { peerId }, peerId);
  broadcast(room, "peers", { peers: peerList(room) });

  ws.roomCode = null;
  ws.peerId = null;
  ws.deviceName = null;
}

function leaveRoomImmediate(ws) {
  const { roomCode, peerId } = ws;
  if (!roomCode || !peerId) return;
  const room = getRoom(roomCode);
  if (!room) return;
  hardRemovePeer(room, peerId);
  ws.roomCode = null;
  ws.peerId = null;
  ws.deviceName = null;
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.roomCode = null;
  ws.peerId = null;
  ws.deviceName = null;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return send(ws, "error", { message: "Mensagem inválida" });
    }

    const { type } = msg;

    if (type === "leave-room") {
      leaveRoomImmediate(ws);
      return send(ws, "left");
    }

    if (type === "create-room") {
      leaveRoomImmediate(ws);
      const room = createRoom();
      const peerId = crypto.randomUUID();
      const deviceName = sanitizeDeviceName(msg.name);
      attachPeer(room, peerId, ws, deviceName);
      return send(ws, "room-created", {
        code: room.code,
        peerId,
        name: deviceName,
        peers: [],
      });
    }

    if (type === "join-room") {
      const room = getRoom(msg.code);
      if (!room) {
        return send(ws, "error", { message: "Rede não encontrada. Confira o código." });
      }

      const onlineCount = [...room.peers.values()].filter((peer) => isSocketOpen(peer.ws)).length;
      if (onlineCount >= 8 && !room.peers.has(msg.peerId)) {
        return send(ws, "error", { message: "Esta rede já está cheia (máx. 8 aparelhos)." });
      }

      leaveRoomImmediate(ws);
      const peerId = crypto.randomUUID();
      const deviceName = sanitizeDeviceName(msg.name);
      attachPeer(room, peerId, ws, deviceName);

      send(ws, "room-joined", {
        code: room.code,
        peerId,
        name: deviceName,
        peers: peerList(room, peerId),
      });
      broadcast(room, "peer-joined", { peerId, name: deviceName }, peerId);
      broadcast(room, "peers", { peers: peerList(room) });
      return;
    }

    if (type === "rejoin-room") {
      const room = getRoom(msg.code);
      if (!room) {
        return send(ws, "error", { message: "Rede não encontrada. Confira o código." });
      }

      const peerId = String(msg.peerId || "");
      const existing = room.peers.get(peerId);
      if (!existing) {
        return send(ws, "error", {
          message: "Sessão expirada. Entre novamente com o código ou QR.",
        });
      }

      if (ws.roomCode && ws.peerId && ws.peerId !== peerId) {
        leaveRoomImmediate(ws);
      }

      const deviceName = sanitizeDeviceName(msg.name || existing.deviceName);
      const wasAway = !isSocketOpen(existing.ws);
      attachPeer(room, peerId, ws, deviceName);

      send(ws, "room-rejoined", {
        code: room.code,
        peerId,
        name: deviceName,
        peers: peerList(room, peerId),
      });

      if (wasAway) {
        broadcast(room, "peer-back", { peerId, name: deviceName }, peerId);
      }
      broadcast(room, "peers", { peers: peerList(room) });
      return;
    }

    if (type === "signal") {
      const room = getRoom(ws.roomCode);
      if (!room || !ws.peerId) {
        return send(ws, "error", { message: "Entre em uma rede antes de conectar." });
      }
      const target = getPeerSocket(room, msg.to);
      if (!target) {
        return send(ws, "error", { message: "Dispositivo destino offline." });
      }
      return send(target, "signal", {
        from: ws.peerId,
        data: msg.data,
      });
    }

    if (type === "relay") {
      const room = getRoom(ws.roomCode);
      if (!room || !ws.peerId) {
        return send(ws, "error", { message: "Entre em uma rede antes de enviar." });
      }
      const target = getPeerSocket(room, msg.to);
      if (!target) {
        return send(ws, "error", { message: "Dispositivo destino offline." });
      }

      const payload = msg.data;
      if (!payload || typeof payload !== "object") {
        return send(ws, "error", { message: "Pacote de relay inválido." });
      }
      if (payload.kind === "bin" && typeof payload.b64 === "string" && payload.b64.length > 120000) {
        return send(ws, "error", { message: "Bloco de arquivo grande demais." });
      }

      return send(target, "relay", {
        from: ws.peerId,
        data: payload,
      });
    }

    if (type === "ping") {
      ws.isAlive = true;
      return send(ws, "pong");
    }
  });

  ws.on("close", () => softDisconnect(ws));
  ws.on("error", () => softDisconnect(ws));
});

const heartbeat = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > ROOM_TTL_MS) {
      for (const peer of room.peers.values()) {
        clearPeerTimer(peer);
        send(peer.ws, "error", { message: "Rede expirada." });
        peer.ws?.close();
      }
      rooms.delete(code);
    }
  }

  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`FileLink online em http://0.0.0.0:${PORT}`);
});
