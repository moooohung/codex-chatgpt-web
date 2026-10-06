import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import { defaultChromeExecutable } from "../src/config";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptMessageDeliveryTimeoutVisible, ChatGptDeliveryRecovery } from "../src/adapters/chatgpt-web/delivery-recovery";

const output = resolve(process.argv[2] ?? "scratch/offline-submission-recovery.json");
if (existsSync(output)) throw new Error("Use a fresh offline probe output path");
mkdirSync(dirname(output), { recursive: true });
const browser = await chromium.launch({ executablePath: defaultChromeExecutable(), headless: true });
const context = await browser.newContext();
await context.route("**/*", route => route.abort());
const fixtures: Record<string, unknown>[] = [];
const html = `<form><div id="prompt-textarea" contenteditable="true">owned complete draft</div><button type="submit" data-testid="send-button">Send</button></form>
<div id="turns"></div><script>window.sent=0;document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();window.sent++;
document.querySelector('#prompt-textarea').textContent='';document.querySelector('#turns').innerHTML='<div data-turn-id-container="owned-user"><div data-testid="conversation-turn-0" data-turn-id="owned-user" data-message-author-role="user">owned complete draft</div></div>';});</script>`;

async function submissionFixture(name: string, dropFirst: boolean, stallAck: boolean) {
  const page = await context.newPage();
  await page.setContent(html);
  const composer = page.locator("#prompt-textarea"), button = page.getByTestId("send-button");
  let attempts = 0, accepted = 0, release: (() => void) | undefined;
  const wrappedButton = { waitFor: button.waitFor.bind(button), isEnabled: button.isEnabled.bind(button),
    press: async (key: string, options: any) => {
      attempts++;
      if (dropFirst && attempts === 1) throw new Error("offline transport rejected before dispatch");
      await button.press(key, options);
      if (stallAck) await new Promise<void>(resolve => { release = resolve; });
    } };
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    activeComposer: async () => ({ evaluate: composer.evaluate.bind(composer), locator: () => ({ locator: () => wrappedButton }) }),
  }) as any;
  try {
    const baseline = await worker.captureSubmissionBaseline(page, "owned complete draft");
    const evidence = await worker.runStage(`offline-${name}`, "send", 10_000, (signal: AbortSignal) => worker.sendAttachedPrompt(
      page, baseline, undefined, signal, undefined, { traceId: `offline-${name}`, onSubmitted: () => { accepted++; } },
    ));
    const sent = await page.evaluate(() => (window as any).sent);
    if (sent !== 1 || accepted !== 1 || attempts !== (dropFirst ? 2 : 1)) throw new Error(`Offline ${name} violated single submission`);
    fixtures.push({ name, evidence, attempts, actualFormSubmissions: sent, acceptanceCallbacks: accepted });
  } finally { release?.(); await page.close(); }
}

try {
  await submissionFixture("stalled-keyboard-ack", false, true);
  await submissionFixture("confirmed-input-not-dispatched", true, false);
  const page: Page = await context.newPage();
  await page.setContent(`<div id="historical"><div class="banner"><span>Message delivery timed out. Please try again.</span><button>Retry</button></div></div>
    <div id="current"><div class="markdown">Completed command and commit.</div><div class="banner"><span>Message delivery timed out. Please try again.</span><button>Retry</button></div></div>
    <div id="quoted"><div class="markdown"><span>Message delivery timed out. Please try again.</span><button>Retry</button></div></div>`);
  const currentError = await chatGptMessageDeliveryTimeoutVisible(page.locator("#current"));
  const quotedError = await chatGptMessageDeliveryTimeoutVisible(page.locator("#quoted"));
  if (!currentError || quotedError) throw new Error("Offline delivery-error UI scoping failed");
  const recovery = new ChatGptDeliveryRecovery("offline-outer-turn");
  let continuations = 0;
  const options = { backoffMs: 1,
    readState: async () => ({ currentResponseIdentity: "current", errorVisible: currentError, running: false,
      toolsInFlight: false, approvalPending: false, deadlineReached: false }),
    continue: async (prompt: string) => { if (!prompt.includes("Do not repeat completed commands")) throw new Error("Missing continuation boundary"); continuations++; return "continued"; },
  };
  await recovery.recover("current", options); await recovery.recover("current", options);
  if (continuations !== 1) throw new Error("Duplicate delivery continuation");
  fixtures.push({ name: "delivery-timeout-current-response", currentError, quotedError, continuations,
    scope: "owned current response; completed-work instruction and receipt dedup" });
  writeFileSync(output, JSON.stringify({ kind: "isolated_offline_browser", browserVersion: browser.version(),
    chromeExecutable: defaultChromeExecutable(), fixtures, chatGptRequests: 0, authenticatedAccounts: 0,
    limits: "Local HTML fixtures. Does not prove live ChatGPT recovery, live outer goal execution, or actual memory reduction." }, null, 2));
  console.log("OFFLINE_SUBMISSION_RECOVERY_OK");
} finally { await context.close(); await browser.close(); }
