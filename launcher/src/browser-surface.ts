/** The owned idle document is a memory parking surface, not a navigable ChatGPT page. */
export function isIdleBrowserSurface(url: string | undefined): boolean {
  if (!url || url === "about:blank") return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "data:"
      && parsed.hash === "#codex-web-gpt-browser-host"
      && parsed.pathname.startsWith("text/html;charset=utf-8,");
  } catch {
    return false;
  }
}
