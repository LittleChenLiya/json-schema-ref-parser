import * as url from "../util/url.js";
import { ResolverError } from "../util/errors.js";
import { isPathWithinRoots } from "../util/file-access-policy.js";
import type { JSONSchema, ResolverOptions } from "../types/index.js";
import type { FileInfo } from "../types/index.js";

export default {
  /**
   * The order that this resolver will run, in relation to other resolvers.
   */
  order: 100,

  /**
   * Determines whether this resolver can read a given file reference.
   * Resolvers that return true will be tried, in order, until one successfully resolves the file.
   * Resolvers that return false will not be given a chance to resolve the file.
   */
  canRead(file: FileInfo) {
    return url.isFileSystemPath(file.url);
  },

  /**
   * Reads the given file and returns its raw contents as a Buffer.
   */
  async read(file: FileInfo): Promise<Buffer> {
    let path: string | undefined;
    const fs = await import("fs");
    try {
      path = url.toFileSystemPath(file.url);
    } catch (err: any) {
      const e = err as Error;
      e.message = `Malformed URI: ${file.url}: ${e.message}`;
      throw new ResolverError(e, file.url);
    }
    // strip trailing slashes
    if (path.endsWith("/") || path.endsWith("\\")) {
      path = path.slice(0, -1);
    }
    const allowedPaths = this.allowedPaths;
    if (allowedPaths && allowedPaths.length > 0) {
      const nodePath = await import("path");
      // Canonicalize a path, resolving any symbolic links. If the path does not
      // exist, fall back to its normalized absolute form; the containment check
      // still applies and the subsequent read will report the missing file.
      const canonicalize = async (p: string): Promise<string> => {
        const absolute = nodePath.resolve(p);
        try {
          return await fs.promises.realpath(absolute);
        } catch {
          return nodePath.normalize(absolute);
        }
      };
      const finalPath = await canonicalize(path);
      const allowedRoots = await Promise.all(allowedPaths.map(canonicalize));
      if (!isPathWithinRoots(finalPath, allowedRoots)) {
        throw new ResolverError(new Error(`Refusing to read "${finalPath}": it is outside of the allowed paths`), path);
      }
    }
    try {
      return await fs.promises.readFile(path);
    } catch (err: any) {
      const e = err as Error;
      e.message = `Error opening file ${path}: ${e.message}`;
      throw new ResolverError(e, path);
    }
  },
} as ResolverOptions<JSONSchema>;
