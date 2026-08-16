import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { renderSvg, THEMES } from '../src/lib.js';

const state = JSON.parse(await readFile('.wrangler/bootstrap-graph-state.json', 'utf8'));
if (!state?.countsByDate || !state?.username || !state?.timeZone || !state?.updatedAt) {
  throw new Error('Bootstrap graph state is missing or malformed. Run npm run bootstrap first.');
}

function localDateKey(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(timestamp));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

async function atomicWrite(path, contents) {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  await writeFile(temporary, contents, 'utf8');
  await rename(temporary, absolute);
}

const common = {
  countsByDate: state.countsByDate,
  timeZone: state.timeZone,
  username: state.username,
  endDate: localDateKey(state.updatedAt, state.timeZone),
  listeningStatus: state.listeningStatus,
  profile: state.profile,
  renderedAt: state.updatedAt
};

for (const themeName of Object.keys(THEMES)) {
  await atomicWrite(`assets/themes/${themeName}.svg`, renderSvg({ ...common, themeName }));
}
await atomicWrite('assets/lastfm-contribution-graph.svg', renderSvg({ ...common, themeName: 'github-dark' }));
console.log(`Generated ${Object.keys(THEMES).length} theme previews and the github-dark main snapshot for ${state.username}.`);
