export const DAY_MS = 86_400_000;

export function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function validateTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format();
    return timeZone;
  } catch {
    throw new Error(`Invalid IANA timezone: ${timeZone}`);
  }
}

export function dateKey(timestampSeconds, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(timestampSeconds * 1000));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function deduplicate(scrobbles) {
  const byKey = new Map();
  for (const item of scrobbles) {
    const key = [item.timestamp, item.artist, item.track, item.album ?? ''].join('\u0000');
    byKey.set(key, item);
  }
  return [...byKey.values()].sort((a, b) =>
    a.timestamp - b.timestamp || a.artist.localeCompare(b.artist) || a.track.localeCompare(b.track)
  );
}

export function intensityThresholds(counts) {
  const positive = counts.filter((count) => count > 0).sort((a, b) => a - b);
  if (positive.length === 0) return [1, 1, 1];
  const quantile = (fraction) => positive[Math.ceil(positive.length * fraction) - 1];
  return [quantile(0.25), quantile(0.5), quantile(0.75)];
}

export function intensityLevel(count, thresholds) {
  if (count === 0) return 0;
  if (count <= thresholds[0]) return 1;
  if (count <= thresholds[1]) return 2;
  if (count <= thresholds[2]) return 3;
  return 4;
}

export function formatTimeAgo(timestampSeconds, nowMilliseconds) {
  const elapsedSeconds = Math.max(0, Math.floor(nowMilliseconds / 1000) - timestampSeconds);
  if (elapsedSeconds < 60) return 'just now';
  const units = [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60]
  ];
  const [unit, seconds] = units.find(([, size]) => elapsedSeconds >= size);
  const count = Math.floor(elapsedSeconds / seconds);
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

export const THEMES = {
  'github-light': {
    background: '#ffffff', text: '#1f2328', levels: ['#ebedf0', '#ffd6d9', '#ff8a91', '#e8343f', '#b90000']
  },
  'github-dark': {
    background: '#0d1117', text: '#e6edf3', levels: ['#161b22', '#651016', '#a71922', '#e12732', '#ff4d57']
  },
  'lastfm-white': {
    background: '#ffffff', text: '#24292f', levels: ['#ebedf0', '#ffd6d9', '#ff8a91', '#e8343f', '#b90000']
  },
  'lastfm-black': {
    background: '#000000', text: '#f0f0f0', levels: ['#262626', '#651016', '#a71922', '#e12732', '#ff4d57']
  },
  'lastfm-grey': {
    background: '#737373', text: '#ffffff', levels: ['#929292', '#f2b4b8', '#ed747c', '#d9232e', '#a60000']
  },
  'lastfm-organza': {
    background: '#f5e9e7', text: '#4b3030', levels: ['#e6d7d5', '#f7c3c7', '#ed7c84', '#d9232e', '#9f0000']
  }
};

export function dailyCounts(scrobbles, timeZone) {
  validateTimeZone(timeZone);
  const counts = {};
  for (const item of scrobbles) {
    const key = dateKey(item.timestamp, timeZone);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function renderSvg({ scrobbles = [], countsByDate = null, timeZone, themeName, username, endDate, listeningStatus = null, profile = null, renderedAt = Date.now() }) {
  const theme = THEMES[themeName];
  if (!theme) throw new Error(`Unknown graph theme: ${themeName}. Use ${Object.keys(THEMES).join(' or ')}.`);
  validateTimeZone(timeZone);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  if (Number.isNaN(end.getTime())) throw new Error('Invalid graph end date.');
  const start = addDays(end, -364);
  const sourceCounts = countsByDate ?? dailyCounts(scrobbles, timeZone);
  const counts = new Map(Object.entries(sourceCounts).filter(([key]) => key >= isoDate(start) && key <= isoDate(end)));
  const graphStart = addDays(start, -start.getUTCDay());
  const graphEnd = addDays(end, 6 - end.getUTCDay());
  const columns = Math.round((graphEnd - graphStart) / DAY_MS / 7) + 1;
  const values = [...counts.values()];
  const thresholds = intensityThresholds(values);
  const total = values.reduce((sum, count) => sum + count, 0);
  const cell = 11, gap = 3, left = 34, top = 66;
  const width = left + columns * (cell + gap) + 8;
  const height = top + 7 * (cell + gap) + 53;
  const title = `${total} Last.fm scrobbles by ${username} in the trailing 365 days`;
  const status = listeningStatus?.kind === 'last-played' && Number.isSafeInteger(listeningStatus.timestamp)
    ? `Last played ${formatTimeAgo(listeningStatus.timestamp, renderedAt)}: ${listeningStatus.artist} — ${listeningStatus.track}`
    : 'No recent track available';
  const description = `Calendar graph from ${isoDate(start)} through ${isoDate(end)} in ${timeZone}. Darker cells represent more scrobbles. ${status}.`;
  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `  <title id="title">${escapeXml(title)}</title>`,
    `  <desc id="desc">${escapeXml(description)}</desc>`,
    `  <rect width="100%" height="100%" rx="6" fill="${theme.background}"/>`,
    '  <defs><clipPath id="avatar-clip"><circle cx="25" cy="25" r="17"/></clipPath></defs>',
    `  <g font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif" font-size="10" fill="${theme.text}">`
  ];
  if (profile?.avatarDataUri) {
    lines.push(`    <image x="8" y="8" width="34" height="34" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatar-clip)" href="${escapeXml(profile.avatarDataUri)}"/>`);
  } else {
    lines.push(`    <circle cx="25" cy="25" r="17" fill="${theme.levels[0]}"/>`);
  }
  lines.push(`    <text x="50" y="29" font-size="15" font-weight="600">${escapeXml(profile?.username || username)}</text>`);
  for (const [row, label] of [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']]) {
    lines.push(`    <text x="0" y="${top + row * (cell + gap) + 9}">${label}</text>`);
  }
  let lastMonth = -1;
  for (let column = 0; column < columns; column++) {
    const week = addDays(graphStart, column * 7);
    for (let row = 0; row < 7; row++) {
      const date = addDays(week, row);
      const key = isoDate(date);
      if (key < isoDate(start) || key > isoDate(end)) continue;
      const count = counts.get(key) ?? 0;
      const level = intensityLevel(count, thresholds);
      const x = left + column * (cell + gap), y = top + row * (cell + gap);
      lines.push(`    <rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="${theme.levels[level]}" data-date="${key}" data-count="${count}"><title>${count} scrobbles on ${key}</title></rect>`);
    }
    const month = week.getUTCMonth();
    if (month !== lastMonth && addDays(week, 6) >= start && week <= end) {
      const label = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(week);
      lines.push(`    <text x="${left + column * (cell + gap)}" y="56">${label}</text>`);
      lastMonth = month;
    }
  }
  lines.push(`    <text x="${left}" y="${height - 28}" font-size="12">${escapeXml(status)}</text>`);
  lines.push(`    <text x="${left}" y="${height - 9}" font-size="12">${total} scrobbles</text>`);
  const legendX = width - 143;
  lines.push(`    <text x="${legendX}" y="${height - 9}">Less</text>`);
  for (let level = 0; level < theme.levels.length; level++) {
    lines.push(`    <rect x="${legendX + 27 + level * 14}" y="${height - 19}" width="${cell}" height="${cell}" rx="2" fill="${theme.levels[level]}"/>`);
  }
  lines.push(`    <text x="${legendX + 101}" y="${height - 9}">More</text>`);
  lines.push('  </g>', '</svg>', '');
  return lines.join('\n');
}
