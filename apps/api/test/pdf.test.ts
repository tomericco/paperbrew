import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// htmlToPdf with a fake puppeteer: checks that the browser is closed once the PDF stream is done
// and that two brews never have a browser open at the same time. No Chromium needed.
vi.mock('../src/config.js', () => ({ config: { CHROME_PATH: '/fake/chrome' } }));

type FakeBrowser = { close: ReturnType<typeof vi.fn>; newPage: ReturnType<typeof vi.fn> };
const browsers: FakeBrowser[] = [];
let openBrowsers = 0;
let maxOpen = 0;
let pdfStream: () => ReadableStream<Uint8Array>;
let setContentError: Error | undefined;

function fakeBrowser(): FakeBrowser {
  openBrowsers++;
  maxOpen = Math.max(maxOpen, openBrowsers);
  const page = {
    setJavaScriptEnabled: vi.fn(async () => {}),
    setRequestInterception: vi.fn(async () => {}),
    on: vi.fn(),
    setContent: vi.fn(async () => {
      if (setContentError) throw setContentError;
    }),
    waitForNetworkIdle: vi.fn(async () => {}),
    createPDFStream: vi.fn(async () => pdfStream()),
  };
  let closed = false;
  const browser = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => {
      if (!closed) openBrowsers--;
      closed = true;
    }),
  };
  browsers.push(browser);
  return browser;
}

const launch = vi.fn(async () => fakeBrowser());
vi.mock('puppeteer-core', () => ({ default: { launch } }));

const { htmlToPdf } = await import('../src/brew/pdf.js');

/** A stream that hands out `chunks` and then waits until `finish()` is called before ending. */
function heldStream(chunks: number[][]) {
  let finish!: () => void;
  const finished = new Promise<void>((r) => (finish = r));
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i < chunks.length) return controller.enqueue(new Uint8Array(chunks[i++]));
      await finished;
      controller.close();
    },
  });
  return { stream, finish };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('htmlToPdf', () => {
  beforeEach(() => {
    browsers.length = 0;
    openBrowsers = 0;
    maxOpen = 0;
    setContentError = undefined;
    launch.mockClear();
    pdfStream = () => heldStream([[37, 80, 68, 70]]).stream;
  });
  afterEach(() => vi.restoreAllMocks());

  it('streams the PDF and closes the browser only after the last byte', async () => {
    const held = heldStream([[37, 80], [68, 70]]);
    pdfStream = () => held.stream;

    const out = await htmlToPdf('<p>hi</p>');
    const body = new Response(out).arrayBuffer();
    await tick();
    expect(browsers[0].close).not.toHaveBeenCalled(); // still streaming
    held.finish();
    expect([...new Uint8Array(await body)]).toEqual([37, 80, 68, 70]);
    expect(browsers[0].close).toHaveBeenCalledTimes(1);
  });

  it('runs two concurrent brews one browser at a time', async () => {
    const first = heldStream([[1]]);
    const second = heldStream([[2]]);
    const queue = [first, second];
    pdfStream = () => queue.shift()!.stream;

    const a = htmlToPdf('a');
    const b = htmlToPdf('b');
    const streamA = await a;
    await tick();
    expect(launch).toHaveBeenCalledTimes(1); // b waits for a's browser to close

    const bodyA = new Response(streamA).arrayBuffer();
    first.finish();
    await bodyA;
    const streamB = await b;
    expect(launch).toHaveBeenCalledTimes(2);
    second.finish();
    await new Response(streamB).arrayBuffer();

    expect(maxOpen).toBe(1);
    expect(openBrowsers).toBe(0);
  });

  it('closes the browser when the client cancels the download', async () => {
    const out = await htmlToPdf('x');
    await out.cancel('client aborted');
    expect(browsers[0].close).toHaveBeenCalledTimes(1);
    // The slot is free again.
    const next = await htmlToPdf('y');
    await next.cancel();
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('closes the browser and frees the slot when rendering fails before the stream starts', async () => {
    setContentError = new Error('page crashed');
    await expect(htmlToPdf('x')).rejects.toThrow('page crashed');
    expect(browsers[0].close).toHaveBeenCalledTimes(1);
    setContentError = undefined;
    const next = await htmlToPdf('y');
    await next.cancel();
    expect(launch).toHaveBeenCalledTimes(2);
  });
});
