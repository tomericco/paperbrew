// Prints the magazine HTML to a PDF with headless Chromium.
// On Vercel the browser comes from @sparticuz/chromium; locally it is the installed Chrome (CHROME_PATH).
// Both packages are imported lazily so other API routes, served by the same function, don't load them.
import dns from 'node:dns';
import type { Browser, HTTPRequest } from 'puppeteer-core';
import { config } from '../config.js';
import { createLimiter, onStreamEnd } from './lifecycle.js';
import { allowRendererRequest, allowResourceType } from './requestPolicy.js';

// Time budget for one brew, well inside the function's 300 s maxDuration (apps/api/vercel.json).
const LOOKUP_TIMEOUT_MS = 3_000;
const LAUNCH_TIMEOUT_MS = 30_000;
const CONTENT_TIMEOUT_MS = 30_000;
const PRINT_TIMEOUT_MS = 45_000;
/** From launch to the last PDF byte; when it runs out the browser is closed, whatever it was doing. */
const RENDER_BUDGET_MS = 120_000;
/** How long a second brew waits for the one ahead of it before giving up (BusyError). */
const QUEUE_TIMEOUT_MS = 120_000;

// One Chromium per instance: two at once in 2 GB can OOM the webhook and drain work sharing it.
const browserSlot = createLimiter(1);

async function launch(): Promise<Browser> {
  const { default: puppeteer } = await import('puppeteer-core');
  if (process.env.VERCEL) {
    const { default: chromium } = await import('@sparticuz/chromium');
    chromium.setGraphicsMode = false; // no WebGL needed to print text and images
    // Per the @sparticuz/chromium README: its binary is chrome-headless-shell, so headless: 'shell'.
    return puppeteer.launch({
      args: await puppeteer.defaultArgs({ args: chromium.args, headless: 'shell' }),
      executablePath: await chromium.executablePath(),
      headless: 'shell',
      timeout: LAUNCH_TIMEOUT_MS,
    });
  }
  return puppeteer.launch({ executablePath: config.CHROME_PATH, headless: true, timeout: LAUNCH_TIMEOUT_MS });
}

/** Every address `host` resolves to, or [] if the lookup fails or takes longer than 3 s. */
async function resolveAll(host: string): Promise<string[]> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('dns timeout')), LOOKUP_TIMEOUT_MS);
  });
  try {
    const answers = await Promise.race([dns.promises.lookup(host, { all: true }), timeout]);
    return answers.map((a) => a.address);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Continue the request only if requestPolicy allows it; otherwise abort it (the image is just missing). */
async function screen(req: HTTPRequest): Promise<void> {
  const url = req.url();
  let allowed = false;
  if (allowResourceType(req.resourceType(), url)) {
    if (url === 'about:blank' || url.startsWith('data:')) {
      allowed = true;
    } else {
      const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
      allowed = allowRendererRequest(url, await resolveAll(host));
    }
  }
  if (req.isInterceptResolutionHandled()) return;
  try {
    if (allowed) {
      await req.continue();
    } else {
      console.warn('[brew] blocked renderer request', req.resourceType(), url.slice(0, 200));
      await req.abort('blockedbyclient');
    }
  } catch {
    // The page closed while we were deciding: nothing left to do.
  }
}

/**
 * Prints `html` to a PDF and returns it as a stream, so the response isn't held to Vercel's 4.5 MB body cap.
 * Only one render runs per instance; the browser stays open until the stream ends, errors or is cancelled,
 * or RENDER_BUDGET_MS runs out, and is then closed. Rejects with BusyError if the queue wait times out.
 */
export async function htmlToPdf(html: string): Promise<ReadableStream<Uint8Array>> {
  const release = await browserSlot.acquire(QUEUE_TIMEOUT_MS);
  let browser: Browser | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    clearTimeout(budget);
    try {
      await browser?.close();
    } catch {
      // Already gone.
    } finally {
      release();
    }
  };
  const budget = setTimeout(() => {
    console.warn(`[brew] over the ${RENDER_BUDGET_MS / 1000} s budget, closing the browser`);
    void close();
  }, RENDER_BUDGET_MS);

  try {
    const launched = await launch();
    browser = launched;
    if (closed) {
      // The budget ran out mid-launch (can't happen while LAUNCH_TIMEOUT_MS < RENDER_BUDGET_MS).
      await launched.close().catch(() => {});
      throw new Error('brew ran out of time');
    }
    const page = await launched.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on('request', (req) => void screen(req));

    try {
      // puppeteer-core 25's setContent only waits for load/domcontentloaded; fonts can start
      // after load, so then wait for the network to go quiet (the old networkidle0), same 30 s budget.
      const deadline = Date.now() + CONTENT_TIMEOUT_MS;
      await page.setContent(html, { waitUntil: 'load', timeout: CONTENT_TIMEOUT_MS });
      await page.waitForNetworkIdle({ idleTime: 500, concurrency: 0, timeout: Math.max(1, deadline - Date.now()) });
    } catch (err) {
      // A slow image host shouldn't sink the whole issue: print what has loaded.
      if ((err as Error).name !== 'TimeoutError') throw err;
      console.warn('[brew] content still loading after 30 s, printing anyway');
    }
    const pdf = await page.createPDFStream({ preferCSSPageSize: true, printBackground: true, timeout: PRINT_TIMEOUT_MS });
    return onStreamEnd(pdf, close);
  } catch (err) {
    await close();
    throw err;
  }
}
