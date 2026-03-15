// vercelserver/dplus-party-server/server.js
// D+ Party WebSocket 서버 - Debug 강화 버전

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const cors = require("cors");

const app = express();

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  console.log(
    `[HTTP ${new Date().toISOString()}] ${req.method} ${req.url} - ip=${req.ip}`,
  );
  next();
});

app.get("/", (_req, res) => {
  res.send("D+ Party WebSocket Server - Running");
});

app.options("*", cors());

const serverStartedAt = Date.now();

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    now: new Date().toISOString(),
    uptimeSec: Math.floor(process.uptime()),
    startedAt: new Date(serverStartedAt).toISOString(),
    rooms: getRoomSummary(),
    clients: getClientCount(),
  });
});

app.get("/debug/rooms", (_req, res) => {
  res.json({
    now: new Date().toISOString(),
    rooms: getRoomSummary(),
    roomStates: Object.fromEntries(roomStates.entries()),
  });
});

app.get("/state", (req, res) => {
  const roomId = req.query.room;
  if (!roomId) {
    return res.status(400).json({ error: "Missing room parameter" });
  }

  const state = roomStates.get(roomId) || null;
  res.json({ roomId, state });
  log("HTTP /state", { roomId, hasState: !!state });
});

app.post("/update", (req, res) => {
  const roomId = req.query.room;
  if (!roomId) {
    return res.status(400).json({ error: "Missing room parameter" });
  }

  const payload = req.body;
  if (!payload || !payload.state) {
    return res.status(400).json({ error: "Invalid state data" });
  }

  roomStates.set(roomId, payload.state);

  const broadcastData = {
    type: "state",
    at: now(),
    from: {
      id: payload.clientId || "http-api",
      nickname: (payload.clientId || "http-api").slice(0, 8),
    },
    state: payload.state,
  };

  const sent = broadcast(roomId, broadcastData);
  log("HTTP /update", {
    roomId,
    sent,
    state: summarizeState(payload.state),
  });

  res.json({ success: true, roomId, sent });
});

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  perMessageDeflate: false,
});

// roomId -> Set<ws>
const rooms = new Map();
// roomId -> latest state
const roomStates = new Map();

let nextConnectionId = 1;

function now() {
  return Date.now();
}

function log(message, extra = null) {
  if (extra) {
    console.log(`[Server ${new Date().toISOString()}] ${message}`, extra);
  } else {
    console.log(`[Server ${new Date().toISOString()}] ${message}`);
  }
}

function summarizeState(state) {
  if (!state || typeof state !== "object") return null;
  return {
    playing: !!state.playing,
    currentTime:
      typeof state.currentTime === "number"
        ? Number(state.currentTime.toFixed(2))
        : state.currentTime,
    playbackRate: state.playbackRate ?? 1,
    lastHostTs: state.lastHostTs ?? null,
    timestamp: state.timestamp ?? null,
  };
}

function safeSend(ws, data, context = "unknown") {
  if (!ws || ws.readyState !== 1) {
    return false;
  }

  try {
    ws.send(JSON.stringify(data));
    return true;
  } catch (error) {
    log(`safeSend failed (${context})`, {
      connId: ws.meta?.connId,
      roomId: ws.meta?.roomId,
      userId: ws.meta?.userId,
      nickname: ws.meta?.nickname,
      error: error.message,
    });
    return false;
  }
}

function getClientCount() {
  let count = 0;
  for (const set of rooms.values()) count += set.size;
  return count;
}

function getRoomSummary() {
  const summary = {};
  for (const [roomId, set] of rooms.entries()) {
    summary[roomId] = Array.from(set).map((ws) => ({
      connId: ws.meta?.connId,
      userId: ws.meta?.userId,
      nickname: ws.meta?.nickname,
      role: ws.meta?.role,
      connectedAt: ws.meta?.connectedAt,
      lastSeenAt: ws.meta?.lastSeenAt,
      lastPingAt: ws.meta?.lastPingAt,
      lastPongAt: ws.meta?.lastPongAt,
      lastStateAt: ws.meta?.lastStateAt,
      closeInfo: ws.meta?.closeInfo || null,
    }));
  }
  return summary;
}

