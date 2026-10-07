import { activateChatGptEffortMenu, parseChatGptEffortSliderState, readChatGptModelAnnouncements } from "../../chatgpt-session";
import type { ChatGptWebAdapterEffort, ChatGptWebModelFamily } from "../../chatgpt-web-models";
import { ChatGptWebAdapterError } from "./adapter-error";

type EffortMenu = Awaited<ReturnType<typeof activateChatGptEffortMenu>>;

export const CHATGPT_MODEL_SELECTION_SETTLE_MS = 10_000;

function selectionTimeout(family: ChatGptWebModelFamily, phase: string, cause?: unknown): ChatGptWebAdapterError {
  console.info(`[chatgpt-web] model_selection ${JSON.stringify({ family, phase, outcome: "timeout" })}`);
  return new ChatGptWebAdapterError(
    `ChatGPT model ${family} could not be selected and verified while its controls were responding slowly. The pending message was not sent.`,
    { status: 502, errorType: "server_error", code: "chatgpt_model_selection_timeout", retryable: true, cause },
  );
}

async function modelProbe<T>(operation: () => Promise<T>, family: ChatGptWebModelFamily, phase: string, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) throw selectionTimeout(family, phase);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(selectionTimeout(family, phase)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function familyError(family: ChatGptWebModelFamily, cause?: unknown): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    `ChatGPT model ${family} could not be selected and verified. The pending message was not sent. Check the selected model and account availability in the browser, then retry.`,
    { status: 400, errorType: "invalid_request_error", code: "model_version_unavailable", retryable: false, cause },
  );
}

function familyOption(menu: EffortMenu, family: ChatGptWebModelFamily) {
  return menu.menu.getByRole("menuitemradio", {
    name: family === "5.6" ? /^GPT[-\s]?5\.6(?:\s+Sol)?(?:\s*(?:\(Web\)|\(웹\)))?(?:\s+Pro)?$/i
      // Simplified/Traditional Chinese and Japanese share 最新; Korean uses 최신.
      : /^(?:Latest|最新|최신|GPT[-\s]?6(?:\s+Astra)?)(?:\s*(?:\(Web\)|\(웹\)))?(?:\s+Pro)?$/i,
    exact: true,
    includeHidden: true,
  });
}

/** Model and effort are separate browser controls; a generic Pro label proves neither family. */
export async function selectChatGptModelFamily(
  menu: EffortMenu,
  family: ChatGptWebModelFamily,
  activate: () => Promise<EffortMenu>,
  settleMs = CHATGPT_MODEL_SELECTION_SETTLE_MS,
): Promise<EffortMenu> {
  let phase = "family-view";
  const deadline = Date.now() + settleMs;
  const remaining = () => Math.max(0, deadline - Date.now());
  const probe = <T>(operation: () => Promise<T>) => modelProbe(operation, family, phase, remaining());
  try {
    const option = familyOption(menu, family);
    const count = await probe(() => option.count());
    if (count > 1) throw familyError(family);
    if (count === 1 && await probe(() => option.getAttribute("aria-checked")) === "true") return menu;
    // The attached radio rows are inert while this composer-owned advanced view is collapsed.
    const powerView = menu.menu.locator('[data-model-picker-view]');
    const viewCount = await probe(() => powerView.count());
    if (viewCount === 1) {
      const view = await probe(() => powerView.getAttribute("data-model-picker-view"));
      if (view === "simple") {
        const trigger = powerView.locator('[data-model-picker-view-toggle="true"][aria-hidden="false"]');
        if (await probe(() => trigger.count()) !== 1) throw familyError(family);
        await probe(() => trigger.click({ timeout: Math.max(1, remaining()) }));
      } else if (view !== "advanced") throw familyError(family);
    } else {
      const trigger = menu.menu.locator('[role="menuitem"][aria-expanded][aria-hidden="false"]');
      if (viewCount !== 0 || await probe(() => trigger.count()) !== 1) throw familyError(family);
      if (await probe(() => trigger.getAttribute("aria-expanded")) === "false") {
        await probe(() => trigger.click({ timeout: Math.max(1, remaining()) }));
      }
    }
    phase = "family-click";
    await probe(() => option.waitFor({ state: "visible", timeout: Math.max(1, remaining()) }));
    await probe(() => option.click({ timeout: Math.max(1, remaining()) }));
    // Choosing a family returns the open picker to its slider. Keep that surface:
    // Escape followed by an immediate reopen races the outgoing menu's cleanup.
    // Activation reuses the open menu and verifies its owner before returning it.
    phase = "family-readback";
    let selected = await probe(activate);
    do {
      const current = familyOption(selected, family);
      const count = await probe(() => current.count());
      if (count > 1) throw familyError(family);
      if (count === 1 && await probe(() => current.getAttribute("aria-checked")) === "true") return selected;
      await new Promise(resolve => setTimeout(resolve, 50));
      // A family change can replace the portal or close its old menu. Resolve the
      // current composer-owned picker again instead of polling a detached ID.
      selected = await probe(activate);
    } while (Date.now() < deadline);
    throw selectionTimeout(family, phase);
  } catch (cause) {
    if (cause instanceof ChatGptWebAdapterError) throw cause;
    if (cause instanceof Error && cause.name === "TimeoutError") throw selectionTimeout(family, phase, cause);
    throw familyError(family, cause);
  }
}

