/** Standalone browser projection: prune message prose before inspecting short error UI.
 * Capped subtree text avoids re-reading a large prompt at every enclosing element. */
export function chatGptTerminalErrorUiVisible(roots: Element[]): boolean {
  const prose = '[data-user-message-bubble], [data-message-author-role="user"], .markdown, '
    + '[data-markdown-text-style], .puik-root.not-markdown > [class*="_DilResponseRoot"], '
    + 'pre, code, blockquote, [data-testid^="cot-v5"]';
  const pattern = /Something went wrong[\s\S]{0,512}help\.openai\.com/i;
  type TextState = { text: string | null; matched: boolean };
  const state = new WeakMap<Node, TextState>();
  const visible = (element: Element): boolean => {
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return element.isConnected && style?.display !== "none"
      && style?.visibility !== "hidden" && style?.visibility !== "collapse"
      && (bounds.width > 0 || bounds.height > 0);
  };
  for (const root of roots) {
    if (root.closest(prose)) continue;
    const stack: Array<{ node: Node; childrenRead: boolean }> = [{ node: root, childrenRead: false }];
    while (stack.length) {
      const { node, childrenRead } = stack.pop()!;
      if (node.nodeType === 3) {
        const text = (node as Text).data;
        state.set(node, { text: text.length <= 1_024 ? text : null, matched: false });
        continue;
      }
      if (node.nodeType !== 1) {
        state.set(node, { text: "", matched: false });
        continue;
      }
      const element = node as Element;
      if (!childrenRead) {
        if (element.matches(prose)) {
          // An ancestor containing prose is not an error-copy boundary either.
          state.set(node, { text: null, matched: false });
          continue;
        }
        stack.push({ node, childrenRead: true });
        for (let child = node.lastChild; child; child = child.previousSibling) stack.push({ node: child, childrenRead: false });
        continue;
      }
      let text: string | null = "", matched = false;
      for (let child = node.firstChild; child; child = child.nextSibling) {
        const current = state.get(child)!;
        matched ||= current.matched;
        if (text !== null) {
          text = current.text === null || text.length + current.text.length > 1_024 ? null : text + current.text;
        }
      }
      // Like getByText, inspect the smallest matching element. Hidden matching children
      // must not turn a visible ancestor into a false visible-error result.
      if (!matched && text !== null && pattern.test(text.replace(/\s+/g, " ").trim())) {
        matched = true;
        if (visible(element)) return true;
      }
      state.set(node, { text, matched });
    }
  }
  return false;
}
