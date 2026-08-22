'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * An address a merchant needs to hand to someone else, with a button that puts the
 * exact string on the clipboard. The displayed text and the copied text are the same
 * value, so what they paste is always what they saw.
 */

type CopyState = 'idle' | 'copied' | 'failed';

export function CopyField({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  function flash(next: CopyState) {
    setState(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2000);
  }

  async function copy() {
    // navigator.clipboard needs a secure context, which a deployment served over
    // plain http (a LAN address, say) will not have. Fall back rather than fail.
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        flash('copied');
        return;
      }
    } catch {
      // fall through to the legacy path
    }

    try {
      const scratch = document.createElement('textarea');
      scratch.value = value;
      scratch.setAttribute('readonly', '');
      scratch.style.position = 'fixed';
      scratch.style.opacity = '0';
      document.body.appendChild(scratch);
      scratch.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(scratch);
      flash(ok ? 'copied' : 'failed');
    } catch {
      flash('failed');
    }
  }

  return (
    <span className="copyfield">
      <span className="copyfield-value">{value}</span>
      <button
        type="button"
        onClick={copy}
        className="copyfield-button"
        aria-label={`Copy ${label} to clipboard`}
      >
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select it' : 'Copy'}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {state === 'copied' ? `${label} copied to clipboard` : ''}
      </span>
    </span>
  );
}
