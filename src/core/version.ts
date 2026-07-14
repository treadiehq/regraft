import { readFileSync } from "node:fs";

const FALLBACK_VERSION = "0.0.0";

export function resolveVersion(bakedVersion: unknown, packageJsonUrl: URL): string {
  if (typeof bakedVersion === "string" && bakedVersion.length > 0) {
    return bakedVersion;
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(packageJsonUrl, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      typeof parsed.version === "string" &&
      parsed.version.length > 0
    ) {
      return parsed.version;
    }
  } catch {
    // Missing or malformed package metadata falls through to the safe default.
  }

  return FALLBACK_VERSION;
}
