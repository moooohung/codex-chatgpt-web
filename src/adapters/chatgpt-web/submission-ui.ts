export function chatGptSubmissionDomProjection(options: { userTurnSelector: string; assistantTurnSelector: string; stopButtonSelector: string; knownKey?: string; attributeFilter: string[]; purpose?: "submission" | "tool_boundary"; renderBudget?: { history?: boolean; multipart?: boolean; motion?: boolean; sidebar?: boolean } }) {
  const projectionStarted = performance.now();
  // Boundary capture needs turn identities only. Layout of a megabyte-sized input can
  // stall its read before the small assistant answer is even inspected. Acceptance,
  // failure alerts and completion continue to use the complete submission projection.
  const boundary = options.purpose === "tool_boundary";
  // Preserve every DOM identity and text node. Only older offscreen layout can be skipped.
  // Keep the latest user/assistant pair fully rendered for acceptance and tool boundaries.
  const renderRoots = (boundary ? [] : [...document.querySelectorAll('[data-turn-key], [data-turn-id-container]')])
    .filter(element => !element.parentElement?.closest('[data-turn-key], [data-turn-id-container]'));
  let deferredHistoryNodes = 0, deferredInputNodes = 0, reducedMotionNodes = 0;
  const budget = options.renderBudget;
  const history = budget?.history !== false;
  const multipart = budget?.multipart !== false;
  const motion = budget?.motion !== false;
  const sidebar = budget?.sidebar !== false;
  if (!boundary && typeof CSS !== "undefined" && CSS.supports("content-visibility", "auto")) {
    let style = document.getElementById("codex-history-render-budget");
    if (!style) {
      style = document.createElement("style"); style.id = "codex-history-render-budget";
      style.textContent = `
        [data-codex-history-render-budget="auto"]{content-visibility:auto;contain-intrinsic-size:auto 700px}
        [data-codex-input-render-budget="auto"]{content-visibility:auto;contain-intrinsic-size:auto 1000px}
        [data-codex-turn-motion="reduced"],[data-codex-turn-motion="reduced"] *{animation-duration:0.001ms!important;animation-iteration-count:1!important;transition-duration:0.001ms!important;transition-delay:0ms!important;scroll-behavior:auto!important}
        html[data-codex-sidebar-budget="reduced"] nav[aria-label="Chat history"],html[data-codex-sidebar-budget="reduced"] [data-testid="conversation-history"]{content-visibility:hidden;contain-intrinsic-size:0 0}
      `;
      document.head.appendChild(style);
    }
    renderRoots.forEach((element, index) => {
      if (history && index < renderRoots.length - 2) {
        if (element.getAttribute("data-codex-history-render-budget") !== "auto") element.setAttribute("data-codex-history-render-budget", "auto");
        deferredHistoryNodes++;
      } else if (element.hasAttribute("data-codex-history-render-budget")) element.removeAttribute("data-codex-history-render-budget");
      // The streaming answer can use animation completion to reveal its controls.
      // Restrict reduced motion to settled history and submitted user content.
      if (motion && index < renderRoots.length - 2) element.setAttribute("data-codex-turn-motion", "reduced");
      else element.removeAttribute("data-codex-turn-motion");
    });
    const inputSelector = '[data-user-message-bubble], [data-message-author-role="user"]';
    const inputs = [...document.querySelectorAll(inputSelector)].filter(input => !input.parentElement?.closest(inputSelector));
    for (const input of inputs) {
      if (multipart && (input.textContent?.length ?? 0) >= 32_768
        && !input.querySelector('textarea,input,[contenteditable="true"]')) {
        input.setAttribute("data-codex-input-render-budget", "auto"); deferredInputNodes++;
      } else input.removeAttribute("data-codex-input-render-budget");
      if (motion) input.setAttribute("data-codex-turn-motion", "reduced");
      else input.removeAttribute("data-codex-turn-motion");
    }
    reducedMotionNodes = document.querySelectorAll('[data-codex-turn-motion="reduced"]').length;
    if (sidebar) document.documentElement.setAttribute("data-codex-sidebar-budget", "reduced");
    else document.documentElement.removeAttribute("data-codex-sidebar-budget");
  }
  // A boundary read must not serialize the full transcript/composer just to
  // refresh a size hint. Ordinary diagnostics/submission reads keep that metric.
  const bodyTextChars = boundary ? undefined : document.body?.textContent?.length ?? 0;
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
  if (!boundary && options.knownKey === observerKey) return { key: observerKey, bodyTextChars, deferredHistoryNodes, deferredInputNodes, reducedMotionNodes, projectionElapsedMs: performance.now() - projectionStarted };
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
    !boundary && userIdentities.includes(turnIdentities[index]!) && hasSubmissionError(container)
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
    if (!boundary && group.querySelector("[data-user-message-bubble]") && hasSubmissionError(group)) failedUserIdentities.push(user);
  });
  return {
    key: observerKey,
    bodyTextChars, deferredHistoryNodes, deferredInputNodes, reducedMotionNodes, projectionElapsedMs: performance.now() - projectionStarted,
    snapshot: {
      userTurnCount: userIdentities.length,
      assistantTurnCount: responseIdentities.length,
      visibleStopButtonCount: boundary ? 0 : [...document.querySelectorAll(options.stopButtonSelector)].filter(visible).length,
      turnIdentities,
      userIdentities,
      responseIdentities,
      failedUserIdentities,
    },
  };
}
