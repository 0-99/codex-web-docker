import { AsyncLocalStorage } from "node:async_hooks";

const browserLanguages = new AsyncLocalStorage<string[]>();

export function normalizeLanguages(value: string): string[] {
  return [
    ...new Set(
      value.split(",").flatMap((entry) => {
        const [language, quality] = entry.trim().split(";");
        if (quality?.trim() === "q=0") return [];
        const candidate = language?.replace(/[.@].*$/, "").replaceAll("_", "-");
        if (!candidate || /^(C|POSIX|auto)$/i.test(candidate)) return [];
        try {
          return Intl.getCanonicalLocales(candidate);
        } catch {
          return [];
        }
      }),
    ),
  ];
}

export function preferredLanguages(): string[] {
  const browser = browserLanguages.getStore();
  if (browser?.length) return browser;
  for (const name of ["LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"]) {
    const languages = normalizeLanguages(
      (process.env[name] || "").replaceAll(":", ","),
    );
    if (languages.length) return languages;
  }
  return normalizeLanguages(Intl.DateTimeFormat().resolvedOptions().locale)
    .concat("en-US")
    .slice(0, 1);
}

export function withBrowserLanguages<T>(
  languages: string[],
  callback: () => T,
): T {
  return browserLanguages.run(languages, callback);
}
