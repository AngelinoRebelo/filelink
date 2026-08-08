const CHUNK_SIZE = 64 * 1024;
const RELAY_CHUNK_SIZE = 12 * 1024;
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

const el = {
  status: document.getElementById("connectionStatus"),
  lobby: document.getElementById("lobby"),
  room: document.getElementById("room"),
  createBtn: document.getElementById("createBtn"),
  joinToggleBtn: document.getElementById("joinToggleBtn"),
  scanQrBtn: document.getElementById("scanQrBtn"),
  joinForm: document.getElementById("joinForm"),
  codeInput: document.getElementById("codeInput"),
  deviceNameInput: document.getElementById("deviceNameInput"),
  roomCode: document.getElementById("roomCode"),
  roomQr: document.getElementById("roomQr"),
  copyBtn: document.getElementById("copyBtn"),
  shareBtn: document.getElementById("shareBtn"),
  leaveBtn: document.getElementById("leaveBtn"),
  peers: document.getElementById("peers"),
  dropzone: document.getElementById("dropzone"),
  dropzoneTitle: document.getElementById("dropzoneTitle"),
  dropzoneHint: document.getElementById("dropzoneHint"),
  fileInput: document.getElementById("fileInput"),
  fileQueue: document.getElementById("fileQueue"),
  targetSelect: document.getElementById("targetSelect"),
  sendBtn: document.getElementById("sendBtn"),
  transfers: document.getElementById("transfers"),
  toast: document.getElementById("toast"),
  keepAwakeBanner: document.getElementById("keepAwakeBanner"),
  scanModal: document.getElementById("scanModal"),
  scanVideo: document.getElementById("scanVideo"),
  scanCanvas: document.getElementById("scanCanvas"),
  scanStatus: document.getElementById("scanStatus"),
  closeScanBtn: document.getElementById("closeScanBtn"),
  switchCameraBtn: document.getElementById("switchCameraBtn"),
};

const DEVICE_NAME_KEY = "filelink-device-name";

const state = {
  ws: null,
  peerId: null,
  deviceName: "",
  roomCode: null,
  peers: [],
  selectedFiles: [],
  connections: new Map(),
  incoming: new Map(),
  batches: new Map(),
  intentionalClose: false,
  reconnectTimer: 0,
  transferActive: 0,
  wakeLock: null,
  noSleepVideo: null,
  noSleepDraw: null,
  noSleepRaf: 0,
  keepAwakeHintShown: false,
  scan: {
    stream: null,
    timer: 0,
    detector: null,
    running: false,
    useFront: false,
    busy: false,
  },
};

let toastTimer = null;

function showToast(message) {
  el.toast.textContent = message;
  el.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add("hidden"), 2800);
}

function setStatus(text) {
  el.status.textContent = text;
}

function sanitizeDeviceName(name) {
  return String(name || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}

function initials(name) {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function peerName(peerId) {
  if (peerId === state.peerId) return state.deviceName || "Você";
  const peer = state.peers.find((item) => item.id === peerId);
  return peer?.name || "Aparelho";
}

function normalizePeers(peers) {
  if (!Array.isArray(peers)) return [];
  return peers
    .map((peer) => {
      if (typeof peer === "string") return { id: peer, name: "Aparelho" };
      return {
        id: peer.id,
        name: sanitizeDeviceName(peer.name) || "Aparelho",
      };
    })
    .filter((peer) => peer.id && peer.id !== state.peerId);
}

function guessFromUserAgent() {
  const ua = navigator.userAgent || "";
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) {
    const model = ua.match(/Android[^;]*;\s*([^)]+)\)/i)?.[1]?.trim();
    if (model && !/wv|Build|Linux/i.test(model)) {
      return model.replace(/\/.*$/, "").trim().slice(0, 40) || "Android";
    }
    return "Android";
  }
  if (/Macintosh|Mac OS X/i.test(ua)) return "Mac";
  if (/Windows NT/i.test(ua)) return "Windows";
  if (/CrOS/i.test(ua)) return "Chromebook";
  if (/Linux/i.test(ua)) return "Linux";
  return "Aparelho";
}

async function detectDeviceName() {
  const saved = sanitizeDeviceName(localStorage.getItem(DEVICE_NAME_KEY) || "");
  if (saved) return saved;

  try {
    if (navigator.userAgentData?.getHighEntropyValues) {
      const info = await navigator.userAgentData.getHighEntropyValues([
        "model",
        "platform",
        "fullVersionList",
      ]);
      const model = sanitizeDeviceName(info.model || "");
      if (model) return model;
      const platform = sanitizeDeviceName(info.platform || "");
      if (platform) return platform;
    }
  } catch {
    // ignore and fall back to UA parsing
  }

  return guessFromUserAgent();
}

