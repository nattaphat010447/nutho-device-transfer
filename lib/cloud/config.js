// Public identifiers only (an OAuth "app key" is not a secret; PKCE needs no client secret).
// Register a Dropbox app (scoped access, "App folder", permissions files.content.read/write)
// and put its App key here, and add CALLBACK_URL to the app's Redirect URIs.
export const DROPBOX_APP_KEY = 'c7ns7a54j1ujenf';

// A static page (served by GitHub Pages, no server involved) that hands the OAuth result back to the opener window.
export const CALLBACK_URL = 'https://nattaphat010447.github.io/nutho-device-transfer/callback.html';
