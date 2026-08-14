import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { updateGraph } from '../worker/src/index.js';

function memoryKv() {
  const values = new Map();
  return {
    writes: 0,
    async get(key, type) {
      const stored = values.get(key) ?? null;
      return type === 'json' && stored ? JSON.parse(stored) : stored;
    },
    async put(key, value) { this.writes += 1; values.set(key, value); }
  };
}

async function seed(kv, username, now) {
  await kv.put(`lastfm-user-v1:${username}:graph`, JSON.stringify({
    version: 1, username, timeZone: 'UTC', countsByDate: {}, recentScrobbles: [],
    listeningStatus: null,
    profile: { username: 'Listener', avatarDataUri: 'data:image/png;base64,AQID', fetchedAt: now.getTime() },
    updatedAt: now.getTime() - 60_000
  }));
  kv.writes = 0;
}

test('Worker updates KV once and serves a no-cache SVG', async () => {
  const now = new Date();
  const env = {
    LASTFM_API_KEY: 'secret', LASTFM_USERNAME: 'listener', TIMEZONE: 'UTC',
    GRAPH_THEME: 'lastfm-black', LASTFM_STATE: memoryKv()
  };
  await seed(env.LASTFM_STATE, 'listener', now);
  const playedAt = String(Math.floor((now.getTime() - 60_000) / 1000));
  const fetchImpl = async (_url, options) => {
    if (options?.body?.get('method') === 'user.getInfo') {
      return { ok: true, status: 200, json: async () => ({ user: {
        name: 'Listener', image: [{ size: 'large', '#text': 'https://img.example/avatar.png' }]
      } }) };
    }
    if (!options?.body) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
    return {
      ok: true, status: 200,
      json: async () => ({ recenttracks: { '@attr': { totalPages: '1' }, track: [
        { '@attr': { nowplaying: 'true' }, artist: { '#text': 'Artist & Co' }, name: 'Live <Song>', album: { '#text': '' } },
        { date: { uts: playedAt }, artist: { '#text': 'Artist' }, name: 'Song', album: { '#text': '' } }
      ] } })
    };
  };
  const result = await updateGraph(env, { now, fetchImpl, sleep: async () => {} });
  assert.equal(result.recentScrobbles.length, 1);
  assert.equal(Object.values(result.countsByDate).reduce((sum, count) => sum + count, 0), 1);
  assert.equal(result.listeningStatus.kind, 'now-playing');
  const repeated = await updateGraph(env, { now: new Date(now.getTime() + 60_000), fetchImpl, sleep: async () => {} });
  assert.equal(Object.values(repeated.countsByDate).reduce((sum, count) => sum + count, 0), 1, 'overlap does not double-count a scrobble');
  const response = await worker.fetch(new Request('https://example.com/graph.svg'), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-cache/);
  assert.match(response.headers.get('content-security-policy'), /img-src data:/);
  const svg = await response.text();
  assert.match(svg, /Artist &amp; Co — Live &lt;Song&gt;/);
  assert.match(svg, />Listener</);
  assert.match(svg, /data:image\/png;base64,AQID/);
  assert.equal(env.LASTFM_STATE.writes, 2, 'each refresh writes only the lightweight graph state');
});

test('single-user endpoint rejects user overrides and never fetches on a missing-cache request', async () => {
  const kv = memoryKv();
  const env = {
    LASTFM_API_KEY: 'secret', LASTFM_USERNAME: 'owner', TIMEZONE: 'UTC',
    GRAPH_THEME: 'lastfm-black', LASTFM_STATE: kv
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    if (options?.body?.get('method') === 'user.getInfo') {
      const user = options.body.get('user');
      return { ok: true, status: 200, json: async () => ({ user: { name: user, image: [] } }) };
    }
    return { ok: true, status: 200, json: async () => ({ recenttracks: { '@attr': { totalPages: '1' }, track: [] } }) };
  };
  try {
    const override = await worker.fetch(new Request('https://example.com/graph.svg?user=Alice'), env);
    assert.equal(override.status, 400);
    const preparing = await worker.fetch(new Request('https://example.com/graph.svg'), env);
    assert.equal(preparing.status, 503);
    assert.equal(preparing.headers.get('retry-after'), '120');
    assert.equal(kv.writes, 0);
    await assert.rejects(updateGraph(env), /not initialized/);
    assert.equal(kv.writes, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