function currentDeviceName() {
  const typed = sanitizeDeviceName(el.deviceNameInput?.value || "");
  return typed || state.deviceName || "Aparelho";
}

function persistDeviceName(name) {
  const cleaned = sanitizeDeviceName(name) || "Aparelho";
  state.deviceName = cleaned;
  if (el.deviceNameInput) el.deviceNameInput.value = cleaned;
  localStorage.setItem(DEVICE_NAME_KEY, cleaned);
  return cleaned;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "—";
  if (bytesPerSecond < 1024) return `${Math.round(bytesPerSecond)} B/s`;
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
}

function createSpeedMeter() {
  const startedAt = performance.now();
  let lastAt = startedAt;
  let lastBytes = 0;
  let instant = 0;

  return {
    update(bytes) {
      const now = performance.now();
      const deltaBytes = Math.max(0, bytes - lastBytes);
      const deltaTime = Math.max(0.001, (now - lastAt) / 1000);
      const sample = deltaBytes / deltaTime;
      instant = instant > 0 ? instant * 0.7 + sample * 0.3 : sample;
      lastAt = now;
      lastBytes = bytes;
      const elapsed = Math.max(0.001, (now - startedAt) / 1000);
      return {
        instant,
        average: bytes / elapsed,
      };
    },
    finish(bytes) {
      const elapsed = Math.max(0.001, (performance.now() - startedAt) / 1000);
      return bytes / elapsed;
    },
  };
}

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

function ensureNoSleepVideo() {
  if (state.noSleepVideo) return state.noSleepVideo;

  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  const ctx = canvas.getContext("2d");
  const draw = () => {
    if (!ctx) return;
    ctx.fillStyle = state.transferActive > 0 ? "#010101" : "#000";
    ctx.fillRect(0, 0, 2, 2);
    if (state.transferActive > 0) {
      state.noSleepRaf = requestAnimationFrame(draw);
    }
  };

  const video = document.createElement("video");
  video.setAttribute("playsinline", "true");
  video.setAttribute("webkit-playsinline", "true");
  video.setAttribute("muted", "true");
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.style.cssText =
    "position:fixed;width:1px;height:1px;left:-10px;top:-10px;opacity:0;pointer-events:none;";

  if (canvas.captureStream) {
    video.srcObject = canvas.captureStream(4);
  }

  document.body.appendChild(video);
  state.noSleepVideo = video;
  state.noSleepDraw = draw;
  return video;
}

async function acquireKeepAwake() {
  el.keepAwakeBanner?.classList.remove("hidden");

  try {
    if (navigator.wakeLock?.request && document.visibilityState === "visible") {
      state.wakeLock = await navigator.wakeLock.request("screen");
      state.wakeLock.addEventListener("release", () => {
        if (state.transferActive > 0 && document.visibilityState === "visible") {
          acquireKeepAwake();
        }
      });
    }
  } catch {
    // continue with video fallback
  }

  try {
    const video = ensureNoSleepVideo();
    state.noSleepDraw?.();
    await video.play();
  } catch {
    // autoplay may require gesture; send/receive actions usually unlock it
  }

  if (!state.keepAwakeHintShown) {
    state.keepAwakeHintShown = true;
    showToast("Tela mantida ligada durante o envio");
  }
}

function releaseKeepAwake() {
  el.keepAwakeBanner?.classList.add("hidden");
  try {
    state.wakeLock?.release?.();
  } catch {}
  state.wakeLock = null;
  if (state.noSleepRaf) {
    cancelAnimationFrame(state.noSleepRaf);
    state.noSleepRaf = 0;
  }
  try {
    state.noSleepVideo?.pause?.();
  } catch {}
}

async function beginTransferKeepAwake() {
  state.transferActive += 1;
  if (state.transferActive === 1) await acquireKeepAwake();
}

function endTransferKeepAwake() {
  state.transferActive = Math.max(0, state.transferActive - 1);
  if (state.transferActive === 0) releaseKeepAwake();
}

function markTransfersInterrupted(reason) {
  for (const item of el.transfers?.querySelectorAll(".transfer") || []) {
    const bar = item.querySelector(".bar > span");
    const meta = item.querySelector(".transfer-meta");
    if (!meta) continue;
    if (meta.textContent.includes("Enviado") || meta.textContent.includes("Recebido")) continue;
    if (meta.textContent.includes("interromp")) continue;
    meta.textContent = `${meta.textContent.split(" · ")[0]} · ${reason}`;
    if (bar && bar.style.width !== "100%") bar.style.width = bar.style.width || "0%";
  }
}

