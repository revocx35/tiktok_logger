/** @vitest-environment node */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The stories page was ported from insta_logger with new class names in the markup (`story-viewer-body`,
 * `story-tile-meta`, `story-author.active`, …) while `styles.css` kept the parent project's (`story-stage`,
 * `story-meta`, `.on`). Half the page then rendered unstyled in production: the viewer had no stage, the avatars
 * rendered at their natural size over the account row, the tiles had no captions and the close/arrow buttons were
 * bare browser buttons.
 *
 * A type-check and a build cannot see that, so these two checks read the sources instead: every `story-*` / `page-*`
 * class the markup uses has a rule, and every `story-*` rule is used by some markup (a leftover rule is how the
 * rename went unnoticed).
 */

const SRC = fileURLToPath(new URL('../', import.meta.url));
const CLASS = /^(?:stories|story|page|tt-card)-[a-z-]*$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !name.endsWith('.test.ts') && !name.endsWith('.test.tsx')) out.push(full);
  }
  return out;
}

/** Class tokens that appear inside a `className=` attribute (plain strings and ternaries). */
function usedClasses(): Map<string, Set<string>> {
  const used = new Map<string, Set<string>>();
  for (const file of walk(SRC)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/className=(?:"([^"]*)"|\{([^}]*)\})/g)) {
      for (const token of (match[1] ?? match[2] ?? '').match(/[a-z][a-z0-9-]*/g) ?? []) {
        if (!CLASS.test(token)) continue;
        if (!used.has(token)) used.set(token, new Set());
        used.get(token)!.add(file.slice(SRC.length));
      }
    }
  }
  return used;
}

const css = readFileSync(join(SRC, 'styles.css'), 'utf8');
const rule = (cls: string) => new RegExp(`\\.${cls}(?![\\w-])`).test(css);

describe('stories CSS', () => {
  const used = usedClasses();

  it('has a rule for every story/page class the markup uses', () => {
    const missing = [...used.keys()].filter((cls) => !rule(cls)).sort();
    expect(missing, `no rule in styles.css for: ${missing.map((c) => `${c} (${[...used.get(c)!]})`).join(', ')}`).toEqual([]);
  });

  it('uses every story class styles.css declares', () => {
    const declared = new Set([...css.matchAll(/\.((?:stories?|tt-card)-[a-z-]+)/g)].map((m) => m[1]!));
    const dead = [...declared].filter((cls) => !used.has(cls)).sort();
    expect(dead, `declared in styles.css but no markup uses: ${dead.join(', ')}`).toEqual([]);
  });
});
