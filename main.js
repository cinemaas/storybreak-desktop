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

// OAuth flow for desktop:
// 1. Start local server on fixed port AUTH_PORT
// 2. Open the original OAuth URL in system browser (no URL modifications)
// 3. After auth, Supabase redirects to storybreak.app as normal
// 4. The web app silently POSTs tokens to localhost:AUTH_PORT via hidden iframe
// 5. We inject the tokens into Electron's BrowserWindow
function startOAuthFlow(originalUrl) {
  stopAuthServer();

  authServer = http.createServer((req, res) => {
    if (req.url === '/auth-tokens' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const params = new URLSearchParams(body);
        const accessToken = params.get('access_token');
        const refreshToken = params.get('refresh_token');
        if (accessToken && refreshToken) {
          injectSession(accessToken, refreshToken);
        }
        // Response loads in hidden iframe — user never sees this
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('ok');
        setTimeout(stopAuthServer, 5000);
      });
    } else {
      res.writeHead(200);
      res.end('ok');
    }
  });

  authServer.listen(AUTH_PORT, '127.0.0.1', () => {
    shell.openExternal(originalUrl);
  });

  authServer.on('error', () => {
    // Port in use — open OAuth anyway (auth still works on web)
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
