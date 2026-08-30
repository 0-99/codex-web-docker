export function normalizeBasePath(rawValue: string | undefined): string {
  const value = rawValue?.trim() || "/";

  if (!value.startsWith("/") || value.startsWith("//")) {
    throw new Error(
      `Invalid base path: ${value}. Expected an absolute URL path such as /codex/.`,
    );
  }

  if (/[?#\\\s]/u.test(value)) {
    throw new Error(
      `Invalid base path: ${value}. Query strings, fragments, backslashes, and whitespace are not allowed.`,
    );
  }

  const segments = value.split("/").filter(Boolean);
  for (const segment of segments) {
    let decodedSegment: string;
    try {
      decodedSegment = decodeURIComponent(segment);
    } catch {
      throw new Error(`Invalid base path: ${value}. Malformed URL encoding.`);
    }

    if (
      decodedSegment === "." ||
      decodedSegment === ".." ||
      decodedSegment.includes("/") ||
      decodedSegment.includes("\\")
    ) {
      throw new Error(`Invalid base path: ${value}. Invalid path segment.`);
    }
  }

  return segments.length === 0 ? "/" : `/${segments.join("/")}/`;
}

export function pathAtBase(basePath: string, relativePath: string): string {
  return `${basePath}${relativePath.replace(/^\/+/, "")}`;
}

export function basePathWithoutTrailingSlash(basePath: string): string {
  return basePath === "/" ? "/" : basePath.slice(0, -1);
}
