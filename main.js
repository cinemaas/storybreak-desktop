const { app, BrowserWindow, shell, Menu, ipcMain } = require('electron');
const http = require('http');
const path = require('path');

const APP_URL = 'https://storybreak.app/StoryBreak_Accounts.html';
const APP_NAME = 'StoryBreak';
const AUTH_PORT = 47836;

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
    trafficLightPosition: { x: 12, y: 10 },
  });

  mainWindow.loadURL(APP_URL);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Inject a draggable title bar region so the window can be moved
  // and the traffic lights don't overlap with the app's logo
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.executeJavaScript(`
      (function() {
        if (document.getElementById('_sb_titlebar')) return;
        var bar = document.createElement('div');
        bar.id = '_sb_titlebar';
        bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:38px;' +
          '-webkit-app-region:drag;z-index:99999;background:#111213;';
        document.body.prepend(bar);
        document.body.style.paddingTop = '38px';
        // Make sure buttons/links inside the app are still clickable (not drag)
        document.querySelectorAll('button, a, input, select, textarea').forEach(function(el) {
          el.style.webkitAppRegion = 'no-drag';
        });
      })();
    `);
  });

  // ── PRIMARY OAuth interception: will-navigate fires BEFORE the page unloads ──
  // event.preventDefault() keeps the current page intact while we handle OAuth
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('https://storybreak.app')) return;
    event.preventDefault();
    if (url.includes('supabase.co/auth/v1/authorize')) {
      console.log('[StoryBreak] Intercepted OAuth via will-navigate');
      startOAuthFlow(url);
    } else {
      shell.openExternal(url);
    }
  });

  // ── SAFETY NET: if will-navigate missed it, catch at network level ──
  // Cancel the request AND reload the page (since it may have started unloading)
  mainWindow.webContents.session.webRequest.onBeforeRequest(
    { urls: ['*://*.supabase.co/auth/v1/authorize*'] },
    (details, callback) => {
      console.log('[StoryBreak] Intercepted OAuth via webRequest (fallback)');
      callback({ cancel: true });
      startOAuthFlow(details.url);
      // Reload the page since it may have started unloading
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(APP_URL);
      }
    }
  );

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://storybreak.app')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    stopAuthServer();
  });
}

// Listen for OAuth URLs from the renderer via IPC
ipcMain.on('oauth-url', (event, url) => {
  console.log('[StoryBreak] Got OAuth URL via IPC');
  startOAuthFlow(url);
});

// OAuth flow: start local server, rewrite redirect, open in system browser
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
    // Serve callback page for any GET request (Supabase redirects here)
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(CALLBACK_PAGE);
      return;
    }

    // Receive tokens POSTed from the callback page's JavaScript
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
          console.log('[StoryBreak] Got tokens, injecting session');
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
    console.log('[StoryBreak] Auth server listening on port ' + AUTH_PORT);
    try {
      const authUrl = new URL(originalUrl);
      authUrl.searchParams.set('redirect_to', `http://localhost:${AUTH_PORT}/callback`);
      const finalUrl = authUrl.toString();
      console.log('[StoryBreak] Opening browser: ' + finalUrl.substring(0, 120) + '...');
      shell.openExternal(finalUrl);
    } catch (e) {
      console.error('[StoryBreak] URL error:', e);
      shell.openExternal(originalUrl);
      stopAuthServer();
    }
  });

  authServer.on('error', (err) => {
    console.error('[StoryBreak] Server error:', err.message);
    shell.openExternal(originalUrl);
  });

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
