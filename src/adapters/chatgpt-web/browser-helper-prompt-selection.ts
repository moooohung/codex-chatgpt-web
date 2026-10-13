import type { CompiledChatGptWebPrompt } from "./prompt";

export interface BrowserHelperPromptSelection {
  select(prepared: CompiledChatGptWebPrompt): boolean;
  cancel(): void;
  wait(): Promise<CompiledChatGptWebPrompt>;
}

export function createBrowserHelperPromptSelection(): BrowserHelperPromptSelection {
  let settle!: (prepared: CompiledChatGptWebPrompt | undefined) => void;
  let settled = false;
  const selected = new Promise<CompiledChatGptWebPrompt | undefined>(resolve => { settle = resolve; });
  const finish = (prepared: CompiledChatGptWebPrompt | undefined): boolean => {
    if (settled) return false;
    settled = true;
    settle(prepared);
    return true;
  };
  return {
    select: prepared => finish(prepared),
    cancel: () => finish(undefined),
    wait: async () => {
      const prepared = await selected;
      if (!prepared) throw new DOMException("Browser helper prompt selection aborted", "AbortError");
      return prepared;
    },
  };
}
