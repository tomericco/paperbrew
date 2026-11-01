// Prints the magazine HTML to a PDF with headless Chromium.
// On Vercel the browser comes from @sparticuz/chromium; locally it is the installed Chrome (CHROME_PATH).
// Both packages are imported lazily so other API routes, served by the same function, don't load them.
import dns from 'node:dns';
import type { Browser, HTTPRequest } from 'puppeteer-core';
import { config } from '../config.js';
import { allowRendererRequest, allowResourceType } from './requestPolicy.js';

const LOOKUP_TIMEOUT_MS = 3_000;
const CONTENT_TIMEOUT_MS = 30_000;

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
    });
  }
  return puppeteer.launch({ executablePath: config.CHROME_PATH, headless: true });
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

export async function htmlToPdf(html: string): Promise<Uint8Array> {
  const browser = await launch();
  try {
    const page = await browser.newPage();
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
    return await page.pdf({ preferCSSPageSize: true, printBackground: true });
  } finally {
    await browser.close();
  }
}
