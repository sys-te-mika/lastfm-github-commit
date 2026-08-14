export function validateUsername(value) {
  const username = value?.trim();
  if (!username || username.length > 64 || /[\u0000-\u001f\u007f]/u.test(username)) {
    throw new Error('Invalid Last.fm username.');
  }
  return username;
}

export function stateKey(username) {
  return `lastfm-user-v1:${encodeURIComponent(validateUsername(username).normalize('NFKC').toLocaleLowerCase('en-US'))}`;
}

export function graphStateKey(username) {
  return `${stateKey(username)}:graph`;
}
