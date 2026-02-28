const { app, BrowserWindow, shell, Menu, protocol } = require('electron');
const path = require('path');

const APP_URL = 'https://storybreak.app/StoryBreak_Accounts.html';
const APP_NAME = 'StoryBreak';
const PROTOCOL = 'storybreak';

let mainWindow;

// Register as handler for storybreak:// URLs (for OAuth callback)
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

// macOS: handle storybreak:// URL when app is already running
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleAuthCallback(url);
});

// Windows/Linux: handle storybreak:// URL via second instance
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine) => {
    // The deep link URL is the last argument
    const url = commandLine.find(arg => arg.startsWith(`${PROTOCOL}://`));
    if (url) handleAuthCallback(url);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// Parse OAuth callback URL and inject tokens into the web app
function handleAuthCallback(url) {
  if (!mainWindow || !url.startsWith(`${PROTOCOL}://auth-callback`)) return;

  // Bring app to front
  mainWindow.show();
  mainWindow.focus();

  // Extract tokens from the URL fragment (#access_token=...&refresh_token=...)
  const fragment = url.split('#')[1];
  if (!fragment) return;

  const params = new URLSearchParams(fragment);
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');

  if (accessToken && refreshToken) {
    // First make sure we're on the StoryBreak page
    const currentUrl = mainWindow.webContents.getURL();
    if (!currentUrl.startsWith('https://storybreak.app')) {
      mainWindow.loadURL(APP_URL);
      mainWindow.webContents.once('did-finish-load', () => {
        injectSession(accessToken, refreshToken);
      });
    } else {
      injectSession(accessToken, refreshToken);
    }
  }
}

function injectSession(accessToken, refreshToken) {
  // Inject the tokens into Supabase via the web app's client
  const js = `
    (async () => {
      try {
        if (typeof _sbc !== 'undefined' && _sbc.auth) {
          const { error } = await _sbc.auth.setSession({
            access_token: ${JSON.stringify(accessToken)},
            refresh_token: ${JSON.stringify(refreshToken)}
          });
          if (error) console.error('Session inject error:', error);
        }
      } catch(e) { console.error('Session inject failed:', e); }
    })();
  `;
  mainWindow.webContents.executeJavaScript(js);
}

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

  // Show window when content is ready (prevents white flash)
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

    // Intercept Supabase OAuth authorize — rewrite redirect and open in system browser
    if (url.includes('supabase.co/auth/v1/authorize')) {
      event.preventDefault();
      try {
        const authUrl = new URL(url);
        // Rewrite redirect_to so callback comes back via storybreak:// protocol
        authUrl.searchParams.set('redirect_to', `${PROTOCOL}://auth-callback`);
        shell.openExternal(authUrl.toString());
      } catch (e) {
        shell.openExternal(url);
      }
      return;
    }

    // Block all other external navigation — open in system browser
    event.preventDefault();
    shell.openExternal(url);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
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

// Set app name
app.setName(APP_NAME);
