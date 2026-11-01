// Vercel Node.js function. vercel.json rewrites every path here; Hono sees the original URL.
// A default export with a fetch(Request) method is served as a Web-standard handler.
import { app } from '../src/app.js';

export default app;
