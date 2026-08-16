import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DAY_MS, dailyCounts, deduplicate, validateTimeZone } from '../src/lib.js';
import { fetchAvatarDataUri, fetchScrobbles, fetchUserProfile } from '../src/lastfm.js';
import { graphStateKey, stateKey, validateUsername } from '../src/state.js';

const RETENTION_DAYS = 370;
const RECENT_WINDOW_SECONDS = 600;
const OUTPUT_PATH = resolve('.wrangler/bootstrap-state.json');
const GRAPH_OUTPUT_PATH = resolve('.wrangler/bootstrap-graph-state.json');

function parseDotenv(contents) {
  return Object.fromEntries(contents.split(/\r?\n/u).flatMap((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u);
    if (!match || match[1].startsWith('#')) return [];
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    return [[match[1], value]];
  }));
}

async function configuration() {
  const wrangler = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  let local = {};
  try { local = parseDotenv(await readFile('.dev.vars', 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const apiKey = process.env.LASTFM_API_KEY?.trim() || local.LASTFM_API_KEY?.trim();
  if (!apiKey) throw new Error('LASTFM_API_KEY is required in the environment or .dev.vars.');
  const username = validateUsername(process.env.LASTFM_USERNAME || wrangler.vars?.LASTFM_USERNAME);
  const timeZone = validateTimeZone(process.env.TIMEZONE || wrangler.vars?.TIMEZONE || 'UTC');
  return { apiKey, username, timeZone };
}

export async function buildBootstrapState({ apiKey, username, now = new Date(), fetchImpl = fetch, sleep }) {
  const cutoff = Math.floor((now.getTime() - RETENTION_DAYS * DAY_MS) / 1000);
  const recent = await fetchScrobbles({ apiKey, username, from: cutoff, to: Math.floor(now.getTime() / 1000), fetchImpl, sleep });
  const scrobbles = deduplicate(recent.scrobbles).filter((item) => item.timestamp >= cutoff);
  let profile = null;
  try {
    const user = await fetchUserProfile({ apiKey, username, fetchImpl, sleep });
    profile = { username: user.username, avatarDataUri: await fetchAvatarDataUri(user.imageUrl, fetchImpl), fetchedAt: now.getTime() };
  } catch {
    // Profile decoration is optional; the scrobble bootstrap should still succeed.
  }
  return {
    version: 1,
    username,
    scrobbles,
    listeningStatus: scrobbles.length ? { ...scrobbles.at(-1), kind: 'last-played' } : null,
    profile,
    updatedAt: now.getTime()
  };
}

async function main() {
  const { apiKey, username, timeZone } = await configuration();
  const state = await buildBootstrapState({ apiKey, username });
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  const temporary = `${OUTPUT_PATH}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, OUTPUT_PATH);
  const graphState = {
    version: 1, username: state.username, timeZone,
    countsByDate: dailyCounts(state.scrobbles, timeZone),
    recentScrobbles: state.scrobbles.filter((item) => item.timestamp >= Math.floor(state.updatedAt / 1000) - RECENT_WINDOW_SECONDS),
    listeningStatus: state.listeningStatus, profile: state.profile, updatedAt: state.updatedAt
  };
  const graphTemporary = `${GRAPH_OUTPUT_PATH}.${process.pid}.tmp`;
  await writeFile(graphTemporary, `${JSON.stringify(graphState)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(graphTemporary, GRAPH_OUTPUT_PATH);
  const key = stateKey(username);
  console.log(`Indexed ${state.scrobbles.length} scrobbles locally.`);
  console.log(`Upload them with:\n  npx wrangler kv key put "${key}" --binding LASTFM_STATE --remote --path ".wrangler/bootstrap-state.json"`);
  console.log(`  npx wrangler kv key put "${graphStateKey(username)}" --binding LASTFM_STATE --remote --path ".wrangler/bootstrap-graph-state.json"`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Bootstrap failed.');
    process.exitCode = 1;
  });
}
