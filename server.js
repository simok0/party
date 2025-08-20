// server/server.js
// CORS 지원 강화 버전
// 개발 편의를 위해 ws:// (비TLS) 사용. 배포 시에는 wss://(TLS)로 전환 권장.

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const cors = require('cors');  // CORS 패키지 추가

const app = express();

// CORS 설정 강화
app.use(cors({
  origin: '*',  // 모든 도메인에서 요청 허용
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// JSON 파싱 설정
app.use(express.json());

app.get('/', (_req, res) => res.send('D+ Party WS server alive'));

// 로깅 미들웨어
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// CORS preflight 요청 대응
app.options('*', cors());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// roomId -> Set<ws>
const rooms = new Map();
// roomId -> 최신 상태
const roomStates = new Map();

function now() { return Date.now(); }

function log(...args) {
  console.log('[Server]', new Date().toISOString(), ...args);
}

function broadcast(roomId, data, except) {
  const set = rooms.get(roomId);
  if (!set) return;
  
  let sentCount = 0;
  for (const client of set) {
    if (client.readyState === 1 && client !== except) {
      try {
        client.send(JSON.stringify(data));
        sentCount++;
      } catch (e) {
        log('Broadcast error:', e.message);
      }
    }
  }
  log(`Broadcast to room ${roomId}: ${sentCount} clients`);
}

// HTTP API 추가 - 방 상태 조회
app.get('/state', (req, res) => {
  const roomId = req.query.room;
  if (!roomId) {
    return res.status(400).json({ error: 'Missing room parameter' });
  }
  
  const state = roomStates.get(roomId);
  res.json({ state });
  log(`HTTP GET /state for room ${roomId}`);
});

// HTTP API 추가 - 상태 업데이트
app.post('/update', (req, res) => {
  const roomId = req.query.room;
  if (!roomId) {
    return res.status(400).json({ error: 'Missing room parameter' });
  }
  
  const payload = req.body;
  if (!payload || !payload.state) {
    return res.status(400).json({ error: 'Invalid state data' });
  }
  
  // 상태 저장
  roomStates.set(roomId, payload.state);
  
  // WebSocket 클라이언트에도 브로드캐스트
  const broadcastData = {
    type: 'state',
    at: now(),
    from: { id: payload.clientId, nickname: payload.clientId.substr(0, 8) },
    state: payload.state
  };
  
  broadcast(roomId, broadcastData);
  
  res.json({ success: true });
  log(`HTTP POST /update for room ${roomId}: ${JSON.stringify(payload.state)}`);
});

wss.on('connection', (ws) => {
  ws.meta = { roomId: null, userId: null, role: 'viewer', nickname: null };
  log('New connection');

  ws.on('message', (raw) => {
    let msg;
    try { 
      msg = JSON.parse(raw.toString()); 
      log('Received:', msg);
    } catch(e) { 
      log('Invalid JSON:', raw.toString());
      return; 
    }
    
    const type = msg?.type;

    if (type === 'join') {
      const { roomId, userId, role = 'viewer', nickname = 'Guest' } = msg;
      if (!roomId || !userId) {
        log('Invalid join message - missing roomId or userId');
        return;
      }
      
      ws.meta.roomId = roomId;
      ws.meta.userId = userId;
      ws.meta.role = role;
      ws.meta.nickname = nickname;
      
      if (!rooms.has(roomId)) rooms.set(roomId, new Set());
      rooms.get(roomId).add(ws);
      
      log(`User joined: ${nickname} (${userId}) as ${role} in room ${roomId}`);

      // 방 참여 알림
      const joinNotification = {
        type: 'system',
        event: 'join',
        at: now(),
        user: { id: userId, nickname, role }
      };
      broadcast(roomId, joinNotification, ws); // 본인 제외하고 브로드캐스트
      
      // 본인에게 확인 메시지
      try {
        ws.send(JSON.stringify({
          type: 'system',
          event: 'joined',
          message: `방 ${roomId}에 ${role}로 참여했습니다.`
        }));
        
        // 기존 상태 전송
        const existingState = roomStates.get(roomId);
        if (existingState && role === 'viewer') {
          ws.send(JSON.stringify({
            type: 'state',
            at: now(),
            state: existingState
          }));
          log(`Sent existing state to new viewer in room ${roomId}`);
        }
      } catch(e) {}
      
      return;
    }

    if (!ws.meta.roomId) {
      log('Message received before join');
      return;
    }
    
    const roomId = ws.meta.roomId;

    // 채팅
    if (type === 'chat') {
      const payload = {
        type: 'chat',
        at: now(),
        from: { id: ws.meta.userId, nickname: ws.meta.nickname, role: ws.meta.role },
        message: String(msg.message ?? '').slice(0, 1000)
      };
      log(`Chat from ${ws.meta.nickname}: ${payload.message}`);
      broadcast(roomId, payload); // 모든 사용자에게 브로드캐스트 (본인 포함)
      return;
    }

    // 재생 상태 (호스트만 허용)
    if (type === 'state') {
      if (ws.meta.role !== 'host') {
        log(`Non-host ${ws.meta.nickname} tried to send state`);
        return;
      }
      
      const payload = {
        type: 'state',
        at: now(),
        from: { id: ws.meta.userId, nickname: ws.meta.nickname },
        state: msg.state // { playing, currentTime, playbackRate, lastHostTs }
      };
      
      // 상태 저장 (HTTP API 용)
      roomStates.set(roomId, msg.state);
      
      log(`State from host ${ws.meta.nickname}:`, payload.state);
      broadcast(roomId, payload, ws); // 호스트 제외하고 브로드캐스트
      return;
    }

    // 강제 동기화 요청 (팔로워 → 호스트)
    if (type === 'request-sync') {
      const payload = {
        type: 'request-sync', 
        at: now(), 
        from: { id: ws.meta.userId, nickname: ws.meta.nickname }
      };
      broadcast(roomId, payload, ws);
      return;
    }
    
    // Ping/Pong
    if (type === 'ping') {
      try {
        ws.send(JSON.stringify({ type: 'pong', ts: now() }));
      } catch(e) {}
      return;
    }
    
    log('Unknown message type:', type);
  });

  ws.on('close', (code, reason) => {
    const { roomId, userId, nickname, role } = ws.meta;
    log(`Connection closed: ${nickname} (${userId}), code: ${code}, reason: ${reason}`);
    
    if (roomId && rooms.has(roomId)) {
      rooms.get(roomId).delete(ws);
      
      // 방이 비었으면 상태 정리 (단, 상태는 보존)
      if (!rooms.get(roomId).size) {
        rooms.delete(roomId);
        log(`Room ${roomId} deleted - empty`);
      } else {
        // 퇴장 알림
        broadcast(roomId, {
          type: 'system',
          event: 'leave',
          at: now(),
          user: { id: userId, nickname, role }
        });
      }
    }
  });

  ws.on('error', (error) => {
    log('WebSocket error:', error.message);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  log(`Server running on port ${PORT}`);
  log(`WebSocket: ws://localhost:${PORT}`);
  log(`HTTP API: http://localhost:${PORT}`);
});