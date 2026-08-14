import { DAY_MS, dailyCounts, deduplicate, renderSvg, THEMES, validateTimeZone } from '../../src/lib.js';
import { fetchAvatarDataUri, fetchScrobbles, fetchUserProfile } from '../../src/lastfm.js';
import { graphStateKey, stateKey, validateUsername } from '../../src/state.js';

const OVERLAP_SECONDS = 300;
const RETENTION_DAYS = 370;
const PROFILE_MAX_AGE_MS = DAY_MS;

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function localDateKey(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export async function updateGraph(env, options = {}) {
  const username = validateUsername(options.username ?? required(env, 'LASTFM_USERNAME'));
  const apiKey = required(env, 'LASTFM_API_KEY');
  const now = options.now ?? new Date();
  const key = stateKey(username);
  const existing = await env.LASTFM_STATE.get(key, 'json');
  if (!existing?.updatedAt || !Array.isArray(existing.scrobbles)) {
    throw new Error('Graph cache is not initialized. Run and upload the local bootstrap first.');
  }
  const cached = Array.isArray(existing?.scrobbles) ? existing.scrobbles : [];
  const cutoff = Math.floor((now.getTime() - RETENTION_DAYS * DAY_MS) / 1000);
  const latest = cached.at(-1)?.timestamp;
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const from = Math.max(cutoff, latest ? latest - OVERLAP_SECONDS : nowSeconds - OVERLAP_SECONDS);
  const recent = await fetchScrobbles({
    apiKey, username, from, to: nowSeconds, maxPages: 10,
    fetchImpl: options.fetchImpl ?? fetch,
    sleep: options.sleep
  });
  const scrobbles = deduplicate([...cached, ...recent.scrobbles])
    .filter((item) => item.timestamp >= cutoff);
  let profile = existing?.profile ?? null;
  if (!profile?.fetchedAt || now.getTime() - profile.fetchedAt >= PROFILE_MAX_AGE_MS) {
    try {
      const userProfile = await fetchUserProfile({ apiKey, username, fetchImpl: options.fetchImpl ?? fetch, sleep: options.sleep });
      profile = {
        username: userProfile.username,
        avatarDataUri: await fetchAvatarDataUri(userProfile.imageUrl, options.fetchImpl ?? fetch),
        fetchedAt: now.getTime()
      };
    } catch {
      // Profile decoration is optional; retain an older successful image if available.
    }
  }
  const listeningStatus = recent.nowPlaying
    ? { ...recent.nowPlaying, kind: 'now-playing' }
    : scrobbles.length ? { ...scrobbles.at(-1), kind: 'last-played' } : null;
  const state = {
    version: 1, username, scrobbles, listeningStatus, profile,
    updatedAt: now.getTime()
  };
  await env.LASTFM_STATE.put(key, JSON.stringify(state));
  const timeZone = validateTimeZone(env.TIMEZONE?.trim() || 'UTC');
  await env.LASTFM_STATE.put(graphStateKey(username), JSON.stringify({
    version: 1, username, timeZone, countsByDate: dailyCounts(scrobbles, timeZone),
    listeningStatus, profile, updatedAt: now.getTime()
  }));
  console.log(JSON.stringify({
    message: 'Last.fm cache updated',
    scrobbles: scrobbles.length
  }));
  return state;
}

function svgResponse(svg) {
  return new Response(svg, {
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'no-cache, no-store, must-revalidate',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox"
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/graph.svg') {
      try {
        if (url.searchParams.has('user')) {
          return new Response('This Worker is configured for one Last.fm user.', { status: 400 });
        }
        const username = validateUsername(required(env, 'LASTFM_USERNAME'));
        const themeName = url.searchParams.get('theme') || env.GRAPH_THEME?.trim() || 'github-dark';
        if (!THEMES[themeName]) return new Response('Unknown theme.', { status: 400 });
        const timeZone = validateTimeZone(env.TIMEZONE?.trim() || 'UTC');
        const requestedTimeZone = url.searchParams.get('timezone');
        if (requestedTimeZone && validateTimeZone(requestedTimeZone) !== timeZone) {
          return new Response('Timezone overrides are unavailable on the optimized Worker cache.', { status: 400 });
        }
        const now = new Date();
        const state = await env.LASTFM_STATE.get(graphStateKey(username), 'json');
        if (!state?.updatedAt) {
          return new Response('Graph cache is waiting for its first scheduled update. Try again in two minutes.', {
            status: 503,
            headers: { 'cache-control': 'no-store', 'retry-after': '120' }
          });
        }
        const svg = renderSvg({
          countsByDate: state.countsByDate, timeZone, themeName,
          username: state.username || username,
          endDate: localDateKey(now, timeZone),
          listeningStatus: state.listeningStatus,
          profile: state.profile
        });
        return svgResponse(svg);
      } catch (error) {
        console.error(JSON.stringify({ message: 'graph request failed', error: safeErrorMessage(error, env) }));
        return new Response('Unable to generate the Last.fm graph.', { status: 502, headers: { 'cache-control': 'no-store' } });
      }
    }
    if (url.pathname === '/health') return new Response('ok', { headers: { 'cache-control': 'no-store' } });
    return new Response('Last.fm contribution graph: use /graph.svg', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(updateGraph(env).catch((error) => logUpdateError(error, env)));
  }
};

function safeErrorMessage(error, env) {
  const message = error instanceof Error ? error.message : String(error);
  return env.LASTFM_API_KEY ? message.replaceAll(env.LASTFM_API_KEY, '[REDACTED]') : message;
}

function logUpdateError(error, env) {
  console.error(JSON.stringify({ message: 'Last.fm cache update failed', error: safeErrorMessage(error, env) }));
}
