import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../apps/backend/src/auth.js";

describe("password hashing", () => {
  it("verifies the right password and rejects a wrong one", async () => {
    const encoded = await hashPassword("SteppeSecure2026");
    expect(encoded).not.toContain("SteppeSecure2026");
    await expect(verifyPassword("SteppeSecure2026", encoded)).resolves.toBe(true);
    await expect(verifyPassword("WrongPassword2026", encoded)).resolves.toBe(false);
  });

  it("rejects malformed hashes", async () => {
    await expect(verifyPassword("SteppeSecure2026", "not-a-password-hash")).resolves.toBe(false);
  });
});
