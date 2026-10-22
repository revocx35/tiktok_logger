/**
 * Checks the page agent against the fake TikTok (scripts/dev/fake-tiktok.mts) in a real Chromium.
 *
 * This is the part of tiktok_logger that is hardest to unit-test: reading an unfamiliar page and driving its
 * composer. It runs against the fake in both modes — with TikTok's `data-e2e` attributes and without them (structural
 * heuristics) — and prints one line per check.
 *
 * Needs a Chromium build: `PUPPETEER_EXECUTABLE_PATH=/path/to/chrome npx tsx scripts/dev/dom-check.mts`.
 * Not part of `npm test`: the app image has no browser (the real browser lives in the chromium container).
 */
import { createRequire } from 'node:module';
// The browser library lives in server/node_modules; these scripts are run from the repo root or server/.
const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const puppeteer = requireFromServer('puppeteer') as typeof import('puppeteer');
import { DomAgent, mergeSelectors } from '../../server/src/tt/dom.js';
import { FeedAgent, mergeFeedSelectors } from '../../server/src/tt/feedAgent.js';
import { domRowToMessage, domThreadToThread, mapMessage } from '../../server/src/tt/mapper.js';
import { Watcher } from '../../server/src/tt/watcher.js';
import { startFakeTikTok } from './fake-tiktok.mts';

const ME = '7000000000000000001';
let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
const browser = await (puppeteer as any).launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});

