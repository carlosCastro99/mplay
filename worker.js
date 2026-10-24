// M3U Player stream relay — Cloudflare Worker
// Fetches http:// IPTV streams and serves them over https with CORS,
// rewriting HLS playlists so every segment also goes through the relay.
//
// 1. Change KEY below to any secret word (stops strangers using your relay).
// 2. Deploy, then put the Worker URL and the same key in the player's Proxy settings.

const KEY = 'change-me';
const UA = 'VLC/3.0.21 LibVLC/3.0.21';   // many IPTV servers only answer media players

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const self = new URL(request.url);
    const target = self.searchParams.get('url');
    if (self.searchParams.get('key') !== KEY) return text('Wrong or missing key', 403);
    if (!target || !/^https?:\/\//i.test(target)) return text('Missing ?url=', 400);

    const headers = { 'User-Agent': UA };
    const range = request.headers.get('Range');
    if (range) headers.Range = range;

    let upstream;
    try {
      upstream = await fetch(target, { headers, redirect: 'follow' });
    } catch (e) {
      return text('Upstream unreachable: ' + e.message, 502);
    }

    const out = new Headers(CORS);
    for (const h of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']) {
      const val = upstream.headers.get(h);
      if (val) out.set(h, val);
    }
    out.set('Cache-Control', 'no-store');
    if (!upstream.body) return new Response(null, { status: upstream.status, headers: out });

    // Peek at the first chunk to tell an HLS playlist from a media stream
    const reader = upstream.body.getReader();
    const first = await reader.read();
    const head = first.value ? new TextDecoder().decode(first.value.slice(0, 16)) : '';
    const type = (upstream.headers.get('Content-Type') || '').toLowerCase();
    const isPlaylist = head.trimStart().startsWith('#EXTM3U') || type.includes('mpegurl');

    if (isPlaylist) {
      let body = first.value ? new TextDecoder().decode(first.value, { stream: true }) : '';
      const dec = new TextDecoder();
      for (;;) { const { done, value } = await reader.read(); if (done) break; body += dec.decode(value, { stream: true }); }
      const base = upstream.url || target;
      const relay = u => `${self.origin}${self.pathname}?key=${encodeURIComponent(KEY)}&url=${encodeURIComponent(new URL(u, base).href)}`;
      body = body.split(/\r?\n/).map(line => {
        const t = line.trim();
        if (!t) return line;
        if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${relay(u)}"`);
        return relay(t);
      }).join('\n');
      out.set('Content-Type', 'application/vnd.apple.mpegurl');
      out.delete('Content-Length');
      return new Response(body, { status: upstream.status, headers: out });
    }

    // Media: stream it through untouched
    const stream = new ReadableStream({
      start(c) { if (first.value) c.enqueue(first.value); if (first.done) c.close(); },
      async pull(c) { const { done, value } = await reader.read(); if (done) c.close(); else c.enqueue(value); },
      cancel(r) { reader.cancel(r); },
    });
    return new Response(stream, { status: upstream.status, headers: out });
  },
};

function text(msg, status) {
  return new Response(msg, { status, headers: { ...CORS, 'Content-Type': 'text/plain' } });
}
