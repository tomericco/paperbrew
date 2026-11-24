import { useEffect, useRef, useState } from 'react';
import { errorText } from './layouts';

export type Device = { id: string; name: string; createdAt: string; lastSeenAt: string | null };

const POLL_MS = 2000;
const GIVE_UP_MS = 10 * 60 * 1000;
const HELP_AFTER_MS = 5000;

const CONNECT_ERROR = "Couldn't start the connection. Try again.";

/** A GET that sends a signed-out user to sign-in. Throws when the request fails. */
export async function getJson<T>(path: string): Promise<T | null> {
  const res = await fetch(path);
  if (res.status === 401) {
    location.replace('/signin');
    return null;
  }
  if (!res.ok) throw new Error();
  return (await res.json()) as T;
}

/**
 * Connecting a Mac, shared by the Settings printer section and the onboarding card: the paired devices, and the
 * pair-code flow. `connect` asks for a code and opens the `paperbrew://` link; then the devices are read every
 * 2 s until one shows up, for at most 10 minutes, and the polling stops when the component unmounts.
 * `onPaired` runs once a device has appeared.
 */
export function usePairing(onPaired?: () => void) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [pairing, setPairing] = useState<{ code: string } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const paired = useRef(onPaired);
  paired.current = onPaired;

  useEffect(() => {
    let cancelled = false;
    getJson<{ devices: Device[] }>('/api/me/print-devices')
      .then((body) => {
        if (!cancelled && body) setDevices(body.devices);
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load your printer.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // After Connect: ask for the device every 2 s until it shows up, for at most 10 minutes. Stops on unmount too.
  useEffect(() => {
    if (!pairing) return;
    let stopped = false;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > GIVE_UP_MS) {
        clearInterval(timer);
        setPairing(null);
        setTimedOut(true);
        return;
      }
      getJson<{ devices: Device[] }>('/api/me/print-devices')
        .then((body) => {
          if (stopped || !body || body.devices.length === 0) return;
          clearInterval(timer);
          setDevices(body.devices);
          setPairing(null);
          paired.current?.();
        })
        .catch(() => {
          // A missed poll is fine; the next one tries again.
        });
    }, POLL_MS);
    const help = setTimeout(() => setShowHelp(true), HELP_AFTER_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
      clearTimeout(help);
    };
  }, [pairing]);

  async function connect() {
    if (connecting) return;
    setConnecting(true);
    setError('');
    setTimedOut(false);
    setShowHelp(false);
    setCopied(false);
    try {
      const res = await fetch('/api/me/print-devices/pair-code', { method: 'POST' });
      if (res.status === 401) {
        location.replace('/signin');
        return;
      }
      if (!res.ok) {
        setError(await errorText(res, CONNECT_ERROR));
        return;
      }
      const body = (await res.json()) as { code: string; link: string };
      setPairing({ code: body.code });
      // Hands over to the Paperbrew app when it is installed; otherwise nothing happens and the page says so.
      location.href = body.link;
    } catch {
      setError(CONNECT_ERROR);
    } finally {
      setConnecting(false);
    }
  }

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy. Select the code and copy it by hand.');
    }
  }

  return { devices, setDevices, loadError, pairing, connecting, showHelp, timedOut, copied, error, setError, connect, copyCode };
}
