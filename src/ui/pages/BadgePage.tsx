// src/ui/pages/BadgePage.tsx
//
// Explains the badge embed and lets an operator tune its look (theme + size) and
// placement, with a live-style preview and a snippet that updates as they choose.
// Also generates a plain-language brief they can hand to an AI coding assistant
// to do the wiring. The preview mirrors embed.ts's rendered pill; the real badge
// shows the live, signed verdict on the operator's own page.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CodeBlock } from '../CodeBlock.tsx';

type Theme = 'light' | 'dark' | 'auto';
type Variant = 'default' | 'compact';
type Placement = 'inline' | 'header' | 'corner' | 'custom';

// Matches embed.ts's tone→colour map and light/dark palettes.
const OK = '#0891b2';
const PALETTE = {
  light: { bg: '#ffffff', fg: '#0a0e1a', sub: '#64748b' },
  dark: { bg: '#0d121c', fg: '#f2f6fc', sub: '#94a3b8' },
};

const PLACEMENTS: Array<{ key: Placement; label: string }> = [
  { key: 'inline', label: 'Inline' },
  { key: 'header', label: 'Next to a logo' },
  { key: 'corner', label: 'Fixed corner' },
  { key: 'custom', label: 'Custom' },
];

function Preview({ theme, variant }: { theme: Theme; variant: Variant }) {
  const pal = theme === 'dark' ? PALETTE.dark : PALETTE.light;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        font: '500 12px/1.2 ui-sans-serif, system-ui, sans-serif',
        border: `1px solid ${OK}33`,
        borderRadius: 8,
        padding: '6px 10px',
        background: pal.bg,
        color: pal.fg,
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: OK, flex: 'none' }} />
      <span style={{ color: OK, fontWeight: 600 }}>Trustwright: verified</span>
      {variant === 'default' && <span style={{ color: pal.sub }}>tools match audit</span>}
    </span>
  );
}

const CONTAINER: Partial<Record<Placement, string>> = {
  header: '<!-- put this in your header, immediately BEFORE the logo -->\n<div id="trustwright-badge" style="display:inline-flex;align-items:center;margin-right:14px"></div>',
  corner: '<!-- add once in your app shell so it survives navigation -->\n<div id="trustwright-badge" style="position:fixed;bottom:12px;right:12px;z-index:9999"></div>',
};

