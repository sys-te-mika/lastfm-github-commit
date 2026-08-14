const ENDPOINT = 'https://ws.audioscrobbler.com/2.0/';
const RETRIES = 5;
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function value(field) {
  return typeof field === 'string' ? field : field?.['#text'];
}

async function requestPage({ apiKey, username, from, to, page, fetchImpl, sleep }) {
  const body = new URLSearchParams({
    method: 'user.getRecentTracks', user: username, api_key: apiKey,
    format: 'json', limit: '200', page: String(page), from: String(from), to: String(to)
  });
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const response = await fetchImpl(ENDPOINT, { method: 'POST', body, headers: { 'user-agent': 'lastfm-contribution-graph/1.0' } });
      const retryableStatus = response.status === 429 || response.status >= 500;
      if (!response.ok && !retryableStatus) throw new Error(`Last.fm request failed with HTTP ${response.status}.`);
      if (retryableStatus) throw Object.assign(new Error('Transient Last.fm response.'), { retryable: true });
      let data;
      try { data = await response.json(); } catch { throw Object.assign(new Error('Last.fm returned malformed JSON.'), { retryable: true }); }
      if (data?.error) {
        const retryable = [11, 16, 29].includes(Number(data.error));
        const error = new Error(retryable ? 'Last.fm is temporarily unavailable or rate limited.' : `Last.fm API error ${Number(data.error)}.`);
        error.retryable = retryable;
        throw error;
      }
      if (!data?.recenttracks || !Array.isArray(data.recenttracks.track)) throw Object.assign(new Error('Last.fm returned a malformed recent-tracks response.'), { retryable: true });
      return data.recenttracks;
    } catch (error) {
      if (attempt === RETRIES - 1 || error.retryable === false || (error.message.startsWith('Last.fm request failed with HTTP') && !error.retryable)) throw error;
      await sleep(1000 * (2 ** attempt));
    }
  }
}

export async function fetchScrobbles({ apiKey, username, from, to, maxPages = Infinity, fetchImpl = fetch, sleep = delay }) {
  const items = [];
  let nowPlaying = null;
  let page = 1, totalPages = 1;
  do {
    const recent = await requestPage({ apiKey, username, from, to, page, fetchImpl, sleep });
    totalPages = Math.max(1, Number(recent['@attr']?.totalPages) || 1);
    for (const track of recent.track) {
      if (track?.['@attr']?.nowplaying === 'true') {
        const artist = value(track.artist), name = value(track.name), album = value(track.album) ?? '';
        if (!nowPlaying && typeof artist === 'string' && typeof name === 'string') nowPlaying = { artist, track: name, album };
        continue;
      }
      if (!track?.date?.uts) continue;
      const timestamp = Number(track.date.uts);
      const artist = value(track.artist), name = value(track.name), album = value(track.album) ?? '';
      if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || typeof artist !== 'string' || typeof name !== 'string') continue;
      items.push({ timestamp, artist, track: name, album });
    }
    page += 1;
  } while (page <= totalPages && page <= maxPages);
  return { scrobbles: items, nowPlaying, complete: page > totalPages };
}

export async function fetchUserProfile({ apiKey, username, fetchImpl = fetch, sleep = delay }) {
  const body = new URLSearchParams({
    method: 'user.getInfo', user: username, api_key: apiKey, format: 'json'
  });
  let data;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const response = await fetchImpl(ENDPOINT, { method: 'POST', body, headers: { 'user-agent': 'lastfm-contribution-graph/1.0' } });
      if (!response.ok) throw new Error(`Profile request failed with HTTP ${response.status}.`);
      data = await response.json();
      if (data?.error) throw new Error(`Last.fm profile API error ${Number(data.error)}.`);
      break;
    } catch (error) {
      if (attempt === RETRIES - 1) throw error;
      await sleep(1000 * (2 ** attempt));
    }
  }
  if (!data?.user || typeof data.user.name !== 'string' || !Array.isArray(data.user.image)) {
    throw new Error('Last.fm returned a malformed user profile response.');
  }
  const imageUrl = [...data.user.image].reverse().find((image) => typeof image?.['#text'] === 'string' && image['#text'])?.['#text'] ?? null;
  return { username: data.user.name, imageUrl };
}

export async function fetchAvatarDataUri(imageUrl, fetchImpl = fetch) {
  if (!imageUrl) return null;
  let url;
  try { url = new URL(imageUrl); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  const response = await fetchImpl(url);
  if (!response.ok) return null;
  const type = response.headers.get('content-type')?.split(';')[0]?.toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(type)) return null;
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > 1_000_000) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 1_000_000) return null;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return `data:${type};base64,${btoa(binary)}`;
}
