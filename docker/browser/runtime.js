// Fork-owned startup/reconnect UI and mobile viewport adapter. No app bundle patch.
(() => {
  const root = document.documentElement;
  const mobile = matchMedia("(max-width: 768px)");
  function fitViewport() {
    if (!mobile.matches) {
      root.style.removeProperty("--codex-web-viewport-height");
      return;
    }
    const viewport = window.visualViewport;
    // Pinch zoom should still magnify the page, not reflow the application.
    if (viewport && viewport.scale !== 1) return;
    root.style.setProperty(
      "--codex-web-viewport-height",
      `${viewport?.height || innerHeight}px`,
    );
  }
  fitViewport();
  window.addEventListener("resize", fitViewport);
  window.visualViewport?.addEventListener("resize", fitViewport);
  mobile.addEventListener("change", fitViewport);

  const panel = document.createElement("section");
  panel.id = "codex-web-status";
  panel.hidden = true;
  const title = document.createElement("div");
  title.setAttribute("role", "status");
  title.setAttribute("aria-live", "polite");
  const countdown = document.createElement("div");
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  const list = document.createElement("ul");
  details.append(summary, list);
  panel.append(title, countdown, details);
  document.body.append(panel);

  let state;
  let receivedAt = 0;
  let serverTime = 0;
  let disconnected = false;
  let readySince = 0;
  let wasStarting = true;
  const messages = {
    de: {
      "backend-ready": "Web-Backend bereit",
      connecting: "Verbindung zum App-Server wird hergestellt …",
      "retry-wait": "App-Server nicht erreichbar · wir warten weiter",
      connected: "App-Server verbunden",
      resuming: "Threads werden wiederhergestellt …",
      ready: "Bereit",
      degraded:
        "App-Server verbunden · ein Thread konnte nicht wiederhergestellt werden",
      failed: "Verbindung beendet · bitte Serverprotokoll prüfen",
      backend:
        "Verbindung zum Web-Backend unterbrochen · wir verbinden erneut …",
      loading: "App-Server verbunden · Oberfläche wird geladen …",
      details: "Verbindungsstatus",
      next: (seconds) => `Nächster Versuch in ${seconds} s`,
      threads: (done, total) =>
        `${done} von ${total} Threads wiederhergestellt`,
    },
    en: {
      "backend-ready": "Web backend ready",
      connecting: "Connecting to app-server …",
      "retry-wait": "App-server unavailable · still waiting",
      connected: "App-server connected",
      resuming: "Restoring threads …",
      ready: "Ready",
      degraded: "App-server connected · a thread could not be restored",
      failed: "Connection stopped · please check the server log",
      backend: "Web backend disconnected · reconnecting …",
      loading: "App-server connected · loading interface …",
      details: "Connection status",
      next: (seconds) => `Next attempt in ${seconds} s`,
      threads: (done, total) => `${done} of ${total} threads restored`,
    },
  };
  function render() {
    if (!state?.enabled) {
      panel.hidden = true;
      return;
    }
    const language = navigator.language || root.lang;
    const text =
      messages[language?.toLowerCase().startsWith("de") ? "de" : "en"];
    const starting = Boolean(document.querySelector(".startup-loader"));
    panel.dataset.starting = String(starting);
    if (wasStarting !== starting) details.open = starting;
    wasStarting = starting;
    const ready = state.phase === "ready" && !disconnected && !starting;
    if (!ready) readySince = 0;
    else if (!readySince) readySince = performance.now();
    panel.hidden = ready && performance.now() - readySince > 2000;
    const heading = disconnected
      ? text.backend
      : state.phase === "ready" && starting
        ? text.loading
        : text[state.phase];
    if (title.textContent !== heading) title.textContent = heading;
    const remaining = Math.max(
      0,
      Math.ceil(
        (state.retryAt - (serverTime + performance.now() - receivedAt)) / 1000,
      ),
    );
    countdown.textContent =
      !disconnected && state.phase === "retry-wait"
        ? text.next(remaining)
        : state.phase === "resuming"
          ? text.threads(state.completed || 0, state.total || 0)
          : "";
    summary.textContent = text.details;
    const steps = [
      "backend-ready",
      ...(state.history || []).map((item) => item.phase),
    ];
    const labels = [...new Set(steps)]
      .map((phase) => text[phase])
      .filter(Boolean);
    if (list.textContent !== labels.join("")) {
      list.replaceChildren(
        ...labels.map((label) => {
          const item = document.createElement("li");
          item.textContent = label;
          return item;
        }),
      );
    }
  }
  details.open = true;
  let events;
  let timer;
  function connectStatus() {
    events = new EventSource(
      new URL("__backend/status/events", document.baseURI),
    );
    events.onmessage = (event) => {
      try {
        state = JSON.parse(event.data);
        serverTime = state.serverTime;
        receivedAt = performance.now();
        disconnected = false;
        render();
      } catch {
        /* A malformed status event must not affect the application. */
      }
    };
    events.onerror = () => {
      disconnected = true;
      render();
    };
    timer = setInterval(render, 250);
  }
  connectStatus();
  window.addEventListener("pagehide", () => {
    clearInterval(timer);
    events.close();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) connectStatus();
  });
})();
