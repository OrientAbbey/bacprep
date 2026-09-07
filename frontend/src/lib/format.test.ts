import { describe, expect, it } from "vitest";
import { formatBytes } from "./format";

describe("formatBytes", () => {
  it("retourne — pour une valeur absente", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
  });
  it("affiche les octets sous 1 Ko", () => {
    expect(formatBytes(0)).toBe("0 o");
    expect(formatBytes(512)).toBe("512 o");
  });
  it("passe en Ko puis Mo", () => {
    expect(formatBytes(1536)).toBe("1,5 Ko");
    expect(formatBytes(2_400_000)).toBe("2,3 Mo");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3 Go");
  });
});
