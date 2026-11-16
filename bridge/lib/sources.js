const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36';
const NIGUN = 'https://nigun.pages.dev';
const NEWS = 'https://newsmusic.blogspot.com';
const BOT = 'https://shir-bot.ze-kal.top/assets/data';
const BOT_LATEST = 60;

const catalog = new Map();
let botAll = null;

const request = (url, opts = {}) => fetch(url, {
  ...opts,
  headers: { 'User-Agent': UA, ...(opts.headers || {}) },
  signal: opts.signal || AbortSignal.timeout(20000),
});

async function getText(url) {
  const res = await request(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.text();
}

const decode = (s) => s
  .replace(/&quot;/g, '"').replace(/&#39;|&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&').trim();

const normalize = (t) => t.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();

function makeSong({ id, source, title, artist, album, cover, url, driveId, date, duration, about }) {
  const split = title.indexOf(' - ');
  const song = {
    id, source, title,
    artist: artist || (split > 0 ? title.slice(0, split) : ''),
    name: split > 0 ? title.slice(split + 3) : title,
    album: album || '', cover: cover || '', url, driveId: driveId || '', date: date || 0,
    duration: duration || '', about: about || '',
  };
  catalog.set(id, song);
  return song;
}

const driveUrl = (id) => `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;

async function loadNigun() {
  const html = await getText(`${NIGUN}/`);
  const songs = [];
  const seen = new Set();
  const re = /<button class="pp"[^>]*data-pid="([^"]+)"[^>]*data-title="([^"]*)"[^>]*data-cover="([^"]*)"/g;
  for (let m; (m = re.exec(html));) {
    if (seen.has(m[1])) continue;
    const link = html.slice(m.index, m.index + 4000).match(/href="(\/dl?\/[^"]+\.mp3)"/);
    if (!link) continue;
    seen.add(m[1]);
    const before = html.slice(Math.max(0, m.index - 2500), m.index);
    const dates = [...before.matchAll(/d-greg">(\d\d)\/(\d\d)\/(\d{4})/g)];
    const d = dates[dates.length - 1];
    const durations = [...before.matchAll(/mdur">([\d:]+)/g)];
    songs.push(makeSong({
      duration: durations.length ? durations[durations.length - 1][1] : '',
      id: `n:${m[1]}`, source: 'nigun', title: decode(m[2]),
      cover: m[3] ? NIGUN + m[3] : '', url: NIGUN + link[1],
      date: d ? Date.UTC(+d[3], +d[2] - 1, +d[1]) : 0,
    }));
  }
  return songs;
}

async function loadNews() {
  const html = await getText(`${NEWS}/`);
  const songs = [];
  for (const post of html.split(/class=['"]post-outer['"]/).slice(1)) {
    const title = post.match(/post-title[\s\S]*?<a [^>]*>([^<]+)<\/a>/);
    const archive = post.match(/https:\/\/archive\.org\/download\/[^"'<\s]+\.mp3/);
    const drive = post.match(/drive\.google\.com\/file\/d\/([\w-]+)/);
    if (!title || (!archive && !drive)) continue;
    const img = post.match(/<img[^>]+src="(https:\/\/[^"]+)"/);
    const when = post.match(/datePublished['"] title=['"]([^'"]+)/);
    const url = archive ? archive[0].replace(/&amp;/g, '&') : driveUrl(drive[1]);
    const paragraphs = [];
    for (const p of post.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)) {
      const text = decode(p[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
      if (/קרדיטים|להורדה|להאזנה/.test(text)) break;
      if (text) paragraphs.push(text);
    }
    songs.push(makeSong({
      about: paragraphs.join('\n').slice(0, 700),
      id: `h:${crypto.createHash('md5').update(url).digest('hex').slice(0, 12)}`,
      source: 'news', title: decode(title[1]),
      cover: img ? img[1].replace(/\/[swh]\d+[^/]*\//, '/s600/') : '',
      url, driveId: archive ? '' : drive[1], date: when ? Date.parse(when[1]) : 0,
    }));
  }
  return songs;
}

function botSong(s) {
  const name = String(s.name || '');
  const title = name.includes(' - ') || !s.singer ? name : `${s.singer} - ${name}`;
  return makeSong({
    id: `s:${s.serial}`, source: 'bot', title, artist: s.singer, album: s.album,
    url: driveUrl(s.driveId), driveId: s.driveId,
  });
}

async function loadBotLatest() {
  const list = JSON.parse(await getText(`${BOT}/new_songs.json`));
  return list.slice(-BOT_LATEST).reverse().map(botSong);
}

function loadBotAll() {
  botAll ||= Promise.all(['all_songs', 'new_songs'].map((f) => getText(`${BOT}/${f}.json`).then(JSON.parse)))
    .then(([all, fresh]) => {
      const seen = new Set();
      return [...fresh.reverse(), ...all.reverse()].filter((s) => {
        if (!s.driveId || seen.has(s.driveId)) return false;
        seen.add(s.driveId);
        return true;
      }).map(botSong);
    })
    .catch((err) => { botAll = null; throw err; });
  return botAll;
}

let latest = [];

async function loadLatest() {
  const names = ['nigun', 'news', 'bot'];
  const results = await Promise.allSettled([loadNigun(), loadNews(), loadBotLatest()]);
  const failed = names.filter((_, i) => results[i].status === 'rejected');
  results.forEach((r, i) => { if (r.status === 'rejected') console.error(names[i], r.reason); });

  const seen = new Map();
  const unique = [];
  for (const song of results.flatMap((r) => r.value || [])) {
    const key = normalize(song.title);
    const twin = seen.get(key);
    if (twin) {
      for (const field of ['cover', 'about', 'album', 'duration']) {
        if (!twin[field] && song[field]) twin[field] = song[field];
      }
      continue;
    }
    seen.set(key, song);
    unique.push(song);
  }
  const dated = unique.filter((s) => s.date).sort((a, b) => b.date - a.date);
  const undated = unique.filter((s) => !s.date);
  const merged = [];
  while (dated.length || undated.length) {
    merged.push(...dated.splice(0, 2), ...undated.splice(0, 1));
  }
  latest = merged;
  return { songs: merged, failed };
}

async function search(query) {
  const words = query.split(/\s+/).map(normalize).filter(Boolean);
  if (!words.length) return [];
  const hit = (s) => {
    const text = normalize(`${s.title} ${s.artist} ${s.album}`);
    return words.every((w) => text.includes(w));
  };
  const seen = new Set();
  const out = [];
  for (const song of [...latest, ...await loadBotAll()]) {
    if (out.length >= 120) break;
    const key = normalize(song.title);
    if (seen.has(key) || !hit(song)) continue;
    seen.add(key);
    out.push(song);
  }
  return out;
}

module.exports = { catalog, loadLatest, loadBotAll, search, normalize, request, driveUrl };
