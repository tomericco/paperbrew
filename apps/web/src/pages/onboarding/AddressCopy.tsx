import { useEffect, useRef, useState } from 'react';

/** The private forwarding address with a Copy button. Where the clipboard is blocked, the address is selected instead. */
export function AddressCopy({ address }: { address: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'selected'>('idle');
  const codeRef = useRef<HTMLElement>(null);
  const timer = useRef<number>(0);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(address);
      setState('copied');
      timer.current = window.setTimeout(() => setState('idle'), 1500);
    } catch {
      // Clipboard blocked or unavailable: select the address so Ctrl/Cmd+C copies it.
      if (codeRef.current) getSelection()?.selectAllChildren(codeRef.current);
      setState('selected');
    }
  }

  return (
    <div className="ob-address">
      <div className="ob-address-row">
        <code ref={codeRef} className="ob-address-code">
          {address}
        </code>
        <button type="button" className="ob-copy" onClick={() => void copy()}>
          {state === 'copied' ? 'Copied' : 'Copy'}
        </button>
      </div>
      {/* Announces the copy for screen readers; the button label changes for everyone else. */}
      <span className="visually-hidden" role="status">
        {state === 'copied' ? 'Address copied.' : ''}
      </span>
      <p className="ob-muted ob-small" role="status">
        {state === 'selected' ? 'Address selected. Press Ctrl+C (Cmd+C on a Mac) to copy it.' : ''}
      </p>
    </div>
  );
}
