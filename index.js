// 개선된 CORS 프록시 서버 - Vercel 배포용
const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
const axios = require('axios');
const app = express();

// CORS 설정 강화
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204
}));

// 프리플라이트 요청 명시적 처리
app.options('*', cors());

// JSON 파싱 설정
app.use(express.json());

// 로깅 미들웨어
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// 기본 라우트
app.get('/', (req, res) => {
  res.send('D+ Party CORS Proxy Server - Running');
});

// 상태 확인 엔드포인트 - 직접 axios로 구현
app.get('/state', async (req, res) => {
  const roomId = req.query.room || 'default';
  const targetUrl = req.query.target || '';
  
  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing target parameter' });
  }
  
  try {
    // targetUrl이 http:// 또는 https://로 시작하는지 확인
    let url = targetUrl;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    
    // URL에서 ws:// 또는 wss:// 제거
    url = url.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');
    
    // URL에 '/state' 추가
    if (!url.endsWith('/')) {
      url += '/';
    }
    url += `state?room=${encodeURIComponent(roomId)}`;
    
    console.log(`Proxying GET request to: ${url}`);
    
    // axios로 요청 보내기
    const response = await axios.get(url, {
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://party-dotoris-projects.vercel.app'
      }
    });
    
    // CORS 헤더 추가
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    
    // 응답 데이터 반환
    res.json(response.data);
  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(500).json({ 
      error: 'Proxy error', 
      message: error.message,
      url: url
    });
  }
});

// 상태 업데이트 엔드포인트 - 직접 axios로 구현
app.post('/update', async (req, res) => {
  const roomId = req.query.room || 'default';
  const targetUrl = req.query.target || '';
  
  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing target parameter' });
  }
  
  try {
    // targetUrl이 http:// 또는 https://로 시작하는지 확인
    let url = targetUrl;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    
    // URL에서 ws:// 또는 wss:// 제거
    url = url.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');
    
    // URL에 '/update' 추가
    if (!url.endsWith('/')) {
      url += '/';
    }
    url += `update?room=${encodeURIComponent(roomId)}`;
    
    console.log(`Proxying POST request to: ${url}`);
    console.log(`Request body:`, req.body);
    
    // axios로 요청 보내기
    const response = await axios.post(url, req.body, {
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://party-dotoris-projects.vercel.app'
      }
    });
    
    // CORS 헤더 추가
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    
    // 응답 데이터 반환
    res.json(response.data);
  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(500).json({ 
      error: 'Proxy error', 
      message: error.message,
      url: url
    });
  }
});

// WebSocket 관련 엔드포인트 (Vercel은 WebSocket 지원이 제한적)
app.get('/ws', (req, res) => {
  res.json({ 
    message: 'WebSocket 직접 지원은 불가능합니다. HTTP 기반 폴링을 사용하세요.',
    version: '1.0.0'
  });
});

// 모든 요청에 CORS 헤더 추가
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  next();
});

// Vercel은 module.exports = app을 사용
module.exports = app;

// 로컬 개발 환경에서 실행할 경우
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`CORS Proxy Server running on port ${PORT}`);
  });
}