export interface SourceSpec {
  /** Git URL, fetchable by the user's git. */
  url: string;
  /** Ref (branch, tag, or 40-char SHA). undefined = remote default branch. */
  ref?: string;
  /** Subpath inside the repo. "" = repo root. */
  path: string;
  /** Explicit published Graft selector (`#graft=name`). */
  graft?: string;
  /** Bare fragment that may be a ref or, if no such ref exists, a published Graft. */
  graftCandidate?: string;
}

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const SCP_LIKE_RE = /^[^/@#]+@[^/#:]+:/;
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);
const SHORTHAND_RE =
  /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\/(tree|blob)\/([^/#]+)(?:\/(.+))?)?(?:#([^#]+))?$/;
const PULL_SHORTHAND_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)$/;

function normalizeSubpath(p: string): string {
  return p.replace(/^\/+/, "").replace(/\/+$/, "");
}

/** Apply a `#ref` / `#ref:subpath` / `#:subpath` fragment to a git URL. */
function applyFragment(url: string, frag: string): SourceSpec {
  if (!frag) return { url, path: "" };
  if (frag.startsWith("graft=")) {
    const graft = frag.slice("graft=".length);
    if (!graft) throw new Error('Published Graft selector must include a name, e.g. "#graft=session".');
    return { url, path: "", graft };
  }
  const colon = frag.indexOf(":");
  const ref = colon === -1 ? frag : frag.slice(0, colon);
  const path = colon === -1 ? "" : normalizeSubpath(frag.slice(colon + 1));
  return ref === ""
    ? { url, path }
    : { url, ref, path, ...(colon === -1 ? { graftCandidate: ref } : {}) };
}

function splitFragment(input: string): { base: string; frag: string } {
  const hashIdx = input.indexOf("#");
  if (hashIdx === -1) return { base: input, frag: "" };
  return { base: input.slice(0, hashIdx), frag: input.slice(hashIdx + 1) };
}

/**
 * Parse a source argument. Accepted forms:
 *
 * - GitHub shorthand:      owner/repo, owner/repo#ref,
 *                          owner/repo/tree/<ref>/<path>, owner/repo/blob/<ref>/<file>
 * - PR head (a live ref):  owner/repo/pull/<number> -> tracks pull/<number>/head
 * - Full GitHub web URLs:  https://github.com/owner/repo[/tree|blob/<ref>/<path>|/pull/<number>]
 * - Published Graft:        owner/repo#graft=<name> (or owner/repo#<name> when no matching ref exists)
 * - Any git URL + fragment: <git-url>#<ref>, <git-url>#<ref>:<subpath>, <git-url>#:<subpath>
 *   (works with https://, ssh://, file://, and scp-style git@host:repo.git)
 */
export function parseSourceArg(input: string): SourceSpec {
  const raw = input.trim();
  if (raw === "") throw new Error("Source must not be empty. Example: regraft add owner/repo/tree/main/src/lib");

  if (SCHEME_RE.test(raw)) {
    const { base, frag } = splitFragment(raw);
    let host: string;
    let pathname: string;
    try {
      const u = new URL(base);
      host = u.hostname.toLowerCase();
      pathname = u.pathname;
    } catch {
      throw new Error(`"${raw}" is not a valid URL.`);
    }
    if (GITHUB_HOSTS.has(host) && !base.endsWith(".git")) {
      const segs = pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
      const owner = segs[0];
      const repo = segs[1];
      if (!owner || !repo) {
        throw new Error(
          `"${raw}" is missing owner/repo segments. Example: https://github.com/owner/repo/tree/main/src`,
        );
      }
      const gitUrl = `https://github.com/${owner}/${repo}.git`;
      if (segs.length === 2) return applyFragment(gitUrl, frag);
      const kind = segs[2];
      const ref = segs[3];
      if ((kind === "tree" || kind === "blob") && ref) {
        return { url: gitUrl, ref, path: normalizeSubpath(segs.slice(4).join("/")) };
      }
      if (kind === "pull" && ref && /^\d+$/.test(ref) && segs.length === 4) {
        return { url: gitUrl, ref: `pull/${ref}/head`, path: "" };
      }
      throw new Error(
        `Unsupported GitHub URL form: "${raw}". Supported: repo root, /tree/<ref>/<path>, /blob/<ref>/<file>, /pull/<number>.`,
      );
    }
    return applyFragment(base, frag);
  }

  if (SCP_LIKE_RE.test(raw)) {
    const { base, frag } = splitFragment(raw);
    return applyFragment(base, frag);
  }

  const pr = raw.match(PULL_SHORTHAND_RE);
  if (pr) {
    const [, owner, repo, num] = pr;
    return { url: `https://github.com/${owner}/${repo}.git`, ref: `pull/${num}/head`, path: "" };
  }

  const m = raw.match(SHORTHAND_RE);
  if (m) {
    const [, owner, repo, kind, refSeg, rest, frag] = m;
    if (owner && repo && owner !== "." && owner !== "..") {
      const gitUrl = `https://github.com/${owner}/${repo}.git`;
      if (kind === "tree" || kind === "blob") {
        if (!refSeg) throw new Error(`"${raw}" is missing a ref after /${kind}/.`);
        return { url: gitUrl, ref: refSeg, path: normalizeSubpath(rest ?? "") };
      }
      return applyFragment(gitUrl, frag ?? "");
    }
  }

  throw new Error(
    `Unrecognized source: "${raw}".\n` +
      `Accepted forms:\n` +
      `  owner/repo[#ref]\n` +
      `  owner/repo#graft=<name>          (published in regraft.yaml)\n` +
      `  owner/repo/tree/<ref>/<path>   owner/repo/blob/<ref>/<file>\n` +
      `  owner/repo/pull/<number>       (tracks the PR head, a live ref)\n` +
      `  https://github.com/owner/repo[/tree|blob/<ref>/<path>|/pull/<number>]\n` +
      `  <git-url>#<ref>[:<subpath>]    (any git remote, incl. file:// and git@host:repo.git)`,
  );
}

/**
 * Heuristic used by `add` to tell a trailing source apart from a dest path:
 * URLs, scp-style remotes, #ref fragments, and /tree|blob|pull/ shorthands are
 * unambiguously sources; anything else (e.g. "lib/components") is a dest.
 */
export function looksLikeSource(arg: string): boolean {
  const raw = arg.trim();
  if (SCHEME_RE.test(raw) || SCP_LIKE_RE.test(raw)) return true;
  if (raw.includes("#")) return true;
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(tree|blob|pull)\//.test(raw);
}

export function repoNameFromUrl(url: string): string {
  let tail = url.replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  if (tail.endsWith(".git")) tail = tail.slice(0, -4);
  if (!tail) throw new Error(`Cannot derive a directory name from "${url}"; pass an explicit dest.`);
  return tail;
}

/** Default local dest: basename of the subpath, or the repo name for repo roots. */
export function defaultDest(spec: SourceSpec): string {
  if (spec.graft) return spec.graft;
  if (spec.path === "") return repoNameFromUrl(spec.url);
  return spec.path.split("/").pop() ?? spec.path;
}