export function chatGptModelFamilyMatches(
  descriptions: readonly string[],
  family: ChatGptWebModelFamily,
  effort: ChatGptWebAdapterEffort,
): boolean {
  // Latest uses 5.6 for the existing lower-effort multipart acknowledgements and 6 for Pro.
  // Never interpret a future Latest Pro model as 6, or a lower effort as the final Pro response.
  const expected = family === "6" && effort !== "max" ? "5.6" : family;
  const states = descriptions.flatMap(text => {
    const match = /^(?:GPT[-\s]?)?(\d+(?:\.\d+)?)(?:\s+(Sol|Astra))?\s+([^,，]+)(?:[,，]|$)/i
      .exec(text.replace(/\s+/g, " ").trim());
    return match ? [{ version: match[1], name: match[2]?.toLowerCase(), mode: match[3]!.trim() }] : [];
  });
  return states.length > 0 && states.every(state => state.version === expected
    && (!state.name || state.name === (expected === "5.6" ? "sol" : "astra"))
    && (effort === "max" ? /^Pro$/i.test(state.mode) : !/^Pro$/i.test(state.mode)));
}

export async function assertChatGptModelFamily(
  menu: EffortMenu,
  family: ChatGptWebModelFamily,
  effort: ChatGptWebAdapterEffort,
  effortIndex: number,
  settleMs = 0,
): Promise<void> {
  const deadline = Date.now() + settleMs;
  const probe = <T>(operation: () => Promise<T>) => modelProbe(operation, family, "model-effort-readback",
    settleMs > 0 ? Math.max(0, deadline - Date.now()) : CHATGPT_MODEL_SELECTION_SETTLE_MS);
  do {
    if (settleMs > 0 && Date.now() >= deadline) break;
    const option = familyOption(menu, family);
    const count = await probe(() => option.count());
    if (count > 1) throw familyError(family);
    const checked = count === 1 && await probe(() => option.getAttribute("aria-checked")) === "true";
    const state = parseChatGptEffortSliderState(
      ...await probe(() => Promise.all([menu.slider.getAttribute("aria-valuemin"), menu.slider.getAttribute("aria-valuemax"),
        menu.slider.getAttribute("aria-valuenow")])) as [string | null, string | null, string | null],
    );
    const descriptions = await probe(() => readChatGptModelAnnouncements(menu.slider));
    if (checked && state && state.value === state.min + effortIndex && chatGptModelFamilyMatches(descriptions, family, effort)) return;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (true);
  throw familyError(family);
}

/** Closing animations must finish before the trigger label becomes selection evidence. */
export async function readClosedChatGptEffortLabel(control: EffortMenu["slider"], family: ChatGptWebModelFamily,
  settleMs = CHATGPT_MODEL_SELECTION_SETTLE_MS): Promise<string> {
  const deadline = Date.now() + settleMs;
  let previous: string | undefined;
  do {
    const [expanded, label] = await modelProbe(() => Promise.all([
      control.getAttribute("aria-expanded"), control.innerText(),
    ]), family, "effort-menu-close", Math.max(0, deadline - Date.now()));
    const closedLabel = expanded === "false" && label.trim() ? label.trim() : undefined;
    if (closedLabel && closedLabel === previous) return closedLabel;
    previous = closedLabel;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw selectionTimeout(family, "effort-menu-close");
}
