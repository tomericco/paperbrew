import { serve } from '@hono/node-server';
import { app } from './app.js';
import { config } from './config.js';

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`Paperbrew API listening on :${info.port}`);
});
