import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAvatarDataUri, fetchScrobbles, fetchUserProfile } from '../src/lastfm.js';

test('handles pagination, now-playing entries, malformed tracks, and duplicates', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: true, status: 200,
      json: async () => ({ recenttracks: {
        '@attr': { totalPages: '2' },
        track: calls === 1
          ? [{ '@attr': { nowplaying: 'true' }, name: 'Live', artist: { '#text': 'A' } },
             { date: { uts: '100' }, name: 'Song', artist: { '#text': 'Artist' }, album: { '#text': 'Album' } }]
          : [{ date: { uts: '100' }, name: 'Song', artist: { '#text': 'Artist' }, album: { '#text': 'Album' } },
             { date: {}, name: 'Broken', artist: { '#text': 'Artist' } }]
      } })
    };
  };
  const result = await fetchScrobbles({ apiKey: 'secret', username: 'user', from: 1, to: 200, fetchImpl, sleep: async () => {} });
  assert.equal(calls, 2);
  assert.equal(result.scrobbles.length, 2, 'overlap duplicates are normalized by the cache merge layer');
  assert.deepEqual(result.nowPlaying, { artist: 'A', track: 'Live', album: '' });
});

test('retries transient errors with exponential backoff', async () => {
  let calls = 0;
  const waits = [];
  const fetchImpl = async () => {
    calls += 1;
    if (calls < 3) return { ok: false, status: 429 };
    return { ok: true, status: 200, json: async () => ({ recenttracks: { '@attr': { totalPages: '1' }, track: [] } }) };
  };
  const result = await fetchScrobbles({ apiKey: 'secret', username: 'user', from: 1, to: 2, fetchImpl, sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(result.nowPlaying, null);
});

test('respects a page ceiling and reports an incomplete range', async () => {
  let calls = 0;
  const result = await fetchScrobbles({
    apiKey: 'secret', username: 'user', from: 1, to: 100,
    maxPages: 2, sleep: async () => {},
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true, status: 200,
        json: async () => ({ recenttracks: {
          '@attr': { totalPages: '10' },
          track: [{ date: { uts: String(100 - calls) }, name: `Song ${calls}`, artist: { '#text': 'Artist' }, album: { '#text': '' } }]
        } })
      };
    }
  });
  assert.equal(calls, 2);
  assert.equal(result.complete, false);
  assert.equal(result.scrobbles.length, 2);
});

test('fetches a canonical profile and safely embeds a small raster avatar', async () => {
  const profile = await fetchUserProfile({
    apiKey: 'secret', username: 'user', sleep: async () => {},
    fetchImpl: async () => ({
      ok: true, status: 200,
      json: async () => ({ user: { name: 'Canonical User', image: [
        { size: 'small', '#text': 'https://img.example/small.jpg' },
        { size: 'large', '#text': 'https://img.example/large.jpg' }
      ] } })
    })
  });
  assert.deepEqual(profile, { username: 'Canonical User', imageUrl: 'https://img.example/large.jpg' });
  const avatar = await fetchAvatarDataUri(profile.imageUrl, async () => new Response(new Uint8Array([1, 2, 3]), {
    headers: { 'content-type': 'image/png', 'content-length': '3' }
  }));
  assert.equal(avatar, 'data:image/png;base64,AQID');
});

test('rejects insecure or non-raster profile images', async () => {
  assert.equal(await fetchAvatarDataUri('http://img.example/avatar.jpg'), null);
  assert.equal(await fetchAvatarDataUri('https://img.example/avatar.svg', async () => new Response('<svg/>', {
    headers: { 'content-type': 'image/svg+xml' }
  })), null);
});
