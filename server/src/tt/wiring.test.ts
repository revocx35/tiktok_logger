import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Wiring that the type checker cannot see and no unit test would notice: the story schedule is **its own timer**, so
 * every path that brings the worker up has to start it. It was started only in the page-driving branch, which meant it
 * never ran while the IM protocol was active — the normal case. The schedule then looked dead for hours without a log
 * line (v1.8.0 → v1.12.2, found 2026-10-23).
 */
const src = readFileSync(new URL('./service.ts', import.meta.url), 'utf8');

/** The body of a method, from its signature to the next method comment (enough to see its first lines). */
function body(name: string): string {
  const at = src.indexOf(`private ${name}(`);
  if (at < 0) throw new Error(`${name} not found`);
  return src.slice(at, at + 1500);
}

describe('service wiring', () => {
  it('starts the story timer on both loop paths', () => {
    expect(body('startProtocolLoops')).toContain('this.stories.reconfigure()');
    expect(body('startLoops')).toContain('this.stories.reconfigure()');
  });

  it('keeps the story logger out of the page-only setup', () => {
    // The web API, not the feed page, is what a story pass needs: it is provided by attachProtocol.
    expect(src).toMatch(/webApiRef\s*=\s*new WebApi/);
  });
});
