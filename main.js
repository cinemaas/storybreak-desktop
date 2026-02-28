const { app, BrowserWindow, shell, Menu } = require('electron');
const http = require('http');
const path = require('path');

const APP_URL = 'https://storybreak.app/StoryBreak_Accounts.html';
const APP_NAME = 'StoryBreak';

let mainWindow;
let authServer = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    icon: path.join(__dirname, 'icons', 'icon.png'),
    title: APP_NAME,
    backgroundColor: '#111213',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 15, y: 15 },
  });

  mainWindow.loadURL(APP_URL);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://storybreak.app')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Handle navigation — intercept OAuth and open in system browser
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Allow navigating within storybreak.app
    if (url.startsWith('https://storybreak.app')) return;

    // Intercept Supabase OAuth — open in system browser with local callback
    if (url.includes('supabase.co/auth/v1/authorize')) {
      event.preventDefault();
      startOAuthFlow(url);
      return;
    }

    // Block all other external navigation
    event.preventDefault();
    shell.openExternal(url);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    stopAuthServer();
  });
}

// Start a local HTTP server to catch the OAuth callback.
// Supabase returns tokens in the URL fragment (#access_token=...).
// Since fragments aren't sent to the server, we serve a tiny HTML page
// that reads the fragment client-side and posts it back.
function startOAuthFlow(originalUrl) {
  stopAuthServer();

  authServer = http.createServer((req, res) => {
    if (req.url.startsWith('/auth-callback') && req.method === 'GET') {
      // Serve a page that extracts the fragment and posts tokens back
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html>
<html><head><title>Signing in...</title>
<style>body{background:#111213;color:#E8DCC8;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
.box{text-align:center;}.spinner{width:30px;height:30px;border:3px solid #333;border-top:3px solid #D4691C;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 16px;}
@keyframes spin{to{transform:rotate(360deg)}}h2{font-size:18px;margin:0 0 6px;}p{color:#666;font-size:13px;}</style></head>
<body><div class="box"><div class="spinner"></div><h2>Signing in to StoryBreak...</h2><p>You can close this tab.</p></div>
<script>
const hash = window.location.hash.substring(1);
if (hash) {
  fetch('/auth-tokens', { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body: hash })
    .then(() => { document.querySelector('h2').textContent = '✓ Signed in! Return to StoryBreak.'; document.querySelector('.spinner').style.display='none'; })
    .catch(() => { document.querySelector('h2').textContent = 'Something went wrong.'; });
} else {
  document.querySelector('h2').textContent = 'No auth data received.';
  document.querySelector('.spinner').style.display='none';
}
</script></body></html>`);
    } else if (req.url === '/auth-tokens' && req.method === 'POST') {
      // Receive the tokens posted from the callback page
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        res.writeHead(200);
        res.end('ok');
        const params = new URLSearchParams(body);
        const accessToken = params.get('access_token');
        const refreshToken = params.get('refresh_token');
        if (accessToken && refreshToken) {
          injectSession(accessToken, refreshToken);
        }
        // Close server after a short delay
        setTimeout(stopAuthServer, 2000);
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  // Listen on a random available port
  authServer.listen(0, '127.0.0.1', () => {
    const port = authServer.address().port;
    const callbackUrl = `http://localhost:${port}/auth-callback`;

    try {
      const authUrl = new URL(originalUrl);
      authUrl.searchParams.set('redirect_to', callbackUrl);
      shell.openExternal(authUrl.toString());
    } catch (e) {
      shell.openExternal(originalUrl);
      stopAuthServer();
    }
  });

  // Auto-close server after 5 minutes if no callback received
  setTimeout(stopAuthServer, 5 * 60 * 1000);
}

function stopAuthServer() {
  if (authServer) {
    try { authServer.close(); } catch (e) {}
    authServer = null;
  }
}

function injectSession(accessToken, refreshToken) {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();

  const js = `
    (async () => {
      try {
        if (typeof _sbc !== 'undefined' && _sbc.auth) {
          const { error } = await _sbc.auth.setSession({
            access_token: ${JSON.stringify(accessToken)},
            refresh_token: ${JSON.stringify(refreshToken)}
          });
          if (error) console.error('StoryBreak session error:', error);
        }
      } catch(e) { console.error('StoryBreak session inject failed:', e); }
    })();
  `;
  mainWindow.webContents.executeJavaScript(js);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac ? [{
      label: APP_NAME,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' },
          { role: 'front' },
        ] : [
          { role: 'close' },
        ]),
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'StoryBreak Guide',
          click: () => shell.openExternal('https://storybreak.app/guide/'),
        },
        {
          label: 'Join Discord',
          click: () => shell.openExternal('https://discord.gg/3eb3SVK3'),
        },
        { type: 'separator' },
        {
          label: 'StoryBreak Website',
          click: () => shell.openExternal('https://storybreak.app'),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// App lifecycle
app.whenReady().then(() => {
  createWindow();
  buildMenu();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.setName(APP_NAME);
