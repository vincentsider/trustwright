import { describe, it, expect, afterEach } from 'vitest';
import { enumerateInPage, normalizeSurface, MAX_TOOLS, type RawScan } from './enumerate.ts';

// enumerateInPage reads the global `window`; simulate it in Node.
function setWindow(w: unknown): void {
  (globalThis as unknown as { window?: unknown }).window = w;
}
afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('enumerateInPage', () => {
  const toolList = [{ name: 'a', description: 'A' }];

  it('finds a host on document.modelContext', async () => {
    setWindow({ document: { modelContext: { getTools: () => toolList } }, navigator: {} });
    const r = await enumerateInPage(1000);
    expect(r.host).toBe('native');
    expect(r.tools).toEqual(toolList);
  });

  it('finds a host on navigator.modelContext', async () => {
    setWindow({ document: {}, navigator: { modelContext: { getTools: () => toolList } } });
    const r = await enumerateInPage(1000);
    expect(r.host).toBe('native');
  });

  it('labels a polyfilled host', async () => {
    setWindow({ __webmcpPolyfill: true, document: { modelContext: { getTools: () => toolList } }, navigator: {} });
    const r = await enumerateInPage(1000);
    expect(r.host).toBe('polyfill');
  });

  it('awaits getTools when it returns a promise', async () => {
    setWindow({ document: { modelContext: { getTools: () => Promise.resolve(toolList) } }, navigator: {} });
    const r = await enumerateInPage(1000);
    expect(r.tools).toEqual(toolList);
  });

  it('returns none after the wait when no host appears', async () => {
    setWindow({ document: {}, navigator: {} });
    const r = await enumerateInPage(300);
    expect(r).toEqual({ host: 'none', tools: [] });
  });

  it('tolerates a throwing getTools', async () => {
    setWindow({
      document: {
        modelContext: {
          getTools: () => {
            throw new Error('boom');
          },
        },
      },
      navigator: {},
    });
    const r = await enumerateInPage(1000);
    expect(r).toEqual({ host: 'native', tools: [] });
  });

  it('picks up a host that appears after a delay', async () => {
    const w: Record<string, unknown> = { document: {}, navigator: {} };
    setWindow(w);
    setTimeout(() => {
      w.document = { modelContext: { getTools: () => toolList } };
    }, 200);
    const r = await enumerateInPage(2000);
    expect(r.host).toBe('native');
    expect(r.tools).toEqual(toolList);
  });

  // --- Scanner-injected host (worker/browserScan.ts) --------------------------
  // The scanner may inject a standard WebMCP host tagged __twInjected so a site
  // that uses the native API but ships no polyfill is still enumerable. An
  // injected host exists from t=0, so its emptiness is only meaningful at the
  // deadline, and tools may register asynchronously into it.

  it('reads tools registered into the injected host', async () => {
    const host = { __twInjected: true, getTools: () => toolList };
    setWindow({ document: { modelContext: host }, navigator: {} });
    const r = await enumerateInPage(1000);
    expect(r.host).toBe('native');
    expect(r.tools).toEqual(toolList);
  });

  it('reports none when the injected host stays empty until the deadline', async () => {
    // The page never used WebMCP: our injected host is present but got no tools.
    const host = { __twInjected: true, getTools: () => [] as unknown[] };
    setWindow({ document: { modelContext: host }, navigator: {} });
    const r = await enumerateInPage(300);
    expect(r).toEqual({ host: 'none', tools: [] });
  });

  it('waits for tools registered asynchronously into the injected host', async () => {
    let current: unknown[] = [];
    const host = { __twInjected: true, getTools: () => current };
    setWindow({ document: { modelContext: host }, navigator: {} });
    setTimeout(() => {
      current = toolList;
    }, 250);
    const r = await enumerateInPage(2000);
    expect(r.host).toBe('native');
    expect(r.tools).toEqual(toolList);
  });

  it('settles a burst of async registrations into the injected host', async () => {
    let current: unknown[] = [{ name: 'a', description: 'A' }];
    const host = { __twInjected: true, getTools: () => current };
    setWindow({ document: { modelContext: host }, navigator: {} });
    // A second tool appears one interval later; the settle loop must catch it.
    setTimeout(() => {
      current = [
        { name: 'a', description: 'A' },
        { name: 'b', description: 'B' },
      ];
    }, 120);
    const r = await enumerateInPage(2000);
    expect(r.tools).toHaveLength(2);
  });
});

describe('normalizeSurface', () => {
  it('passes through host: none', () => {
    expect(normalizeSurface({ host: 'none', tools: [] })).toEqual({ host: 'none', tools: [] });
  });

  it('coerces, slices, and keeps valid fields', () => {
    const raw: RawScan = {
      host: 'native',
      tools: [
        {
          name: 'x'.repeat(200),
          description: 'y'.repeat(9000),
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: true, note: 'z'.repeat(500), nested: { drop: 1 }, big: 7 },
        },
      ],
    };
    const { tools } = normalizeSurface(raw);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name.length).toBe(128);
    expect(tools[0]!.description.length).toBe(8000);
    expect(tools[0]!.inputSchema).toEqual({ type: 'object' });
    expect(tools[0]!.annotations).toEqual({ readOnlyHint: true, note: 'z'.repeat(256), big: 7 });
  });

  it('skips non-object and nameless entries', () => {
    const raw: RawScan = {
      host: 'native',
      tools: [null, 'nope', { description: 'no name' }, { name: '', description: 'empty' }, { name: 'ok', description: 'good' }],
    };
    const { tools } = normalizeSurface(raw);
    expect(tools).toEqual([{ name: 'ok', description: 'good' }]);
  });

  it('drops an oversized inputSchema', () => {
    const big = { blob: 'q'.repeat(9000) };
    const { tools } = normalizeSurface({ host: 'native', tools: [{ name: 't', description: 'd', inputSchema: big }] });
    expect(tools[0]!.inputSchema).toBeUndefined();
  });

  it('caps the number of tools', () => {
    const many = Array.from({ length: MAX_TOOLS + 50 }, (_, i) => ({ name: `t${i}`, description: 'd' }));
    const { tools } = normalizeSurface({ host: 'native', tools: many });
    expect(tools).toHaveLength(MAX_TOOLS);
  });
});
