import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const MAX_SNAPSHOT_FILE_BYTES = 65_536;

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  Object.values(value).forEach((child) => deepFreeze(child, seen));
  return Object.freeze(value);
}

/*
 * Snapshot only a caller-owned isolated test tree. Symbolic links are recorded
 * but never followed, and regular files are bounded before their bytes are
 * read. Production code must never import this test helper.
 */
export async function snapshotIsolatedTree(target: string): Promise<unknown> {
  const metadata = await lstat(target);
  const common = {
    mode: metadata.mode,
    size: metadata.size,
    links: metadata.nlink,
    uid: metadata.uid,
    gid: metadata.gid,
    modified: metadata.mtimeMs,
    changed: metadata.ctimeMs,
  };
  if (metadata.isSymbolicLink()) {
    return deepFreeze({ kind: "symbolic-link", ...common });
  }
  if (metadata.isDirectory()) {
    const entries = (await readdir(target)).sort();
    return deepFreeze({
      kind: "directory",
      ...common,
      entries: await Promise.all(
        entries.map(async (name) =>
          Object.freeze({
            name,
            value: await snapshotIsolatedTree(join(target, name)),
          }),
        ),
      ),
    });
  }
  if (metadata.isFile()) {
    if (metadata.size > MAX_SNAPSHOT_FILE_BYTES) {
      throw new Error("Isolated tree snapshot file exceeded its test bound.");
    }
    return deepFreeze({
      kind: "file",
      ...common,
      bytes: [...(await readFile(target))],
    });
  }
  return deepFreeze({ kind: "other", ...common });
}