try {
  for (const plain of [false, true]) {
    const fake = await startFakeTikTok({ plain });
    console.log(`\n== fake TikTok (${plain ? 'no data-e2e attributes' : 'data-e2e attributes'}) at ${fake.url}`);
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('  page error:', String(e).slice(0, 200)));
    await page.goto(`${fake.url}/messages`, { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 400));

    const agent = new DomAgent(page, mergeSelectors(null));
    await agent.install();

    const state = await agent.state();
    check('page reports a conversation open', state.threadId === 'conv-ali', JSON.stringify(state));

    const threads = await agent.threads();
    check('three conversations are found', threads.length === 3, JSON.stringify(threads.map((t) => t.name)));
    check('names and previews are read', threads[0]?.name === 'Ali Veli' && !!threads[0]?.lastText, JSON.stringify(threads[0]));
    const mapped = threads.map((t) => domThreadToThread(t, { meId: ME })).filter((t) => t !== null);
    check('every conversation maps to a chat', mapped.length === 3, JSON.stringify(mapped.map((t) => t.id)));
    check('conversation ids come from the page', mapped.some((t) => t!.id === 'conv-ali'));

    const snap = await agent.messages();
    check('messages are read', snap.rows.length === 4, `rows=${snap.rows.length}`);
    const mine = snap.rows.filter((r) => r.mine).length;
    check('own messages are recognised', mine === 1, `mine=${mine}`);
    check('photo rows carry their url', snap.rows.some((r) => (r.media ?? []).some((m) => m.kind === 'image' && /tiktokcdn/.test(m.url ?? ''))));
    const msgMapped = snap.rows.map((r) => domRowToMessage('conv-ali', r, { meId: ME, now: Date.now() })).filter((m) => m !== null);
    check('every row maps to a message', msgMapped.length === 4, `mapped=${msgMapped.length}`);
    check('the photo has its dimensions-less media entry', msgMapped.some((m) => m!.media?.length === 1));

    // Open another conversation by name (what the service does when a chat has no id in the map).
    const opened = await agent.openThread('Ayşe');
    await new Promise((r) => setTimeout(r, 300));
    const snap2 = await agent.messages();
    check('opening a conversation by name works', opened.ok && snap2.threadId === 'conv-ayse', JSON.stringify({ opened, id: snap2.threadId }));
    check('the video row is read as a video', snap2.rows.some((r) => (r.media ?? []).some((m) => m.kind === 'video')));

    // Sending: fill the composer, press send, check the message appears as ours.
    await agent.openThread('conv-ali');
    await new Promise((r) => setTimeout(r, 300));
    const typed = await agent.setText('hello from the logger');
    check('the composer accepts text', typed.ok, JSON.stringify(typed));
    const sent = await agent.send();
    await new Promise((r) => setTimeout(r, 700));
    const snap3 = await agent.messages();
    const sentRow = snap3.rows.find((r) => (r.text ?? '').includes('hello from the logger'));
    check('the sent message appears as ours', !!sentRow && sentRow.mine === true, JSON.stringify(sentRow));
    check('send went through the send control or Enter', sent.ok && (sent.via === 'button' || sent.via === 'enter'), JSON.stringify(sent));

    // Attaching a file through the page's own input.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const attached = await agent.attachBase64(png, 'photo.png', 'image/png');
    await new Promise((r) => setTimeout(r, 700));
    check('a file can be attached', attached.ok, JSON.stringify(attached));
    const snap4 = await agent.messages();
    check('the attached file appears as a media row', snap4.rows.some((r) => r.mine && (r.media ?? []).length > 0));

    // The network side: the page's own IM answers must be captured and mapped.
    const watcher = new Watcher(page, { frame: () => undefined, body: () => undefined, navigated: () => undefined }, fake.url);
    await watcher.attach();
    const bodies: { url: string; contentType: string }[] = [];
    const frames: string[] = [];
    const watcher2 = new Watcher(
      page,
      {
        frame: (f) => frames.push(f.socket),
        body: (b) => bodies.push({ url: b.url, contentType: b.contentType }),
        navigated: () => undefined,
      },
      fake.url,
    );
    await watcher.detach();
    await watcher2.attach();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 800));
    await agent.reset();
    check('IM answers are captured', bodies.some((b) => b.url.includes('/api/im/')), JSON.stringify(bodies.map((b) => new URL(b.url).pathname)));
    await watcher2.detach();

    // The mapper on a real answer body: fetch it through the page and map it.
    const answerText = await page.evaluate(async () => (await fetch('/api/im/message/list/?conversation_id=conv-ali')).text());
    const answer = JSON.parse(answerText) as { data: { messages: Record<string, unknown>[] } };
    const mappedApi = answer.data.messages.map((m) => mapMessage(m, null, { meId: ME })).filter((m) => m !== null);
    check('IM answers map to messages', mappedApi.length === answer.data.messages.length, `${mappedApi.length}/${answer.data.messages.length}`);
    check('mapped text and ids are usable', mappedApi.every((m) => !!m!.id && !!m!.threadId));

    await page.close();
    await fake.close();
  }

  /* ---------------------------------------------------------------- feed */
  {
    const fake = await startFakeTikTok({});
    console.log(`\n== fake TikTok feed at ${fake.url}/foryou`);
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 800 });
    await page.goto(`${fake.url}/foryou`, { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 600));
    const agent = new FeedAgent(page, mergeFeedSelectors(null));
    await agent.install();

    const first = await agent.current();
    check('the first video is read', first?.id === fake.feed[0]!.id, JSON.stringify(first));
    check('author, caption and music are read', first?.author.username === fake.feed[0]!.username && first?.caption === fake.feed[0]!.caption && !!first?.music, JSON.stringify(first));
    check('stats are parsed (1.2K likes, 34K plays)', first?.stats.likes === 1200 && first?.stats.plays === 34000, JSON.stringify(first?.stats));
    check('the like state is read', first?.liked === false);
    check('the video source is read', !!first?.video?.src && /\/media\//.test(first.video.src), JSON.stringify(first?.video));

    await agent.step('next');
    await new Promise((r) => setTimeout(r, 400));
    const second = await agent.current();
    check('next moves to the second video', second?.id === fake.feed[1]!.id, JSON.stringify(second?.id));
    check('the second video is marked liked', second?.liked === true);

    await agent.like();
    await new Promise((r) => setTimeout(r, 400));
    const afterLike = await agent.current();
    check('liking toggles the state', afterLike?.liked === false, JSON.stringify(afterLike?.liked));

    await agent.step('prev');
    await new Promise((r) => setTimeout(r, 400));
    const back = await agent.current();
    check('previous goes back', back?.id === fake.feed[0]!.id, JSON.stringify(back?.id));

    await agent.openComments();
    await new Promise((r) => setTimeout(r, 400));
    const panel = await agent.comments();
    check('comments open', panel.open === true);
    check('comments are read with their replies', panel.comments.length === 2 && panel.comments[1]?.replies.length === 1, JSON.stringify(panel.comments.map((c) => [c.text, c.replies.length])));
    check('a comment has its author', panel.comments[0]?.author.username === 'ayse');

    const posted = await agent.postComment('hello from the check');
    await new Promise((r) => setTimeout(r, 500));
    const afterPost = await agent.comments();
    check('a comment can be posted', posted.ok && afterPost.comments.some((c) => c.text === 'hello from the check'), JSON.stringify(afterPost.comments.map((c) => c.text)));

    await agent.closeComments();
    await new Promise((r) => setTimeout(r, 300));
    check('comments close', (await agent.comments()).open === false);

    await page.close();
    await fake.close();
  }
} finally {
  await browser.close();
}

console.log(failures === 0 ? '\nall DOM checks passed' : `\n${failures} DOM check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
