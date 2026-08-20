import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBootstrapState } from '../scripts/bootstrap.js';
import { stateKey } from '../src/state.js';

test('bootstrap creates upload-compatible normalized state', async () => {
  const timestamp = 1_700_000_000;
  const fetchImpl = async (_url, options) => {
    if (options.body.get('method') === 'user.getInfo') {
      return { ok: true, status: 200, json: async () => ({ user: { name: 'Listener', image: [] } }) };
    }
    return { ok: true, status: 200, json: async () => ({ recenttracks: {
      '@attr': { totalPages: '1' },
      track: [
        { '@attr': { nowplaying: 'true' }, artist: { '#text': 'Current' }, name: 'Playing', album: { '#text': '' } },
        { date: { uts: String(timestamp) }, artist: { '#text': 'A' }, name: 'Song', album: { '#text': '' } },
        { date: { uts: String(timestamp) }, artist: { '#text': 'A' }, name: 'Song', album: { '#text': '' } }
      ]
    } }) };
  };
  const state = await buildBootstrapState({
    apiKey: 'secret', username: 'Listener', now: new Date((timestamp + 60) * 1000),
    fetchImpl, sleep: async () => {}
  });
  assert.equal(state.scrobbles.length, 1);
  assert.equal(state.listeningStatus.kind, 'now-playing');
  assert.equal(state.listeningStatus.track, 'Playing');
  assert.equal(stateKey('Listener'), 'lastfm-user-v1:listener');
  assert.equal('apiKey' in state, false);
});