function connectSocket() {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = 0;
  }

  const ws = new WebSocket(wsUrl());
  state.ws = ws;
  setStatus("Conectando…");

  ws.addEventListener("open", () => {
    setStatus("Online");
    if (state.roomCode) {
      send("join-room", {
        code: state.roomCode,
        name: currentDeviceName(),
      });
      return;
    }
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    if (code) {
      el.codeInput.value = code.toUpperCase();
      el.joinForm.classList.remove("hidden");
      joinRoom(code);
    }
  });

  ws.addEventListener("close", () => {
    if (state.intentionalClose) {
      state.intentionalClose = false;
      return;
    }
    setStatus("Reconectando…");
    cleanupConnections();
    if (state.transferActive > 0) {
      markTransfersInterrupted("interrompido (tela/app em segundo plano)");
      showToast("Transferência pausada — mantenha a tela ligada");
    }
    state.reconnectTimer = setTimeout(connectSocket, document.visibilityState === "hidden" ? 2500 : 1000);
  });

  ws.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handleSignalMessage(msg);
  });
}

function send(type, payload = {}) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type, ...payload }));
  }
}

function roomJoinUrl(code) {
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("code", code);
  return url.toString();
}

function renderRoomQr(code) {
  if (!el.roomQr || !code) return;
  const joinUrl = roomJoinUrl(code);
  el.roomQr.src = `/api/qr?data=${encodeURIComponent(joinUrl)}`;
  el.roomQr.alt = `QR code para entrar na rede ${code}`;
}

function enterRoom(code, peerId, peers, name) {
  state.roomCode = code;
  state.peerId = peerId;
  if (name) persistDeviceName(name);
  state.peers = normalizePeers(peers);
  el.roomCode.textContent = code;
  el.lobby.classList.add("hidden");
  el.room.classList.remove("hidden");
  const url = new URL(location.href);
  url.searchParams.set("code", code);
  history.replaceState({}, "", url);
  renderRoomQr(code);
  renderPeers();
  updateTargetSelect();
}

function leaveRoomUI() {
  cleanupConnections();
  state.roomCode = null;
  state.peerId = null;
  state.peers = [];
  state.selectedFiles = [];
  state.batches.clear();
  el.fileInput.value = "";
  renderFileQueue();
  if (el.roomQr) {
    el.roomQr.removeAttribute("src");
    el.roomQr.alt = "QR code da rede";
  }
  el.lobby.classList.remove("hidden");
  el.room.classList.add("hidden");
  const url = new URL(location.href);
  url.searchParams.delete("code");
  history.replaceState({}, "", url);
}

function handleSignalMessage(msg) {
  switch (msg.type) {
    case "room-created":
    case "room-joined":
      enterRoom(msg.code, msg.peerId, msg.peers, msg.name);
      showToast(msg.type === "room-created" ? "Rede criada" : "Você entrou na rede");
      break;
    case "peers":
      state.peers = normalizePeers(msg.peers);
      renderPeers();
      updateTargetSelect();
      break;
    case "peer-joined": {
      const name = sanitizeDeviceName(msg.name) || "Aparelho";
      if (!state.peers.some((peer) => peer.id === msg.peerId)) {
        state.peers.push({ id: msg.peerId, name });
      }
      renderPeers();
      updateTargetSelect();
      showToast(`${name} entrou`);
      break;
    }
    case "peer-left": {
      const leftName = peerName(msg.peerId);
      state.peers = state.peers.filter((peer) => peer.id !== msg.peerId);
      closePeer(msg.peerId);
      renderPeers();
      updateTargetSelect();
      showToast(`${leftName} saiu`);
      break;
    }
    case "signal":
      handlePeerSignal(msg.from, msg.data);
      break;
    case "relay":
      handleRelayMessage(msg.from, msg.data);
      break;
    case "error":
      showToast(msg.message || "Erro");
      break;
    default:
      break;
  }
}

function renderPeers() {
  const nodes = [];
  nodes.push(peerCard({ id: state.peerId, name: state.deviceName }, true));
  for (const peer of state.peers) nodes.push(peerCard(peer, false));
  if (state.peers.length === 0) {
    nodes.push(`<div class="peer empty">Aguardando outro aparelho…</div>`);
  }
  el.peers.innerHTML = nodes.join("");
}

