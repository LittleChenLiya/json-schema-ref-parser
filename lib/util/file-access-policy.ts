import nodePath from "node:path";
import { FileAccessDeniedError } from "./errors.js";

/**
 * Returns the target of a symbolic link, or `undefined` if the path is not a symlink.
 */
export type LinkReader = (linkPath: string) => Promise<string | undefined> | string | undefined;

/**
 * Options for assertFileAllowed.
 */
export interface FileAccessCheckOptions {
  /**
   * Overrides how symbolic links are resolved. Production code uses fs.promises.readlink;
   * tests can supply a virtual link table to deterministically cover link-escape scenarios
   * on platforms where creating real symlinks is not permitted.
   */
  readLink?: LinkReader;
}

/**
 * The maximum number of symbolic links followed while resolving a single path. Once the
 * limit is reached resolution fails closed rather than looping forever.
 */
const MAX_LINK_HOPS = 40;

const defaultReadLink: LinkReader = async (linkPath: string) => {
  try {
    const fs = await import("node:fs");
    return await fs.promises.readlink(linkPath);
  } catch {
    return undefined;
  }
};

/**
 * Determines whether childPath is the same as rootPath or located anywhere underneath it.
 *
 * The check compares path segments instead of strings, so a root such as /srv/app does
 * not grant access to the sibling directory /srv/application. On Windows drive letters
 * are compared case-insensitively.
 */
export function isPathInsideRoot(childPath: string, rootPath: string): boolean {
  let child = nodePath.resolve(childPath);
  let root = nodePath.resolve(rootPath);
  if (nodePath.sep === "\\") {
    child = child.toUpperCase();
    root = root.toUpperCase();
  }
  const relative = nodePath.relative(root, child);
  return relative === "" || (!nodePath.isAbsolute(relative) && !relative.split(nodePath.sep).includes(".."));
}

/**
 * Lexically normalizes a path and then follows every symbolic link encountered along it,
 * returning the final physical location. Missing, non-symlink path components are kept as-is,
 * which means references to files that do not exist yet are checked against the location they
 * would physically occupy.
 *
 * Relative symlink targets are resolved against the directory containing the link.
 */
export async function resolvePhysicalPath(inputPath: string, readLink: LinkReader = defaultReadLink): Promise<string> {
  let current = nodePath.resolve(inputPath);

  for (let hops = 0; hops <= MAX_LINK_HOPS; hops++) {
    const { root } = nodePath.parse(current);
    const segments = current
      .slice(root.length)
      .split(/[\\/]/)
      .filter((segment) => segment.length > 0);
    let walked = root;
    let linkTarget: string | undefined;

    for (const segment of segments) {
      const candidate = nodePath.join(walked, segment);
      const target = await readLink(candidate);
      if (typeof target === "string" && target.length > 0) {
        linkTarget = nodePath.isAbsolute(target)
          ? nodePath.resolve(target)
          : nodePath.resolve(nodePath.dirname(candidate), target);
        break;
      }
      walked = candidate;
    }

    if (linkTarget === undefined) {
      return current;
    }
    current = linkTarget;
  }

  throw new Error('Too many symbolic links encountered while resolving "' + inputPath + '"');
}

/**
 * Asserts that a file about to be opened physically resides within one of the allowed root
 * directories.
 *
 * The supplied path and every allowed root are first normalized lexically and then resolved
 * through any symbolic links, so links that escape a permitted directory are rejected even
 * though their textual path appears to stay inside it.
 *
 * An absent or empty allowedRoots list means no policy was configured and access is allowed.
 * Any failure while resolving the physical location fails closed (the read is denied).
 */
export async function assertFileAllowed(
  filePath: string,
  allowedRoots?: readonly string[],
  options: FileAccessCheckOptions = {},
): Promise<void> {
  const roots = (allowedRoots ?? [])
    .map((root) => (typeof root === "string" ? root.trim() : ""))
    .filter((root): root is string => root.length > 0);
  if (roots.length === 0) {
    return;
  }

  const readLink = options.readLink ?? defaultReadLink;
  let physicalPath: string;
  let physicalRoots: string[];
  try {
    [physicalPath, physicalRoots] = await Promise.all([
      resolvePhysicalPath(filePath, readLink),
      Promise.all(roots.map((root) => resolvePhysicalPath(nodePath.resolve(root), readLink))),
    ]);
  } catch (err) {
    throw new FileAccessDeniedError(nodePath.resolve(filePath), roots, err instanceof Error ? err : undefined);
  }

  if (!physicalRoots.some((root) => isPathInsideRoot(physicalPath, root))) {
    throw new FileAccessDeniedError(physicalPath, roots);
  }
}
