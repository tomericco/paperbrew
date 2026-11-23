import { serve } from '@hono/node-server';
import { app } from './app.js';
import { config } from './config.js';

// overrideGlobalObjects: false keeps the global Response native; otherwise transformers.js's
// `response instanceof Response` check fails on its own downloads. (Vercel's entry never patches it.)
serve({ fetch: app.fetch, port: config.PORT, overrideGlobalObjects: false }, (info) => {
  console.log(`Paperbrew API listening on :${info.port}`);
});
