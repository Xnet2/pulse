// Runs hidden on the PC: the player has no internet, so this fetches for it over the USB cable.
// PC -> player: catalog-*, status-*, covers-* files in the app folder.
// Player -> PC: empty req-* / cov-* / cfg-* files whose names carry the request.
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const tls = require('tls');
const dns = require('dns');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { createInterface } = require('readline');

dns.setDefaultResultOrder('ipv4first');
try {
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);
} catch {}

const { catalog, loadLatest, loadBotAll, request, driveUrl, normalize } = require('./lib/sources');
const { tagLength, readPicture, retag } = require('./lib/id3');

const WORK = path.join(os.tmpdir(), 'offline-player-bridge');
const HOME = path.join(process.env.LOCALAPPDATA, 'OfflinePlayer-Bridge');
const LOCK_PORT = 47832;
const SCAN_MS = 1500;
const MUSIC_EVERY = 10;
const MISSES_BEFORE_DISCONNECT = 4;
const HEARTBEAT_MS = 12000;
const CATALOG_MS = 10 * 60 * 1000;
const RETRY_MS = 30000;
const MIN_FREE = 300 * 1024 * 1024;

fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(HOME, { recursive: true });

function log(...parts) {
  try { fs.appendFileSync(path.join(HOME, 'log.txt'), `${new Date().toLocaleString('he-IL')}  ${parts.join(' ')}\n`); } catch {}
}

/* ---------- settings kept between runs ---------- */

const SETTINGS = path.join(HOME, 'settings.json');
let settings = { channel: '', auto: false, autoStorage: 0, autoDone: [] };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) }; } catch {}
const autoDone = new Set(settings.autoDone);

function saveSettings() {
  settings.autoDone = [...autoDone].slice(-5000);
  try { fs.writeFileSync(SETTINGS, JSON.stringify(settings)); } catch (err) { log('settings', err.message); }
}

/* ---------- PowerShell workers: one for the USB device, one for image work ---------- */

function makeWorker(timeoutFor) {
  const script = path.join(__dirname, 'ps', 'mtp.ps1');
  let child = null;
  let seq = 0;
  let chain = Promise.resolve();
  const waiting = new Map();

  function ensure() {
    if (child) return child;
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true });
    const own = child;
    createInterface({ input: child.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      const done = waiting.get(msg.id);
      if (done) done(msg);
    });
    child.stdin.on('error', () => {});
    child.on('error', () => {});
    child.on('close', () => {
      if (child === own) child = null;
      waiting.forEach((done) => done({ error: 'worker closed' }));
    });
    return child;
  }

  return (req) => {
    const run = () => new Promise((resolve) => {
      const proc = ensure();
      const id = ++seq;
      const timer = setTimeout(() => { waiting.delete(id); proc.kill(); resolve({ error: 'timeout' }); }, timeoutFor(req.action));
      waiting.set(id, (msg) => { clearTimeout(timer); waiting.delete(id); resolve(msg); });
      proc.stdin.write(`${JSON.stringify({ ...req, id })}\n`);
    });
    const result = chain.then(run);
    chain = result.catch(() => {});
    return result;
  };
}

const mtp = makeWorker((a) => (a === 'song' ? 300000 : 45000));
const images = makeWorker(() => 120000);

/* ---------- device state ---------- */

let device = null;
let storages = [];
let misses = 0;
const handled = new Set();
const acks = [];
const jobs = {};
let statusDirty = false;
let lastStatus = 0;

const byCapacity = () => [...storages].sort((a, b) => b.capacity - a.capacity);

function onDeviceKeys() {
  const keys = new Set();
  for (const s of storages) for (const f of s.music) keys.add(normalize(f.replace(/\.mp3$/i, '')));
  return keys;
}

// A failed put used to wait 40s and then hop to the other storage, stalling every scan behind it.
// Now: the storage that worked last (remembered across runs) gets two quick tries before the others.
async function putFile(file) {
  const ordered = byCapacity().filter((s) => s.hasApp);
  ordered.sort((a, b) => (b.name === settings.channel) - (a.name === settings.channel));
  for (const s of ordered) {
    const tries = s.name === settings.channel ? 2 : 1;
    for (let i = 0; i < tries; i++) {
      const reply = await mtp({ action: 'put', device, storage: s.name, file, wait: 15 });
      if (reply.ok) {
        if (settings.channel !== s.name) {
          log('channel storage:', s.name);
          settings.channel = s.name;
          saveSettings();
        }
        return true;
      }
      if (reply.error === 'storage' || !device) return false;
    }
  }
  return false;
}

