// The page Google sends the browser back to after the user has agreed (or not). It does one thing:
// give the answer (the query string: code and state) back to the app. With a pop-up, to the page
// that opened it; with a full-page trip, to the app's own page after this tab is sent back to it.
if (window.opener) {
  const ch = new BroadcastChannel('inkpad-oauth');
  ch.postMessage({ search: location.search });
  ch.close();
  window.close();
} else {
  try { sessionStorage.setItem('inkpad_oauth_result', location.search); } catch { /* blocked */ }
  location.replace('./index.html');
}
