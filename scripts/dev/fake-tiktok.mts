/**
 * A fake TikTok messages page for development and the end-to-end test.
 *
 * It serves what tiktok_logger expects to find in a real browser tab:
 *  - `GET /messages` — a page with a conversation list, a message list and a composer, rendered from `/api/im/…`
 *    answers (so the capture layer sees the same kind of traffic TikTok produces),
 *  - `GET /api/im/thread/list/` and `GET /api/im/message/list/?conversation_id=…` — JSON answers in TikTok's shape
 *    (`content` is a JSON string, times in seconds, `sender.uid` and `sender.nickname`),
 *  - `POST /api/im/message/send/` — appends to a conversation and answers with the stored message.
 *
 * Nothing here is TikTok: it is a test double, so the capture, mapping and sending paths can be exercised without an
 * account. `--plain` serves the same page without `data-e2e` attributes, to exercise the DOM heuristics.
 *
 * Usage: `npx tsx scripts/dev/fake-tiktok.mts --port 8099 [--plain]`
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';

export interface FakeMessage {
  message_id: string;
  conversation_id: string;
  create_time: number;
  sender: { uid: string; nickname: string };
  content: string;
  type?: number;
  image?: { url_list: string[]; width: number; height: number };
  video?: { url_list: string[]; width: number; height: number; duration: number };
}

export interface FakeConversation {
  conversation_id: string;
  conversation_name: string;
  peer: { uid: string; nickname: string; avatar: string };
  unread_count: number;
  is_pinned?: boolean;
  messages: FakeMessage[];
}

export interface FakeTikTokOptions {
  plain?: boolean;
  me?: { uid: string; nickname: string };
}

const IMG = 'https://p16-sign.tiktokcdn-us.com/obj/fake/photo.jpg?x-expires=1&x-signature=fake';
const VID = 'https://v16-sign.tiktokcdn-us.com/obj/fake/video.mp4?x-expires=1&x-signature=fake';

/** Deterministic sample inbox: three conversations, a photo, a video, a text and an unsent-looking gap. */
export function sampleConversations(me = { uid: '7000000000000000001', nickname: 'Owner' }): FakeConversation[] {
  const t0 = Math.floor(Date.now() / 1000) - 3600;
  const c = (id: string, name: string, uid: string, unread: number): FakeConversation => ({
    conversation_id: id,
    conversation_name: name,
    peer: { uid, nickname: name, avatar: IMG },
    unread_count: unread,
    messages: [],
  });
  const convos = [
    c('conv-ali', 'Ali Veli', '7000000000000000042', 2),
    c('conv-ayse', 'Ayşe', '7000000000000000043', 0),
    c('conv-group', 'Study group', '7000000000000000044', 1),
  ];
  const say = (convo: FakeConversation, fromMe: boolean, text: string, at: number, extra: Partial<FakeMessage> = {}): void => {
    convo.messages.push({
      message_id: randomUUID(),
      conversation_id: convo.conversation_id,
      create_time: at,
      sender: fromMe ? me : { uid: convo.peer.uid, nickname: convo.peer.nickname },
      content: JSON.stringify({ text, aweType: 700, is_card: false }),
      ...extra,
    });
  };
  say(convos[0]!, false, 'hello there', t0);
  say(convos[0]!, true, 'hi Ali', t0 + 30);
  convos[0]!.messages.push({
    message_id: randomUUID(),
    conversation_id: 'conv-ali',
    create_time: t0 + 60,
    sender: { uid: convos[0]!.peer.uid, nickname: convos[0]!.peer.nickname },
    content: '',
    image: { url_list: [IMG], width: 1080, height: 1440 },
  });
  say(convos[0]!, false, 'did you see this?', t0 + 90);
  say(convos[1]!, false, 'see you tomorrow', t0 + 120);
  convos[1]!.messages.push({
    message_id: randomUUID(),
    conversation_id: 'conv-ayse',
    create_time: t0 + 150,
    sender: { uid: convos[1]!.peer.uid, nickname: convos[1]!.peer.nickname },
    content: '',
    video: { url_list: [VID], width: 720, height: 1280, duration: 12 },
  });
  say(convos[2]!, false, 'notes are in the drive', t0 + 200);
  return convos;
}


/** Three sample videos for the For You feed (one in view at a time, like TikTok). */
export interface FakeFeedItem {
  id: string;
  username: string;
  caption: string;
  music: string;
  likes: number;
  comments: number;
  shares: number;
  plays: number;
  liked: boolean;
  commentsList: { id: string; username: string; text: string; likes: number; replies: { id: string; username: string; text: string; likes: number }[] }[];
}