async function putGenerated(prefix, ext, data) {
  const dir = fs.mkdtempSync(path.join(WORK, 'put-'));
  const file = path.join(dir, `${prefix}-${Date.now()}-${data.length}.${ext}`);
  try {
    fs.writeFileSync(file, data);
    return await putFile(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function autoLeft() {
  return autoQueue.length + (autoCurrent ? 1 : 0);
}

async function sendStatus() {
  statusDirty = false;
  lastStatus = Date.now();
  const body = {
    device,
    storages: byCapacity().map((s) => ({ name: s.name, music: s.music })),
    jobs,
    auto: settings.auto,
    autoLeft: autoLeft(),
    autoNote,
    ack: acks.splice(0),
  };
  const ok = await putGenerated('status', 'json', Buffer.from(JSON.stringify(body), 'utf8'));
  if (!ok) {
    acks.unshift(...body.ack);
    statusDirty = true;
    lastStatus = Date.now() - HEARTBEAT_MS + 4000;
  }
}

let statusRunning = false;
async function pumpStatus() {
  if (statusRunning || !device) return;
  statusRunning = true;
  try {
    while (device && (statusDirty || Date.now() - lastStatus > HEARTBEAT_MS)) await sendStatus();
  } catch (err) { log('status', err.message); }
  statusRunning = false;
}

function setJob(id, patch) {
  jobs[id] = { ...(jobs[id] || {}), ...patch };
  statusDirty = true;
  pumpStatus();
}

/* ---------- catalog and covers ---------- */

const thumbs = new Map();
const coversSent = new Set();
let latestSongs = [];
let sentCatalogHash = '';
const safeId = (id) => id.replace(':', '_');

async function ranged(driveId, end) {
  const res = await request(driveUrl(driveId), { headers: { Range: `bytes=0-${end}` } });
  if (res.status !== 206 && res.status !== 200) throw new Error(`drive ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function coverBytes(song) {
  if (song.cover) {
    const res = await request(song.cover);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  }
  if (!song.driveId) return null;
  const head = await ranged(song.driveId, 9);
  const size = tagLength(head);
  if (!size) return null;
  const picture = readPicture(await ranged(song.driveId, Math.min(size, 3000000) - 1));
  return picture ? picture.data : null;
}

async function buildThumbs(songs) {
  const missing = songs.filter((s) => !thumbs.has(s.id));
  if (!missing.length) return;
  const dir = fs.mkdtempSync(path.join(WORK, 'thumb-'));
  const src = path.join(dir, 'src');
  const out = path.join(dir, 'out');
  fs.mkdirSync(src);
  fs.mkdirSync(out);
  try {
    const queue = [...missing];
    await Promise.all(Array.from({ length: 6 }, async () => {
      for (let s; (s = queue.shift());) {
        try {
          const data = await coverBytes(s);
          if (data) fs.writeFileSync(path.join(src, safeId(s.id)), data);
        } catch {}
      }
    }));
    await images({ action: 'images', dir: src, out, size: 520 });
    for (const f of fs.readdirSync(out)) {
      thumbs.set(f.replace(/\.jpg$/, '').replace('_', ':'), fs.readFileSync(path.join(out, f)));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function packCovers(songs) {
  const index = {};
  const blobs = [];
  let offset = 0;
  for (const s of songs) {
    const data = thumbs.get(s.id);
    if (!data) continue;
    index[safeId(s.id)] = [offset, data.length];
    blobs.push(data);
    offset += data.length;
  }
  if (!blobs.length) return null;
  const json = Buffer.from(JSON.stringify(index), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(json.length);
  return Buffer.concat([head, json, ...blobs]);
}

// Sends only covers the player has not received during this connection.
async function pushCovers(songs) {
  const wanted = songs.filter((s) => !coversSent.has(s.id));
  if (!wanted.length) return true;
  await buildThumbs(wanted);
  const ready = wanted.filter((s) => thumbs.has(s.id));
  const pack = packCovers(ready);
  if (!pack) return true;
  const ok = await putGenerated('covers', 'bin', pack);
  if (ok) ready.forEach((s) => coversSent.add(s.id));
  log('covers', ready.length, ok ? 'sent' : 'FAILED');
  return ok;
}

let pushing = false;
async function pushCatalog() {
  if (pushing || !device) return true;
  pushing = true;
  try {
    const { songs, failed } = await loadLatest();
    const all = await loadBotAll().catch(() => []);
    latestSongs = songs;
    const compact = (s) => ({ i: s.id, t: s.title, n: s.name, a: s.artist, s: s.source, b: s.album, d: s.date, l: s.duration, x: s.about });
    const index = all.map((s) => [s.id.slice(2), s.name, s.artist, s.album]);
    const text = JSON.stringify({ latest: songs.map(compact), all: index, failed });
    const hash = crypto.createHash('md5').update(text).digest('hex');
    if (hash !== sentCatalogHash) {
      const ok = await putGenerated('catalog', 'json', Buffer.from(text, 'utf8'));
      log('catalog', songs.length, all.length, ok ? 'sent' : 'FAILED');
      if (!ok) return false;
      sentCatalogHash = hash;
    }
    planAuto();
    return await pushCovers(songs);
  } catch (err) {
    log('catalog', err.message);
    return false;
  } finally {
    pushing = false;
  }
}

/* ---------- song jobs ---------- */

const safeName = (t) => t.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim().slice(0, 120) || 'song';

async function fetchAudio(id, song) {
  const res = await request(song.url, { signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw new Error('המקור לא זמין כרגע');
  if ((res.headers.get('content-type') || '').includes('text/html')) throw new Error('המקור החזיר דף במקום קובץ שמע');
  const total = +res.headers.get('content-length') || 0;
  const chunks = [];
  let got = 0;
  let last = 0;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    got += chunk.length;
    if (total && Date.now() - last > 1200) {
      last = Date.now();
      setJob(id, { p: got / total });
    }
  }
  const data = Buffer.concat(chunks);
  if (data.length < 20000) throw new Error('הקובץ שהתקבל קטן מדי');
  return data;
}

async function jpegCover(song) {
  if (!song.cover) return null;
  const dir = fs.mkdtempSync(path.join(WORK, 'cover-'));
  try {
    const res = await request(song.cover);
    if (!res.ok) return null;
    const src = path.join(dir, 'src');
    const out = path.join(dir, 'out');
    fs.mkdirSync(src);
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(src, 'a'), Buffer.from(await res.arrayBuffer()));
    await images({ action: 'images', dir: src, out, size: 600 });
    const file = path.join(out, 'a.jpg');
    return fs.existsSync(file) ? { mime: 'image/jpeg', data: fs.readFileSync(file) } : null;
  } catch { return null; } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function runSong(id, storageName) {
  const song = catalog.get(id);
  if (!song) { setJob(id, { st: 'error', e: 'השיר לא נמצא' }); return false; }
  const dir = fs.mkdtempSync(path.join(WORK, 'job-'));
  try {
    setJob(id, { st: 'downloading', p: 0, e: '' });
    const audio = await fetchAudio(id, song);
    setJob(id, { st: 'tagging', p: 1 });
    const picture = await jpegCover(song);
    const fileName = `${safeName(song.title)}.mp3`;
    const file = path.join(dir, fileName);
    const tagged = retag(audio, { title: song.name, artist: song.artist, album: song.album, picture });
    fs.writeFileSync(file, tagged);
    setJob(id, { st: 'copying' });
    let reply = await mtp({ action: 'song', device, storage: storageName, file });
    if (!reply.ok && device) reply = await mtp({ action: 'song', device, storage: storageName, file });
    if (!reply.ok) throw new Error('ההעתקה לנגן נכשלה');
    const storage = storages.find((s) => s.name === storageName);
    if (storage) {
      if (!storage.music.includes(fileName)) storage.music.push(fileName);
      storage.free -= tagged.length;
    }
    setJob(id, { st: 'done' });
    log('song', song.title, storageName);
    return true;
  } catch (err) {
    log('song failed', song.title, err.message);
    setJob(id, { st: 'error', e: err.name === 'TimeoutError' ? 'ההורדה ארכה יותר מדי' : err.message });
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const running = new Set();

/* ---------- automatic download ---------- */

let autoQueue = [];
let autoCurrent = null;
let autoNote = '';
const autoFailures = new Map();

function planAuto() {
  if (!settings.auto || !device || !latestSongs.length) return;
  const have = onDeviceKeys();
  for (const song of latestSongs) {
    if (have.has(normalize(song.title))) { autoDone.add(song.id); continue; }
    if (autoDone.has(song.id) || running.has(song.id) || autoQueue.includes(song.id)) continue;
    if ((autoFailures.get(song.id) || 0) >= 2) continue;
    autoQueue.push(song.id);
  }
  saveSettings();
  statusDirty = true;
  runAutoQueue();
}

async function runAutoQueue() {
  if (autoCurrent) return;
  while (settings.auto && device && autoQueue.length) {
    const target = byCapacity()[settings.autoStorage] || byCapacity()[0];
    if (!target) break;
    if (target.free && target.free < MIN_FREE) {
      autoNote = 'אין מספיק מקום פנוי בנגן';
      log('auto stopped: storage full');
      autoQueue = [];
      break;
    }
    autoNote = '';
    const id = autoQueue.shift();
    if (running.has(id)) continue;
    autoCurrent = id;
    running.add(id);
    const ok = await runSong(id, target.name);
    running.delete(id);
    autoCurrent = null;
    if (ok) autoDone.add(id);
    else autoFailures.set(id, (autoFailures.get(id) || 0) + 1);
    saveSettings();
  }
  autoCurrent = null;
  statusDirty = true;
  pumpStatus();
}

/* ---------- requests from the player ---------- */

function handleInbox(name) {
  if (handled.has(name)) return;
  handled.add(name);
  const base = name.replace(/\.txt$/, '');
  if (base.startsWith('hello-')) {
    nextCatalog = 0;
    return;
  }
  acks.push(name);
  statusDirty = true;

  let m = base.match(/^req-\d+-(\d+)-(.+)$/);
  if (m) {
    const id = m[2].replace('_', ':');
    if (running.has(id)) return;
    const ordered = byCapacity();
    const storage = ordered[+m[1]] || ordered[0];
    autoQueue = autoQueue.filter((q) => q !== id);
    running.add(id);
    runSong(id, storage.name).then((ok) => { if (ok) autoDone.add(id); }).finally(() => running.delete(id));
    return;
  }
  m = base.match(/^cov-\d+-(.+)$/);
  if (m) {
    const songs = m[1].split('_').map((serial) => catalog.get(`s:${serial}`)).filter(Boolean);
    pushCovers(songs).catch((err) => log('covers', err.message));
    return;
  }
  m = base.match(/^cfg-\d+-auto-([01])-(\d+)$/);
  if (m) {
    settings.auto = m[1] === '1';
    settings.autoStorage = +m[2];
    autoNote = '';
    if (!settings.auto) autoQueue = [];
    saveSettings();
    log('auto download', settings.auto ? 'on' : 'off');
    planAuto();
  }
}

/* ---------- main loop ---------- */

let tick = 0;
let nextCatalog = 0;

function resetDevice() {
  device = null;
  storages = [];
  sentCatalogHash = '';
  coversSent.clear();
  autoQueue = [];
}

async function loop() {
  const reply = await mtp({ action: 'scan', music: tick % MUSIC_EVERY === 0 || !device });
  tick++;
  const found = reply.error ? null : [].concat(reply.devices || []).find((d) => [].concat(d.storages || []).some((s) => s.hasApp));
  if (reply.error) log('scan', reply.error);
  if (!found) {
    // A busy device sometimes answers one scan with nothing; only several misses in a row mean the cable is out.
    if (device && ++misses < MISSES_BEFORE_DISCONNECT) return;
    if (device) log('disconnected');
    resetDevice();
    return;
  }
  misses = 0;
  const previous = new Map(storages.map((s) => [s.name, s]));
  storages = [].concat(found.storages).map((s) => {
    const old = previous.get(s.name);
    return {
      name: s.name, capacity: s.capacity, free: s.free, hasApp: s.hasApp,
      inbox: [].concat(s.inbox || []),
      music: s.music ? [].concat(s.music) : (old ? old.music : []),
    };
  });
  if (device !== found.name) {
    device = found.name;
    log('connected', device);
    statusDirty = true;
    nextCatalog = 0;
  }
  storages.flatMap((s) => s.inbox).forEach(handleInbox);
  pumpStatus();
  if (Date.now() >= nextCatalog) {
    nextCatalog = Date.now() + CATALOG_MS;
    pushCatalog().then((ok) => { if (!ok) nextCatalog = Date.now() + RETRY_MS; });
  }
}

async function forever() {
  log('bridge started');
  for (;;) {
    try { await loop(); } catch (err) { log('loop', err.stack || err.message); }
    await new Promise((r) => setTimeout(r, SCAN_MS));
  }
}

process.on('uncaughtException', (err) => log('uncaught', err.stack || err.message));
process.on('unhandledRejection', (err) => log('unhandled', (err && err.stack) || err));

net.createServer().on('error', () => process.exit(0)).listen(LOCK_PORT, '127.0.0.1', () => {
  loadBotAll().catch(() => {});
  forever();
});
