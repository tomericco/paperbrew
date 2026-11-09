import { useEffect, useState } from 'react';

const POUR_EVERY_MS = 30_000;

/**
 * The Paperbrew mark: a classic espresso machine (cup rail, gauge, group head with a straight portafilter
 * handle and spout, drip tray) pouring into a cup. Drawn on a 64-unit grid in currentColor.
 * The stream is hidden until `pouring`, then falls, holds and drains once (see .logo-pour in styles.css).
 * Keep the shapes in sync with public/favicon.svg.
 */
export function LogoMark({
  size = 34,
  pouring = false,
  onPourEnd,
}: {
  size?: number;
  pouring?: boolean;
  onPourEnd?: () => void;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* Cup rail, body and pressure gauge */}
      <path d="M20 4h24" />
      <rect x="16" y="8" width="32" height="46" rx="4" />
      <circle cx="32" cy="15" r="3.5" />
      {/* Group head, portafilter handle and spout */}
      <path d="M25 22h14v3a3 3 0 0 1-3 3h-8a3 3 0 0 1-3-3z" />
      <path d="M39 24.5h14" />
      <path d="M29.5 28h5l-1 3h-3z" />
      {/* The pour: pathLength 10 lets the CSS animate it with fixed dash values */}
      <path
        className={pouring ? 'logo-pour is-pouring' : 'logo-pour'}
        pathLength={10}
        strokeWidth={4}
        d="M32 31.5v8.5"
        onAnimationEnd={onPourEnd}
      />
      {/* Cup resting on the drip tray: its bottom edge (y 51.4 + half stroke) meets the tray's top edge */}
      <path d="M23 41h18a9 10.4 0 0 1-18 0z" />
      <path d="M12 54h40v5H12z" />
    </svg>
  );
}

/** The header brand: mark plus wordmark, linking home. Pours on load, every 30 s, and on hover. */
export function Brand() {
  const [pouring, setPouring] = useState(true);

  useEffect(() => {
    const id = setInterval(() => setPouring(true), POUR_EVERY_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <a className="brand" href="/" onMouseEnter={() => setPouring(true)}>
      <LogoMark pouring={pouring} onPourEnd={() => setPouring(false)} />
      Paperbrew
    </a>
  );
}