function broadcast(roomId, data, except = null) {
  const set = rooms.get(roomId);
  if (!set) return 0;

  let sentCount = 0;
  const deadClients = [];

  for (const client of set) {
    if (client === except) continue;

    if (client.readyState !== 1) {
      deadClients.push(client);
      continue;
    }

    const ok = safeSend(client, data, `broadcast:${data.type}:room=${roomId}`);

    if (ok) {
      sentCount++;
    } else {
      deadClients.push(client);
    }
  }

  for (const dead of deadClients) {
    set.delete(dead);
  }

  log(`Broadcast ${data.type}`, {
    roomId,
    sentCount,
    skippedDead: deadClients.length,
    exceptConnId: except?.meta?.connId || null,
  });

  if (set.size === 0) {
    rooms.delete(roomId);
    log(`Room deleted after broadcast cleanup`, { roomId });
  }

  return sentCount;
}

function removeClientFromRoom(ws, reason = "unknown") {
  const roomId = ws.meta?.roomId;
  if (!roomId || !rooms.has(roomId)) return;

  const set = rooms.get(roomId);
  set.delete(ws);

  log("Client removed from room", {
    roomId,
    connId: ws.meta?.connId,
    userId: ws.meta?.userId,
    nickname: ws.meta?.nickname,
    reason,
    remaining: set.size,
  });

  if (set.size === 0) {
    rooms.delete(roomId);
    log("Room deleted - empty", { roomId });
  }
}

