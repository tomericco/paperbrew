// What the PDF renderer (headless Chromium in pdf.ts) may load. Pure, so it is unit-tested directly.
//
// Article HTML is sanitized, but its <img src> still points wherever the original page did,
// so every network request is checked here: only public addresses, only http(s).
import net from 'node:net';
import { isPrivateIp } from '../fetch/ip.js';

const FONT_CSS_HOST = 'fonts.googleapis.com';
const FONT_FILE_HOST = 'fonts.gstatic.com';

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * True when the renderer may fetch `url`, given every address its host resolved to.
 * `data:` URLs never touch the network. Anything else must be http(s), resolve to at least one
 * address, and resolve only to public addresses (one private answer refuses the whole request).
 */
export function allowRendererRequest(url: string, resolvedAddresses: string[]): boolean {
  const u = parse(url);
  if (!u) return false;
  if (u.protocol === 'data:') return true;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;

  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return false;
  if (net.isIP(host) && isPrivateIp(host)) return false;

  if (!resolvedAddresses.length) return false;
  return resolvedAddresses.every((ip) => !isPrivateIp(ip));
}

/**
 * Which kinds of request the renderer makes at all: the blank page it starts on, images,
 * and the Google Fonts stylesheet and font files the magazine links. No scripts, frames,
 * media, XHR/fetch or navigations.
 */
export function allowResourceType(resourceType: string, url: string): boolean {
  const u = parse(url);
  if (!u) return false;
  switch (resourceType) {
    case 'document':
      return url === 'about:blank';
    case 'image':
      return u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'data:';
    case 'stylesheet':
      return u.protocol === 'https:' && u.hostname === FONT_CSS_HOST;
    case 'font':
      return u.protocol === 'https:' && u.hostname === FONT_FILE_HOST;
    default:
      return false;
  }
}
