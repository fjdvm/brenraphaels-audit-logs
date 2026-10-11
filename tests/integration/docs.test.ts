import { expect, test } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../../src/http/app.ts';

// The guide is static, so no query runs and no database is needed.
const app = createApp(new Pool());

test('serves the team guide without an API key', async () => {
  const response = await request(app).get('/docs');
  expect(response.status).toBe(200);
  expect(response.type).toBe('text/html');
  expect(response.text).toContain('Audit Logs API');
});

test('keeps the Audit Event routes behind keys', async () => {
  expect((await request(app).get('/events')).status).toBe(401);
});