export function BadgePage() {
  const apiBase = location.origin;
  const [theme, setTheme] = useState<Theme>('light');
  const [variant, setVariant] = useState<Variant>('default');
  const [origin, setOrigin] = useState('https://your-site.com');
  const [placement, setPlacement] = useState<Placement>('inline');
  const [customMount, setCustomMount] = useState('');

  const mount = placement === 'custom' ? customMount.trim() : placement === 'inline' ? '' : '#trustwright-badge';
  const containerSnippet = CONTAINER[placement];

  const attrs = [
    `        data-origin="${origin || 'https://your-site.com'}"`,
    theme !== 'light' ? `        data-theme="${theme}"` : '',
    variant !== 'default' ? `        data-variant="${variant}"` : '',
    mount ? `        data-mount="${mount}"` : '',
  ].filter(Boolean);
  const snippet = `<script src="${apiBase}/badge.js"\n${attrs.join('\n')}></script>`;

  const placeStep =
    placement === 'inline'
      ? 'No container needed. Put the <script> tag where the badge should appear, e.g. in the site footer, or in the header right after the logo. The badge renders inline at that spot.'
      : placement === 'header'
        ? `Add this empty container in the header, immediately BEFORE the logo element so the badge sits to its left:\n${containerSnippet}\nThen add the <script> above once, in the root layout / index.html.`
        : placement === 'corner'
          ? `Add this fixed-position container once in the app shell so it persists across navigation:\n${containerSnippet}\nThen add the <script> above once, in the root layout / index.html.`
          : `The badge renders into the element matching "${mount || '#your-selector'}". Make sure that element exists where you want the badge, then add the <script> above once, in the root layout / index.html.`;

  const agentBrief = `Add the Trustwright trust badge to this website.

1. Add this badge script exactly once. For a React/Next/Vue/SvelteKit app, put it in the root layout or index.html (NOT inside a single component), so it loads on every page:

${snippet}

2. Placement:
${placeStep}

Rules:
- Do NOT change data-origin ("${origin || 'https://your-site.com'}"); it identifies the audited site.
- Do NOT hide the badge or restyle it to force a colour. It renders in a shadow DOM and shows the live, signed verdict; it must be left able to show the true state.
- It links to the public Trustwright report; leave that link working.
- If the mount container is rendered by the app, make sure it exists within a few seconds of load (the badge waits up to 6s for it).`;

  return (
    <div className="page console page-narrow">
      <div className="cx-head">
        <p className="cx-kick">Mode 2 · the badge</p>
        <h1 className="cx-title">Your badge, your way.</h1>
        <p className="cx-sub">
          One line of HTML. It re-checks your live tools on every page load and can never claim more than the truth.
          Pick a look and a spot below, and the snippet updates as you choose. No badge yet?{' '}
          <Link to="/badge">Get one first</Link>.
        </p>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-title" style={{ marginBottom: 12 }}>Preview</div>
        <div
          style={{
            display: 'grid',
            placeItems: 'center',
            padding: '26px 0',
            borderRadius: 10,
            background:
              theme === 'dark'
                ? 'repeating-linear-gradient(45deg,#0a0e17,#0a0e17 10px,#0c1120 10px,#0c1120 20px)'
                : 'repeating-linear-gradient(45deg,#e9edf3,#e9edf3 10px,#f2f5f9 10px,#f2f5f9 20px)',
          }}
        >
          <Preview theme={theme} variant={variant} />
        </div>

        <div className="row" style={{ marginTop: 16, gap: 24 }}>
          <div>
            <div className="muted-3" style={{ fontSize: 12, marginBottom: 4 }}>Theme</div>
            <div className="seg">
              {(['light', 'dark', 'auto'] as Theme[]).map((t) => (
                <button key={t} className={theme === t ? 'on' : ''} onClick={() => setTheme(t)} type="button">
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="muted-3" style={{ fontSize: 12, marginBottom: 4 }}>Size</div>
            <div className="seg">
              {(['default', 'compact'] as Variant[]).map((v) => (
                <button key={v} className={variant === v ? 'on' : ''} onClick={() => setVariant(v)} type="button">
                  {v}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <label className="card-title" htmlFor="badge-origin" style={{ display: 'block', marginBottom: 8 }}>
          Your domain
        </label>
        <input
          id="badge-origin"
          className="field"
          value={origin}
          onChange={(e) => setOrigin(e.target.value)}
          spellCheck={false}
          autoCapitalize="none"
        />

        <div className="card-title" style={{ margin: '16px 0 6px' }}>Where it appears</div>
        <div className="seg">
          {PLACEMENTS.map((p) => (
            <button key={p.key} className={placement === p.key ? 'on' : ''} onClick={() => setPlacement(p.key)} type="button">
              {p.label}
            </button>
          ))}
        </div>
        <p className="muted-3" style={{ fontSize: 12.5, margin: '8px 0 0' }}>
          {placement === 'inline' && 'Appears right where you paste the line, great for a footer or About page.'}
          {placement === 'header' && 'Sits to the left of your logo. Add the container below just before the logo in your header.'}
          {placement === 'corner' && 'Floats in a fixed corner over your app, ideal for a full-screen 3D/2D world or canvas UI.'}
          {placement === 'custom' && 'Renders into any element you name with a CSS selector.'}
        </p>
        {placement === 'custom' && (
          <input
            className="field"
            style={{ marginTop: 8 }}
            placeholder="#trustwright-badge"
            value={customMount}
            onChange={(e) => setCustomMount(e.target.value)}
            spellCheck={false}
            autoCapitalize="none"
          />
        )}
        {containerSnippet && <CodeBlock code={containerSnippet} label="mount container" />}

        <p className="muted" style={{ margin: '14px 0 0' }}>Then paste this badge line:</p>
        <CodeBlock code={snippet} label="badge embed" />
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-title" style={{ marginBottom: 6 }}>Let an AI assistant wire it up</div>
        <p className="muted" style={{ margin: '0 0 6px' }}>
          Not hands-on with code? Copy this and paste it to your AI coding assistant (Cursor, Copilot, Lovable,
          v0, Claude…). It reflects your choices above.
        </p>
        <CodeBlock code={agentBrief} label="AI assistant brief" />
      </div>

      <div className="notice">
        <strong style={{ color: 'var(--ink)' }}>What you can and can't change.</strong> You can restyle the
        badge's theme, size and position. You cannot change the <em>verdict</em>: the label and colour always
        come from the live, signed check, and the badge renders inside a shadow DOM so your page's CSS can't
        repaint a warning green. That is the point: a badge only ever says what's true.
      </div>
    </div>
  );
}
