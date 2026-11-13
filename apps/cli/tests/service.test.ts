import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonCommand, launchAgentPlist, plistPath, serviceLabel } from "../src/service.ts";

test("the launch agent plist is valid and escapes what it embeds", () => {
  const plist = launchAgentPlist({
    label: "dev.warren.daemon",
    program: ["/opt/homebrew/bin/bun", "/Users/a & b/warren/main.ts", "daemon"],
    logFile: "/Users/u/.warren/logs/daemon.log",
    workingDirectory: "/Users/u/.warren",
    environment: { PATH: "/usr/bin:/bin", WARREN_HOME: "/Users/u/<home>" },
  });
  expect(plist).toContain("<string>/Users/a &amp; b/warren/main.ts</string>");
  expect(plist).toContain("<string>/Users/u/&lt;home&gt;</string>");
  expect(plist).toContain("<key>KeepAlive</key>\n    <true/>");

  if (process.platform === "darwin") {
    const dir = mkdtempSync(join(tmpdir(), "warren-plist-"));
    try {
      const file = join(dir, "agent.plist");
      writeFileSync(file, plist);
      const lint = Bun.spawnSync(["/usr/bin/plutil", "-lint", file]);
      expect(lint.stdout.toString()).toContain("OK");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("from source, the agent runs bun with the CLI script", () => {
  const [program, script, command] = daemonCommand();
  expect(program).toBe(process.execPath);
  expect(script).toEndWith("apps/cli/src/main.ts");
  expect(command).toBe("daemon");
});

test("a development label keeps its own plist", () => {
  expect(serviceLabel({})).toBe("dev.warren.daemon");
  expect(serviceLabel({ WARREN_SERVICE_LABEL: "dev.warren.test" })).toBe("dev.warren.test");
  expect(plistPath("dev.warren.test", "/Users/u")).toBe(
    "/Users/u/Library/LaunchAgents/dev.warren.test.plist",
  );
});
