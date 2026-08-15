import { describe, expect, it } from "vitest";
import { normalizeName, resolveUniqueName } from "./naming.js";

describe("naming", () => {
  it("normalizes whitespace", () => {
    expect(normalizeName("  Board   Consent.pdf  ")).toBe("Board Consent.pdf");
  });

  it("keeps a unique file name unchanged", async () => {
    const result = await resolveUniqueName("Board Consent.pdf", "file", async () => false);
    expect(result).toEqual({ name: "Board Consent.pdf", conflictResolved: false });
  });

  it("adds suffixes before the extension for duplicate file names", async () => {
    const taken = new Set(["Board Consent.pdf", "Board Consent (1).pdf"]);
    const result = await resolveUniqueName("Board Consent.pdf", "file", async (name) => taken.has(name));
    expect(result).toEqual({ name: "Board Consent (2).pdf", conflictResolved: true });
  });

  it("adds suffixes to duplicate folder names", async () => {
    const taken = new Set(["Legal", "Legal (1)"]);
    const result = await resolveUniqueName("Legal", "folder", async (name) => taken.has(name));
    expect(result).toEqual({ name: "Legal (2)", conflictResolved: true });
  });
});
