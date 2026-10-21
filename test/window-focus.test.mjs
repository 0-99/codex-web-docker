import assert from "node:assert/strict";
import test from "node:test";
import {
  browserWindowFocus,
  installBrowserWindowFocus,
  withBrowserWindowFocus,
} from "../src/browser/window-focus.ts";

test("browser focus replaces synthetic Desktop focus without changing other events", () => {
  let focused = true;
  const document = { visibilityState: "visible", hasFocus: () => focused };
  assert.deepEqual(
    withBrowserWindowFocus(
      { type: "electron-window-focus-changed", isFocused: false },
      document,
    ),
    {
      type: "electron-window-focus-changed",
      isFocused: true,
    },
  );
  focused = false;
  const blurred = withBrowserWindowFocus(
    { type: "electron-window-focus-changed", isFocused: true },
    document,
  );
  assert.equal(blurred.isFocused, false);
  assert.equal(typeof blurred.occurredAtMs, "number");
  focused = true;
  document.visibilityState = "hidden";
  assert.equal(browserWindowFocus(document).isFocused, false);
  const other = { type: "navigate-to-route", path: "/local/saved" };
  assert.equal(withBrowserWindowFocus(other, document), other);
});

test("each tab reports focus and visibility changes through its own listener", () => {
  function tab() {
    const window = new EventTarget();
    const document = Object.assign(new EventTarget(), {
      visibilityState: "visible",
      focused: true,
      hasFocus() {
        return this.focused;
      },
    });
    const messages = [];
    const dispose = installBrowserWindowFocus(window, document, (message) =>
      messages.push(message),
    );
    return { window, document, messages, dispose };
  }
  const first = tab();
  const second = tab();
  first.document.focused = false;
  first.window.dispatchEvent(new Event("blur"));
  assert.equal(first.messages.at(-1).isFocused, false);
  assert.equal(second.messages.length, 0);
  first.document.focused = true;
  first.window.dispatchEvent(new Event("focus"));
  assert.equal(first.messages.at(-1).isFocused, true);
  first.document.visibilityState = "hidden";
  first.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(first.messages.at(-1).isFocused, false);
  first.dispose();
  first.window.dispatchEvent(new Event("focus"));
  assert.equal(first.messages.length, 3);
  second.dispose();
});
