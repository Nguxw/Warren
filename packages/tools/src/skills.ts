import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { SkillSummary, Tool } from "@warren/core";
import { z } from "zod";

/**
 * Skills: folders of instructions and files for a kind of work, such as writing a research
 * report or reviewing a pull request. The format is Anthropic's Agent Skills: a folder with a
 * `SKILL.md` whose front matter names the skill and says when to use it, followed by the
 * instructions; other files in the folder (references, templates, scripts) come along.
 *
 * The model sees only names and descriptions until it loads one. Loading copies the folder into
 * the task's scratch directory, because Warren's home, where skills live, is hidden from the
 * sandbox; scripts in a skill therefore run sandboxed like any other command. A skill adds
 * instructions, never permissions.
 */

export interface Skill extends SkillSummary {
  /** The skill's folder. */
  path: string;
}

/** Skill names: lowercase words joined by hyphens, as in the Agent Skills format. */
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SKILL_BYTES = 20_000_000;

export class SkillCatalog {
  constructor(
    /** The folder holding one folder per skill. */
    readonly root: string,
    /** Names of installed skills the person has turned off. */
    private readonly disabled: () => readonly string[] = () => [],
  ) {}

  /** Every installed skill, valid or not, with whether it is on. */
  all(): (Skill & { enabled: boolean; error?: string })[] {
    if (!existsSync(this.root)) return [];
    const off = new Set(this.disabled());
    return readdirSync(this.root)
      .filter((name) => lstatSync(join(this.root, name)).isDirectory())
      .sort()
      .map((folder) => {
        const path = join(this.root, folder);
        try {
          const skill = readSkill(path);
          return { ...skill, enabled: !off.has(skill.name) };
        } catch (error) {
          return {
            name: folder,
            description: "",
            path,
            enabled: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      });
  }

  /** The skills a task may load. */
  enabled(): Skill[] {
    return this.all()
      .filter((skill) => skill.enabled && !skill.error)
      .map(({ name, description, path }) => ({ name, description, path }));
  }

  /**
   * Installs a skill by copying its folder in; the folder's SKILL.md names it. Links are not
   * followed, so a skill cannot carry a path to elsewhere on the disk into a task.
   */
  install(source: string): Skill {
    const skill = readSkill(source);
    let bytes = 0;
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const stat = lstatSync(join(dir, name));
        if (stat.isDirectory()) walk(join(dir, name));
        else bytes += stat.size;
      }
    };
    walk(source);
    if (bytes > MAX_SKILL_BYTES) throw new SkillError("a skill folder must be under 20 MB");
    const target = join(this.root, skill.name);
    mkdirSync(this.root, { recursive: true });
    rmSync(target, { recursive: true, force: true });
    cpSync(source, target, { recursive: true, verbatimSymlinks: true, filter: notLink });
    return { ...skill, path: target };
  }

  remove(name: string): void {
    if (!SKILL_NAME.test(name)) throw new SkillError(`no skill "${name}"`);
    const target = join(this.root, name);
    if (!existsSync(target)) throw new SkillError(`no skill "${name}"`);
    rmSync(target, { recursive: true, force: true });
  }
}

/** A skill that cannot be read or installed; the request was wrong, not the daemon. */
export class SkillError extends Error {}

/** Reads a skill folder's SKILL.md: its front matter (name, description) and instructions. */
export function readSkill(path: string): Skill & { instructions: string } {
  const file = join(path, "SKILL.md");
  if (!existsSync(file)) throw new SkillError("the folder has no SKILL.md");
  const text = readFileSync(file, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) throw new SkillError("SKILL.md must start with front matter between --- lines");
  const fields = frontMatter(match[1] ?? "");
  const name = fields.name ?? "";
  const description = fields.description ?? "";
  if (!SKILL_NAME.test(name)) {
    throw new SkillError(`the skill's name "${name}" must be lowercase words joined by hyphens`);
  }
  if (!description) throw new SkillError("the skill needs a description");
  return { name, description, path, instructions: (match[2] ?? "").trim() };
}

/**
 * The few front matter shapes skills use: `key: value`, quoted values, and values folded over
 * indented lines (`description: >` or plain continuation lines).
 */
function frontMatter(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let key: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (field) {
      key = field[1] as string;
      const value = (field[2] ?? "").trim();
      fields[key] = /^[>|][+-]?$/.test(value) ? "" : unquote(value);
    } else if (key && /^\s+\S/.test(line)) {
      fields[key] = `${fields[key] ? `${fields[key]} ` : ""}${line.trim()}`;
    }
  }
  return fields;
}

function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted ? (quoted[2] ?? "") : value;
}

function notLink(source: string): boolean {
  return !lstatSync(source).isSymbolicLink();
}

/** The tool that gives the model a skill's instructions and a copy of its files. */
export function loadSkillTool(catalog: SkillCatalog): Tool<{ name: string }> {
  return {
    name: "load_skill",
    description:
      "Load a skill listed in your instructions: returns its instructions and copies its files (references, templates, scripts) to a folder you can read and run from with the shell.",
    parameters: z.object({ name: z.string().describe("The skill's name, as listed") }),
    effect: "read",
    async run({ name }, { scratch }) {
      const skill = catalog.enabled().find((s) => s.name === name);
      if (!skill) {
        const known =
          catalog
            .enabled()
            .map((s) => s.name)
            .join(", ") || "none";
        return { outcome: "error", text: `No skill "${name}". Available: ${known}` };
      }
      const { instructions } = readSkill(skill.path);
      const target = join(scratch, "skills", skill.name);
      rmSync(target, { recursive: true, force: true });
      mkdirSync(join(scratch, "skills"), { recursive: true });
      cpSync(skill.path, target, { recursive: true, filter: notLink });
      const files = listFiles(target).filter((f) => f !== "SKILL.md");
      const listing =
        files.length > 0
          ? `\n\nFiles of this skill, in ${target}:\n${files.map((f) => `- ${f}`).join("\n")}`
          : "";
      return { outcome: "ok", text: `# Skill: ${skill.name}\n\n${instructions}${listing}` };
    },
  };
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (lstatSync(full).isDirectory()) walk(full);
      else files.push(relative(root, full));
    }
  };
  walk(root);
  return files.slice(0, 200);
}
