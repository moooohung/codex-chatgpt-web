const { applyStealthHeaders } = require("./stealth.cjs");

const CHATGPT_BROWSER_LOCALE = "en-US";
const CHATGPT_ACCEPT_LANGUAGES = "en-US,en";

function configureChatGptLocale(browserSession) {
  applyStealthHeaders(browserSession);
  // Chromium's language list and ChatGPT's explicit UI preference are separate.
  browserSession.setUserAgent(browserSession.getUserAgent(), CHATGPT_ACCEPT_LANGUAGES);
  return browserSession.cookies.set({
    url: "https://chatgpt.com/",
    domain: ".chatgpt.com",
    path: "/",
    name: "oai-locale",
    value: CHATGPT_BROWSER_LOCALE,
    secure: true,
    sameSite: "lax",
    expirationDate: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
  }).then(() => browserSession.cookies.flushStore());
}

module.exports = { CHATGPT_BROWSER_LOCALE, CHATGPT_ACCEPT_LANGUAGES, configureChatGptLocale };
