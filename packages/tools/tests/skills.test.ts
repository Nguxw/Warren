import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillTool, readSkill, SkillCatalog, SkillError } from "../src/index.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "warren-skills-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function skillFolder(name: string, front: string, body = "Do it well.") {
  const dir = join(root, "src", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${front}\n---\n\n${body}\n`);
  return dir;
}

test("reads the Agent Skills format, including folded descriptions", () => {
  const plain = skillFolder("a", 'name: pdf-forms\ndescription: "Fill PDF forms."');
  expect(readSkill(plain)).toMatchObject({
    name: "pdf-forms",
    description: "Fill PDF forms.",
    instructions: "Do it well.",
  });
  const folded = skillFolder(
    "b",
    "name: review\ndescription: >\n  Review a pull request\n  for bugs.\nlicense: MIT",
  );
  expect(readSkill(folded).description).toBe("Review a pull request for bugs.");
  for (const bad of ["name: Bad Name\ndescription: x", "name: ok", "description: x"]) {
    expect(() => readSkill(skillFolder(`bad${bad.length}`, bad))).toThrow(SkillError);
  }
});

test("installs, lists, turns off and removes skills; links are not carried in", () => {
  const source = skillFolder("report", "name: research-report\ndescription: Write a report.");
  writeFileSync(join(source, "template.md"), "# Template");
  writeFileSync(join(root, "secret"), "do not copy");
  symlinkSync(join(root, "secret"), join(source, "link"));

  let disabled: string[] = [];
  const catalog = new SkillCatalog(join(root, "skills"), () => disabled);
  expect(catalog.install(source).name).toBe("research-report");
  expect(existsSync(join(root, "skills", "research-report", "template.md"))).toBe(true);
  expect(existsSync(join(root, "skills", "research-report", "link"))).toBe(false);
  expect(catalog.enabled().map((s) => s.name)).toEqual(["research-report"]);
  disabled = ["research-report"];
  expect(catalog.enabled()).toEqual([]);
  expect(catalog.all()[0]).toMatchObject({ name: "research-report", enabled: false });
  catalog.remove("research-report");
  expect(catalog.all()).toEqual([]);
});

test("loading a skill returns its instructions and copies its files into the task's scratch", async () => {
  const catalog = new SkillCatalog(join(root, "skills"));
  const source = skillFolder(
    "report",
    "name: research-report\ndescription: Write a report.",
    "Use template.md.",
  );
  writeFileSync(join(source, "template.md"), "# Template");
  catalog.install(source);
  const scratch = join(root, "scratch");
  mkdirSync(scratch);
  const tool = loadSkillTool(catalog);
  const output = await tool.run({ name: "research-report" }, { scratch } as never);
  expect(output.outcome).toBe("ok");
  expect(output.text).toContain("Use template.md.");
  expect(output.text).toContain(join(scratch, "skills", "research-report"));
  expect(readFileSync(join(scratch, "skills", "research-report", "template.md"), "utf8")).toBe(
    "# Template",
  );
  expect((await tool.run({ name: "nope" }, { scratch } as never)).outcome).toBe("error");
});

test("the example skills in the repository are valid", () => {
  for (const name of ["research-report", "code-review"]) {
    const skill = readSkill(join(import.meta.dir, "..", "..", "..", "examples", "skills", name));
    expect(skill.name).toBe(name);
  }
});
