const { app, BrowserWindow } = require("electron");
app.whenReady().then(async () => {
  // Inert controls must keep their actionability frames while the fixture stays hidden.
  const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  await window.loadURL("about:blank");
});
