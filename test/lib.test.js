import test from 'node:test';
import assert from 'node:assert/strict';
import { dateKey, deduplicate, escapeXml, formatTimeAgo, intensityLevel, intensityThresholds, renderSvg, THEMES } from '../src/lib.js';

test('buckets timestamps across timezone date boundaries', () => {
  const timestamp = Date.parse('2025-01-01T00:30:00Z') / 1000;
  assert.equal(dateKey(timestamp, 'UTC'), '2025-01-01');
  assert.equal(dateKey(timestamp, 'America/Los_Angeles'), '2024-12-31');
  assert.equal(dateKey(timestamp, 'Asia/Tokyo'), '2025-01-01');
});

test('calculates quartile thresholds and intensity levels', () => {
  const thresholds = intensityThresholds([0, 1, 2, 3, 4, 8, 12, 20]);
  assert.deepEqual(thresholds, [2, 4, 12]);
  assert.deepEqual([0, 1, 3, 8, 20].map((count) => intensityLevel(count, thresholds)), [0, 1, 2, 3, 4]);
});

test('removes exact duplicate scrobbles and sorts chronologically', () => {
  const later = { timestamp: 20, artist: 'B', track: 'Two', album: '' };
  const earlier = { timestamp: 10, artist: 'A', track: 'One', album: 'Album' };
  assert.deepEqual(deduplicate([later, earlier, { ...earlier }]), [earlier, later]);
});

test('escapes every XML special character', () => {
  assert.equal(escapeXml(`A&B <C> "D" 'E'`), 'A&amp;B &lt;C&gt; &quot;D&quot; &apos;E&apos;');
});

test('formats elapsed listening time with sensible boundaries', () => {
  const now = Date.parse('2025-02-04T12:00:00Z');
  const seconds = now / 1000;
  assert.equal(formatTimeAgo(seconds - 30, now), 'just now');
  assert.equal(formatTimeAgo(seconds - 60, now), '1 minute ago');
  assert.equal(formatTimeAgo(seconds - 59 * 60, now), '59 minutes ago');
  assert.equal(formatTimeAgo(seconds - 60 * 60, now), '1 hour ago');
  assert.equal(formatTimeAgo(seconds - 23 * 60 * 60, now), '23 hours ago');
  assert.equal(formatTimeAgo(seconds - 24 * 60 * 60, now), '1 day ago');
  assert.equal(formatTimeAgo(seconds - 3 * 24 * 60 * 60, now), '3 days ago');
  assert.equal(formatTimeAgo(seconds + 30, now), 'just now');
});

test('SVG generation is deterministic and escapes external text', () => {
  const options = {
    scrobbles: [{ timestamp: Date.parse('2025-02-03T12:00:00Z') / 1000, artist: 'A', track: 'T', album: '' }],
    timeZone: 'UTC', themeName: 'github-light', username: '<listener & friends>', endDate: '2025-02-04',
    listeningStatus: { kind: 'last-played', timestamp: Date.parse('2025-02-04T11:58:00Z') / 1000, artist: 'A&B', track: '<Song>' },
    profile: { username: '<Profile & Name>', avatarDataUri: 'data:image/png;base64,AAAA' },
    renderedAt: Date.parse('2025-02-04T12:00:00Z')
  };
  const first = renderSvg(options);
  assert.equal(first, renderSvg(options));
  assert.match(first, /&lt;listener &amp; friends&gt;/);
  assert.doesNotMatch(first, /<listener/);
  assert.match(first, /1 scrobbles/);
  assert.match(first, /Last played 2 minutes ago: A&amp;B — &lt;Song&gt;/);
  assert.match(first, /<desc id="desc">[^<]*Last played 2 minutes ago: A&amp;B — &lt;Song&gt;\.<\/desc>/);
  assert.match(first, /&lt;Profile &amp; Name&gt;/);
  assert.match(first, /href="data:image\/png;base64,AAAA"/);
  assert.match(first, />Less</);
  assert.match(first, />More</);
});

test('Last.fm themes use red cells and their requested backgrounds', () => {
  assert.equal(THEMES['lastfm-white'].background, '#ffffff');
  assert.equal(THEMES['lastfm-black'].background, '#000000');
  assert.equal(THEMES['lastfm-grey'].background, '#737373');
  assert.equal(THEMES['lastfm-organza'].background, '#f5e9e7');
  for (const name of ['lastfm-white', 'lastfm-black', 'lastfm-grey', 'lastfm-organza', 'github-light', 'github-dark']) {
    assert.equal(THEMES[name].levels.length, 5);
    assert.match(THEMES[name].levels[4], /^#(?:9f|a6|b9|ff)/i);
  }
});
