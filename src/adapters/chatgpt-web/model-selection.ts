import {
  type ChatGptEffortActivation,
  chatGptModelOption,
  openChatGptModelRows,
  parseChatGptEffortSliderState,
  parseChatGptModelAnnouncement,
  readChatGptModelAnnouncements,
} from "../../chatgpt-ui/model-picker";
import type { ChatGptWebAdapterEffort, ChatGptWebModelFamily } from "../../chatgpt-web-models";
import { ChatGptWebAdapterError } from "./adapter-error";

type EffortMenu = ChatGptEffortActivation;

/** User-authorized downgrade applies only after positive Plus account evidence. */
export function resolveChatGptPlusFallback(family: ChatGptWebModelFamily | undefined, effort: ChatGptWebAdapterEffort, planType: string) {
  if (planType !== "plus" || (effort !== "xhigh" && effort !== "max")) return undefined;
  return { family: family === "6" && effort === "max" ? "5.6" as const : family, effort: "high" as const };
}

export const CHATGPT_MODEL_SELECTION_SETTLE_MS = 10_000;

function selectionTimeout(family: ChatGptWebModelFamily, phase: string, cause?: unknown): ChatGptWebAdapterError {
  console.info(`[chatgpt-web] model_selection ${JSON.stringify({ family, phase, outcome: "timeout" })}`);
  return new ChatGptWebAdapterError(
    `ChatGPT model ${family} could not be selected and verified at ${phase} while its controls were responding slowly. This part was not sent.`,
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

function familyError(family: ChatGptWebModelFamily, phase = "family-selection", cause?: unknown): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    `ChatGPT model ${family} could not be selected and verified at model family selection (${phase}). This part was not sent.`,
    { status: 400, errorType: "invalid_request_error", code: "chatgpt_model_family_selection_failed", retryable: false, cause },
  );
}

function verificationError(family: ChatGptWebModelFamily, effort: ChatGptWebAdapterEffort, reason: string): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    `ChatGPT model ${family} could not be selected and verified at model/effort verification (${reason}, requested effort ${effort}). This part was not sent.`,
    { status: 400, errorType: "invalid_request_error", code: reason === "effort-position-mismatch"
      ? "chatgpt_effort_verification_failed" : "chatgpt_model_verification_failed", retryable: false },
  );
}

/** Keep the exact requested version; callers choose multipart staging separately. */
export function chatGptSelectionFamily(family: ChatGptWebModelFamily, _effort: ChatGptWebAdapterEffort): ChatGptWebModelFamily {
  return family;
}

/** Error text identifies the physical part; accepted earlier multipart parts are not undone. */
export function chatGptModelSelectionStageError(error: unknown, stage: string): unknown {
  if (!(error instanceof ChatGptWebAdapterError)
    || !/^(?:chatgpt_model_|chatgpt_effort_|model_version_unavailable)/.test(error.code)) return error;
  return new ChatGptWebAdapterError(
    `ChatGPT ${stage} failed: ${error.message}`
      + (stage === "multipart_requested_model_preflight" ? " No multipart part was sent."
        : /^(?:multipart_|final_part_)/.test(stage) ? " Earlier multipart parts may already have been accepted." : ""),
    { status: error.status, errorType: error.errorType, code: error.code, retryable: error.retryable, cause: error },
  );
}

function familyOption(menu: EffortMenu, family: ChatGptWebModelFamily, effort?: ChatGptWebAdapterEffort) {
  return chatGptModelOption(menu.menu, {
    version: family, name: family === "6" && effort === "max" ? "astra" : "sol",
  });
}

