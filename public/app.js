const CHUNK_SIZE = 256 * 1024; // 256 KB — larger P2P blocks fill the pipe faster
const RELAY_CHUNK_SIZE = 48 * 1024; // bigger relay blocks (still under WS payload limit)
const P2P_HIGH_WATER = 16 * 1024 * 1024; // keep up to 16 MB queued in the data channel
const P2P_LOW_WATER = 2 * 1024 * 1024; // resume when buffer drains to 2 MB
const RELAY_HIGH_WATER = 2 * 1024 * 1024;
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
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
  transferControls: document.getElementById("transferControls"),
  pauseSendBtn: document.getElementById("pauseSendBtn"),
  resumeSendBtn: document.getElementById("resumeSendBtn"),
  stopSendBtn: document.getElementById("stopSendBtn"),
  transferControlsHint: document.getElementById("transferControlsHint"),
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
  transferRecords: new Map(),
  sendJob: {
    active: false,
    paused: false,
    stopped: false,
  },
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

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "calculando tempo…";
  const whole = Math.max(0, Math.ceil(seconds));
  if (whole <= 1) return "faltam < 1s para acabar";
  if (whole < 60) return `faltam ${whole}s para acabar`;
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  if (mins < 60) {
    return secs > 0
      ? `faltam ${mins}m ${secs}s para acabar`
      : `faltam ${mins}m para acabar`;
  }
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0
    ? `faltam ${hours}h ${remMins}m para acabar`
    : `faltam ${hours}h para acabar`;
}

