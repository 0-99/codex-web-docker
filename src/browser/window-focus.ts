// Desktop's renderer uses the Electron focus protocol, but the hidden server-side
// BrowserWindow cannot describe the user's browser tab. Translate focus locally:
// first-run splash completion depends on a focused-window notification.
type FocusDocument = Pick<Document, "hasFocus" | "visibilityState">;

export function browserWindowFocus(document: FocusDocument) {
  // A visible tab may still belong to an unfocused browser window. Require both
  // signals to handle switching applications as well as switching tabs.
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
  // Late native notifications must not overwrite this tab's current state.
  // Unrelated messages retain their original payload and object identity.
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
  // Report subsequent changes; the shim answers the initial request separately.
  // Return a disposer so subscriptions can be released with their owning tab.
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
