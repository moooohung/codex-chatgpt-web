import type { ChatGptWebCapabilities } from "./model";
import { CHATGPT_WEB_LUNA_MODEL_ID } from "./model";
import { ChatGptWebAdapterError } from "./adapter-error";

export interface ChatGptAccountContext {
  accountKey: string;
  planType: "plus" | "pro" | "prolite" | "free";
}

export interface ChatGptAccountPreparation extends ChatGptAccountContext {
  capabilities: ChatGptWebCapabilities;
  modelFamily?: "5.6" | "6";
  reasoning?: string;
}

export function isChatGptAccountPreparation(value: unknown): value is ChatGptAccountPreparation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (typeof item.accountKey !== "string" || !/^[a-f0-9]{64}$/.test(item.accountKey)
    || !["plus", "pro", "prolite", "free"].includes(String(item.planType))
    || (item.modelFamily !== undefined && item.modelFamily !== "5.6" && item.modelFamily !== "6")
    || (item.reasoning !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(String(item.reasoning)))) return false;
  const caps = item.capabilities;
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) return false;
  const c = caps as Record<string, unknown>;
  if (!["localToolsEnabled", "solAvailable", "extraHighAvailable", "proAvailable"].every(key => typeof c[key] === "boolean")) return false;
  const pro = item.planType === "pro" || item.planType === "prolite";
  return c.proAvailable === pro && c.solAvailable === (item.planType !== "free")
    && (c.solAvailable || !c.extraHighAvailable)
    && (item.reasoning !== "max" || pro)
    && (item.reasoning !== "xhigh" || c.extraHighAvailable === true);
}

/** Lease evidence sizes this submission; a primary-account setup cannot grant a neighbour's tier. */
export function resolveChatGptAccountPreparation(
  turn: { modelId: string; modelFamily?: "5.6" | "6"; reasoning?: string; capabilities: ChatGptWebCapabilities },
  account: ChatGptAccountContext,
): ChatGptAccountPreparation {
  const pro = account.planType === "pro" || account.planType === "prolite";
  const capabilities = { ...turn.capabilities, proAvailable: pro,
    solAvailable: account.planType !== "free",
    extraHighAvailable: pro || (account.planType === "plus" && turn.capabilities.extraHighAvailable) };
  let reasoning = turn.reasoning;
  let modelFamily = turn.modelFamily;
  if (account.planType === "plus" && reasoning === "max") {
    reasoning = "high";
    // The user requested 6 Pro -> 5.6 High, never 6 High.
    if (modelFamily === "6") modelFamily = "5.6";
  } else if (account.planType === "plus" && reasoning === "xhigh" && !capabilities.extraHighAvailable) {
    reasoning = "high";
  }
  if ((turn.modelId === CHATGPT_WEB_LUNA_MODEL_ID) !== !capabilities.solAvailable) {
    throw new ChatGptWebAdapterError("The selected ChatGPT account cannot run this model. No message was sent.", {
      status: 409, errorType: "invalid_request_error", code: "chatgpt_account_model_unavailable", retryable: false,
    });
  }
  const result = { ...account, capabilities, ...(modelFamily ? { modelFamily } : {}), ...(reasoning ? { reasoning } : {}) };
  if (!isChatGptAccountPreparation(result)) throw new Error("Invalid leased ChatGPT account preparation");
  return result;
}