/** Stable ETA for the whole transfer job (all files), based on average throughput. */
function createOperationMeter(totalBytes) {
  const startedAt = performance.now();
  let completedBytes = 0;
  let lastUiAt = 0;

  return {
    get totalBytes() {
      return totalBytes;
    },
    markFileDone(size) {
      completedBytes += Math.max(0, size);
    },
    snapshot(currentFileOffset = 0) {
      const now = performance.now();
      const transferred = Math.min(totalBytes, completedBytes + Math.max(0, currentFileOffset));
      const elapsed = Math.max(0.001, (now - startedAt) / 1000);
      const remaining = Math.max(0, totalBytes - transferred);
      // Wait until we have a meaningful sample so early spikes don't skew ETA.
      const ready = remaining === 0 || (elapsed >= 1 && transferred >= 256 * 1024);
      const rate = ready || remaining === 0 ? transferred / elapsed : NaN;
      const etaSeconds = ready && rate > 0 && remaining > 0 ? remaining / rate : remaining === 0 ? 0 : NaN;
      const shouldRender = now - lastUiAt >= 200 || remaining === 0;
      if (shouldRender) lastUiAt = now;
      return {
        transferred,
        remaining,
        rate,
        etaSeconds,
        shouldRender,
        elapsed,
      };
    },
    finish() {
      const elapsed = Math.max(0.001, (performance.now() - startedAt) / 1000);
      return totalBytes / elapsed;
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

  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const ws = new WebSocket(wsUrl());
  state.ws = ws;
  setStatus("Conectando…");

  ws.addEventListener("open", () => {
    setStatus(state.roomCode ? "Online" : "Online");
    if (state.roomCode && state.peerId) {
      send("rejoin-room", {
        code: state.roomCode,
        peerId: state.peerId,
        name: currentDeviceName(),
      });
      return;
    }
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
    // Keep P2P/data channels alive during brief signaling drops.
    setStatus(state.roomCode ? "Reconectando sinal…" : "Reconectando…");
    state.reconnectTimer = setTimeout(connectSocket, document.visibilityState === "hidden" ? 2000 : 800);
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
  state.transferRecords.clear();
  if (el.transfers) el.transfers.innerHTML = "";
  el.fileInput.value = "";
  renderFileQueue();
  updateSendControls();
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
      enterRoom(msg.code, msg.peerId, msg.peers, msg.name);
      showToast("Pronto para transferir");
      break;
    case "room-joined":
      enterRoom(msg.code, msg.peerId, msg.peers, msg.name);
      showToast("Você entrou na rede");
      break;
    case "room-rejoined":
      enterRoom(msg.code, msg.peerId, msg.peers, msg.name);
      setStatus("Online");
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
    case "peer-back": {
      const name = sanitizeDeviceName(msg.name) || peerName(msg.peerId);
      if (!state.peers.some((peer) => peer.id === msg.peerId)) {
        state.peers.push({ id: msg.peerId, name });
      } else {
        state.peers = state.peers.map((peer) =>
          peer.id === msg.peerId ? { ...peer, name } : peer
        );
      }
      renderPeers();
      updateTargetSelect();
      break;
    }
    case "peer-away":
      // Temporary signaling drop — keep P2P/transfer state.
      break;
    case "peer-left": {
      const leftName = peerName(msg.peerId);
      state.peers = state.peers.filter((peer) => peer.id !== msg.peerId);
      closePeer(msg.peerId);
      renderPeers();
      updateTargetSelect();
      if (state.transferActive > 0) {
        markTransfersInterrupted("interrompido (aparelho saiu)");
      }
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
    updateSendControls();
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
  updateSendControls();
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

  const pc = new RTCPeerConnection({
    iceServers: ICE_SERVERS,
    bundlePolicy: "max-bundle",
  });
  conn = { pc, channel: null, mode: "webrtc", failed: false };
  state.connections.set(peerId, conn);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      send("signal", { to: peerId, data: { type: "candidate", candidate: event.candidate } });
    }
  };

  if (initiator) {
    const channel = pc.createDataChannel("filelink", {
      ordered: true,
      negotiated: false,
    });
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
  conn.failed = false;
  channel.binaryType = "arraybuffer";
  channel.bufferedAmountLowThreshold = P2P_LOW_WATER;
  channel.onmessage = (event) => onChannelMessage(peerId, event.data);
  channel.onerror = () => {
    conn.failed = true;
  };
  channel.onclose = () => {
    conn.failed = true;
  };
}

function waitForChannelDrain(channel) {
  if (!channel || channel.readyState !== "open") {
    return Promise.reject(new Error("Canal P2P fechou"));
  }
  if (channel.bufferedAmount <= P2P_LOW_WATER) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.removeEventListener("bufferedamountlow", onLow);
      channel.removeEventListener("close", onClose);
      channel.removeEventListener("error", onClose);
      fn(value);
    };
    const onLow = () => done(resolve);
    const onClose = () => done(reject, new Error("Canal P2P fechou"));
    const timer = setTimeout(() => done(resolve), 3000);
    channel.bufferedAmountLowThreshold = P2P_LOW_WATER;
    channel.addEventListener("bufferedamountlow", onLow);
    channel.addEventListener("close", onClose);
    channel.addEventListener("error", onClose);
  });
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

function createRelayTransport(peerId) {
  return {
    mode: "relay",
    async send(payload) {
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
        throw new Error("Sinalização offline");
      }
      relaySend(peerId, payload);
      // Only yield when the browser socket buffer is actually backing up.
      while (state.ws.bufferedAmount > RELAY_HIGH_WATER) {
        await new Promise((r) => setTimeout(r, 1));
        if (state.ws.readyState !== WebSocket.OPEN) {
          throw new Error("Sinalização offline");
        }
      }
    },
  };
}

async function openTransport(peerId, { forceRelay = false } = {}) {
  if (!forceRelay) {
    try {
      const conn = await ensureConnection(peerId, true);
      await waitForOpen(conn.channel, conn.pc, 8000);
      return {
        mode: "p2p",
        async send(payload) {
          if (!conn.channel || conn.channel.readyState !== "open" || conn.failed) {
            throw new Error("Canal P2P fechou");
          }
          if (conn.channel.bufferedAmount > P2P_HIGH_WATER) {
            await waitForChannelDrain(conn.channel);
          }
          if (!conn.channel || conn.channel.readyState !== "open" || conn.failed) {
            throw new Error("Canal P2P fechou");
          }
          conn.channel.send(payload);
        },
      };
    } catch {
      closePeer(peerId);
    }
  }

  showToast("Continuando pela rede FileLink");
  return createRelayTransport(peerId);
}

function createTransferItem({
  id,
  name,
  size,
  direction,
  file = null,
  peerId = null,
  status = "sending",
}) {
  const li = document.createElement("li");
  li.className = "transfer";
  li.dataset.id = id;
  li.innerHTML = `
    <div class="transfer-top">
      <strong>${escapeHtml(name)}</strong>
      <span class="transfer-meta">${direction} · ${formatBytes(size)}</span>
    </div>
    <div class="bar"><span style="width:0%"></span></div>
    <div class="transfer-actions">
      <button type="button" class="btn btn-ghost hidden" data-transfer-action="pause">Pausar</button>
      <button type="button" class="btn btn-ghost hidden" data-transfer-action="resume">Continuar</button>
      <button type="button" class="btn btn-danger hidden" data-transfer-action="stop">Parar</button>
      <button type="button" class="btn btn-ghost hidden" data-transfer-action="resend">Reenviar</button>
    </div>
  `;
  el.transfers.prepend(li);
  state.transferRecords.set(id, {
    file,
    peerId,
    name,
    size,
    status,
  });
  setTransferActions(id, status);
  return li;
}

function setTransferActions(id, status) {
  const item = el.transfers.querySelector(`[data-id="${id}"]`);
  const record = state.transferRecords.get(id);
  if (!item) return;
  if (record) record.status = status;

  const pauseBtn = item.querySelector('[data-transfer-action="pause"]');
  const resumeBtn = item.querySelector('[data-transfer-action="resume"]');
  const stopBtn = item.querySelector('[data-transfer-action="stop"]');
  const resendBtn = item.querySelector('[data-transfer-action="resend"]');

  pauseBtn?.classList.toggle("hidden", status !== "sending");
  resumeBtn?.classList.toggle("hidden", status !== "paused");
  stopBtn?.classList.toggle("hidden", status !== "sending" && status !== "paused");
  resendBtn?.classList.toggle(
    "hidden",
    !(record?.file && ["sent", "stopped", "error"].includes(status))
  );
}

function updateSendControls() {
  const active = state.sendJob.active;
  el.transferControls?.classList.toggle("hidden", !active);
  el.pauseSendBtn?.classList.toggle("hidden", !active || state.sendJob.paused);
  el.resumeSendBtn?.classList.toggle("hidden", !active || !state.sendJob.paused);
  el.stopSendBtn?.classList.toggle("hidden", !active);
  if (el.transferControlsHint) {
    el.transferControlsHint.textContent = !active
      ? ""
      : state.sendJob.paused
        ? "Envio pausado"
        : "Enviando…";
  }
  el.sendBtn.disabled =
    state.sendJob.active || state.selectedFiles.length === 0 || state.peers.length === 0;
}

function pauseSending() {
  if (!state.sendJob.active || state.sendJob.stopped) return;
  state.sendJob.paused = true;
  updateSendControls();
  for (const [id, record] of state.transferRecords) {
    if (record.status === "sending") {
      setTransferActions(id, "paused");
      const item = el.transfers.querySelector(`[data-id="${id}"]`);
      const meta = item?.querySelector(".transfer-meta");
      if (meta && !meta.textContent.includes("Pausado")) {
        meta.textContent = `${meta.textContent.split(" · ")[0]} · Pausado`;
      }
    }
  }
  showToast("Envio pausado");
}

function resumeSending() {
  if (!state.sendJob.active || state.sendJob.stopped) return;
  state.sendJob.paused = false;
  updateSendControls();
  for (const [id, record] of state.transferRecords) {
    if (record.status === "paused") setTransferActions(id, "sending");
  }
  showToast("Envio retomado");
}

function stopSending() {
  if (!state.sendJob.active) return;
  state.sendJob.stopped = true;
  state.sendJob.paused = false;
  updateSendControls();
  showToast("Parando envio…");
}

async function waitWhilePaused() {
  while (state.sendJob.paused && !state.sendJob.stopped) {
    await new Promise((r) => setTimeout(r, 120));
  }
  if (state.sendJob.stopped) {
    const err = new Error("Envio parado");
    err.code = "TRANSFER_STOPPED";
    throw err;
  }
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

async function sendOneFile(
  transport,
  peerId,
  file,
  { batchId = null, transferId = null, operationMeter = null, fileIndex = 1, fileCount = 1 } = {}
) {
  const targetName = peerName(peerId);
  const chunkSize = transport.mode === "relay" ? RELAY_CHUNK_SIZE : CHUNK_SIZE;
  const via = transport.mode === "relay" ? "rede FileLink" : "P2P";
  const id = transferId || crypto.randomUUID();
  const meter = operationMeter || createOperationMeter(file.size);

  if (!el.transfers.querySelector(`[data-id="${id}"]`)) {
    createTransferItem({
      id,
      name: file.name,
      size: file.size,
      direction: `Enviando → ${targetName}`,
      file,
      peerId,
    });
  } else {
    const record = state.transferRecords.get(id) || {};
    state.transferRecords.set(id, {
      ...record,
      file,
      peerId,
      name: file.name,
      size: file.size,
      status: "sending",
    });
    setTransferActions(id, "sending");
    updateTransferProgress(id, 0, `Enviando → ${targetName}`);
  }

  await waitWhilePaused();
  await transport.send(
    JSON.stringify({
      kind: "meta",
      transferId: id,
      batchId,
      name: file.name,
      size: file.size,
      type: file.type || "application/octet-stream",
    })
  );

  let offset = 0;
  let nextRead =
    offset < file.size ? file.slice(offset, offset + chunkSize).arrayBuffer() : null;

  while (offset < file.size && nextRead) {
    await waitWhilePaused();
    const buffer = await nextRead;
    offset += buffer.byteLength;
    nextRead =
      offset < file.size ? file.slice(offset, offset + chunkSize).arrayBuffer() : null;

    await transport.send(buffer);
    const snap = meter.snapshot(offset);
    if (!snap.shouldRender && offset < file.size) continue;

    const fileProgress =
      fileCount > 1
        ? `arquivo ${fileIndex}/${fileCount} · ${formatBytes(snap.transferred)} / ${formatBytes(meter.totalBytes)}`
        : `${formatBytes(offset)} / ${formatBytes(file.size)}`;

    updateTransferProgress(
      id,
      fileCount > 1 ? snap.transferred / meter.totalBytes : offset / file.size,
      `Enviando → ${targetName} · ${via} · ${fileProgress} · ${formatSpeed(snap.rate)} · ${formatEta(snap.etaSeconds)}`
    );
  }

  await waitWhilePaused();
  await transport.send(JSON.stringify({ kind: "done", transferId: id, batchId }));
  meter.markFileDone(file.size);
  const snap = meter.snapshot(0);
  const doneProgress =
    fileCount > 1
      ? `arquivo ${fileIndex}/${fileCount} · ${formatBytes(snap.transferred)} / ${formatBytes(meter.totalBytes)}`
      : formatBytes(file.size);
  updateTransferProgress(
    id,
    fileCount > 1 ? snap.transferred / Math.max(1, meter.totalBytes) : 1,
    `Enviado → ${targetName} · ${via} · ${doneProgress} · média ${formatSpeed(snap.rate)}`
  );
  setTransferActions(id, "sent");
  return id;
}

async function sendFilesTo(peerId, files, { reuseTransferIds = null } = {}) {
  state.sendJob.active = true;
  state.sendJob.paused = false;
  state.sendJob.stopped = false;
  updateSendControls();
  await beginTransferKeepAwake();
  try {
    let transport = await openTransport(peerId);
    const list = [...files];
    const batchId = list.length > 1 ? crypto.randomUUID() : null;
    const totalBytes = list.reduce((sum, file) => sum + file.size, 0);
    const operationMeter = createOperationMeter(totalBytes);

    if (batchId) {
      await transport.send(
        JSON.stringify({
          kind: "batch-start",
          batchId,
          count: list.length,
          totalBytes,
        })
      );
    }

    for (let index = 0; index < list.length; index += 1) {
      await waitWhilePaused();
      const file = list[index];
      const transferId = reuseTransferIds?.[index] || crypto.randomUUID();
      if (!reuseTransferIds?.[index]) {
        createTransferItem({
          id: transferId,
          name: file.name,
          size: file.size,
          direction: `Enviando → ${peerName(peerId)}`,
          file,
          peerId,
        });
      }

      const opts = {
        batchId,
        transferId,
        operationMeter,
        fileIndex: index + 1,
        fileCount: list.length,
      };

      try {
        await sendOneFile(transport, peerId, file, opts);
      } catch (err) {
        if (err.code === "TRANSFER_STOPPED") {
          setTransferActions(transferId, "stopped");
          updateTransferProgress(transferId, 0, `Parado → ${peerName(peerId)}`);
          for (let rest = index + 1; rest < list.length; rest += 1) {
            const restId = reuseTransferIds?.[rest] || crypto.randomUUID();
            if (!reuseTransferIds?.[rest]) {
              createTransferItem({
                id: restId,
                name: list[rest].name,
                size: list[rest].size,
                direction: `Parado → ${peerName(peerId)}`,
                file: list[rest],
                peerId,
              });
            }
            setTransferActions(restId, "stopped");
            updateTransferProgress(restId, 0, `Parado → ${peerName(peerId)} · não enviado`);
          }
          throw err;
        }

        closePeer(peerId);
        transport = await openTransport(peerId, { forceRelay: true });
        if (batchId) {
          await transport.send(
            JSON.stringify({
              kind: "batch-start",
              batchId,
              count: 1,
              totalBytes: file.size,
            })
          );
        }
        await sendOneFile(transport, peerId, file, opts);
        if (batchId) {
          await transport.send(JSON.stringify({ kind: "batch-end", batchId }));
        }
      }
    }

    if (batchId) {
      try {
        await transport.send(JSON.stringify({ kind: "batch-end", batchId }));
      } catch {
        const relay = await openTransport(peerId, { forceRelay: true });
        await relay.send(JSON.stringify({ kind: "batch-end", batchId }));
      }
    }
  } finally {
    state.sendJob.active = false;
    state.sendJob.paused = false;
    state.sendJob.stopped = false;
    updateSendControls();
    endTransferKeepAwake();
  }
}

async function resendTransfer(transferId) {
  const record = state.transferRecords.get(transferId);
  if (!record?.file) {
    showToast("Arquivo indisponível para reenviar");
    return;
  }
  if (state.sendJob.active) {
    showToast("Aguarde o envio atual terminar");
    return;
  }

  let peerId = el.targetSelect.value;
  if (!peerId || !state.peers.some((peer) => peer.id === peerId)) {
    peerId = state.peers.some((peer) => peer.id === record.peerId)
      ? record.peerId
      : state.peers[0]?.id;
  }
  if (!peerId) {
    showToast("Escolha o aparelho em Enviar para");
    return;
  }

  try {
    updateTransferProgress(transferId, 0, `Reenviando → ${peerName(peerId)}`);
    setTransferActions(transferId, "sending");
    await sendFilesTo(peerId, [record.file], { reuseTransferIds: [transferId] });
    showToast("Reenvio concluído");
  } catch (err) {
    if (err.code !== "TRANSFER_STOPPED") {
      setTransferActions(transferId, "error");
      showToast(err.message || "Falha no reenvio");
    }
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
      const totalBytes = Number(msg.totalBytes) || 0;
      state.batches.set(msg.batchId, {
        peerId,
        expected: Number(msg.count) || 0,
        files: [],
        totalBytes,
        operationMeter: totalBytes > 0 ? createOperationMeter(totalBytes) : null,
        filesDone: 0,
      });
      return;
    }
    if (msg.kind === "meta") {
      const batch = msg.batchId ? state.batches.get(msg.batchId) : null;
      const operationMeter =
        batch?.operationMeter || createOperationMeter(Number(msg.size) || 0);
      state.incoming.set(msg.transferId, {
        peerId,
        batchId: msg.batchId || null,
        name: msg.name,
        size: msg.size,
        type: msg.type,
        received: 0,
        chunks: [],
        operationMeter,
        fileIndex: batch ? batch.filesDone + 1 : 1,
        fileCount: batch?.expected || 1,
      });
      beginTransferKeepAwake();
      createTransferItem({
        id: msg.transferId,
        name: msg.name,
        size: msg.size,
        direction: `Recebendo ← ${peerName(peerId)}`,
        status: "receiving",
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
  if (!entry.operationMeter) entry.operationMeter = createOperationMeter(entry.size);
  const snap = entry.operationMeter.snapshot(entry.received);
  if (!snap.shouldRender && entry.received < entry.size) return;

  const fileCount = entry.fileCount || 1;
  const progressLabel =
    fileCount > 1
      ? `arquivo ${entry.fileIndex}/${fileCount} · ${formatBytes(snap.transferred)} / ${formatBytes(entry.operationMeter.totalBytes)}`
      : `${formatBytes(entry.received)} / ${formatBytes(entry.size)}`;

  updateTransferProgress(
    transferId,
    fileCount > 1 ? snap.transferred / Math.max(1, entry.operationMeter.totalBytes) : entry.received / entry.size,
    `Recebendo ← ${peerName(peerId)} · ${progressLabel} · ${formatSpeed(snap.rate)} · ${formatEta(snap.etaSeconds)}`
  );
}

function finalizeIncoming(transferId) {
  const entry = state.incoming.get(transferId);
  if (!entry) return;
  const blob = new Blob(entry.chunks, { type: entry.type || "application/octet-stream" });
  entry.operationMeter?.markFileDone(entry.size);
  const snap = entry.operationMeter?.snapshot(0) || { rate: 0, transferred: entry.size };
  const fileCount = entry.fileCount || 1;
  const doneLabel =
    fileCount > 1
      ? `arquivo ${entry.fileIndex}/${fileCount} · ${formatBytes(snap.transferred)} / ${formatBytes(entry.operationMeter.totalBytes)}`
      : formatBytes(entry.size);
  updateTransferProgress(
    transferId,
    fileCount > 1 ? snap.transferred / Math.max(1, entry.operationMeter.totalBytes) : 1,
    `Recebido ← ${peerName(entry.peerId)} · ${doneLabel} · média ${formatSpeed(snap.rate)}`
  );
  state.incoming.delete(transferId);

  if (entry.batchId && state.batches.has(entry.batchId)) {
    const batch = state.batches.get(entry.batchId);
    batch.files.push({ name: entry.name, blob });
    batch.filesDone = (batch.filesDone || 0) + 1;
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

  el.sendBtn.disabled =
    state.sendJob.active || state.selectedFiles.length === 0 || state.peers.length === 0;
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
  send("leave-room");
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
  // Only newly queued files are sent by Enviar.
  if (!target || state.selectedFiles.length === 0 || state.sendJob.active) return;
  el.sendBtn.disabled = true;
  const filesToSend = [...state.selectedFiles];
  state.selectedFiles = [];
  el.fileInput.value = "";
  renderFileQueue();
  try {
    await sendFilesTo(target, filesToSend);
    showToast("Envio concluído");
  } catch (err) {
    if (err.code === "TRANSFER_STOPPED") {
      showToast("Envio parado");
    } else {
      showToast(err.message || "Falha no envio");
    }
  } finally {
    updateSendControls();
  }
});

el.pauseSendBtn?.addEventListener("click", pauseSending);
el.resumeSendBtn?.addEventListener("click", resumeSending);
el.stopSendBtn?.addEventListener("click", stopSending);

el.transfers?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-transfer-action]");
  if (!button) return;
  const item = button.closest(".transfer");
  const transferId = item?.dataset.id;
  if (!transferId) return;
  const action = button.dataset.transferAction;
  if (action === "pause") pauseSending();
  if (action === "resume") resumeSending();
  if (action === "stop") stopSending();
  if (action === "resend") resendTransfer(transferId);
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
}, 12000);

(async () => {
  const detected = await detectDeviceName();
  persistDeviceName(detected);
  connectSocket();
})();
