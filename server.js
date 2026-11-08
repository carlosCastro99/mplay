// M3U Player — local server for your PC (no installs, no third parties)
// Serves the player at http://localhost:8787 and relays streams through this PC,
// so http:// channels and servers that block browser players both work.
// Run:  node server.js        (or double-click start.bat on Windows)

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { spawn, spawnSync } = require('child_process');

// ffmpeg (optional) converts channels Chrome can't decode (HEVC video, AC-3/MP2 audio)
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const hasFfmpeg = (() => { try { return spawnSync(FFMPEG, ['-version']).status === 0 } catch { return false } })();

// Pick the fastest working H.264 encoder: graphics card (NVIDIA / Intel / AMD) first, CPU last
const ENCODERS = [
  { name: 'NVIDIA GPU', args: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll', '-rc', 'vbr', '-cq', '23', '-g', '50', '-pix_fmt', 'yuv420p'] },
  { name: 'Intel GPU',  args: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '23', '-g', '50', '-pix_fmt', 'nv12'] },
  { name: 'AMD GPU',    args: ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '23', '-qp_p', '23', '-g', '50', '-pix_fmt', 'nv12'] },
];
const CPU_ENCODER = { name: 'CPU', args: ['-c:v', 'libx264', '-preset', 'superfast', '-tune', 'zerolatency', '-crf', '23', '-pix_fmt', 'yuv420p', '-g', '50', '-keyint_min', '25', '-sc_threshold', '0'] };
const encoder = !hasFfmpeg ? CPU_ENCODER : (ENCODERS.find(e => {
  try {
    return spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=1280x720:r=25', '-t', '0.5', ...e.args, '-f', 'null', '-'], { timeout: 15000 }).status === 0;
  } catch { return false }
}) || CPU_ENCODER);

function transcode(req, res, self) {
  const target = self.searchParams.get('url');
  if (!hasFfmpeg) { res.writeHead(501, { 'Access-Control-Allow-Origin': '*' }); return res.end('ffmpeg not installed'); }
  if (!target || !/^https?:\/\//i.test(target)) { res.writeHead(400); return res.end('Missing ?url='); }
  const full = self.searchParams.get('mode') === 'full';
  const video = full ? encoder.args : ['-c:v', 'copy'];
  const args = ['-hide_banner', '-loglevel', 'fatal', '-stats', '-stats_period', '5', '-user_agent', UA,
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-fflags', '+genpts+discardcorrupt', '-analyzeduration', '3000000', '-probesize', '3000000', '-i', target,
    '-map', '0:v:0?', '-map', '0:a:0?', ...video, '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000',
    // Live MPEG-TS out: the player starts it within a second or two (fragmented MP4 waits for keyframes)
    '-f', 'mpegts', '-mpegts_flags', '+resend_headers', '-muxdelay', '0', '-muxpreload', '0', 'pipe:1'];
  console.log(`${new Date().toLocaleTimeString()}  ffmpeg ${full ? 'convert video+audio (' + encoder.name + ')' : 'convert audio'}  ${target.replace(/^(https?:\/\/[^/]+).*?([^/?#]*)(\?.*)?$/, '$1/…/$2')}`);
  const ff = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  // Report conversion speed every ~10 s: below 1.0x the PC can't keep up and playback will stall
  let lastSpeed = 0;
  ff.stderr.on('data', d => {
    const text = d.toString();
    const m = text.match(/speed=\s*([\d.]+)x/);
    if (m) { const now = Date.now(); if (now - lastSpeed > 10000) { lastSpeed = now; const sp = parseFloat(m[1]); console.log(`  conversion speed ${sp.toFixed(2)}x${sp < 1 ? '  <- too slow, playback will stall' : ''}`); } }
    else if (text.trim()) process.stdout.write('  ffmpeg: ' + text);
  });
  res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  ff.stdout.pipe(res);
  ff.on('close', () => res.end());
  req.on('close', () => ff.kill('SIGKILL'));
}

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';   // only this PC; set HOST=0.0.0.0 to allow your phone on the same Wi-Fi
const UA = 'VLC/3.0.21 LibVLC/3.0.21';           // many IPTV servers only answer media players
const PAGE = path.join(__dirname, 'index.html');

function get(target, headers, hops = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(target);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { headers }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 5) {
        res.resume();
        return resolve(get(new URL(res.headers.location, u).href, headers, hops + 1));
      }
      res.finalUrl = u.href;
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
  });
}

