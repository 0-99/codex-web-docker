type FocusDocument = Pick<Document, "hasFocus" | "visibilityState">;

export function browserWindowFocus(document: FocusDocument) {
  const isFocused =
    document.visibilityState === "visible" && document.hasFocus();
  return {
    type: "electron-window-focus-changed" as const,
    isFocused,
    ...(isFocused ? {} : { occurredAtMs: Date.now() }),
  };
}

export function withBrowserWindowFocus(
  message: unknown,
  document: FocusDocument,
) {
  if (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "electron-window-focus-changed"
  ) {
    return browserWindowFocus(document);
  }
  return message;
}

export function installBrowserWindowFocus(
  window: Pick<Window, "addEventListener" | "removeEventListener">,
  document: FocusDocument &
    Pick<Document, "addEventListener" | "removeEventListener">,
  send: (message: ReturnType<typeof browserWindowFocus>) => void,
) {
  const update = () => send(browserWindowFocus(document));
  window.addEventListener("focus", update);
  window.addEventListener("blur", update);
  document.addEventListener("visibilitychange", update);
  return () => {
    window.removeEventListener("focus", update);
    window.removeEventListener("blur", update);
    document.removeEventListener("visibilitychange", update);
  };
}
