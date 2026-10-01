import { isWindows } from "./is-windows.js";

/**
 * Normalizes a filesystem path for containment comparison.
 *
 * Both the candidate path and the allowed roots are expected to be absolute and
 * already canonicalized (e.g. via `path.resolve` and `fs.realpath`). This helper
 * only smooths out the remaining platform differences: path separators, the
 * Windows extended-length path prefix that `fs.realpath` may return, duplicate
 * slashes, trailing slashes, and letter casing on case-insensitive filesystems.
 */
function normalizePathForComparison(path: string): string {
  let normalized = path.replace(/\\/g, "/");
  // Strip the Windows extended-length path prefix ("\\?\") that fs.realpath can return
  if (normalized.startsWith("//?/")) {
    normalized = normalized.slice(4);
  }
  normalized = normalized.replace(/\/{2,}/g, "/");
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return isWindows() ? normalized.toLowerCase() : normalized;
}

/**
 * Determines whether a fully-resolved filesystem path is located inside at least
 * one of the given allowed root directories (or is exactly one of them).
 *
 * The comparison is segment-aware: a sibling directory whose name merely shares
 * a prefix with an allowed root (e.g. "allowed-evil" next to "allowed") is NOT
 * considered to be inside that root.
 */
export function isPathWithinRoots(targetPath: string, allowedRoots: string[]): boolean {
  const target = normalizePathForComparison(targetPath);
  return allowedRoots.some((root) => {
    const normalizedRoot = normalizePathForComparison(root);
    if (target === normalizedRoot) {
      return true;
    }
    const prefix = normalizedRoot.endsWith("/") ? normalizedRoot : normalizedRoot + "/";
    return target.startsWith(prefix);
  });
}
