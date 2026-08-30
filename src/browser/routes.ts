export function normalizeBrowserBasePath(basePath: string): string {
  const segments = basePath.split("/").filter(Boolean);
  return segments.length === 0 ? "/" : `/${segments.join("/")}/`;
}

export function getDocumentBasePath(): string {
  return normalizeBrowserBasePath(new URL(document.baseURI).pathname);
}

export function removeBrowserBasePath(
  pathname: string,
  basePath: string,
): string | null {
  const normalizedBasePath = normalizeBrowserBasePath(basePath);
  if (normalizedBasePath === "/") {
    return pathname;
  }

  if (pathname === normalizedBasePath.slice(0, -1)) {
    return "/";
  }

  if (!pathname.startsWith(normalizedBasePath)) {
    return null;
  }

  return `/${pathname.slice(normalizedBasePath.length)}`;
}

export function addBrowserBasePath(pathname: string, basePath: string): string {
  const normalizedBasePath = normalizeBrowserBasePath(basePath);
  const normalizedPathname = pathname.startsWith("/")
    ? pathname
    : `/${pathname}`;
  return normalizedBasePath === "/"
    ? normalizedPathname
    : `${normalizedBasePath.slice(0, -1)}${normalizedPathname}`;
}

export function mapBrowserPathToInitialRoute(
  pathname: string,
  search: string,
  basePath = "/",
) {
  const applicationPath = removeBrowserBasePath(pathname, basePath) ?? "/";

  if (applicationPath === "/share/receive" && search) {
    const params = new URLSearchParams(search);

    const prompt = ["title", "text", "url"]
      .flatMap((name) => {
        const value = params.get(name);
        return value === null ? [] : [`${name}: ${value}`];
      })
      .join("\n");

    return {
      memoryPath: prompt
        ? `/?${new URLSearchParams({ prompt }).toString()}`
        : "/",
      browserPath: addBrowserBasePath("/", basePath),
    };
  }

  return {
    memoryPath: mapBrowserPathToRoute(pathname, basePath),
  };
}

export function mapBrowserPathToRoute(
  pathname: string,
  basePath = "/",
): string {
  const applicationPath = removeBrowserBasePath(pathname, basePath);
  const match = applicationPath?.match(/^\/thread\/([^/]+)$/);
  if (match) {
    try {
      return `/local/${decodeURIComponent(match[1])}`;
    } catch {
      return "/";
    }
  }

  return "/";
}

export function mapMemoryPathToBrowserPath(pathname: string, basePath = "/") {
  if (pathname === "/") {
    return { path: addBrowserBasePath("/", basePath), titleChange: "Codex" };
  }

  const match = pathname.match(/^\/local\/([^/?#]+)$/);
  if (!match) {
    return null;
  }

  return {
    path: addBrowserBasePath(
      `/thread/${encodeURIComponent(match[1])}`,
      basePath,
    ),
  };
}

export function dispatchNavigateToRoute(path: string): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "navigate-to-route",
        path,
      },
    }),
  );
}
