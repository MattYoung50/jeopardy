import { useState } from 'react';

export default function ShareLink({ label, url, open = false, wrap = false }: { label: string; url: string; open?: boolean; wrap?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  async function copy() {
    try {
      // Clipboard API is unavailable on plain HTTP LAN origins.
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const input = document.createElement('textarea');
        input.value = url;
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.appendChild(input);
        const focused = document.activeElement;
        try {
          input.select();
          if (!document.execCommand('copy')) throw new Error('Copy failed');
        } finally {
          input.remove();
          if (focused instanceof HTMLElement) focused.focus();
        }
      }
      setError(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(true);
    }
  }
  return (
    <div className="bg-gray-800 rounded p-2 flex items-center gap-2">
      <div className="flex-1 min-w-0">
        <div className="text-xs text-gray-400">{label}</div>
        <div className={`${wrap ? 'text-lg break-all select-all' : 'text-xs truncate'} text-gray-300 font-mono`}>{url}</div>
        {error && <p role="status" className="text-sm text-yellow-300">Select and copy the URL above.</p>}
      </div>
      {open && <a href={url} target="_blank" rel="noopener noreferrer" title="Open in a new tab" className="text-xs btn-ghost py-1 px-2 flex-shrink-0">Open</a>}
      <button className="text-xs btn-ghost py-1 px-2 flex-shrink-0" onClick={copy}>
        {copied ? '✓' : 'Copy'}
      </button>
    </div>
  );
}