function peerCard(peer, isYou) {
  const name = peer?.name || "Aparelho";
  return `
    <div class="peer ${isYou ? "you" : ""}">
      <div class="peer-avatar">${initials(name)}</div>
      <strong>${isYou ? "Você" : escapeHtml(name)}</strong>
      <span>${isYou ? escapeHtml(name) : "conectado"}</span>
    </div>
  `;
}

function updateTargetSelect() {
  const previous = el.targetSelect.value;
  el.targetSelect.innerHTML = "";
  if (state.peers.length === 0) {
    el.targetSelect.innerHTML = `<option value="">Aguardando aparelhos…</option>`;
    el.targetSelect.disabled = true;
    el.sendBtn.disabled = true;
    return;
  }
  for (const peer of state.peers) {
    const opt = document.createElement("option");
    opt.value = peer.id;
    opt.textContent = peer.name;
    el.targetSelect.appendChild(opt);
  }
  if (previous && state.peers.some((peer) => peer.id === previous)) {
    el.targetSelect.value = previous;
  }
  el.targetSelect.disabled = false;
  el.sendBtn.disabled = state.selectedFiles.length === 0;
}

function cleanupConnections() {
  for (const id of [...state.connections.keys()]) closePeer(id);
  state.incoming.clear();
}

function closePeer(peerId) {
  const conn = state.connections.get(peerId);
  if (!conn) return;
  try {
    conn.channel?.close();
  } catch {}
  try {
    conn.pc?.close();
  } catch {}
  state.connections.delete(peerId);
}

async function ensureConnection(peerId, initiator) {
  let conn = state.connections.get(peerId);
  if (conn?.channel && conn.channel.readyState === "open") return conn;

  if (conn) closePeer(peerId);

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  conn = { pc, channel: null, mode: "webrtc" };
  state.connections.set(peerId, conn);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      send("signal", { to: peerId, data: { type: "candidate", candidate: event.candidate } });
    }
  };

  if (initiator) {
    const channel = pc.createDataChannel("filelink", { ordered: true });
    wireChannel(peerId, channel);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send("signal", { to: peerId, data: { type: "offer", sdp: pc.localDescription } });
  } else {
    pc.ondatachannel = (event) => wireChannel(peerId, event.channel);
  }

  return conn;
}

function wireChannel(peerId, channel) {
  const conn = state.connections.get(peerId);
  if (!conn) return;
  conn.channel = channel;
  channel.binaryType = "arraybuffer";

  channel.onmessage = (event) => onChannelMessage(peerId, event.data);
}

