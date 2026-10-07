export function chatGptSubmissionDomProjection(options: { userTurnSelector: string; assistantTurnSelector: string; stopButtonSelector: string; knownKey?: string; attributeFilter: string[] }) {
  const projectionStarted = performance.now();
  // Preserve every DOM identity and text node. Only older offscreen layout can be skipped.
  // Keep the latest user/assistant pair fully rendered for acceptance and tool boundaries.
  const renderRoots = [...document.querySelectorAll('[data-turn-key], [data-turn-id-container]')]
    .filter(element => !element.parentElement?.closest('[data-turn-key], [data-turn-id-container]'));
  let deferredHistoryNodes = 0;
  if (typeof CSS !== "undefined" && CSS.supports("content-visibility", "auto") && renderRoots.length > 2) {
    let style = document.getElementById("codex-history-render-budget");
    if (!style) {
      style = document.createElement("style"); style.id = "codex-history-render-budget";
      style.textContent = '[data-codex-history-render-budget="auto"]{content-visibility:auto;contain-intrinsic-size:auto 700px}';
      document.head.appendChild(style);
    }
    renderRoots.forEach((element, index) => {
      if (index < renderRoots.length - 2) {
        if (element.getAttribute("data-codex-history-render-budget") !== "auto") element.setAttribute("data-codex-history-render-budget", "auto");
        deferredHistoryNodes++;
      } else if (element.hasAttribute("data-codex-history-render-budget")) element.removeAttribute("data-codex-history-render-budget");
    });
  }
  const bodyTextChars = document.body?.textContent?.length ?? 0;
  type ObserverState = { id: string; revision: number; observer: MutationObserver };
  const scope = globalThis as typeof globalThis & {
    __CODEX_WEB_GPT_TURN_OBSERVER__?: ObserverState;
  };
  const observerState = scope.__CODEX_WEB_GPT_TURN_OBSERVER__ ??= (() => {
    const state: ObserverState = {
      id: `${performance.timeOrigin}:${Math.random().toString(36).slice(2)}`,
      revision: 0,
      observer: undefined as unknown as MutationObserver,
    };
    state.observer = new MutationObserver(() => {
      state.revision += 1;
    });
    state.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: options.attributeFilter,
    });
    return state;
  })();
  const observerKey = `${observerState.id}:${observerState.revision}`;
  if (options.knownKey === observerKey) return { key: observerKey, bodyTextChars, deferredHistoryNodes, projectionElapsedMs: performance.now() - projectionStarted };
  const identities = (elements: Element[], attribute: string): string[] => {
    const values = elements.map(element => element.getAttribute(attribute));
    if (values.some(value => typeof value !== "string" || value.trim().length === 0)) {
      throw new Error(`ChatGPT conversation turn has no stable ${attribute} identity`);
    }
    const typed = values as string[];
    if (new Set(typed).size !== typed.length) {
      throw new Error("ChatGPT exposed duplicate conversation turn identities");
    }
    return typed;
  };
  const visible = (element: Element): boolean => {
    const candidate = element as HTMLElement;
    const style = getComputedStyle(candidate);
    const bounds = candidate.getBoundingClientRect();
    return candidate.isConnected
      && style.visibility !== "hidden"
      && (bounds.width > 0 || bounds.height > 0);
  };
  const hasSubmissionError = (container: Element): boolean => (
    Array.from(container.querySelectorAll('[role="alert"]')).some(alert => {
      // This error UI can replace the assistant entirely. Quoted errors in message
      // prose cannot establish that the current browser submission was rejected.
      if (alert.closest('[data-user-message-bubble], [data-message-author-role], .markdown')
        || !visible(alert)
        || !/^(?:Unknown error|Something went wrong|알 수 없는 오류|오류가 발생)/i.test(alert.textContent?.trim() ?? "")) return false;
      return Array.from(alert.querySelectorAll("button")).some(button => visible(button)
        && /^(?:Retry|다시 시도)$/i.test(button.textContent?.trim() ?? ""));
    })
  );
  // data-testid contains a display index: ChatGPT can renumber it while the same turn lives.
  // Virtualization removes a turn's section, but retains its outer identity container.
  const containers = [...document.querySelectorAll("[data-turn-id-container]")].filter(element =>
    !element.closest("[data-turn-key]")
    && element.parentElement?.closest("[data-turn-id-container]")?.getAttribute("data-turn-id-container")
      !== element.getAttribute("data-turn-id-container"));
  const turnIdentities = identities(containers, "data-turn-id-container");
  const legacyTurns = (selector: string) => [...document.querySelectorAll(selector)]
    .filter(element => element.getAttribute("data-turn-key") == null);
  const userIdentities = identities(legacyTurns(options.userTurnSelector), "data-turn-id");
  const responseIdentities = identities(legacyTurns(options.assistantTurnSelector), "data-turn-id");
  const knownTurns = new Set(turnIdentities);
  if ([...userIdentities, ...responseIdentities].some(identity => !knownTurns.has(identity))) {
    throw new Error("ChatGPT conversation turn has no matching identity container");
  }
  const groups = [...document.querySelectorAll("[data-turn-key]")];
  const groupKeys = identities(groups, "data-turn-key");
  const failedUserIdentities = containers.flatMap((container, index) => (
    userIdentities.includes(turnIdentities[index]!) && hasSubmissionError(container)
      ? [turnIdentities[index]!] : []
  ));
  groups.forEach((group, index) => {
    const user = `group:user:${groupKeys[index]}`;
    const assistant = `group:assistant:${groupKeys[index]}`;
    // Keep both logical roles in the baseline even when virtualization unmounts their
    // contents. Remounting an old answer must never acknowledge a new submission.
    turnIdentities.push(user, assistant);
    if (group.querySelector("[data-user-message-bubble]")) userIdentities.push(user);
    if (group.querySelector('[data-conversation-role="assistant"], [data-chatgpt-agent-turn-start]')) responseIdentities.push(assistant);
    if (group.querySelector("[data-user-message-bubble]") && hasSubmissionError(group)) failedUserIdentities.push(user);
  });
  return {
    key: observerKey,
    bodyTextChars, deferredHistoryNodes, projectionElapsedMs: performance.now() - projectionStarted,
    snapshot: {
      userTurnCount: userIdentities.length,
      assistantTurnCount: responseIdentities.length,
      visibleStopButtonCount: [...document.querySelectorAll(options.stopButtonSelector)].filter(visible).length,
      turnIdentities,
      userIdentities,
      responseIdentities,
      failedUserIdentities,
    },
  };
}
