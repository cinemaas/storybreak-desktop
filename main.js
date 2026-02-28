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

// OAuth flow for desktop: opens auth in the system browser, redirecting back
// to storybreak.app with a desktop_auth_port param. The web app detects this
// and POSTs tokens to our local server, which injects them into the Electron app.
function startOAuthFlow(originalUrl) {
  stopAuthServer();

  authServer = http.createServer((req, res) => {
    // CORS preflight for cross-origin POST from storybreak.app
    if (req.method === 'OPTIONS') {
      res.writeHead(200, {
        'Access-Control-Allow-Origin': 'https://storybreak.app',
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    if (req.url === '/auth-tokens' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        res.writeHead(200, {
          'Access-Control-Allow-Origin': 'https://storybreak.app',
        });
        res.end('ok');
        const params = new URLSearchParams(body);
        const accessToken = params.get('access_token');
        const refreshToken = params.get('refresh_token');
        if (accessToken && refreshToken) {
          injectSession(accessToken, refreshToken);
        }
        setTimeout(stopAuthServer, 2000);
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  authServer.listen(0, '127.0.0.1', () => {
    const port = authServer.address().port;
    // Redirect to storybreak.app (already in Supabase allowed list) with our port
    const callbackUrl = `https://storybreak.app/StoryBreak_Accounts.html?desktop_auth_port=${port}`;

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
