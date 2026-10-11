import type { Express } from 'express';
import { readFileSync } from 'node:fs';

// A literal URL relative to this module lets Vercel's file tracing bundle the page, and resolves the same from src/ and dist/.
const guide = () => readFileSync(new URL('../../docs/guide/index.html', import.meta.url), 'utf8');

// The team guide describes the API and holds no data, so it needs no key.
export function registerDocs(app: Express) {
  app.get('/docs', (_req, res) => { res.type('html').send(guide()); });
}
