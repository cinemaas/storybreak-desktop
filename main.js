const { app, BrowserWindow, shell, Menu } = require('electron');
const http = require('http');
const path = require('path');

const APP_URL = 'https://storybreak.app/StoryBreak_Accounts.html';
const APP_NAME = 'StoryBreak';
const AUTH_PORT = 47836; // Fixed port for OAuth token bridge

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

// OAuth flow for desktop (same pattern as VS Code, Spotify, etc.):
// 1. Start local HTTP server on fixed port
// 2. Rewrite Supabase redirect_to → http://localhost:47836/callback
// 3. Open modified OAuth URL in system browser
// 4. After auth, Supabase redirects browser directly to our local server
// 5. Tokens arrive in URL fragment — we serve a page that reads them client-side
// 6. Page POSTs tokens back to our server, we inject into Electron
//
// REQUIRES: http://localhost:47836 added to Supabase redirect URLs in dashboard
function startOAuthFlow(originalUrl) {
  stopAuthServer();

  const CALLBACK_PAGE = `<!DOCTYPE html><html><head><title>StoryBreak</title>
<style>body{background:#111213;color:#E8DCC8;font-family:-apple-system,BlinkMacSystemFont,sans-serif;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{text-align:center}.spinner{width:30px;height:30px;border:3px solid #333;
border-top:3px solid #D4691C;border-radius:50%;animation:spin 1s linear infinite;
margin:0 auto 16px}@keyframes spin{to{transform:rotate(360deg)}}
h2{font-size:18px;margin:0 0 6px}p{color:#888;font-size:13px;margin:0}</style></head>
<body><div class="box"><div class="spinner"></div>
<h2 id="msg">Signing in to StoryBreak...</h2><p>Please wait</p></div>
<script>
var h = window.location.hash.substring(1);
if (h) {
  fetch('/auth-tokens', {method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:h})
    .then(function(){
      document.getElementById('msg').textContent='\\u2713 Signed in! You can close this tab.';
      document.querySelector('.spinner').style.display='none';
      document.querySelector('p').textContent='Switch back to the StoryBreak app.';
    })
    .catch(function(){
      document.getElementById('msg').textContent='Something went wrong.';
      document.querySelector('.spinner').style.display='none';
    });
} else {
  document.getElementById('msg').textContent='No auth data received.';
  document.querySelector('.spinner').style.display='none';
}
</script></body></html>`;

  authServer = http.createServer((req, res) => {
    // Callback page: serves HTML that reads the URL fragment client-side
    if (req.url.startsWith('/callback')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(CALLBACK_PAGE);
      return;
    }

    // Token receiver: gets tokens POSTed from the callback page
    if (req.url === '/auth-tokens' && req.method === 'POST') {
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
        setTimeout(stopAuthServer, 5000);
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  authServer.listen(AUTH_PORT, '127.0.0.1', () => {
    // Rewrite redirect_to to point to our local callback server
    try {
      const authUrl = new URL(originalUrl);
      authUrl.searchParams.set('redirect_to', `http://localhost:${AUTH_PORT}/callback`);
      console.log('[StoryBreak] OAuth: opening browser with redirect to localhost:' + AUTH_PORT);
      shell.openExternal(authUrl.toString());
    } catch (e) {
      console.error('[StoryBreak] OAuth URL parse error:', e);
      shell.openExternal(originalUrl);
      stopAuthServer();
    }
  });

  authServer.on('error', (err) => {
    console.error('[StoryBreak] Auth server error:', err.message);
    shell.openExternal(originalUrl);
  });

  // Auto-close server after 5 minutes
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

  // Bounce dock icon to get user's attention (macOS)
  if (process.platform === 'darwin' && app.dock) {
    app.dock.bounce('critical');
  }

  mainWindow.show();
  mainWindow.focus();

  const js = `
    (async () => {
      try {
        if (typeof _sbc !== 'undefined' && _sbc.auth) {
          const { data, error } = await _sbc.auth.setSession({
            access_token: ${JSON.stringify(accessToken)},
            refresh_token: ${JSON.stringify(refreshToken)}
          });
          if (error) {
            console.error('StoryBreak session error:', error);
          } else if (data?.session?.user) {
            // Session set — boot the app
            if (typeof bootApp === 'function') bootApp(data.session.user);
          }
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