/** Model and effort are separate browser controls; a generic Pro label proves neither family. */
export async function selectChatGptModelFamily(
  menu: EffortMenu,
  family: ChatGptWebModelFamily,
  activate: () => Promise<EffortMenu>,
  effort?: ChatGptWebAdapterEffort,
  settleMs = CHATGPT_MODEL_SELECTION_SETTLE_MS,
  checkUnavailable?: (menu: EffortMenu) => Promise<void>,
): Promise<EffortMenu> {
  let phase = "family-view";
  const deadline = Date.now() + settleMs;
  const remaining = () => Math.max(0, deadline - Date.now());
  const probe = <T>(operation: () => Promise<T>) => modelProbe(operation, family, phase, remaining());
  try {
    const option = await probe(() => familyOption(menu, family, effort));
    const count = await probe(() => option.count());
    if (count > 1) throw familyError(family, "ambiguous-family-rows");
    if (count === 1 && await probe(() => option.getAttribute("aria-checked")) === "true") return menu;
    await probe(() => openChatGptModelRows(menu.menu));
    phase = "family-click";
    await checkUnavailable?.(menu);
    await probe(() => option.waitFor({ state: "visible", timeout: Math.max(1, remaining()) }));
    await probe(() => option.click({ timeout: Math.max(1, remaining()) }));
    // Choosing a family returns the open picker to its slider. Keep that surface:
    // Escape followed by an immediate reopen races the outgoing menu's cleanup.
    // Activation reuses the open menu and verifies its owner before returning it.
    phase = "family-readback";
    let selected = await probe(activate);
    do {
      const current = await probe(() => familyOption(selected, family, effort));
      const count = await probe(() => current.count());
      if (count > 1) throw familyError(family, "ambiguous-family-rows");
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
    throw familyError(family, phase, cause);
  }
}

export function chatGptModelFamilyMatches(
  descriptions: readonly string[],
  family: ChatGptWebModelFamily,
  effort: ChatGptWebAdapterEffort,
): boolean {
  // GPT-6 uses Sol below Pro and Astra at Pro. An old Latest picker can still use
  // 5.6 at lower efforts; that is not proof of an explicitly requested GPT-6 turn.
  const expectedName = family === "6" && effort === "max" ? "astra" : "sol";
  const expectedMode = { low: "instant", medium: "medium", high: "high", xhigh: "extra high", max: "pro" }[effort];
  const states = descriptions.flatMap(text => {
    const state = parseChatGptModelAnnouncement(text);
    return state ? [state] : [];
  });
  return states.length > 0 && states.every(state => state.version === family
    && (!state.name || state.name === expectedName)
    && (state.mode.toLowerCase() === expectedMode
      || family === "6" && effort === "max" && state.name === "astra" && /^max$/i.test(state.mode)));
}

/**
 * Plus accounts (2026-10-21) announce only the effort ("Medium, 2 of 4.") and the
 * picker header shows only "Medium", with no version. That is acceptable evidence
 * only for 5.6, whose explicit "GPT-5.6 Sol" row the caller has already proven
 * checked; GPT-6 keeps requiring a versioned announcement (Latest may run 5.6).
 */
export function chatGptEffortOnlyEvidenceMatches(
  descriptions: readonly string[],
  family: ChatGptWebModelFamily,
  effort: ChatGptWebAdapterEffort,
): boolean {
  if (family !== "5.6") return false;
  const expectedMode = { low: "instant", medium: "medium", high: "high", xhigh: "extra high", max: "pro" }[effort];
  const labels = descriptions
    .map(text => text.normalize("NFKC").replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (labels.length === 0 || labels.some(text => parseChatGptModelAnnouncement(text))) return false;
  return labels.every(text => (/^([^\p{P}\d]+)(?:\p{P}|$)/u.exec(text)?.[1] ?? "").trim().toLowerCase() === expectedMode);
}

export async function assertChatGptModelFamily(
  menu: EffortMenu,
  family: ChatGptWebModelFamily,
  effort: ChatGptWebAdapterEffort,
  effortIndex: number,
  settleMs = 0,
): Promise<void> {
  const deadline = Date.now() + settleMs;
  const selectionFamily = chatGptSelectionFamily(family, effort);
  let reason = "family-not-checked";
  let observed = false;
  const probe = <T>(operation: () => Promise<T>) => modelProbe(operation, family, "model-effort-readback",
    settleMs > 0 ? Math.max(0, deadline - Date.now()) : CHATGPT_MODEL_SELECTION_SETTLE_MS)
    .catch((error: unknown) => {
      // The settle deadline can expire inside a later readback. A completed readback already
      // proved the mismatch, so report it instead of a retryable slow-control timeout.
      if (observed && error instanceof ChatGptWebAdapterError && error.code === "chatgpt_model_selection_timeout") {
        throw verificationError(family, effort, reason);
      }
      throw error;
    });
  do {
    if (settleMs > 0 && Date.now() >= deadline) break;
    const option = await probe(() => familyOption(menu, selectionFamily, effort));
    const count = await probe(() => option.count());
    if (count > 1) throw verificationError(family, effort, "ambiguous-family-rows");
    const checked = count === 1 && await probe(() => option.getAttribute("aria-checked")) === "true";
    const state = parseChatGptEffortSliderState(
      ...await probe(() => Promise.all([menu.slider.getAttribute("aria-valuemin"), menu.slider.getAttribute("aria-valuemax"),
        menu.slider.getAttribute("aria-valuenow")])) as [string | null, string | null, string | null],
    );
    const descriptions = await probe(() => readChatGptModelAnnouncements(menu.slider));
    if (checked && state && state.value === state.min + effortIndex && (chatGptModelFamilyMatches(descriptions, family, effort)
      || chatGptEffortOnlyEvidenceMatches(descriptions, family, effort))) return;
    reason = !checked ? "family-not-checked" : !state || state.value !== state.min + effortIndex
      ? "effort-position-mismatch" : "model-evidence-mismatch";
    observed = true;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (true);
  throw verificationError(family, effort, reason);
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
