const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ROOM_TTL_MS = 2 * 60 * 60 * 1000; // 2h
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

/** @type {Map<string, { code: string, createdAt: number, peers: Map<string, import('ws').WebSocket> }>} */
const rooms = new Map();

app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
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

function peerList(room, excludeId = null) {
  return [...room.peers.keys()].filter((id) => id !== excludeId);
}

function send(ws, type, payload = {}) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

function broadcast(room, type, payload = {}, excludeId = null) {
  for (const [id, peer] of room.peers) {
    if (id !== excludeId) send(peer, type, payload);
  }
}

function leaveRoom(ws) {
  const { roomCode, peerId } = ws;
  if (!roomCode || !peerId) return;
  const room = getRoom(roomCode);
  if (!room) return;

  room.peers.delete(peerId);
  broadcast(room, "peer-left", { peerId });

  if (room.peers.size === 0) {
    rooms.delete(room.code);
  } else {
    broadcast(room, "peers", { peers: peerList(room) });
  }

  ws.roomCode = null;
  ws.peerId = null;
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.roomCode = null;
  ws.peerId = null;

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

    if (type === "create-room") {
      leaveRoom(ws);
      const room = createRoom();
      const peerId = crypto.randomUUID();
      ws.roomCode = room.code;
      ws.peerId = peerId;
      room.peers.set(peerId, ws);
      return send(ws, "room-created", {
        code: room.code,
        peerId,
        peers: [],
      });
    }

    if (type === "join-room") {
      const room = getRoom(msg.code);
      if (!room) {
        return send(ws, "error", { message: "Rede não encontrada. Confira o código." });
      }
      if (room.peers.size >= 8) {
        return send(ws, "error", { message: "Esta rede já está cheia (máx. 8 aparelhos)." });
      }

      leaveRoom(ws);
      const peerId = crypto.randomUUID();
      ws.roomCode = room.code;
      ws.peerId = peerId;
      room.peers.set(peerId, ws);

      send(ws, "room-joined", {
        code: room.code,
        peerId,
        peers: peerList(room, peerId),
      });
      broadcast(room, "peer-joined", { peerId }, peerId);
      broadcast(room, "peers", { peers: peerList(room) });
      return;
    }

    if (type === "signal") {
      const room = getRoom(ws.roomCode);
      if (!room || !ws.peerId) {
        return send(ws, "error", { message: "Entre em uma rede antes de conectar." });
      }
      const target = room.peers.get(msg.to);
      if (!target) {
        return send(ws, "error", { message: "Dispositivo destino offline." });
      }
      return send(target, "signal", {
        from: ws.peerId,
        data: msg.data,
      });
    }

    if (type === "ping") {
      return send(ws, "pong");
    }
  });

  ws.on("close", () => leaveRoom(ws));
  ws.on("error", () => leaveRoom(ws));
});

const heartbeat = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > ROOM_TTL_MS) {
      for (const peer of room.peers.values()) {
        send(peer, "error", { message: "Rede expirada." });
        peer.close();
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
}, 30000);

wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`FileLink online em http://0.0.0.0:${PORT}`);
});