async function relay(req, res, self) {
  const target = self.searchParams.get('url');
  if (!target || !/^https?:\/\//i.test(target)) { res.writeHead(400); return res.end('Missing ?url='); }
  const headers = { 'User-Agent': UA };
  if (req.headers.range) headers.Range = req.headers.range;

  let up;
  try { up = await get(target, headers); }
  catch (e) { console.log(`${new Date().toLocaleTimeString()}  FAILED  ${e.message}  ${target.replace(/\?.*/, '')}`); res.writeHead(502, { 'Access-Control-Allow-Origin': '*' }); return res.end('Upstream unreachable: ' + e.message); }

  const out = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (up.headers[h]) out[h] = up.headers[h];

  // Peek at the first bytes to tell an HLS playlist from a media stream
  const short = target.replace(/^(https?:\/\/[^/]+).*?([^/?#]*)(\?.*)?$/, '$1/…/$2');
  console.log(`${new Date().toLocaleTimeString()}  ${up.statusCode}  ${up.headers['content-type'] || '-'}  ${short}`);
  let started = false;
  up.once('data', first => {
    started = true;
    const isPlaylist = !self.searchParams.has('raw') && (first.slice(0, 16).toString().trimStart().startsWith('#EXTM3U') || /mpegurl/i.test(up.headers['content-type'] || ''));
    if (!isPlaylist && self.searchParams.has('expect')) {
      // The player asked for an HLS playlist but this is a live stream: refuse at once and free the provider connection
      up.destroy();
      res.writeHead(415, { 'Access-Control-Allow-Origin': '*' });
      return res.end('Not an HLS playlist');
    }
    if (!isPlaylist) {
      res.writeHead(up.statusCode, out);
      res.write(first);
      up.pipe(res);
      return;
    }
    const chunks = [first];
    up.on('data', c => chunks.push(c));
    up.on('end', () => {
      const base = up.finalUrl;
      const wrap = u => '/relay?url=' + encodeURIComponent(new URL(u, base).href);
      const body = Buffer.concat(chunks).toString().split(/\r?\n/).map(line => {
        const t = line.trim();
        if (!t) return line;
        if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${wrap(u)}"`);
        return wrap(t);
      }).join('\n');
      delete out['content-length'];
      out['content-type'] = 'application/vnd.apple.mpegurl';
      res.writeHead(up.statusCode, out);
      res.end(body);
    });
  });
  up.on('end', () => { if (!started) { res.writeHead(up.statusCode, out); res.end(); } });
  up.on('error', () => res.destroy());
  req.on('close', () => up.destroy());
}

http.createServer((req, res) => {
  const self = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (self.pathname === '/relay') return relay(req, res, self);
  if (self.pathname === '/transcode') return transcode(req, res, self);
  if (self.pathname === '/' || self.pathname === '/index.html') {
    fs.readFile(PAGE, 'utf8', (err, html) => {
      if (err) { res.writeHead(500); return res.end('index.html not found next to server.js'); }
      html = html.replace('<head>', `<head>\n<script>window.MPLAY_LOCAL_RELAY = "/relay"; window.MPLAY_FFMPEG = ${hasFfmpeg};</script>`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    });
    return;
  }
  res.writeHead(404); res.end();
}).on('error', e => {
  if (e.code === 'EADDRINUSE') console.log(`Port ${PORT} is already in use. Close the other M3U Player window (or restart the PC) and run start.bat again.`);
  else console.log('Server error: ' + e.message);
  process.exit(1);
}).listen(PORT, HOST, () => {
  console.log(`M3U Player running at http://localhost:${PORT}  (close this window to stop)`);
  console.log(hasFfmpeg ? `ffmpeg found: channels Chrome cannot decode will be converted (video encoder: ${encoder.name}).` : 'ffmpeg NOT found: some channels (HEVC, AC-3) will not play. Install it with:  winget install Gyan.FFmpeg   then run start.bat again.');
});