export function sampleFeed(): FakeFeedItem[] {
  return [
    {
      id: '7412345678901234567',
      username: 'ali.veli',
      caption: 'first video caption #test',
      music: 'original sound - ali.veli',
      likes: 1200,
      comments: 2,
      shares: 34,
      plays: 34000,
      liked: false,
      commentsList: [
        { id: 'c1', username: 'ayse', text: 'nice one', likes: 12, replies: [] },
        { id: 'c2', username: 'mehmet', text: 'where is this?', likes: 3, replies: [{ id: 'c2r1', username: 'ali.veli', text: 'istanbul', likes: 1 }] },
      ],
    },
    {
      id: '7412345678901234568',
      username: 'ayse',
      caption: 'second video',
      music: 'some song - artist',
      likes: 98,
      comments: 0,
      shares: 1,
      plays: 1500,
      liked: true,
      commentsList: [],
    },
    {
      id: '7412345678901234569',
      username: 'study.group',
      caption: 'third video with a longer caption to check wrapping in the overlay',
      music: 'lofi beats',
      likes: 5500,
      comments: 0,
      shares: 210,
      plays: 120000,
      liked: false,
      commentsList: [],
    },
  ];
}

/** TikTok bundles the feed's item structs with the document; the agent reads ids/video URLs from there. */
function hydrationJson(): string {
  const items = sampleFeed().map((f) => ({
    id: f.id,
    desc: f.caption,
    author: { uniqueId: f.username, nickname: f.username },
    video: { playAddr: `https://v16.example.com/${f.id}.mp4`, cover: `https://p16.example.com/${f.id}.jpg` },
    music: { title: f.music },
    stats: { diggCount: f.likes, commentCount: f.comments, shareCount: f.shares, playCount: f.plays },
  }));
  return JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.updated-items': items } });
}

function feedHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>For You — TikTok</title>
<style>
  * { box-sizing: border-box; font-family: system-ui, sans-serif; }
  body { margin: 0; background: #000; color: #fff; }
  #feed { height: 100vh; overflow-y: auto; scroll-snap-type: y mandatory; }
  .item { height: 100vh; scroll-snap-align: start; position: relative; display: flex; align-items: center; justify-content: center; }
  video { max-height: 100%; max-width: 100%; background: #111; }
  .meta { position: absolute; left: 20px; bottom: 24px; max-width: 55%; text-shadow: 0 1px 2px #000; }
  .meta a { color: #fff; font-weight: 700; text-decoration: none; }
  .meta p { margin: 4px 0; }
  .rail { position: absolute; right: 18px; bottom: 30px; display: flex; flex-direction: column; gap: 14px; align-items: center; }
  .rail button { background: rgba(30,30,40,.7); color: #fff; border: 0; border-radius: 999px; padding: 10px 8px; min-width: 60px; cursor: pointer; }
  .rail button[aria-pressed="true"] { color: #fe2c55; }
  .arrows { position: fixed; right: 18px; top: 50%; transform: translateY(-50%); display: flex; flex-direction: column; gap: 10px; }
  .arrows button { width: 40px; height: 40px; border-radius: 50%; border: 0; background: rgba(30,30,40,.8); color: #fff; cursor: pointer; }
  #comments { position: fixed; top: 0; right: 0; bottom: 0; width: 380px; background: #161823; color: #fff; display: none; flex-direction: column; }
  #comments.open { display: flex; }
  #comments header { padding: 12px; border-bottom: 1px solid #2a2b38; display: flex; justify-content: space-between; }
  #clist { flex: 1; overflow-y: auto; padding: 10px 12px; }
  .comment { margin: 10px 0; }
  .comment a { color: #25f4ee; text-decoration: none; font-weight: 600; }
  .comment p { margin: 2px 0; }
  .reply { margin-left: 18px; border-left: 2px solid #2a2b38; padding-left: 10px; }
  #cform { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid #2a2b38; }
  #cinput { flex: 1; min-height: 34px; border: 1px solid #2a2b38; border-radius: 8px; padding: 8px; }
  #cpost { background: #fe2c55; color: #fff; border: 0; border-radius: 8px; padding: 0 14px; }
</style></head>
<body>
<div id="feed"></div>
<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${hydrationJson()}</script>
<div class="arrows">
  <button data-e2e="arrow-left" onclick="go(-1)">↑</button>
  <button data-e2e="arrow-right" onclick="go(1)">↓</button>
</div>
<div id="comments">
  <header><strong>Comments</strong><button data-e2e="comment-close" onclick="closeComments()">✕</button></header>
  <div id="clist" class="css-fake--DivCommentListContainer"></div>
  <div id="cform">
    <div id="cinput" data-e2e="comment-input" contenteditable="true" role="textbox"></div>
    <button id="cpost" data-e2e="comment-post" onclick="post()">Post</button>
  </div>
</div>
<script>
let items = [];
let current = 0;

const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);

async function load() {
  const r = await fetch('/api/recommend/item_list/');
  const j = await r.json();
  items = j.itemList;
  render();
}

function render() {
  const box = document.getElementById('feed');
  box.innerHTML = '';
  items.forEach((it, i) => {
    const el = document.createElement('div');
    el.className = 'item';
    el.setAttribute('data-e2e', 'recommend-list-item-container');
    el.setAttribute('data-item-id', it.id);
    el.innerHTML =
      '<video src="/media/' + it.id + '.mp4" poster="/media/' + it.id + '.jpg" loop muted playsinline></video>' +
      '<div class="meta">' +
        '<a href="/@' + it.username + '/video/' + it.id + '" data-e2e="browse-username">@' + it.username + '</a>' +
        '<p data-e2e="browse-video-desc">' + it.caption + '</p>' +
        '<p data-e2e="browse-music">' + it.music + '</p>' +
        '<p class="stats"><span data-e2e="video-views">' + fmt(it.plays) + '</span> plays</p>' +
      '</div>' +
      '<div class="rail">' +
        '<button data-e2e="like-icon" aria-pressed="' + (it.liked ? 'true' : 'false') + '" onclick="like(' + i + ')">♥ <strong data-e2e="like-count">' + fmt(it.likes) + '</strong></button>' +
        '<button data-e2e="comment-icon" onclick="openComments()">💬 <strong data-e2e="comment-count">' + fmt(it.comments) + '</strong></button>' +
        '<button data-e2e="share-icon">↗ <strong data-e2e="share-count">' + fmt(it.shares) + '</strong></button>' +
      '</div>';
    box.appendChild(el);
  });
  box.scrollTop = current * window.innerHeight;
}

function go(dir) {
  current = Math.max(0, Math.min(items.length - 1, current + dir));
  const box = document.getElementById('feed');
  box.scrollTo({ top: current * window.innerHeight, behavior: 'auto' });
}

async function like(i) {
  const r = await fetch('/api/feed/like', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: items[i].id }) });
  const j = await r.json();
  items[i].liked = j.liked;
  items[i].likes = j.likes;
  render();
}

function currentItem() { return items[current]; }

async function openComments() {
  document.getElementById('comments').classList.add('open');
  renderComments();
}

function closeComments() { document.getElementById('comments').classList.remove('open'); }

function renderComments() {
  const it = currentItem();
  const box = document.getElementById('clist');
  box.innerHTML = '';
  // Same shape as the live page: the row is a plain wrapper class, the text is the data-e2e span, the author is the
  // profile link, and a reply is a whole row nested inside its parent's row (which is what the agent walks).
  const add = (c, reply, parent) => {
    const el = document.createElement('div');
    el.className = 'css-fake--DivCommentItemWrapper' + (reply ? ' reply' : '');
    el.setAttribute('data-id', c.id);
    el.innerHTML = '<div class="css-fake--DivAvatarWrapper"><a href="/@' + c.username + '"><img src="/img/a.jpg"></a></div>' +
      '<div class="css-fake--DivCommentContentWrapper"><a href="/@' + c.username + '">@' + c.username + '</a>' +
      '<span data-e2e="comment-level-1">' + c.text + '</span>' +
      '<span data-e2e="comment-like-count">' + (c.likes || 0) + '</span></div>';
    (parent || box).appendChild(el);
    return el;
  };
  for (const c of it.commentsList) {
    const el = add(c, false, null);
    for (const r of c.replies || []) add(r, true, el);
  }
  if (!it.commentsList.length) box.innerHTML = '<p>No comments yet</p>';
}

async function post() {
  const input = document.getElementById('cinput');
  const text = input.innerText.trim();
  if (!text) return;
  const r = await fetch('/api/feed/comment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: currentItem().id, text }) });
  const j = await r.json();
  Object.assign(currentItem(), j);
  input.innerHTML = '';
  renderComments();
  render();
}

load();
</script>
</body></html>`;
}

function pageHtml(plain: boolean): string {
  // data-e2e attributes are TikTok's own convention; --plain drops them so the structural heuristics are used.
  const e2e = (v: string) => (plain ? '' : ` data-e2e="${v}"`);
  const cls = (v: string) => `class="${v}"`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Messages — TikTok</title>
<style>
  * { box-sizing: border-box; font-family: system-ui, sans-serif; }
  body { margin: 0; display: flex; height: 100vh; background: #fff; color: #161823; }
  #threads { width: 320px; border-right: 1px solid #eee; overflow-y: auto; }
  #threads .row { display: flex; gap: 10px; padding: 10px 14px; cursor: pointer; align-items: center; }
  #threads .row:hover { background: #f8f8f8; }
  #threads .row.sel { background: #f2f2f2; }
  #threads img { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; background: #eee; }
  #threads .name { font-weight: 600; font-size: 14px; }
  #threads .prev { font-size: 12px; color: #8a8b91; max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #threads .badge { margin-left: auto; background: #fe2c55; color: #fff; border-radius: 10px; font-size: 11px; padding: 1px 6px; }
  #conv { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  #conv header { padding: 14px 18px; border-bottom: 1px solid #eee; font-weight: 600; }
  #list { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 6px; }
  .msg { display: flex; justify-content: flex-start; }
  .msg.mine { justify-content: flex-end; }
  .bubble { max-width: 70%; padding: 8px 12px; border-radius: 14px; background: #f1f1f2; font-size: 14px; }
  .msg.mine .bubble { background: #fe2c55; color: #fff; }
  .bubble img, .bubble video { max-width: 240px; border-radius: 10px; display: block; }
  .time { font-size: 11px; color: #999; margin: 0 6px; align-self: flex-end; }
  .sys { text-align: center; color: #999; font-size: 12px; }
  #composer { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #eee; }
  #input { flex: 1; min-height: 36px; border: 1px solid #e3e3e4; border-radius: 8px; padding: 8px 10px; outline: none; }
  #send { background: #fe2c55; color: #fff; border: 0; border-radius: 8px; padding: 0 16px; }
</style></head>
<body>
  <div id="threads" ${cls('DivConversationList')} ${e2e('conversation-list')}></div>
  <div id="conv">
    <header id="title" ${e2e('conversation-name')}>Choose a conversation</header>
    <div id="list" ${cls('DivMessageList')} ${e2e('message-list')}></div>
    <div id="composer">
      <div id="input" contenteditable="true" role="textbox" aria-label="Send a message" ${e2e('message-input')}></div>
      <button id="send" ${e2e('message-send')}>Send</button>
      <input id="file" type="file" hidden>
    </div>
  </div>
<script>
const NO_E2E = ${plain ? 'true' : 'false'};
let state = { me: null, conversations: [], current: null };

const fmtTime = (s) => { const d = new Date(s * 1000); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

async function load() {
  const r = await fetch('/api/im/thread/list/', { credentials: 'include' });
  const j = await r.json();
  state.me = j.data.me;
  state.conversations = j.data.conversations;
  renderThreads();
  const first = new URLSearchParams(location.search).get('c') || state.conversations[0]?.conversation_id;
  if (first) open(first);
}

function renderThreads() {
  const box = document.getElementById('threads');
  box.innerHTML = '';
  for (const c of state.conversations) {
    const msgs = c.messages || [];
    const last = msgs[msgs.length - 1] || c.last_message;
    const row = document.createElement('div');
    row.className = 'row' + (state.current === c.conversation_id ? ' sel' : '');
    row.setAttribute('data-conversation-id', c.conversation_id);
    row.innerHTML = '<img src="' + c.peer.avatar + '" alt="">' +
      '<div><div class="name" ${plain ? '' : 'data-e2e="conversation-name"'}>' + c.conversation_name + '</div>' +
      '<div class="prev" ${plain ? '' : 'data-e2e="conversation-preview"'}>' + (last ? previewOf(last) : '') + '</div></div>' +
      (c.unread_count ? '<span class="badge" ' + (NO_E2E ? '' : 'data-e2e="unread-count"') + '>' + c.unread_count + '</span>' : '');
    row.addEventListener('click', () => open(c.conversation_id));
    box.appendChild(row);
  }
}

function previewOf(m) { if (!m) return ''; try { const c = JSON.parse(m.content || '{}'); return c.text || (m.image ? 'Photo' : m.video ? 'Video' : ''); } catch (e) { return ''; } }

async function open(id) {
  state.current = id;
  history.replaceState(null, '', '/messages/' + encodeURIComponent(id));
  const r = await fetch('/api/im/message/list/?conversation_id=' + encodeURIComponent(id), { credentials: 'include' });
  const j = await r.json();
  const c = state.conversations.find((x) => x.conversation_id === id);
  if (c) c.messages = j.data.messages || [];
  renderThreads();
  renderMessages();
  document.getElementById('title').textContent = c ? c.conversation_name : '';
}

function renderMessages() {
  const box = document.getElementById('list');
  box.innerHTML = '';
  const c = state.conversations.find((x) => x.conversation_id === state.current);
  if (!c) return;
  for (const m of c.messages) {
    const mine = m.sender.uid === (state.me?.uid ?? '');
    const row = document.createElement('div');
    row.className = 'msg' + (mine ? ' mine' : '');
    row.setAttribute('data-message-id', m.message_id);
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    const parts = [];
    try { const c2 = JSON.parse(m.content || '{}'); if (c2.text) parts.push(document.createTextNode(c2.text)); } catch (e) {}
    if (m.image) { const img = document.createElement('img'); img.src = m.image.url_list[0]; parts.push(img); }
    if (m.video) { const v = document.createElement('video'); v.src = m.video.url_list[0]; v.controls = true; v.poster = ''; parts.push(v); }
    for (const p of parts) bubble.appendChild(p);
    row.appendChild(bubble);
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = fmtTime(m.create_time);
    time.setAttribute('title', new Date(m.create_time * 1000).toISOString());
    row.appendChild(time);
    box.appendChild(row);
  }
  box.scrollTop = box.scrollHeight;
}

async function send() {
  const input = document.getElementById('input');
  const text = input.innerText.trim();
  if (!text) return;
  const r = await fetch('/api/im/message/send/', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversation_id: state.current, text }),
  });
  const j = await r.json();
  const c = state.conversations.find((x) => x.conversation_id === state.current);
  if (c && j.data.message) (c.messages = c.messages || []).push(j.data.message);
  input.innerHTML = '';
  renderMessages();
  renderThreads();
}

document.getElementById('send').addEventListener('click', send);
document.getElementById('input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
document.getElementById('file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const r = await fetch('/api/im/message/send/', {
    method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversation_id: state.current, file: { name: f.name, type: f.type, size: f.size } }),
  });
  const j = await r.json();
  const c = state.conversations.find((x) => x.conversation_id === state.current);
  if (c && j.data.message) (c.messages = c.messages || []).push(j.data.message);
  renderMessages();
});
load();
</script>
</body></html>`;
}

export interface FakeTikTok {
  port: number;
  url: string;
  conversations: FakeConversation[];
  feed: FakeFeedItem[];
  /** Appends a message as if the peer sent it (used by tests to simulate a live message). */
  receive(conversationId: string, text: string): FakeMessage;
  close(): Promise<void>;
}

export async function startFakeTikTok(opts: FakeTikTokOptions = {}): Promise<FakeTikTok> {
  const me = opts.me ?? { uid: '7000000000000000001', nickname: 'Owner' };
  const conversations = sampleConversations(me);
  const feed = sampleFeed();
  const html = pageHtml(opts.plain === true);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (body: unknown, status = 200) => {
      const s = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
      res.end(s);
    };
    if (url.pathname === '/foryou') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(feedHtml());
      return;
    }
    if (url.pathname === '/api/recommend/item_list/') {
      json({ status_code: 0, itemList: feed });
      return;
    }
    if (url.pathname === '/api/feed/like' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += String(d); if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        let id = '';
        try { id = (JSON.parse(body) as { id?: string }).id ?? ''; } catch { /* ignore */ }
        const item = feed.find((f) => f.id === id);
        if (!item) { json({ status_code: 404 }, 404); return; }
        item.liked = !item.liked;
        item.likes += item.liked ? 1 : -1;
        json({ status_code: 0, liked: item.liked, likes: item.likes });
      });
      return;
    }
    if (url.pathname === '/api/feed/comment' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += String(d); if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        let id = '';
        let text = '';
        try { const p = JSON.parse(body) as { id?: string; text?: string }; id = p.id ?? ''; text = p.text ?? ''; } catch { /* ignore */ }
        const item = feed.find((f) => f.id === id);
        if (!item) { json({ status_code: 404 }, 404); return; }
        item.commentsList.push({ id: 'mine-' + Date.now(), username: 'owner', text, likes: 0, replies: [] });
        item.comments = item.commentsList.length;
        json({ status_code: 0, commentsList: item.commentsList, comments: item.comments });
      });
      return;
    }
    if (url.pathname.startsWith('/media/')) {
      // Not a real video: enough for the page and the capture layer (the agent only needs the source URL).
      res.writeHead(200, { 'content-type': url.pathname.endsWith('.jpg') ? 'image/jpeg' : 'video/mp4', 'cache-control': 'no-store' });
      res.end(Buffer.from(url.pathname.endsWith('.jpg') ? [0xff, 0xd8, 0xff, 0xd9] : [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]));
      return;
    }
    if (url.pathname.startsWith('/messages') || url.pathname === '/login') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (url.pathname === '/api/im/thread/list/') {
      json({
        status_code: 0,
        data: {
          me,
          conversations: conversations.map((c) => ({
            conversation_id: c.conversation_id,
            conversation_name: c.conversation_name,
            participant_count: 2,
            unread_count: c.unread_count,
            is_pinned: c.is_pinned === true,
            peer: { uid: c.peer.uid, nickname: c.peer.nickname, avatar: c.peer.avatar },
            participant: { uid: c.peer.uid, nickname: c.peer.nickname, avatar_thumb: { url_list: [c.peer.avatar] } },
            last_message: c.messages[c.messages.length - 1] ?? null,
          })),
        },
      });
      return;
    }
    if (url.pathname === '/api/im/message/list/') {
      const id = url.searchParams.get('conversation_id');
      const c = conversations.find((x) => x.conversation_id === id);
      json({ status_code: 0, data: { messages: c?.messages ?? [] } });
      return;
    }
    if (url.pathname === '/api/im/message/send/' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => {
        body += String(d);
        if (body.length > 1e6) req.destroy();
      });
      req.on('end', () => {
        let parsed: { conversation_id?: string; text?: string; file?: { name: string; type: string } } = {};
        try {
          parsed = JSON.parse(body) as typeof parsed;
        } catch {
          /* ignore */
        }
        const c = conversations.find((x) => x.conversation_id === parsed.conversation_id);
        if (!c) {
          json({ status_code: 1001, status_msg: 'no conversation' }, 400);
          return;
        }
        const m: FakeMessage = {
          message_id: randomUUID(),
          conversation_id: c.conversation_id,
          create_time: Math.floor(Date.now() / 1000),
          sender: me,
          content: JSON.stringify({ text: parsed.text ?? '', aweType: 700 }),
          ...(parsed.file ? { image: { url_list: [IMG], width: 800, height: 600 } } : {}),
        };
        c.messages.push(m);
        c.unread_count = 0;
        json({ status_code: 0, data: { message: m } });
      });
      return;
    }
    json({ status_code: 404, status_msg: 'not found' }, 404);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    conversations,
    feed,
    receive(conversationId: string, text: string): FakeMessage {
      const c = conversations.find((x) => x.conversation_id === conversationId);
      if (!c) throw new Error('no such conversation');
      const m: FakeMessage = {
        message_id: randomUUID(),
        conversation_id: conversationId,
        create_time: Math.floor(Date.now() / 1000),
        sender: { uid: c.peer.uid, nickname: c.peer.nickname },
        content: JSON.stringify({ text, aweType: 700 }),
      };
      c.messages.push(m);
      c.unread_count++;
      return m;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/* ------------------------------------------------------------------- CLI */

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const portArg = args.indexOf('--port');
  const port = portArg >= 0 ? Number(args[portArg + 1]) : 8099;
  const plain = args.includes('--plain');
  const convos = sampleConversations();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (body: unknown) => {
      const s = JSON.stringify(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(s);
    };
    if (url.pathname.startsWith('/messages')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(pageHtml(plain));
      return;
    }
    if (url.pathname === '/api/im/thread/list/') return json({ status_code: 0, data: { me: { uid: '7000000000000000001', nickname: 'Owner' }, conversations: convos } });
    if (url.pathname === '/api/im/message/list/') return json({ status_code: 0, data: { messages: convos.find((c) => c.conversation_id === url.searchParams.get('conversation_id'))?.messages ?? [] } });
    res.writeHead(404);
    res.end('not found');
  });
  server.listen(port, '127.0.0.1', () => {
    // eslint-disable-next-line no-console
    console.log(`fake TikTok on http://127.0.0.1:${port}/messages${plain ? ' (no data-e2e attributes)' : ''}`);
  });
}
