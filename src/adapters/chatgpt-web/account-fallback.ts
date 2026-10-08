import { ChatGptWebAdapterError } from "./adapter-error";
import type { BrowserTurn } from "./browser-worker";

export type ChatGptPlusPreparation = Pick<BrowserTurn, "capabilities" | "modelFamily"> & { reasoning: "high" };

/** These codes are issued only before any physical Send, after positive Plus evidence. */
export async function runWithChatGptPlusPreparation(
  worker: { run(turn: BrowserTurn): Promise<string> }, turn: BrowserTurn,
  prepare: (override: ChatGptPlusPreparation, resume: boolean) => ReturnType<BrowserTurn["prepare"]>,
): Promise<string> {
  let submitted = false;
  try {
    return await worker.run({ ...turn,
      onSendActivated: async () => { submitted = true; await turn.onSendActivated?.(); },
      onMultipartStageAcknowledged: async index => { submitted = true; await turn.onMultipartStageAcknowledged?.(index); },
    });
  } catch (error) {
    if (submitted || !(error instanceof ChatGptWebAdapterError)) throw error;
    const family = error.code === "chatgpt_plus_reprepare_56_high" ? "5.6"
      : error.code === "chatgpt_plus_reprepare_6_high" ? "6" : undefined;
    if (!family) throw error;
    turn.abortSignal?.throwIfAborted();
    const override: ChatGptPlusPreparation = { reasoning: "high", modelFamily: family,
      capabilities: { ...turn.capabilities, proAvailable: false, extraHighAvailable: false } };
    console.info(`[chatgpt-web] plus_context_reprepared ${JSON.stringify({ traceId: turn.traceId, family, effort: "high" })}`);
    // Exactly one fresh preparation; a second failure propagates without looping.
    return worker.run({ ...turn, ...override,
      prepare: () => prepare(override, false),
      ...(turn.prepareResume ? { prepareResume: () => prepare(override, true) } : {}),
    });
  }
}
