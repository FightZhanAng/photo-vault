import { app, BrowserWindow, shell } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { closeDatabase } from './db';
import { openLibrary } from './db/libraryRepo';
import { registerIpc } from './ipc/register';
import { handleVaultProtocol, registerVaultScheme } from './media/protocol';
import { lastLibraryPath } from './recent';
import { repaintTitlebar, TITLEBAR_HEIGHT } from './titlebar';
import { stopUploadServer } from './upload/server';

// 自定义协议必须在 app ready 之前登记
registerVaultScheme();

let mainWindow: BrowserWindow | null = null;

/** 开发运行时用 build/icon.png 当窗口图标；打包后由 exe 自带图标接管 */
const devIcon = join(__dirname, '../../build/icon.png');

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1420,
    height: 900,
    minWidth: 1020,
    minHeight: 660,
    backgroundColor: '#141518',
    // 不用 show:false + ready-to-show：Windows 上偶发不触发，窗口会一直隐藏
    show: true,
    autoHideMenuBar: true,
    icon: existsSync(devIcon) ? devIcon : undefined,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#16171a',
      symbolColor: '#d8d9dd',
      height: TITLEBAR_HEIGHT,
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.focus());
  // 上面构造参数里是启动默认配色，如果已经有主题推送过，按记住的那份来
  repaintTitlebar();
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 覆盖层配色在最大化/还原/重新聚焦后偶尔会掉回默认值，状态一变就重贴一次
  const repaint = (): void => repaintTitlebar();
  mainWindow.on('maximize', repaint);
  mainWindow.on('unmaximize', repaint);
  mainWindow.on('restore', repaint);
  mainWindow.on('focus', repaint);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    handleVaultProtocol();
    registerIpc();

    // 先恢复上次打开的库，再开窗口，避免首屏闪一下欢迎页
    const last = lastLibraryPath();
    if (last) {
      try {
        openLibrary(last);
      } catch {
        /* 库文件被删或损坏时保持未打开状态 */
      }
    }

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    void stopUploadServer();
    closeDatabase();
  });
}
