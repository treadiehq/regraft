import { describe, expect, it, vi } from "vitest";
import { executeExitCode } from "../core/execute";

describe("executeExitCode", () => {
  it("returns the command exit code without reporting an error", () => {
    const reportError = vi.fn();
    expect(executeExitCode(() => 0, reportError)).toBe(0);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("reports only the error message and returns exit code 1", () => {
    const reportError = vi.fn();
    const error = new Error("git checkout -q FETCH_HEAD failed: reference is not a tree");

    expect(
      executeExitCode(() => {
        throw error;
      }, reportError),
    ).toBe(1);
    expect(reportError).toHaveBeenCalledWith(error.message);
  });

  it("formats non-Error throws", () => {
    const reportError = vi.fn();
    expect(
      executeExitCode(() => {
        throw "checkout failed";
      }, reportError),
    ).toBe(1);
    expect(reportError).toHaveBeenCalledWith("checkout failed");
  });
});
