/**
 * Screenshots of the web UI in a real browser (light, dark and phone width), for checking the layout by eye.
 *
 *   cd server && npx tsx ../scripts/dev/ui-shots.mts <baseUrl> <outDir> [password]
 *
 * It logs in, reads the conversation list from the API and shoots the first conversations plus the other screens.
 * Needs a running stack with some imported data. Connect to a browser you started yourself with `BROWSER_URL`
 * (default http://127.0.0.1:9333), or let it launch one via `PUPPETEER_EXECUTABLE_PATH`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const puppeteer = requireFromServer('puppeteer') as any;

const BASE = (process.argv[2] ?? 'https://localhost:29443').replace(/\/$/, '');
const OUT = process.argv[3] ?? '/tmp/shots';
const PASSWORD = process.argv[4] ?? 'correct-horse-battery-staple';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // a stack with Caddy's internal CA; test only

fs.mkdirSync(OUT, { recursive: true });

const browser = process.env.BROWSER_URL
  ? await puppeteer.connect({ browserURL: process.env.BROWSER_URL, defaultViewport: null })
  : await puppeteer.launch({
      headless: true,
      ...(process.env.PUPPETEER_EXECUTABLE_PATH ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH } : {}),
      args: ['--no-sandbox'],
    });

const ctx = browser.createBrowserContext ? await browser.createBrowserContext() : browser;
const page = await ctx.newPage();
await page.setViewport({ width: 1280, height: 820 });
const shot = async (name: string) => {
  await new Promise((r) => setTimeout(r, 900));
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log('shot', name);
};

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2' });
await shot('01-login');
await page.type('input[autocomplete="username"], input[name="username"]', 'owner');
await page.type('input[type="password"]', PASSWORD);
await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => undefined), page.keyboard.press('Enter')]);

const chats = (await page.evaluate(async () => (await fetch('/api/chats', { credentials: 'include' })).json())) as { id: string }[];
const [first, second] = chats;

if (first) {
  await page.goto(`${BASE}/chat/${encodeURIComponent(first.id)}`, { waitUntil: 'networkidle2' });
  await shot('02-chat-light');
}
if (second) {
  await page.goto(`${BASE}/chat/${encodeURIComponent(second.id)}`, { waitUntil: 'networkidle2' });
  await shot('03-second-chat');
}
await page.goto(`${BASE}/deleted`, { waitUntil: 'networkidle2' });
await shot('04-unsent');
await page.goto(`${BASE}/tiktok`, { waitUntil: 'networkidle2' });
await shot('05-tiktok');
await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle2' });
await shot('06-settings');
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
if (first) {
  await page.goto(`${BASE}/chat/${encodeURIComponent(first.id)}`, { waitUntil: 'networkidle2' });
  await shot('07-chat-dark');
}
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
await shot('08-phone-list');
if (first) {
  await page.goto(`${BASE}/chat/${encodeURIComponent(first.id)}`, { waitUntil: 'networkidle2' });
  await shot('09-phone-chat');
}
console.log(`\n${chats.length} conversations; screenshots in ${OUT}`);
await browser.close();
