
import 'dotenv/config';
import { createServer, type RequestListener } from 'node:http';

const PORT = 8080;
const startingResponse = JSON.stringify({ status: 'starting' });

// Bind the port before loading the database-backed application. Docker Compose
// can report a container as started a few milliseconds before Node has loaded
// Express; returning a normal 503 during that window lets health pollers retry.
let handler: RequestListener = (_req, res) => {
  res.writeHead(503, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(startingResponse),
  });
  res.end(startingResponse);
};

const server = createServer((req, res) => handler(req, res));

server.listen(PORT, async () => {
  try {
    const [{ app }, { startRetentionScheduler }] = await Promise.all([
      import('./app.js'),
      import('./services/retention.service.js'),
    ]);

    handler = app as unknown as RequestListener;
    startRetentionScheduler();
    console.log(`Server listening on port ${PORT}`);
  } catch (error) {
    console.error('Application startup failed:', error);
  }
});
