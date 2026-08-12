import { Router } from 'express';
import { ingestRequestSchema } from '../validation/logEntry.schema';
import { validateBatch, insertBatch } from '../services/ingestion.service';
import { validateQueryParams, queryLogs } from '../services/query.service';
import { validateAggregateParams, aggregateLogs } from '../services/aggregate.service';
export const logsRouter = Router();

logsRouter.post('/logs', async (req, res) => {
  const parsedRequest = ingestRequestSchema.safeParse(req.body);

  if (!parsedRequest.success) {
    return res.status(400).json({ error: 'invalid request body' });
  }

  const { accepted, rejected } = validateBatch(parsedRequest.data.logs);

  if (accepted.length === 0) {
    return res.status(400).json({ accepted: 0, rejected });
  }

  try {
    await insertBatch(accepted);
  } catch (error) {
    console.error('Insert failed:', error);
    return res.status(500).json({ error: 'failed to store logs' });
  }

  res.status(200).json({ accepted: accepted.length, rejected });
});






logsRouter.get('/logs', async (req, res) => {
  const attrFilters: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.query)) {
    if (key.startsWith('attr.') && typeof value === 'string') {
      attrFilters[key.slice('attr.'.length)] = value;
    }
  }

  const params = {
    service: typeof req.query.service === 'string' ? req.query.service : undefined,
    level: typeof req.query.level === 'string' ? req.query.level : undefined,
    since: typeof req.query.since === 'string' ? req.query.since : undefined,
    until: typeof req.query.until === 'string' ? req.query.until : undefined,
    q: typeof req.query.q === 'string' ? req.query.q : undefined,
    limit: req.query.limit !== undefined ? Number(req.query.limit) : undefined,
    cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
    attrFilters,
  };

  const validationError = validateQueryParams(params);
  if (validationError) {
    return res.status(400).json(validationError);
  }

  try {
    const result = await queryLogs(params);
    res.status(200).json(result);
  } catch (error) {
    console.error('Query failed:', error);
    res.status(500).json({ error: 'failed to query logs' });
  }
});




logsRouter.get('/logs/aggregate', async (req, res) => {
  const attrFilters: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.query)) {
    if (key.startsWith('attr.') && typeof value === 'string') {
      attrFilters[key.slice('attr.'.length)] = value;
    }
  }

  const params = {
    service: typeof req.query.service === 'string' ? req.query.service : undefined,
    level: typeof req.query.level === 'string' ? req.query.level : undefined,
    q: typeof req.query.q === 'string' ? req.query.q : undefined,
    since: typeof req.query.since === 'string' ? req.query.since : undefined,
    until: typeof req.query.until === 'string' ? req.query.until : undefined,
    bucket: typeof req.query.bucket === 'string' ? req.query.bucket : undefined,
    group_by: typeof req.query.group_by === 'string' ? req.query.group_by : undefined,
    attrFilters,
  };

  const validationError = validateAggregateParams(params);
  if (validationError) {
    return res.status(400).json(validationError);
  }

  try {
    const buckets = await aggregateLogs(params);
    res.status(200).json({ buckets });
  } catch (error) {
    console.error('Aggregate failed:', error);
    res.status(500).json({ error: 'failed to aggregate logs' });
  }
});