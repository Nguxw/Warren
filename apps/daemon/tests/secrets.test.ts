import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSecrets, maskSecret, parseEnvFile } from "../src/index.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "warren-secrets-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("secrets", () => {
  test("parses env files with comments, export and quotes", () => {
    expect(
      parseEnvFile(
        ["# comment", "", "A=1", "export B = two", `C="three = 3"`, "D='4'", "not a line"].join(
          "\n",
        ),
      ),
    ).toEqual({ A: "1", B: "two", C: "three = 3", D: "4" });
  });

  test("the environment wins over the credentials file, which fills the gaps", () => {
    const file = join(dir, "credentials.env");
    writeFileSync(file, "WARREN_OPENAI_API_KEY=from-file\nOPENAI_API_KEY=ignored\n");
    expect(loadSecrets({ env: {}, file })).toEqual({ WARREN_OPENAI_API_KEY: "from-file" });
    expect(loadSecrets({ env: { WARREN_OPENAI_API_KEY: "from-env" }, file })).toEqual({
      WARREN_OPENAI_API_KEY: "from-env",
    });
  });

  test("never picks up other tools' variables, and a missing file is fine", () => {
    expect(loadSecrets({ env: { OPENAI_API_KEY: "sk-other" }, file: join(dir, "nope") })).toEqual(
      {},
    );
  });

  test("masks secrets for display", () => {
    expect(maskSecret("sk-proj-abcdefghijklmnopqrstuvwxyz1234")).toBe("sk-proj…1234");
    expect(maskSecret("short")).toBe("****");
  });
});
