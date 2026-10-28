// Local multi-brand poster: X, LinkedIn, YouTube, Instagram via their official APIs. Run: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const D = __dirname, DATA = path.join(D, 'data.json'), MEDIA = path.join(D, 'media');
fs.mkdirSync(MEDIA, { recursive: true });
let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(D, 'config.json'), 'utf8')); } catch {}
const PORT = cfg.port || 3000, BASE = `http://localhost:${PORT}`;
const BRANDS = {
  // Note: the current LinkedIn app posts as the personal profile, not the company pages; those need LinkedIn's Community Management API.
  atlas: { name: 'Atlas Builders Community', p: ['linkedin', 'x', 'instagram'] },
  m33: { name: 'm33.hq', p: ['linkedin', 'x', 'instagram', 'youtube'] },
  legend: { name: 'Legend editx', p: ['youtube', 'instagram', 'x'] },
  fenil: { name: 'Fenil Shah', p: ['instagram', 'x', 'linkedin'] },
};
let db = { tokens: {}, posts: [] }; try { db = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch {}
const save = () => fs.writeFileSync(DATA, JSON.stringify(db, null, 1));
const form = o => new URLSearchParams(o).toString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const G = 'https://graph.instagram.com/v21.0/';

async function J(url, opt) {
  const r = await fetch(url, opt), t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${url.split('?')[0]}: ${t.slice(0, 300)}`);
  let b = t; try { b = JSON.parse(t); } catch {}
  return { b, h: r.headers };
}

const AUTH = {
  x: { url: 'https://twitter.com/i/oauth2/authorize', q: { scope: 'tweet.read tweet.write users.read offline.access' } },
  linkedin: { url: 'https://www.linkedin.com/oauth/v2/authorization', q: { scope: 'openid profile w_member_social' } },
  youtube: { url: 'https://accounts.google.com/o/oauth2/v2/auth', q: { scope: 'https://www.googleapis.com/auth/youtube.upload', access_type: 'offline', prompt: 'consent' } },
  instagram: { url: 'https://www.instagram.com/oauth/authorize', q: { scope: 'instagram_business_basic,instagram_business_content_publish' } }, // Instagram Login: no Facebook Page needed
};
const TOKEN = { x: 'https://api.twitter.com/2/oauth2/token', linkedin: 'https://www.linkedin.com/oauth/v2/accessToken', youtube: 'https://oauth2.googleapis.com/token' };

async function tokenReq(pl, params) {
  const c = cfg[pl], h = { ...FORM }, body = { ...params };
  if (pl === 'x') h.authorization = 'Basic ' + Buffer.from(c.client_id + ':' + c.client_secret).toString('base64');
  else { body.client_id = c.client_id; body.client_secret = c.client_secret; }
  return (await J(TOKEN[pl], { method: 'POST', headers: h, body: form(body) })).b;
}

async function access(key, pl) {
  const t = db.tokens[key];
  if (!t) throw new Error('not connected');
  // Instagram long-lived tokens last 60 days and can be refreshed once they are a day old.
  if (pl === 'instagram' && t.exp - Date.now() < 7 * 864e5 && Date.now() < t.exp && Date.now() - t.at > 864e5) {
    const r = (await J('https://graph.instagram.com/refresh_access_token?' + form({ grant_type: 'ig_refresh_token', access_token: t.access }))).b;
    t.access = r.access_token; t.exp = Date.now() + r.expires_in * 1000; t.at = Date.now(); save();
  }
  if (t.exp && Date.now() > t.exp) {
    if (!t.refresh) throw new Error('token expired, reconnect');
    const n = await tokenReq(pl, { grant_type: 'refresh_token', refresh_token: t.refresh });
    t.access = n.access_token; t.exp = Date.now() + n.expires_in * 1000 - 60000;
    if (n.refresh_token) t.refresh = n.refresh_token;
    save();
  }
  return t;
}

const A = {
  async x(t, p) {
    if (p.text.length > 280) throw new Error(`${p.text.length} chars, X limit is 280`);
    await J('https://api.twitter.com/2/tweets', { method: 'POST', headers: { authorization: 'Bearer ' + t.access, 'content-type': 'application/json' }, body: JSON.stringify({ text: p.text }) }); // text only
  },
  async linkedin(t, p) { // personal profile only
    await J('https://api.linkedin.com/v2/ugcPosts', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + t.access, 'content-type': 'application/json', 'X-Restli-Protocol-Version': '2.0.0' },
      body: JSON.stringify({ author: t.urn, lifecycleState: 'PUBLISHED', specificContent: { 'com.linkedin.ugc.ShareContent': { shareCommentary: { text: p.text }, shareMediaCategory: 'NONE' } }, visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' } }),
    });
  },
  async youtube(t, p) {
    if (!p.media) throw new Error('needs a video');
    const [title, ...rest] = p.text.split('\n');
    const { h } = await J('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST', headers: { authorization: 'Bearer ' + t.access, 'content-type': 'application/json' },
      body: JSON.stringify({ snippet: { title: title.slice(0, 100), description: rest.join('\n') + '\n#Shorts' }, status: { privacyStatus: 'public' } }),
    });
    await J(h.get('location'), { method: 'PUT', headers: { 'content-type': 'video/*' }, body: fs.readFileSync(path.join(MEDIA, p.media)) });
  },
  async instagram(t, p) { // a Reel (video), one JPEG, or a carousel of 2-10 JPEG photos and/or videos (p.media = comma-separated files)
    if (!p.media) throw new Error('needs a video or JPEG photo');
    if (!cfg.publicBaseUrl) throw new Error('set publicBaseUrl in config.json (see README)');
    const files = p.media.split(',');
    if (files.some(f => /\.(png|gif|webp)$/i.test(f))) throw new Error('Instagram photos must be JPEG');
    if (files.some(f => !/^https?:\/\//.test(f) && !/\.(jpe?g|mp4|mov)$/i.test(f))) throw new Error('only JPEG photos and MP4/MOV videos');
    const isImg = f => /\.jpe?g$/i.test(f);
    const url = f => /^https?:\/\//.test(f) ? f : cfg.publicBaseUrl + '/media/' + encodeURIComponent(f); // full URLs = a temporary public host
    const create = body => J(G + 'me/media', { method: 'POST', headers: FORM, body: form({ ...body, access_token: t.access }) }).then(r => r.b);
    const ready = async id => {
      for (let i = 0; ; i++) {
        const { b } = await J(`${G}${id}?fields=status_code,status&access_token=${t.access}`);
        if (b.status_code === 'FINISHED') return;
        if (b.status_code === 'ERROR' || b.status_code === 'EXPIRED' || i >= 180) throw new Error('Instagram processing ' + b.status_code + (b.status ? ': ' + b.status : ''));
        await sleep(5000);
      }
    };
    // Instagram's resumable upload does not work with Instagram Login (tested: "video_url is required"), so Instagram fetches the public link.
    const video = (body, f) => create({ ...body, video_url: url(f) });
    let c;
    if (files.length > 1) {
      if (files.length > 10) throw new Error('a carousel takes 2-10 items');
      const kids = [];
      for (const f of files) {
        const k = isImg(f) ? await create({ image_url: url(f), is_carousel_item: 'true' }) : await video({ media_type: 'VIDEO', is_carousel_item: 'true' }, f);
        await ready(k.id); kids.push(k.id);
      }
      c = await create({ media_type: 'CAROUSEL', children: kids.join(','), caption: p.text });
    } else {
      c = isImg(p.media) ? await create({ image_url: url(p.media), caption: p.text }) : await video({ media_type: 'REELS', caption: p.text }, p.media);
    }
    await ready(c.id);
    const pub = await J(G + 'me/media_publish', { method: 'POST', headers: FORM, body: form({ creation_id: c.id, access_token: t.access }) });
    p.published = pub.b.id; // lets us look up the permalink afterwards
  },
};

// Music: Instagram's API can't pick tracks from its library, so the audio is baked into the video here.
// One video -> its sound is replaced by the track. Photos -> a 9:16 Reel slideshow (3 s per photo) set to the track.
const ff = args => require('child_process').execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args]);
function addMusic(media, music) {
  const files = media.split(',').filter(Boolean), out = crypto.randomBytes(4).toString('hex') + '-music.mp4', o = path.join(MEDIA, out), m = path.join(MEDIA, music);
  if (!files.length || !fs.existsSync(m)) throw new Error('music needs a video or photos, and an uploaded audio file');
  if (files.length === 1 && !/\.jpe?g$/i.test(files[0])) {
    ff(['-i', path.join(MEDIA, files[0]), '-i', m, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-shortest', o]);
  } else {
    const ins = files.flatMap(f => ['-loop', '1', '-t', '3', '-i', path.join(MEDIA, f)]);
    const v = files.map((_, i) => `[${i}:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30[v${i}]`).join(';');
    ff([...ins, '-i', m, '-filter_complex', `${v};${files.map((_, i) => `[v${i}]`).join('')}concat=n=${files.length}:v=1:a=0[v]`, '-map', '[v]', '-map', `${files.length}:a`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', o]);
  }
  return out;
}

// Phone videos are often HEVC/MOV, which Instagram rejects. Make every uploaded video H.264 + AAC MP4 with the index up front
// (a lossless remux when it already is H.264/AAC, a re-encode otherwise).
const run = (bin, args) => new Promise((ok, no) => require('child_process').execFile(bin, args, { maxBuffer: 1 << 26 }, (e, out, err) => e ? no(new Error(String(err || e.message).slice(-300))) : ok(String(out))));
async function normalizeVideo(name) {
  const src = path.join(MEDIA, name), out = name.replace(/\.\w+$/, '') + '-ig.mp4';
  const s = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,pix_fmt', '-of', 'json', src])).streams || [];
  const v = s.find(x => x.codec_type === 'video'), a = s.find(x => x.codec_type === 'audio');
  if (!v) throw new Error('no video stream in ' + name);
  const ok = v.codec_name === 'h264' && v.pix_fmt === 'yuv420p' && (!a || a.codec_name === 'aac');
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-map', '0:v:0', '-map', '0:a:0?', ...(ok ? ['-c', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k']), '-movflags', '+faststart', path.join(MEDIA, out)]);
  fs.unlinkSync(src); return out;
}

// Never retries a failed platform automatically: a retry could double-post.
let busy = false;
async function tick() {
  if (busy) return; busy = true;
  try {
    for (const p of db.posts) {
      if (new Date(p.when).getTime() > Date.now()) continue;
      for (const pl of p.platforms) {
        if (p.status[pl] !== 'pending') continue;
        p.status[pl] = 'posting'; save();
        try { await A[pl](await access(p.brand + ':' + pl, pl), p); p.status[pl] = 'done'; }
        catch (e) { p.status[pl] = 'error: ' + e.message; }
        save();
      }
    }
  } finally { busy = false; }
}
setInterval(tick, 30000);

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const SESSION = cfg.password ? crypto.createHmac('sha256', cfg.password).update('posthub').digest('hex') : null;
let fails = 0, lockUntil = 0;
const LOGIN = '<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="font:16px system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh"><form method=post action=/login><h2>Post Hub</h2><input type=password name=password placeholder=Password autofocus style="font:inherit;padding:8px"> <button style="font:inherit;padding:8px">Log in</button></form>';
const states = {};
const readBody = req => new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });

http.createServer(async (req, res) => {
  const u = new URL(req.url, BASE);
  const send = (c, b, h = {}) => { res.writeHead(c, { 'content-type': 'text/plain', ...h }); res.end(b); };
  try {
    // Requests via a tunnel/phone (non-localhost Host) need the password; /media/ stays public for Instagram to fetch.
    const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '');
    const ck = (req.headers.cookie || '').match(/(?:^|; )sid=([0-9a-f]{64})/);
    const authed = local || (SESSION && ck && crypto.timingSafeEqual(Buffer.from(ck[1]), Buffer.from(SESSION)));
    // /cb/ is open too: it only works with the one-time state created by the local-only /connect (Instagram needs an https redirect).
    if (!authed && !u.pathname.startsWith('/media/') && !u.pathname.startsWith('/cb/')) {
      if (!SESSION) return send(403, 'Remote access is off. Set "password" in config.json on the PC.');
      if (req.method === 'POST' && u.pathname === '/login') {
        if (Date.now() < lockUntil) return send(429, 'Too many tries, wait a minute.');
        const pw = new URLSearchParams((await readBody(req)).toString()).get('password') || '';
        await sleep(1000);
        if (crypto.timingSafeEqual(sha(pw), sha(cfg.password))) {
          fails = 0;
          res.writeHead(302, { location: '/', 'set-cookie': `sid=${SESSION}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` + (req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '') });
          return res.end();
        }
        if (++fails >= 5) { lockUntil = Date.now() + 60000; fails = 0; }
        return send(401, 'Wrong password');
      }
      return send(200, LOGIN, { 'content-type': 'text/html' });
    }
    // Instagram's redirect is the public https link, so it can be connected from the phone; the others redirect to localhost.
    if (!local && u.pathname.startsWith('/connect') && !u.pathname.endsWith('/instagram')) return send(403, 'Connect this one from the PC itself.');

    if (u.pathname === '/') return send(200, fs.readFileSync(path.join(D, 'index.html')), { 'content-type': 'text/html' });
    if (u.pathname.startsWith('/media/')) {
      const f = path.join(MEDIA, path.basename(decodeURIComponent(u.pathname.slice(7))));
      if (!fs.existsSync(f)) return send(404, 'nf');
      const MIME = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
      res.writeHead(200, { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'content-length': fs.statSync(f).size });
      return fs.createReadStream(f).pipe(res);
    }
    if (u.pathname === '/api/state') return send(200, JSON.stringify({ brands: BRANDS, connected: Object.keys(db.tokens), names: Object.fromEntries(Object.entries(db.tokens).map(([k, t]) => [k, t.name || ''])),posts: db.posts, configured: Object.keys(cfg) }), { 'content-type': 'application/json' });

    let m = u.pathname.match(/^\/connect\/(\w+)\/(\w+)$/);
    if (m) {
      const [, brand, pl] = m;
      if (!BRANDS[brand] || !AUTH[pl] || !cfg[pl]) return send(400, 'Unknown brand/platform, or no keys for it in config.json');
      const state = crypto.randomBytes(16).toString('hex'), v = crypto.randomBytes(32).toString('base64url');
      // Instagram only accepts https redirects, so it goes through the public tunnel URL; the others use localhost.
      const redirect = (pl === 'instagram' && cfg.publicBaseUrl ? cfg.publicBaseUrl : BASE) + `/cb/${pl}`;
      if (pl === 'instagram' && !cfg.publicBaseUrl) return send(400, 'Set publicBaseUrl (your https tunnel link) in config.json first.');
      states[state] = { brand, v, redirect, home: local ? BASE : cfg.publicBaseUrl }; // send phone users back to the phone link, not localhost
      const q = { client_id: cfg[pl].client_id, redirect_uri: redirect, response_type: 'code', state, ...AUTH[pl].q };
      if (pl === 'x') { q.code_challenge = crypto.createHash('sha256').update(v).digest('base64url'); q.code_challenge_method = 'S256'; }
      res.writeHead(302, { location: AUTH[pl].url + '?' + form(q) }); return res.end();
    }

    m = u.pathname.match(/^\/cb\/(\w+)$/);
    if (m) {
      const pl = m[1], st = states[u.searchParams.get('state')], code = u.searchParams.get('code');
      if (!st || !code || !cfg[pl]) return send(400, 'Login failed or was cancelled: ' + (u.searchParams.get('error_description') || u.searchParams.get('error') || 'bad state'));
      delete states[u.searchParams.get('state')];
      const redirect_uri = st.redirect; let rec;
      if (pl === 'instagram') {
        const c = cfg.instagram;
        const s = (await J('https://api.instagram.com/oauth/access_token', { method: 'POST', headers: FORM, body: form({ client_id: c.client_id, client_secret: c.client_secret, grant_type: 'authorization_code', redirect_uri, code }) })).b;
        const L = (await J('https://graph.instagram.com/access_token?' + form({ grant_type: 'ig_exchange_token', client_secret: c.client_secret, access_token: s.access_token }))).b;
        rec = { access: L.access_token, exp: Date.now() + L.expires_in * 1000, at: Date.now() };
        rec.name = '@' + (await J(G + 'me?fields=username&access_token=' + rec.access)).b.username;
      } else {
        const b = { grant_type: 'authorization_code', code, redirect_uri }; if (pl === 'x') b.code_verifier = st.v;
        const t = await tokenReq(pl, b);
        rec = { access: t.access_token, refresh: t.refresh_token, exp: t.expires_in ? Date.now() + t.expires_in * 1000 - 60000 : 0 };
        if (pl === 'linkedin') rec.urn = 'urn:li:person:' + (await J('https://api.linkedin.com/v2/userinfo', { headers: { authorization: 'Bearer ' + rec.access } })).b.sub;
      }
      db.tokens[st.brand + ':' + pl] = rec; save();
      res.writeHead(302, { location: st.home + '/' }); return res.end();
    }

    if (req.method === 'POST') {
      const raw = await readBody(req);
      if (u.pathname === '/api/upload') {
        let name = crypto.randomBytes(4).toString('hex') + '-' + path.basename(u.searchParams.get('name') || 'video.mp4').replace(/[^\w.-]/g, '_');
        fs.writeFileSync(path.join(MEDIA, name), raw);
        if (/\.(mp4|mov|m4v)$/i.test(name)) try { name = await normalizeVideo(name); } catch (e) { console.log('video not normalized:', e.message); } // keep the original if ffmpeg fails
        // Instagram only takes JPEG photos: convert PNG/WEBP on upload so carousels just work.
        if (/\.(png|webp)$/i.test(name)) {
          const jpg = name.replace(/\.\w+$/, '.jpg');
          ff(['-i', path.join(MEDIA, name), '-q:v', '2', path.join(MEDIA, jpg)]); fs.unlinkSync(path.join(MEDIA, name));
          return send(200, JSON.stringify({ name: jpg }), { 'content-type': 'application/json' });
        }
        return send(200, JSON.stringify({ name }), { 'content-type': 'application/json' });
      }
      const b = JSON.parse(raw.toString() || '{}');
      if (u.pathname === '/api/post') {
        const br = BRANDS[b.brand], pls = (b.platforms || []).filter(x => br && br.p.includes(x));
        if (!br || !pls.length || !String(b.text || '').trim()) return send(400, 'brand, platforms and text are required');
        let media = b.media || '';
        if (b.music) media = addMusic(media, path.basename(b.music));
        db.posts.push({ id: crypto.randomBytes(4).toString('hex'), brand: b.brand, platforms: pls, text: b.text, media, when: b.when || new Date().toISOString(), status: Object.fromEntries(pls.map(x => [x, x === 'x' && !(cfg.x && cfg.x.client_id) ? 'manual' : 'pending'])) }); // X's API is paid: without keys, X posts wait for the phone share button
        save(); tick(); return send(200, 'ok');
      }
      if (u.pathname === '/api/mark') { const p = db.posts.find(q => q.id === b.id); if (p && p.status[b.platform] === 'manual') { p.status[b.platform] = 'done'; save(); } return send(200, 'ok'); }
      if (u.pathname === '/api/delete') { db.posts = db.posts.filter(p => p.id !== b.id); save(); return send(200, 'ok'); }
    }
    send(404, 'nf');
  } catch (e) { send(500, 'Error: ' + e.message); }
}).listen(PORT, '127.0.0.1', () => console.log('Post Hub on ' + BASE));
