/** Read short account-error UI once, without matching text inside the conversation. */
export function chatGptSessionFailureUiState(roots: Element[]): "expired" | "subscription" | undefined {
  const prose = '[data-user-message-bubble], [data-message-author-role], .markdown, '
    + '[data-markdown-text-style], .puik-root.not-markdown > [class*="_DilResponseRoot"], '
    + 'pre, code, blockquote, [data-testid^="cot-v5"]';
  const expired = /Your session has expired|你的工作階段已過期|您的工作階段已過期|你的会话已过期|您的会话已过期/i;
  const subscription = /Failed to load subscription/i;
  type TextState = { text: string | null; matched: boolean };
  const states = new WeakMap<Node, TextState>();
  let subscriptionVisible = false;
  const visible = (element: Element): boolean => {
    // A hidden child must not turn a visible dialog containing it into an error.
    for (let node: Element | null = element; node; node = node.parentElement) {
      if (node.hasAttribute("hidden")) return false;
      const style = node.ownerDocument.defaultView?.getComputedStyle(node);
      if (style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse") return false;
    }
    const bounds = element.getBoundingClientRect();
    return element.isConnected && (bounds.width > 0 || bounds.height > 0);
  };
  for (const root of roots) {
    if (root.closest(prose)) continue;
    const stack = [{ node: root as Node, childrenRead: false }];
    while (stack.length) {
      const { node, childrenRead } = stack.pop()!;
      if (states.has(node)) continue; // Nested alert/dialog roots share this scan.
      if (node.nodeType === 3) {
        const text = (node as Text).data;
        states.set(node, { text: text.length <= 1_024 ? text : null, matched: false });
        continue;
      }
      if (node.nodeType !== 1 || (node as Element).matches(prose)) {
        states.set(node, { text: node.nodeType === 1 ? null : "", matched: false });
        continue;
      }
      if (!childrenRead) {
        stack.push({ node, childrenRead: true });
        for (let child = node.lastChild; child; child = child.previousSibling) stack.push({ node: child, childrenRead: false });
        continue;
      }
      let text: string | null = "", matched = false;
      for (let child = node.firstChild; child; child = child.nextSibling) {
        const state = states.get(child)!;
        matched ||= state.matched;
        if (text !== null) text = state.text === null || text.length + state.text.length > 1_024 ? null : text + state.text;
      }
      if (!matched && text !== null) {
        const normalized = text.replace(/\s+/g, " ").trim();
        const expiredMatch = expired.test(normalized);
        const subscriptionMatch = subscription.test(normalized);
        if (expiredMatch || subscriptionMatch) {
          matched = true;
          if (visible(node as Element)) {
            if (expiredMatch) return "expired";
            subscriptionVisible = true;
          }
        }
      }
      states.set(node, { text, matched });
    }
  }
  return subscriptionVisible ? "subscription" : undefined;
}
