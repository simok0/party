// CORS 프록시 서버 - Vercel 배포용
const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
const app = express();

// CORS 설정 - 모든 도메인에서의 요청 허용
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// 프록시 로깅 미들웨어
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// 기본 라우트
app.get('/', (req, res) => {
  res.send('D+ Party CORS Proxy Server - Running');
});

// 상태 확인 엔드포인트
app.get('/state', (req, res) => {
  const roomId = req.query.room || 'default';
  const targetUrl = req.query.target || '';
  
  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing target parameter' });
  }
  
  // targetUrl이 http:// 또는 https://로 시작하는지 확인
  let url = targetUrl;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  
  // URL에 '/state' 추가
  if (!url.endsWith('/')) {
    url += '/';
  }
  url += `state?room=${encodeURIComponent(roomId)}`;
  
  // 프록시 설정
  const proxy = createProxyMiddleware({
    target: url,
    changeOrigin: true,
    pathRewrite: () => '',
    onProxyRes: (proxyRes, req, res) => {
      proxyRes.headers['Access-Control-Allow-Origin'] = '*';
    }
  });
  
  proxy(req, res, (err) => {
    if (err) {
      console.error('Proxy error:', err);
      res.status(500).json({ error: 'Proxy error', message: err.message });
    }
  });
});

// 상태 업데이트 엔드포인트
app.post('/update', express.json(), (req, res) => {
  const roomId = req.query.room || 'default';
  const targetUrl = req.query.target || '';
  
  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing target parameter' });
  }
  
  // targetUrl이 http:// 또는 https://로 시작하는지 확인
  let url = targetUrl;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  
  // URL에 '/update' 추가
  if (!url.endsWith('/')) {
    url += '/';
  }
  url += `update?room=${encodeURIComponent(roomId)}`;
  
  // 프록시 설정
  const proxy = createProxyMiddleware({
    target: url,
    changeOrigin: true,
    pathRewrite: () => '',
    onProxyRes: (proxyRes, req, res) => {
      proxyRes.headers['Access-Control-Allow-Origin'] = '*';
    }
  });
  
  proxy(req, res, (err) => {
    if (err) {
      console.error('Proxy error:', err);
      res.status(500).json({ error: 'Proxy error', message: err.message });
    }
  });
});

// WebSocket 프록시 - Vercel은 WebSocket 지원이 제한적이므로 
// HTTP 기반 폴링 방식으로 구현합니다

// 포트 설정
const PORT = process.env.PORT || 3000;

// Vercel은 module.exports = app을 사용
module.exports = app;

// 로컬 개발 환경에서 실행할 경우
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`CORS Proxy Server running on port ${PORT}`);
  });
}