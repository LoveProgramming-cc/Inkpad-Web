// @ts-check
// Signing in to Google (B:gdrive.py `authorize`, `load_client`, `install_client`...; PORTING.md 7.6).
//
// B and A use a "Desktop app" OAuth client and a loopback address. A web page cannot receive a
// loopback redirect on another host, so the redirect goes to this site's own `oauth.html`, which
// hands the answer back (a pop-up) or sends the browser back to the app (a full-page redirect).
// The client id and secret are the user's own, kept in kv['google_client']; the tokens in
// kv['google_token']. Nothing leaves this origin except to Google.
import { DriveError } from './errors.js';
import { tr } from '../core/i18n.js';
import { now } from '../core/clock.js';
import { Sha256 } from '../core/hash.js';

export const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const AUTH_URI = 'https://accounts.google.com/o/oauth2/auth';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';

/** @typedef {{client_id: string, client_secret?: string, auth_uri?: string, token_uri?: string}} Client */

/** Where Google sends the browser back to: this site's oauth.html, without query or fragment. */
export function redirectUri() {
  return new URL('oauth.html', location.href.split(/[?#]/)[0]).href;
}

/** The address a "Web application" client needs under "authorised JavaScript origins". */
export function originUri() { return location.origin; }

/** Whether this page is on a loopback address (a client of type "Desktop app" may be used there). */
/** Whether Google will sign this page in: it refuses plain http anywhere but on the machine itself. */
export function canSignIn() { return location.protocol === 'https:' || isLoopback(); }

export function isLoopback() { return ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname); }

/** @param {import('../platform/vfs.js').Vfs} vfs @returns {Promise<Client|null>} */
export async function loadClient(vfs) {
  const data = await vfs.kvGet('google_client');
  return data ? (data.installed || data.web || null) : null;
}

/** The Drive folder the user asked the library to be kept in, or '' for a folder named Inkpad at the top of their Drive.
 * @param {import('../platform/vfs.js').Vfs} vfs */
export async function folderId(vfs) {
  const data = await vfs.kvGet('google_client');
  return String((data && data.inkpad_folder) || '');
}

/** Adopt an OAuth client file downloaded from the Google Cloud console (text of the JSON).
 * @param {import('../platform/vfs.js').Vfs} vfs @param {string} text */
export async function installClient(vfs, text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new DriveError(tr('这不是 OAuth 客户端凭据文件')); }
  const client = data.installed || data.web;
  if (!client || !client.client_id || !client.token_uri) throw new DriveError(tr('这不是 OAuth 客户端凭据文件'));
  // A file exported from Inkpad names the folder to sync with; one from Google does not, and leaves that as it is here.
  data.inkpad_folder ??= await folderId(vfs);
  await vfs.kvSet('google_client', data);
}

/** Use an OAuth client typed in by hand. Changing the client drops the current sign-in.
 * @param {import('../platform/vfs.js').Vfs} vfs @param {string} clientId @param {string} secret */
export async function saveClient(vfs, clientId, secret) {
  clientId = clientId.trim(); secret = secret.trim();
  if (!clientId.endsWith('.apps.googleusercontent.com')) throw new DriveError(tr('客户端 ID 应以 .apps.googleusercontent.com 结尾'));
  const old = (await loadClient(vfs)) || /** @type {any} */ ({});
  if (old.client_id !== clientId) await vfs.kvDelete('google_token');
  await vfs.kvSet('google_client', { inkpad_folder: await folderId(vfs), installed: { client_id: clientId, client_secret: secret, auth_uri: AUTH_URI, token_uri: TOKEN_URI } });
}

/** @param {import('../platform/vfs.js').Vfs} vfs @param {string} value */
export async function setFolderId(vfs, value) {
  const data = await vfs.kvGet('google_client');
  if (!data) throw new DriveError(tr('请先填写并保存凭据'));
  await vfs.kvSet('google_client', { ...data, inkpad_folder: value });
}

/** The client credentials and the folder id as a file, for setting up another device. A Web client is
 * written under "web", so that B and A will not take it for a desktop client. @param {import('../platform/vfs.js').Vfs} vfs */
export async function exportClient(vfs) {
  const data = await vfs.kvGet('google_client');
  if (!data) throw new DriveError(tr('请先填写并保存凭据'));
  const client = data.installed || data.web;
  const out = { inkpad_folder: data.inkpad_folder || '', [isLoopback() ? 'installed' : 'web']: client };
  return new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
}

/** @param {import('../platform/vfs.js').Vfs} vfs */
export async function connected(vfs) {
  return !!(await vfs.kvGet('google_token')) && !!(await loadClient(vfs));
}

/** POST a form to Google. @param {string} url @param {Record<string, string>} fields */
async function post(url, fields) {
  let r;
  try {
    r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
  } catch (e) { throw new DriveError(tr('无法连接 Google Drive：%s').replace('%s', String((/** @type {any} */ (e)).message || e))); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new DriveError(tr('Google 登录出错：') + (data.error_description || data.error || r.status), r.status);
    throw e;
  }
  return data;
}

/** @param {Uint8Array} bytes */
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

/**
 * Run the browser consent flow and store the tokens. Call it from a click: a pop-up is opened
 * first thing, and when the browser will not allow that the whole page goes to Google and comes
 * back to `completeRedirect`. Resolves when connected; false when the page is being left.
 * @param {import('../platform/vfs.js').Vfs} vfs @returns {Promise<boolean>}
 */
export async function authorize(vfs) {
  const client = await loadClient(vfs);
  if (!client) throw new DriveError(tr('尚未提供 Google 客户端凭据'));
  const popup = window.open('', 'inkpad-oauth', 'width=520,height=720');
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = b64url(new Sha256().update(new TextEncoder().encode(verifier)).digest());
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const redirect = redirectUri();
  const url = (client.auth_uri || AUTH_URI) + '?' + new URLSearchParams({
    client_id: client.client_id, redirect_uri: redirect, response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent', state,
    code_challenge: challenge, code_challenge_method: 'S256' });
  try { sessionStorage.setItem('inkpad_oauth', JSON.stringify({ verifier, state, redirect })); } catch { /* storage blocked */ }
  if (!popup) { location.assign(url); return false; }   // pop-ups are blocked: go there with the whole page
  popup.location.href = url;
  const search = await new Promise((resolve, reject) => {
    const ch = new BroadcastChannel('inkpad-oauth');
    const timer = setTimeout(() => { done(); reject(new DriveError(tr('等待授权超时'))); }, 300_000);
    const watch = setInterval(() => { if (popup.closed) setTimeout(() => { done(); reject(new DriveError(tr('授权未完成'))); }, 800); }, 800);
    const done = () => { clearTimeout(timer); clearInterval(watch); ch.close(); };
    ch.onmessage = e => { done(); resolve(e.data.search); };
  });
  await finish(vfs, search, { verifier, state, redirect });
  return true;
}

/** @param {import('../platform/vfs.js').Vfs} vfs @param {string} search @param {{verifier: string, state: string, redirect: string}} pending */
async function finish(vfs, search, pending) {
  const client = /** @type {Client} */ (await loadClient(vfs));
  const q = new URLSearchParams(search);
  if (!q.get('code') || q.get('state') !== pending.state) throw new DriveError(tr('授权未完成'));
  const token = await post(client.token_uri || TOKEN_URI, {
    client_id: client.client_id, client_secret: client.client_secret || '', code: /** @type {string} */ (q.get('code')),
    code_verifier: pending.verifier, grant_type: 'authorization_code', redirect_uri: pending.redirect });
  if (!token.refresh_token) throw new DriveError(tr('Google 没有返回刷新令牌，请重试'));
  await vfs.kvSet('google_token', { refresh_token: token.refresh_token, access_token: token.access_token, expires_at: now() + (token.expires_in || 3600) - 60 });
}

/** After a full-page trip to Google: oauth.html left the answer in sessionStorage; finish the sign-in.
 * Returns true if there was one. @param {import('../platform/vfs.js').Vfs} vfs */
export async function completeRedirect(vfs) {
  let result = null, pending = null;
  try {
    result = sessionStorage.getItem('inkpad_oauth_result');
    pending = JSON.parse(sessionStorage.getItem('inkpad_oauth') || 'null');
    sessionStorage.removeItem('inkpad_oauth_result'); sessionStorage.removeItem('inkpad_oauth');
  } catch { return false; }
  if (result === null || !pending) return false;
  await finish(vfs, result, pending);
  return true;
}

/** Forget the account: revoke the grant (best effort) and delete the stored tokens. @param {import('../platform/vfs.js').Vfs} vfs */
export async function disconnect(vfs) {
  const token = await vfs.kvGet('google_token');
  await vfs.kvDelete('google_token');
  if (token && token.refresh_token) {
    try { await post('https://oauth2.googleapis.com/revoke', { token: token.refresh_token }); } catch { /* best effort */ }
  }
}

/** A current access token, refreshed when it has run out (B:Drive._access). @param {import('../platform/vfs.js').Vfs} vfs */
export async function accessToken(vfs, force = false) {
  const client = await loadClient(vfs);
  const token = await vfs.kvGet('google_token');
  if (!client || !token) throw new DriveError(tr('尚未连接 Google Drive'));
  if (force || now() >= (token.expires_at || 0)) {
    const fresh = await post(client.token_uri || TOKEN_URI, { client_id: client.client_id, client_secret: client.client_secret || '', refresh_token: token.refresh_token, grant_type: 'refresh_token' });
    token.access_token = fresh.access_token;
    token.expires_at = now() + (fresh.expires_in || 3600) - 60;
    await vfs.kvSet('google_token', token);
  }
  return /** @type {string} */ (token.access_token);
}