async function handlePeerSignal(from, data) {
  let conn = state.connections.get(from);
  if (!conn) {
    conn = await ensureConnection(from, false);
  }
  const { pc } = conn;

  if (data.type === "offer") {
    await pc.setRemoteDescription(data.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send("signal", { to: from, data: { type: "answer", sdp: pc.localDescription } });
    return;
  }

  if (data.type === "answer") {
    await pc.setRemoteDescription(data.sdp);
    return;
  }

  if (data.type === "candidate" && data.candidate) {
    try {
      await pc.addIceCandidate(data.candidate);
    } catch {
      // ignore late candidates
    }
  }
}

function waitForOpen(channel, pc, timeoutMs = 8000) {
  if (channel?.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const fail = (reason) => {
      cleanup();
      reject(new Error(reason));
    };
    const timer = setTimeout(() => fail("Canal demorou para abrir"), timeoutMs);
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onClose = () => fail("Canal fechou antes de abrir");
    const onState = () => {
      if (pc && ["failed", "closed", "disconnected"].includes(pc.connectionState)) {
        fail("Conexão P2P indisponível");
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      channel?.removeEventListener("open", onOpen);
      channel?.removeEventListener("close", onClose);
      pc?.removeEventListener("connectionstatechange", onState);
    };

    if (!channel) {
      fail("Canal indisponível");
      return;
    }

    channel.addEventListener("open", onOpen);
    channel.addEventListener("close", onClose);
    pc?.addEventListener("connectionstatechange", onState);
  });
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function handleRelayMessage(from, data) {
  if (!data || typeof data !== "object") return;
  if (data.kind === "text" && typeof data.text === "string") {
    onChannelMessage(from, data.text);
    return;
  }
  if (data.kind === "bin" && typeof data.b64 === "string") {
    onChannelMessage(from, base64ToArrayBuffer(data.b64));
  }
}

function relaySend(peerId, payload) {
  if (typeof payload === "string") {
    send("relay", { to: peerId, data: { kind: "text", text: payload } });
    return;
  }
  send("relay", {
    to: peerId,
    data: { kind: "bin", b64: arrayBufferToBase64(payload) },
  });
}

async function openTransport(peerId) {
  try {
    const conn = await ensureConnection(peerId, true);
    await waitForOpen(conn.channel, conn.pc, 8000);
    return {
      mode: "p2p",
      async send(payload) {
        while (conn.channel.bufferedAmount > 8 * 1024 * 1024) {
          await new Promise((r) => setTimeout(r, 20));
        }
        conn.channel.send(payload);
      },
    };
  } catch {
    closePeer(peerId);
    showToast("Usando rede FileLink (sem Wi‑Fi compartilhado)");
    return {
      mode: "relay",
      async send(payload) {
        relaySend(peerId, payload);
        await new Promise((r) => setTimeout(r, 8));
      },
    };
  }
}

function createTransferItem({ id, name, size, direction }) {
  const li = document.createElement("li");
  li.className = "transfer";
  li.dataset.id = id;
  li.innerHTML = `
    <div class="transfer-top">
      <strong>${escapeHtml(name)}</strong>
      <span class="transfer-meta">${direction} · ${formatBytes(size)}</span>
    </div>
    <div class="bar"><span style="width:0%"></span></div>
  `;
  el.transfers.prepend(li);
  return li;
}

function updateTransferProgress(id, ratio, meta) {
  const item = el.transfers.querySelector(`[data-id="${id}"]`);
  if (!item) return;
  item.querySelector(".bar > span").style.width = `${Math.min(100, Math.round(ratio * 100))}%`;
  if (meta) item.querySelector(".transfer-meta").textContent = meta;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function sendFilesTo(peerId, files) {
  await beginTransferKeepAwake();
  try {
    const transport = await openTransport(peerId);
    const targetName = peerName(peerId);
    const chunkSize = transport.mode === "relay" ? RELAY_CHUNK_SIZE : CHUNK_SIZE;
    const via = transport.mode === "relay" ? "rede FileLink" : "P2P";
    const list = [...files];
    const batchId = list.length > 1 ? crypto.randomUUID() : null;

    if (batchId) {
      await transport.send(
        JSON.stringify({
          kind: "batch-start",
          batchId,
          count: list.length,
        })
      );
    }

    for (const file of list) {
      const transferId = crypto.randomUUID();
      createTransferItem({
        id: transferId,
        name: file.name,
        size: file.size,
        direction: `Enviando → ${targetName}`,
      });

      await transport.send(
        JSON.stringify({
          kind: "meta",
          transferId,
          batchId,
          name: file.name,
          size: file.size,
          type: file.type || "application/octet-stream",
        })
      );

      let offset = 0;
      const speedMeter = createSpeedMeter();
      while (offset < file.size) {
        const chunk = file.slice(offset, offset + chunkSize);
        const buffer = await chunk.arrayBuffer();
        await transport.send(buffer);
        offset += buffer.byteLength;
        const { instant } = speedMeter.update(offset);
        updateTransferProgress(
          transferId,
          offset / file.size,
          `Enviando → ${targetName} · ${via} · ${formatBytes(offset)} / ${formatBytes(file.size)} · ${formatSpeed(instant)}`
        );
      }

      await transport.send(JSON.stringify({ kind: "done", transferId, batchId }));
      const avgSpeed = speedMeter.finish(file.size);
      updateTransferProgress(
        transferId,
        1,
        `Enviado → ${targetName} · ${via} · ${formatBytes(file.size)} · média ${formatSpeed(avgSpeed)}`
      );
    }

    if (batchId) {
      await transport.send(JSON.stringify({ kind: "batch-end", batchId }));
    }
  } finally {
    endTransferKeepAwake();
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function uniqueZipName(name, used) {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const match = name.match(/^(.*?)(\.[^.]+)?$/);
  const base = match?.[1] || name;
  const ext = match?.[2] || "";
  let i = 1;
  let candidate = `${base} (${i})${ext}`;
  while (used.has(candidate)) {
    i += 1;
    candidate = `${base} (${i})${ext}`;
  }
  used.add(candidate);
  return candidate;
}

async function downloadFilesTogether(files) {
  if (files.length === 0) return;
  if (files.length === 1) {
    downloadBlob(files[0].blob, files[0].name);
    showToast(`Arquivo recebido: ${files[0].name}`);
    return;
  }

  if (typeof window.JSZip === "undefined") {
    for (const file of files) downloadBlob(file.blob, file.name);
    showToast(`${files.length} arquivos recebidos`);
    return;
  }

  const zip = new window.JSZip();
  const used = new Set();
  for (const file of files) {
    zip.file(uniqueZipName(file.name, used), file.blob);
  }
  const blob = await zip.generateAsync({ type: "blob" });
  downloadBlob(blob, `FileLink-${files.length}-arquivos.zip`);
  showToast(`${files.length} arquivos baixados juntos`);
}

function onChannelMessage(peerId, data) {
  if (typeof data === "string") {
    const msg = JSON.parse(data);
    if (msg.kind === "batch-start") {
      state.batches.set(msg.batchId, {
        peerId,
        expected: Number(msg.count) || 0,
        files: [],
      });
      return;
    }
    if (msg.kind === "meta") {
      state.incoming.set(msg.transferId, {
        peerId,
        batchId: msg.batchId || null,
        name: msg.name,
        size: msg.size,
        type: msg.type,
        received: 0,
        chunks: [],
        speedMeter: createSpeedMeter(),
      });
      beginTransferKeepAwake();
      createTransferItem({
        id: msg.transferId,
        name: msg.name,
        size: msg.size,
        direction: `Recebendo ← ${peerName(peerId)}`,
      });
      return;
    }
    if (msg.kind === "done") {
      finalizeIncoming(msg.transferId);
      return;
    }
    if (msg.kind === "batch-end") {
      flushBatch(msg.batchId);
    }
    return;
  }

  const entry = [...state.incoming.values()].find(
    (item) => item.peerId === peerId && item.received < item.size
  );
  if (!entry) return;

  const transferId = [...state.incoming.entries()].find(([, v]) => v === entry)?.[0];
  entry.chunks.push(data);
  entry.received += data.byteLength;
  if (!entry.speedMeter) entry.speedMeter = createSpeedMeter();
  const { instant } = entry.speedMeter.update(entry.received);
  updateTransferProgress(
    transferId,
    entry.received / entry.size,
    `Recebendo ← ${peerName(peerId)} · ${formatBytes(entry.received)} / ${formatBytes(entry.size)} · ${formatSpeed(instant)}`
  );
}

function finalizeIncoming(transferId) {
  const entry = state.incoming.get(transferId);
  if (!entry) return;
  const blob = new Blob(entry.chunks, { type: entry.type || "application/octet-stream" });
  const avgSpeed = entry.speedMeter?.finish(entry.received) || 0;
  updateTransferProgress(
    transferId,
    1,
    `Recebido ← ${peerName(entry.peerId)} · ${formatBytes(entry.size)} · média ${formatSpeed(avgSpeed)}`
  );
  state.incoming.delete(transferId);

  if (entry.batchId && state.batches.has(entry.batchId)) {
    const batch = state.batches.get(entry.batchId);
    batch.files.push({ name: entry.name, blob });
    endTransferKeepAwake();
    return;
  }

  downloadBlob(blob, entry.name);
  showToast(`Arquivo recebido: ${entry.name}`);
  endTransferKeepAwake();
}

async function flushBatch(batchId) {
  const batch = state.batches.get(batchId);
  if (!batch) return;
  state.batches.delete(batchId);
  await downloadFilesTogether(batch.files);
}

function extractRoomCode(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;

  try {
    const url = new URL(text);
    const code = url.searchParams.get("code");
    if (code) return sanitizeRoomCode(code);
  } catch {
    // not a full URL — try embedded URL next
  }

  const embeddedUrl = text.match(/https?:\/\/\S+/i)?.[0];
  if (embeddedUrl) {
    try {
      const code = new URL(embeddedUrl).searchParams.get("code");
      if (code) return sanitizeRoomCode(code);
    } catch {
      // ignore
    }
  }

  const fromQuery = text.match(/[?&]code=([A-Za-z0-9]{6})/i)?.[1];
  if (fromQuery) return sanitizeRoomCode(fromQuery);

  const match = text.toUpperCase().match(/\b([A-Z0-9]{6})\b/);
  return match ? match[1] : null;
}

function sanitizeRoomCode(code) {
  const normalized = String(code || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return /^[A-Z0-9]{6}$/.test(normalized) ? normalized : null;
}

function stopQrScanner() {
  state.scan.running = false;
  state.scan.busy = false;
  if (state.scan.timer) {
    clearTimeout(state.scan.timer);
    state.scan.timer = 0;
  }
  if (state.scan.stream) {
    for (const track of state.scan.stream.getTracks()) track.stop();
    state.scan.stream = null;
  }
  if (el.scanVideo) {
    el.scanVideo.pause?.();
    el.scanVideo.srcObject = null;
  }
  el.scanModal?.classList.add("hidden");
}

async function handleScannedPayload(raw) {
  const code = extractRoomCode(raw);
  if (!code) return false;
  stopQrScanner();
  el.joinForm.classList.remove("hidden");
  el.codeInput.value = code;
  showToast(`QR lido: ${code}`);
  joinRoom(code);
  return true;
}

function captureScanFrame() {
  const video = el.scanVideo;
  const canvas = el.scanCanvas;
  if (!video || !canvas || video.readyState < 2 || !video.videoWidth) return null;

  const maxSide = 640;
  const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
  const width = Math.max(1, Math.round(video.videoWidth * scale));
  const height = Math.max(1, Math.round(video.videoHeight * scale));
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

async function scanOnce() {
  if (!state.scan.running || state.scan.busy) return;
  state.scan.busy = true;
  try {
    if (state.scan.detector) {
      try {
        const codes = await state.scan.detector.detect(el.scanVideo);
        for (const code of codes || []) {
          if (code?.rawValue && (await handleScannedPayload(code.rawValue))) return;
        }
      } catch {
        // continue with jsQR
      }
    }

    if (typeof window.jsQR === "function") {
      const image = captureScanFrame();
      if (image) {
        const result = window.jsQR(image.data, image.width, image.height, {
          inversionAttempts: "attemptBoth",
        });
        if (result?.data && (await handleScannedPayload(result.data))) return;
      }
    }
  } finally {
    state.scan.busy = false;
  }
}

function scheduleScanLoop() {
  if (!state.scan.running) return;
  state.scan.timer = setTimeout(async () => {
    await scanOnce();
    scheduleScanLoop();
  }, 220);
}

async function openCameraStream(useFront = false) {
  const attempts = [
    {
      audio: false,
      video: {
        facingMode: { exact: useFront ? "user" : "environment" },
      },
    },
    {
      audio: false,
      video: {
        facingMode: { ideal: useFront ? "user" : "environment" },
      },
    },
    {
      audio: false,
      video: true,
    },
  ];

  let lastError = null;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("Câmera indisponível");
}

async function startQrScanner(useFront = state.scan.useFront) {
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast("Câmera indisponível neste navegador");
    return;
  }
  if (typeof window.jsQR !== "function" && !("BarcodeDetector" in window)) {
    showToast("Leitor de QR indisponível");
    return;
  }

  stopQrScanner();
  state.scan.useFront = Boolean(useFront);
  el.scanModal.classList.remove("hidden");
  el.scanStatus.textContent = "Abrindo câmera…";

  try {
    el.scanVideo.setAttribute("playsinline", "true");
    el.scanVideo.setAttribute("webkit-playsinline", "true");
    el.scanVideo.muted = true;

    const stream = await openCameraStream(state.scan.useFront);
    state.scan.stream = stream;
    el.scanVideo.srcObject = stream;
    await el.scanVideo.play();

    // Prefer jsQR on mobile; BarcodeDetector is optional bonus.
    state.scan.detector = null;
    if ("BarcodeDetector" in window) {
      try {
        const formats = await BarcodeDetector.getSupportedFormats?.();
        if (!formats || formats.includes("qr_code")) {
          state.scan.detector = new BarcodeDetector({ formats: ["qr_code"] });
        }
      } catch {
        state.scan.detector = null;
      }
    }

    el.scanStatus.textContent = "Aponte para o QR da rede…";
    state.scan.running = true;
    scheduleScanLoop();
  } catch {
    el.scanStatus.textContent = "Permissão da câmera negada ou indisponível";
    showToast("Não foi possível abrir a câmera");
  }
}

function renderFileQueue() {
  if (!el.fileQueue) return;
  if (state.selectedFiles.length === 0) {
    el.fileQueue.innerHTML = "";
    if (el.dropzoneTitle) el.dropzoneTitle.textContent = "Solte arquivos aqui";
    if (el.dropzoneHint) el.dropzoneHint.textContent = "ou toque para escolher";
    el.sendBtn.disabled = true;
    return;
  }

  if (el.dropzoneTitle) {
    el.dropzoneTitle.textContent =
      state.selectedFiles.length === 1
        ? "1 arquivo selecionado"
        : `${state.selectedFiles.length} arquivos selecionados`;
  }
  if (el.dropzoneHint) el.dropzoneHint.textContent = "toque para adicionar mais";

  el.fileQueue.innerHTML = state.selectedFiles
    .map(
      (file, index) => `
      <li class="file-queue-item">
        <strong title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</strong>
        <span>${formatBytes(file.size)}</span>
        <button type="button" data-remove-file="${index}">Remover</button>
      </li>
    `
    )
    .join("");

  el.sendBtn.disabled = state.peers.length === 0;
}

function setSelectedFiles(fileList, { append = false } = {}) {
  const incoming = [...fileList];
  state.selectedFiles = append ? [...state.selectedFiles, ...incoming] : incoming;
  renderFileQueue();
  if (state.selectedFiles.length) {
    showToast(
      state.selectedFiles.length === 1
        ? `1 arquivo pronto`
        : `${state.selectedFiles.length} arquivos prontos`
    );
  }
}

function removeSelectedFile(index) {
  state.selectedFiles = state.selectedFiles.filter((_, i) => i !== index);
  el.fileInput.value = "";
  renderFileQueue();
}

function createRoom() {
  const name = persistDeviceName(currentDeviceName());
  send("create-room", { name });
}

function joinRoom(code) {
  const normalized = sanitizeRoomCode(code);
  if (!normalized) {
    showToast("Código inválido (6 caracteres)");
    return;
  }
  const name = persistDeviceName(currentDeviceName());
  send("join-room", { code: normalized, name });
}

el.createBtn.addEventListener("click", createRoom);
el.joinToggleBtn.addEventListener("click", () => {
  el.joinForm.classList.toggle("hidden");
  if (!el.joinForm.classList.contains("hidden")) el.codeInput.focus();
});
el.scanQrBtn?.addEventListener("click", () => {
  startQrScanner(false);
});
el.switchCameraBtn?.addEventListener("click", () => {
  startQrScanner(!state.scan.useFront);
});
el.closeScanBtn?.addEventListener("click", () => stopQrScanner());
el.scanModal?.addEventListener("click", (event) => {
  if (event.target === el.scanModal) stopQrScanner();
});

el.joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  joinRoom(el.codeInput.value);
});

el.codeInput.addEventListener("input", () => {
  el.codeInput.value = el.codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
});

el.copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(state.roomCode);
    showToast("Código copiado");
  } catch {
    showToast("Não foi possível copiar");
  }
});

el.shareBtn.addEventListener("click", async () => {
  const url = roomJoinUrl(state.roomCode);
  if (navigator.share) {
    try {
      await navigator.share({
        title: "FileLink",
        text: `Entre na rede ${state.roomCode} no FileLink`,
        url,
      });
      return;
    } catch {}
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast("Link copiado");
  } catch {
    showToast(url);
  }
});

el.leaveBtn.addEventListener("click", () => {
  state.intentionalClose = true;
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = 0;
  }
  const ws = state.ws;
  leaveRoomUI();
  releaseKeepAwake();
  state.transferActive = 0;
  ws?.close();
  connectSocket();
});

