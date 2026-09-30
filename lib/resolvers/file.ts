import * as url from "../util/url.js";
import { assertFileAllowed } from "../util/file-access-policy.js";
import { FileAccessDeniedError, ResolverError } from "../util/errors.js";
import type { FileResolverOptions, JSONSchema } from "../types/index.js";
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
  async read(this: FileResolverOptions<JSONSchema>, file: FileInfo): Promise<Buffer> {
    let path: string | undefined;
    const fs = await import("fs");
    const nodePath = await import("path");
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
    const allowedRoots = typeof this.allowedRoots === "string" ? [this.allowedRoots] : this.allowedRoots;
    if (allowedRoots && allowedRoots.length > 0) {
      // Resolve the reference's final physical location and keep it within the allowed
      // roots before any bytes are read. The URL was already resolved relative to the
      // referencing document by the external-reference crawler; here we normalize,
      // follow symlinks, and enforce the allowlist.
      const absoluteRoots = allowedRoots.map((root) =>
        nodePath.resolve(url.toFileSystemPath(url.fromFileSystemPath(root))),
      );
      try {
        await assertFileAllowed(path, absoluteRoots, this.readLink ? { readLink: this.readLink } : {});
      } catch (err) {
        if (err instanceof FileAccessDeniedError) {
          throw err;
        }
        throw new ResolverError(err instanceof Error ? err : new Error(String(err)), path);
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
} as FileResolverOptions<JSONSchema>;
