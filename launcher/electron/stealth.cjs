const CHATGPT_STEALTH_URLS = [
  "https://*.chatgpt.com/*",
  "https://*.oaistatic.com/*",
  "https://*.oaiusercontent.com/*",
  "https://*.openai.com/*",
  "https://*.cloudflare.com/*",
  "https://*.challenges.cloudflare.com/*",
];

function sanitizeUserAgent(ua) {
  if (!ua || typeof ua !== "string") return ua;
  return ua
    .replace(/Electron\/[0-9.]+\s?/gi, "")
    .replace(/Codex\s?Web\s?GPT\/[0-9.]+\s?/gi, "")
    .replace(/codex-chatgpt-web\/[0-9.]+\s?/gi, "")
    .trim();
}

function applyStealthHeaders(browserSession) {
  if (!browserSession || !browserSession.webRequest?.onBeforeSendHeaders) return;
  if (browserSession._stealthHeadersBound) return;
  browserSession._stealthHeadersBound = true;

  const chromeVersion = (process.versions && process.versions.chrome) || "134.0.6998.35";
  const chromeMajor = chromeVersion.split(".")[0];
  const secChUa = `"Chromium";v="${chromeMajor}", "Not:A-Brand";v="24", "Google Chrome";v="${chromeMajor}"`;
  const secChUaFull = `"Chromium";v="${chromeVersion}", "Not:A-Brand";v="24.0.0.0", "Google Chrome";v="${chromeVersion}"`;

  browserSession.webRequest.onBeforeSendHeaders(
    { urls: CHATGPT_STEALTH_URLS },
    (details, callback) => {
      const headers = { ...details.requestHeaders };

      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === "user-agent") {
          headers[key] = sanitizeUserAgent(headers[key]);
        }
      }

      headers["Sec-CH-UA"] = secChUa;
      headers["Sec-CH-UA-Mobile"] = "?0";
      headers["Sec-CH-UA-Platform"] = '"Windows"';
      headers["Sec-CH-UA-Platform-Version"] = '"15.0.0"';
      headers["Sec-CH-UA-Arch"] = '"x86"';
      headers["Sec-CH-UA-Bitness"] = '"64"';
      headers["Sec-CH-UA-Model"] = '""';
      headers["Sec-CH-UA-Full-Version-List"] = secChUaFull;

      callback({ requestHeaders: headers });
    },
  );
}

const STEALTH_DOM_SCRIPT = `
(() => {
  try {
    try {
      delete navigator.webdriver;
    } catch {}
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
      configurable: true,
      enumerable: true,
    });
    const proto = Object.getPrototypeOf(navigator);
    if (proto && proto !== Object.prototype) {
      Object.defineProperty(proto, 'webdriver', {
        get: () => false,
        configurable: true,
        enumerable: true,
      });
    }
  } catch {}

  try {
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) {
      window.chrome.runtime = {
        OnInstalledReason: { CHROME_UPDATE: "chrome_update", INSTALL: "install", SHARED_MODULE_UPDATE: "shared_module_update", UPDATE: "update" },
        OnRestartRequiredReason: { APP_UPDATE: "app_update", OS_UPDATE: "os_update", PERIODIC: "periodic" },
        PlatformArch: { ARM: "arm", ARM64: "arm64", MIPS: "mips", MIPS64: "mips64", X86_32: "x86-32", X86_64: "x86-64" },
        PlatformNaclArch: { ARM: "arm", MIPS: "mips", MIPS64: "mips64", X86_32: "x86-32", X86_64: "x86-64" },
        PlatformOs: { ANDROID: "android", CROS: "cros", LINUX: "linux", MAC: "mac", OPENBSD: "openbsd", WIN: "win" },
        RequestUpdateCheckStatus: { NO_UPDATE: "no_update", THROTTLED: "throttled", UPDATE_AVAILABLE: "update_available" },
        connect: function () {},
        sendMessage: function () {},
      };
    }
    if (!window.chrome.loadTimes) {
      window.chrome.loadTimes = function () {
        const nowSec = Date.now() / 1000;
        return {
          requestTime: nowSec,
          startLoadTime: nowSec,
          commitLoadTime: nowSec,
          finishDocumentLoadTime: nowSec,
          finishLoadTime: nowSec,
          firstPaintTime: nowSec,
          firstPaintAfterLoadTime: 0,
          navigationType: "Other",
          wasFetchedViaSpdy: true,
          wasNpnNegotiated: true,
          npnNegotiatedProtocol: "h2",
          wasAlternateProtocolAvailable: false,
          connectionInfo: "h2",
        };
      };
    }
    if (!window.chrome.csi) {
      window.chrome.csi = function () {
        return {
          startE: Date.now(),
          onloadT: Date.now(),
          pageT: (performance && performance.now) ? performance.now() : 0,
          tran: 15,
        };
      };
    }
  } catch {}

  try {
    if (navigator.plugins && navigator.plugins.length === 0) {
      const mockPlugins = [
        { name: "PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
        { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
        { name: "Chromium PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
      ];
      if (Object.getPrototypeOf(navigator)) {
        Object.defineProperty(Object.getPrototypeOf(navigator), 'plugins', {
          get: () => mockPlugins,
          configurable: true,
          enumerable: true,
        });
      }
    }
  } catch {}
})();
`;

function injectDomStealth(webContents) {
  if (!webContents || webContents.isDestroyed?.()) return;
  try {
    if (typeof webContents.executeJavaScript === "function") {
      void webContents.executeJavaScript(STEALTH_DOM_SCRIPT, true)?.catch?.(() => {});
    }
  } catch {}
}

module.exports = {
  CHATGPT_STEALTH_URLS,
  sanitizeUserAgent,
  applyStealthHeaders,
  STEALTH_DOM_SCRIPT,
  injectDomStealth,
};