el.fileInput.addEventListener("change", () => {
  if (el.fileInput.files?.length) {
    setSelectedFiles(el.fileInput.files, { append: state.selectedFiles.length > 0 });
  }
});

el.fileQueue?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-file]");
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  removeSelectedFile(Number(button.dataset.removeFile));
});

["dragenter", "dragover"].forEach((type) => {
  el.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    el.dropzone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach((type) => {
  el.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    el.dropzone.classList.remove("dragover");
  });
});

el.dropzone.addEventListener("drop", (event) => {
  if (event.dataTransfer?.files?.length) {
    setSelectedFiles(event.dataTransfer.files, { append: state.selectedFiles.length > 0 });
  }
});

el.sendBtn.addEventListener("click", async () => {
  const target = el.targetSelect.value;
  if (!target || state.selectedFiles.length === 0) return;
  el.sendBtn.disabled = true;
  const filesToSend = [...state.selectedFiles];
  try {
    await sendFilesTo(target, filesToSend);
    showToast("Envio concluído");
    state.selectedFiles = [];
    el.fileInput.value = "";
    renderFileQueue();
  } catch (err) {
    showToast(err.message || "Falha no envio");
  } finally {
    el.sendBtn.disabled = state.selectedFiles.length === 0 || state.peers.length === 0;
  }
});

el.deviceNameInput?.addEventListener("change", () => {
  persistDeviceName(el.deviceNameInput.value);
});

el.deviceNameInput?.addEventListener("blur", () => {
  persistDeviceName(el.deviceNameInput.value || state.deviceName);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (state.transferActive > 0) acquireKeepAwake();
    if (!state.ws || state.ws.readyState === WebSocket.CLOSED) {
      connectSocket();
    }
  }
});

setInterval(() => {
  if (state.ws?.readyState === WebSocket.OPEN && state.roomCode) {
    send("ping");
  }
}, 20000);

(async () => {
  const detected = await detectDeviceName();
  persistDeviceName(detected);
  connectSocket();
})();