wss.on("connection", (ws, req) => {
  const connId = nextConnectionId++;

  ws.meta = {
    connId,
    roomId: null,
    userId: null,
    role: "viewer",
    nickname: null,
    ip: req.socket.remoteAddress,
    connectedAt: now(),
    lastSeenAt: now(),
    lastPingAt: null,
    lastPongAt: null,
    lastStateAt: null,
    closeInfo: null,
  };

  log("New connection", {
    connId,
    ip: ws.meta.ip,
    userAgent: req.headers["user-agent"] || null,
  });

  ws.on("message", (raw) => {
    ws.meta.lastSeenAt = now();

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (error) {
      log("Invalid JSON", {
        connId,
        raw: raw.toString().slice(0, 300),
        error: error.message,
      });
      return;
    }

    const type = msg?.type;
    log("Message received", {
      connId,
      type,
      roomId: ws.meta.roomId,
      userId: ws.meta.userId,
      nickname: ws.meta.nickname,
    });

    if (type === "join") {
      const { roomId, userId, role = "viewer", nickname = "Guest" } = msg;

      if (!roomId || !userId) {
        log("Invalid join - missing roomId or userId", {
          connId,
          msg,
        });
        return;
      }

      ws.meta.roomId = roomId;
      ws.meta.userId = userId;
      ws.meta.role = role;
      ws.meta.nickname = nickname;

      if (!rooms.has(roomId)) rooms.set(roomId, new Set());
      rooms.get(roomId).add(ws);

      log("User joined room", {
        connId,
        roomId,
        userId,
        nickname,
        role,
        roomSize: rooms.get(roomId).size,
      });

      broadcast(
        roomId,
        {
          type: "system",
          event: "join",
          at: now(),
          user: { id: userId, nickname, role },
        },
        ws,
      );

      safeSend(
        ws,
        {
          type: "system",
          event: "joined",
          message: `방 ${roomId}에 ${role}로 참여했습니다.`,
        },
        "join-confirmation",
      );

      const existingState = roomStates.get(roomId);
      if (existingState && role === "viewer") {
        safeSend(
          ws,
          {
            type: "state",
            at: now(),
            state: existingState,
          },
          "existing-state",
        );

        log("Sent existing state to new viewer", {
          connId,
          roomId,
          state: summarizeState(existingState),
        });
      }

      return;
    }

    if (!ws.meta.roomId) {
      log("Message received before join", { connId, type });
      return;
    }

    const roomId = ws.meta.roomId;

    if (type === "chat") {
      const payload = {
        type: "chat",
        at: now(),
        from: {
          id: ws.meta.userId,
          nickname: ws.meta.nickname,
          role: ws.meta.role,
        },
        message: String(msg.message ?? "").slice(0, 1000),
      };

      const sent = broadcast(roomId, payload);
      log("Chat broadcast", {
        connId,
        roomId,
        nickname: ws.meta.nickname,
        sent,
        length: payload.message.length,
      });
      return;
    }

    if (type === "state") {
      if (ws.meta.role !== "host") {
        log("Rejected non-host state", {
          connId,
          roomId,
          nickname: ws.meta.nickname,
          role: ws.meta.role,
        });
        return;
      }

      ws.meta.lastStateAt = now();
      roomStates.set(roomId, msg.state);

      const payload = {
        type: "state",
        at: now(),
        from: {
          id: ws.meta.userId,
          nickname: ws.meta.nickname,
        },
        state: msg.state,
      };

      const sent = broadcast(roomId, payload, ws);

      log("Host state broadcast", {
        connId,
        roomId,
        nickname: ws.meta.nickname,
        sent,
        state: summarizeState(msg.state),
      });
      return;
    }

    if (type === "request-sync") {
      const payload = {
        type: "request-sync",
        at: now(),
        from: {
          id: ws.meta.userId,
          nickname: ws.meta.nickname,
        },
      };

      const sent = broadcast(roomId, payload, ws);

      log("Request-sync broadcast", {
        connId,
        roomId,
        nickname: ws.meta.nickname,
        sent,
      });
      return;
    }

    if (type === "ping") {
      ws.meta.lastPingAt = now();

      const clientTs = typeof msg.timestamp === "number" ? msg.timestamp : null;
      const serverTs = now();

      const ok = safeSend(
        ws,
        {
          type: "pong",
          ts: serverTs,
          echoTimestamp: clientTs,
        },
        "pong",
      );

      ws.meta.lastPongAt = serverTs;

      log("Ping/Pong", {
        connId,
        roomId,
        nickname: ws.meta.nickname,
        ok,
        clientTs,
        serverTs,
        oneWayGuessMs: clientTs ? serverTs - clientTs : null,
      });
      return;
    }

    log("Unknown message type", {
      connId,
      roomId,
      type,
      msg,
    });
  });

  ws.on("close", (code, reasonBuffer) => {
    const reason = Buffer.isBuffer(reasonBuffer)
      ? reasonBuffer.toString()
      : String(reasonBuffer || "");

    ws.meta.closeInfo = {
      code,
      reason,
      at: now(),
    };

    log("Connection closed", {
      connId,
      roomId: ws.meta.roomId,
      userId: ws.meta.userId,
      nickname: ws.meta.nickname,
      role: ws.meta.role,
      code,
      reason,
    });

    const { roomId, userId, nickname, role } = ws.meta;
    removeClientFromRoom(ws, `close:${code}`);

    if (roomId && rooms.has(roomId)) {
      broadcast(roomId, {
        type: "system",
        event: "leave",
        at: now(),
        user: { id: userId, nickname, role },
      });
    }
  });

  ws.on("error", (error) => {
    log("WebSocket error", {
      connId,
      roomId: ws.meta.roomId,
      userId: ws.meta.userId,
      nickname: ws.meta.nickname,
      error: error.message,
      stack: error.stack,
    });
  });
});

// 30초마다 서버 관점의 상태 로그
setInterval(() => {
  log("Server heartbeat", {
    uptimeSec: Math.floor(process.uptime()),
    rooms: getRoomSummary(),
    roomCount: rooms.size,
    clientCount: getClientCount(),
  });
}, 30000);

// 메모리/프로세스 상황도 60초마다 출력
setInterval(() => {
  const mem = process.memoryUsage();
  log("Process stats", {
    rssMB: Number((mem.rss / 1024 / 1024).toFixed(2)),
    heapUsedMB: Number((mem.heapUsed / 1024 / 1024).toFixed(2)),
    heapTotalMB: Number((mem.heapTotal / 1024 / 1024).toFixed(2)),
    uptimeSec: Math.floor(process.uptime()),
  });
}, 60000);

process.on("uncaughtException", (error) => {
  log("uncaughtException", {
    error: error.message,
    stack: error.stack,
  });
});

process.on("unhandledRejection", (reason) => {
  log("unhandledRejection", {
    reason: String(reason),
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  log("WS server running", {
    port: PORT,
    wsEndpoint: `ws://localhost:${PORT}`,
    health: `http://localhost:${PORT}/health`,
    debugRooms: `http://localhost:${PORT}/debug/rooms`,
  });
});
