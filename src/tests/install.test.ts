import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "./helpers";

afterAll(cleanupTempDirs);

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function setupInstallerFixture(): { binDir: string; fakeBinDir: string; regraft: string; state: string } {
  const dir = makeTempDir("regraft-install-");
  const binDir = join(dir, "bin");
  const fakeBinDir = join(dir, "fake-bin");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(fakeBinDir, { recursive: true });

  const regraft = join(binDir, "regraft");
  writeExecutable(
    regraft,
    `#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo "0.1.0"; exit 0; fi
echo old
`,
  );

  writeExecutable(
    join(fakeBinDir, "curl"),
    `#!/usr/bin/env bash
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    shift
    out="$1"
  fi
  shift || true
done
[ -n "$out" ] || exit 2
case "\${FAKE_BINARY_MODE:-ok}" in
  fail)
    cat > "$out" <<'BIN'
#!/usr/bin/env bash
exit 42
BIN
    ;;
  fail-after-first)
    cat > "$out" <<'BIN'
#!/usr/bin/env bash
state="\${FAKE_STATE:?}"
count=0
if [ -f "$state" ]; then count="$(cat "$state")"; fi
if [ "$count" = "0" ]; then
  printf '1' > "$state"
  echo "0.2.0"
  exit 0
fi
exit 42
BIN
    ;;
  *)
    cat > "$out" <<'BIN'
#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo "0.2.0"; exit 0; fi
echo new
BIN
    ;;
esac
chmod +x "$out"
`,
  );

  return { binDir, fakeBinDir, regraft, state: join(dir, "state") };
}

function runInstaller(fixture: { binDir: string; fakeBinDir: string; state: string }, mode: string) {
  return spawnSync("bash", ["scripts/install.sh"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: `${fixture.fakeBinDir}:${process.env.PATH ?? ""}`,
      REGRAFT_BIN_DIR: fixture.binDir,
      FAKE_BINARY_MODE: mode,
      FAKE_STATE: fixture.state,
    },
    encoding: "utf8",
  });
}

describe("install.sh rollback", () => {
  it("leaves the existing binary untouched when the downloaded binary fails verification", () => {
    const fixture = setupInstallerFixture();
    const result = runInstaller(fixture, "fail");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("downloaded binary failed to run");
    expect(execFileSync(fixture.regraft, ["--version"], { encoding: "utf8" }).trim()).toBe("0.1.0");
  });

  it("restores the existing binary when installed verification fails after replacement", () => {
    const fixture = setupInstallerFixture();
    const result = runInstaller(fixture, "fail-after-first");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("rolled back to the previous regraft binary");
    expect(result.stderr).toContain("installed binary failed to run");
    expect(execFileSync(fixture.regraft, ["--version"], { encoding: "utf8" }).trim()).toBe("0.1.0");
  });
});
