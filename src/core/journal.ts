import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { readFileIfExists } from "./hash";
import { managedFilePath, pruneEmptyDirs, writeFileEnsuringDir } from "./workspace";

/** In-memory rollback journal for one bounded CLI operation. */
export class MutationJournal {
  private readonly originals = new Map<string, Buffer | null>();

  constructor(private readonly root: string) {}

  capture(path: string): void {
    if (!this.originals.has(path)) {
      this.originals.set(path, readFileIfExists(managedFilePath(this.root, path)));
    }
  }

  write(path: string, data: Buffer | string): void {
    this.capture(path);
    writeFileEnsuringDir(this.root, path, data);
  }

  remove(path: string): void {
    this.capture(path);
    rmSync(managedFilePath(this.root, path), { force: true });
    pruneEmptyDirs(this.root, dirname(path));
  }

  rollback(): void {
    for (const [path, original] of [...this.originals.entries()].reverse()) {
      if (original === null) {
        rmSync(managedFilePath(this.root, path), { force: true });
        pruneEmptyDirs(this.root, dirname(path));
      } else {
        writeFileEnsuringDir(this.root, path, original);
      }
    }
  }
}
