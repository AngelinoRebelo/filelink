const CHUNK_SIZE = 64 * 1024;
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

const el = {
  status: document.getElementById("connectionStatus"),
  lobby: document.getElementById("lobby"),
  room: document.getElementById("room"),
  createBtn: document.getElementById("createBtn"),
  joinToggleBtn: document.getElementById("joinToggleBtn"),
  joinForm: document.getElementById("joinForm"),
  codeInput: document.getElementById("codeInput"),
  roomCode: document.getElementById("roomCode"),
  roomQr: document.getElementById("roomQr"),
  copyBtn: document.getElementById("copyBtn"),
  shareBtn: document.getElementById("shareBtn"),
  leaveBtn: document.getElementById("leaveBtn"),
  peers: document.getElementById("peers"),
  dropzone: document.getElementById("dropzone"),
  fileInput: document.getElementById("fileInput"),
  targetSelect: document.getElementById("targetSelect"),
  sendBtn: document.getElementById("sendBtn"),
  transfers: document.getElementById("transfers"),
  toast: document.getElementById("toast"),
};

const state = {
  ws: null,
  peerId: null,
  roomCode: null,
  peers: [],
  selectedFiles: [],
  connections: new Map(),
  incoming: new Map(),
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

function shortId(id) {
  return id ? id.slice(0, 4).toUpperCase() : "????";
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

function connectSocket() {
  const ws = new WebSocket(wsUrl());
  state.ws = ws;
  setStatus("Conectando…");

  ws.addEventListener("open", () => {
    setStatus("Online");
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    if (code && !state.roomCode) {
      el.codeInput.value = code.toUpperCase();
      el.joinForm.classList.remove("hidden");
      joinRoom(code);
    }
  });

  ws.addEventListener("close", () => {
    setStatus("Reconectando…");
    cleanupConnections();
    setTimeout(connectSocket, 1200);
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

function enterRoom(code, peerId, peers) {
  state.roomCode = code;
  state.peerId = peerId;
  state.peers = peers || [];
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
  el.fileInput.value = "";
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
      enterRoom(msg.code, msg.peerId, msg.peers);
      showToast(msg.type === "room-created" ? "Rede criada" : "Você entrou na rede");
      break;
    case "peers":
      state.peers = msg.peers || [];
      renderPeers();
      updateTargetSelect();
      break;
    case "peer-joined":
      if (!state.peers.includes(msg.peerId)) state.peers.push(msg.peerId);
      renderPeers();
      updateTargetSelect();
      showToast(`Aparelho ${shortId(msg.peerId)} entrou`);
      break;
    case "peer-left":
      state.peers = state.peers.filter((id) => id !== msg.peerId);
      closePeer(msg.peerId);
      renderPeers();
      updateTargetSelect();
      showToast(`Aparelho ${shortId(msg.peerId)} saiu`);
      break;
    case "signal":
      handlePeerSignal(msg.from, msg.data);
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
  nodes.push(peerCard(state.peerId, true));
  for (const id of state.peers) nodes.push(peerCard(id, false));
  if (state.peers.length === 0) {
    nodes.push(`<div class="peer empty">Aguardando outro aparelho…</div>`);
  }
  el.peers.innerHTML = nodes.join("");
}

function peerCard(id, isYou) {
  return `
    <div class="peer ${isYou ? "you" : ""}">
      <div class="peer-avatar">${shortId(id).slice(0, 2)}</div>
      <strong>${isYou ? "Você" : `Aparelho ${shortId(id)}`}</strong>
      <span>${isYou ? "nesta rede" : "conectado"}</span>
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
  for (const id of state.peers) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = `Aparelho ${shortId(id)}`;
    el.targetSelect.appendChild(opt);
  }
  if (previous && state.peers.includes(previous)) el.targetSelect.value = previous;
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
  conn = { pc, channel: null, makingOffer: false };
  state.connections.set(peerId, conn);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      send("signal", { to: peerId, data: { type: "candidate", candidate: event.candidate } });
    }
  };

  pc.onconnectionstatechange = () => {
    if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
      // keep map entry briefly; next send recreates
    }
  };

  if (initiator) {
    const channel = pc.createDataChannel("filelink", { ordered: true });
    wireChannel(peerId, channel);
    conn.makingOffer = true;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send("signal", { to: peerId, data: { type: "offer", sdp: pc.localDescription } });
    conn.makingOffer = false;
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
  channel.onopen = () => {
    // ready
  };
  channel.onclose = () => {
    // ignore
  };
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

function waitForOpen(channel) {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Canal demorou para abrir")), 12000);
    channel.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
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
  const conn = await ensureConnection(peerId, true);
  await waitForOpen(conn.channel);

  for (const file of files) {
    const transferId = crypto.randomUUID();
    createTransferItem({
      id: transferId,
      name: file.name,
      size: file.size,
      direction: `Enviando → ${shortId(peerId)}`,
    });

    conn.channel.send(
      JSON.stringify({
        kind: "meta",
        transferId,
        name: file.name,
        size: file.size,
        type: file.type || "application/octet-stream",
      })
    );

    let offset = 0;
    while (offset < file.size) {
      const chunk = file.slice(offset, offset + CHUNK_SIZE);
      const buffer = await chunk.arrayBuffer();
      // backpressure
      while (conn.channel.bufferedAmount > 8 * 1024 * 1024) {
        await new Promise((r) => setTimeout(r, 20));
      }
      conn.channel.send(buffer);
      offset += buffer.byteLength;
      updateTransferProgress(
        transferId,
        offset / file.size,
        `Enviando → ${shortId(peerId)} · ${formatBytes(offset)} / ${formatBytes(file.size)}`
      );
    }

    conn.channel.send(JSON.stringify({ kind: "done", transferId }));
    updateTransferProgress(transferId, 1, `Enviado → ${shortId(peerId)} · ${formatBytes(file.size)}`);
  }
}

function onChannelMessage(peerId, data) {
  if (typeof data === "string") {
    const msg = JSON.parse(data);
    if (msg.kind === "meta") {
      state.incoming.set(msg.transferId, {
        peerId,
        name: msg.name,
        size: msg.size,
        type: msg.type,
        received: 0,
        chunks: [],
      });
      createTransferItem({
        id: msg.transferId,
        name: msg.name,
        size: msg.size,
        direction: `Recebendo ← ${shortId(peerId)}`,
      });
      return;
    }
    if (msg.kind === "done") {
      finalizeIncoming(msg.transferId);
    }
    return;
  }

  // binary chunk: attach to latest open incoming from this peer if only one,
  // otherwise match by scanning for incomplete transfers from peer
  const entry = [...state.incoming.values()].find(
    (item) => item.peerId === peerId && item.received < item.size
  );
  if (!entry) return;

  const transferId = [...state.incoming.entries()].find(([, v]) => v === entry)?.[0];
  entry.chunks.push(data);
  entry.received += data.byteLength;
  updateTransferProgress(
    transferId,
    entry.received / entry.size,
    `Recebendo ← ${shortId(peerId)} · ${formatBytes(entry.received)} / ${formatBytes(entry.size)}`
  );
}

function finalizeIncoming(transferId) {
  const entry = state.incoming.get(transferId);
  if (!entry) return;
  const blob = new Blob(entry.chunks, { type: entry.type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = entry.name;
  a.click();
  URL.revokeObjectURL(url);
  updateTransferProgress(
    transferId,
    1,
    `Recebido ← ${shortId(entry.peerId)} · ${formatBytes(entry.size)}`
  );
  state.incoming.delete(transferId);
  showToast(`Arquivo recebido: ${entry.name}`);
}

function createRoom() {
  send("create-room");
}

function joinRoom(code) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(normalized)) {
    showToast("Código inválido (6 caracteres)");
    return;
  }
  send("join-room", { code: normalized });
}

function setSelectedFiles(fileList) {
  state.selectedFiles = [...fileList];
  el.sendBtn.disabled = state.selectedFiles.length === 0 || state.peers.length === 0;
  if (state.selectedFiles.length) {
    showToast(
      state.selectedFiles.length === 1
        ? `1 arquivo pronto`
        : `${state.selectedFiles.length} arquivos prontos`
    );
  }
}

el.createBtn.addEventListener("click", createRoom);
el.joinToggleBtn.addEventListener("click", () => {
  el.joinForm.classList.toggle("hidden");
  if (!el.joinForm.classList.contains("hidden")) el.codeInput.focus();
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
  state.ws?.close();
  leaveRoomUI();
  connectSocket();
});

el.fileInput.addEventListener("change", () => setSelectedFiles(el.fileInput.files));

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
  if (event.dataTransfer?.files?.length) setSelectedFiles(event.dataTransfer.files);
});

el.sendBtn.addEventListener("click", async () => {
  const target = el.targetSelect.value;
  if (!target || state.selectedFiles.length === 0) return;
  el.sendBtn.disabled = true;
  try {
    await sendFilesTo(target, state.selectedFiles);
    showToast("Envio concluído");
  } catch (err) {
    showToast(err.message || "Falha no envio");
  } finally {
    el.sendBtn.disabled = state.selectedFiles.length === 0 || state.peers.length === 0;
  }
});

connectSocket();
