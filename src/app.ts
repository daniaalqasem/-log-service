import express from 'express';
import { pool } from './db/client';
import { logsRouter } from './routes/logs';

export const app = express();

app.use(express.json());

app.use(logsRouter);

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(503).json({ status: 'unavailable' });
  }
});