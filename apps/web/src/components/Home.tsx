import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TaskSummary } from "@warren/protocol";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { api } from "../api.ts";
import { useI18n } from "../context.tsx";
import type { MessageKey } from "../i18n.ts";
import {
  ArrowUp,
  Check,
  Close,
  Cpu,
  Folder,
  Globe,
  Logo,
  Package,
  Paperclip,
  Plug,
  Plus,
  Sparkle,
  Terminal,
} from "../icons.tsx";
import { useEnterToSend } from "../keys.ts";
import { matchesQuery, slashQuery } from "../model.ts";
import {
  AttachButton,
  DropHint,
  PendingFiles,
  useAttachments,
  useDropZone,
} from "./Attachments.tsx";
import { type Command, CommandMenu } from "./CommandMenu.tsx";
import { Menu } from "./Menu.tsx";

const ROLES = ["main", "hard", "cheap"] as const;
type Role = (typeof ROLES)[number];
/** Options a starter sets along with its text, so the task is ready to send. */
interface Preset {
  network?: boolean;
  /** A skill to use, if it is installed and on. */
  skill?: string;
  /** What the person still has to choose, shown above the bar. */
  tip?: MessageKey;
}

/** Ways to begin, shown while the text box is empty. */
const STARTERS: {
  key: string;
  icon: ReactNode;
  title: MessageKey;
  description: MessageKey;
  text: MessageKey;
  preset: Preset;
}[] = [
  {
    key: "research",
    icon: <Globe size={17} />,
    title: "starter.research.title",
    description: "starter.research.description",
    text: "starter.research.text",
    preset: { network: true, skill: "research-report" },
  },
  {
    key: "fix",
    icon: <Terminal size={17} />,
    title: "starter.fix.title",
    description: "starter.fix.description",
    text: "starter.fix.text",
    preset: { tip: "starter.fix.tip" },
  },
  {
    key: "notes",
    icon: <Folder size={17} />,
    title: "starter.notes.title",
    description: "starter.notes.description",
    text: "starter.notes.text",
    preset: { tip: "starter.notes.tip" },
  },
];

/**
 * The start page: say what to do and press Enter. Everything else has a default: no folder (an
 * empty workspace), nowhere to save yet, the standard model, the network as the settings say.
 * Each can be changed from the bar under the text, only when the task needs it.
 */
export function Home(props: {
  tasks: readonly TaskSummary[];
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onCreated(id: string): void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [preset, setPreset] = useState<Preset>();
  const clearPreset = useCallback(() => setPreset(undefined), []);
  return (
    <div className="home">
      <div className="home-inner">
        <span className="hero-mark">
          <Logo size={44} />
        </span>
        <h1>{t("home.title")}</h1>
        <p className="muted">{t("home.body")}</p>
        <TaskComposer
          tasks={props.tasks}
          inputRef={props.inputRef}
          text={text}
          onText={setText}
          preset={preset}
          onPresetUsed={clearPreset}
          onCreated={props.onCreated}
        />
        {/* Starters make way once something is typed. */}
        <div className={`starters ${text.trim() ? "hidden" : ""}`}>
          {STARTERS.map((starter) => (
            <button
              key={starter.key}
              type="button"
              className="starter"
              tabIndex={text.trim() ? -1 : 0}
              onClick={() => {
                const value = t(starter.text);
                setText(value);
                setPreset(starter.preset);
                const box = props.inputRef.current;
                box?.focus();
                requestAnimationFrame(() => box?.setSelectionRange(value.length, value.length));
              }}
            >
              <span className="starter-icon">{starter.icon}</span>
              <span className="starter-title">{t(starter.title)}</span>
              <span className="starter-description">{t(starter.description)}</span>
            </button>
          ))}
        </div>
        <p className="shortcuts">{t("home.shortcuts")}</p>
      </div>
    </div>
  );
}

/** Recent folders, newest first, from the tasks the daemon already knows. */
export function recentFolders(tasks: readonly TaskSummary[]): { name: string; path: string }[] {
  const seen = new Map<string, { name: string; path: string; at: number }>();
  for (const task of tasks) {
    if (!task.repoPath || !task.repo) continue;
    const known = seen.get(task.repoPath);
    if (!known || known.at < task.updatedAt) {
      seen.set(task.repoPath, { name: task.repo, path: task.repoPath, at: task.updatedAt });
    }
  }
  return [...seen.values()].sort((a, b) => b.at - a.at).slice(0, 5);
}

function TaskComposer(props: {
  tasks: readonly TaskSummary[];
  inputRef: RefObject<HTMLTextAreaElement | null>;
  text: string;
  onText(text: string): void;
  /** Options set by a starter, applied once. */
  preset?: Preset | undefined;
  onPresetUsed(): void;
  onCreated(id: string): void;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 30_000 });
  const recent = useMemo(() => recentFolders(props.tasks), [props.tasks]);
  const lastOutput = savedOutputDir();
  const [folder, setFolder] = useState("");
  const [output, setOutput] = useState("");
  const [role, setRole] = useState<Role>("main");
  const [networkChoice, setNetwork] = useState<boolean>();
  const network = networkChoice ?? settings.data?.tasks.network ?? false;
  const skillList = useQuery({ queryKey: ["skills"], queryFn: api.skills, staleTime: 30_000 });
  const [skills, setSkills] = useState<string[]>([]);
  // The MCP servers on; the task gets all of them unless the person narrows the choice.
  const servers = Object.entries(settings.data?.mcpServers ?? {})
    .filter(([, server]) => server.enabled)
    .map(([name]) => name);
  const [serverChoice, setServerChoice] = useState<string[]>();
  const chosenServers = serverChoice ?? servers;
  // The slash menu: where its `/` is in the text, and the highlighted item.
  const [slash, setSlash] = useState<{ start: number; query: string }>();
  const [active, setActive] = useState(0);
  const [tip, setTip] = useState<MessageKey>();
  const attach = useAttachments();
  const drop = useDropZone(attach.add);
  const { preset, onPresetUsed } = props;
  const installed = skillList.data?.skills;
  useEffect(() => {
    if (!preset) return;
    // A starter replaces what the previous one set: no network choice means the default.
    setNetwork(preset.network);
    const skill = preset.skill;
    setSkills(
      skill && installed?.some((s) => s.name === skill && s.enabled && !s.error) ? [skill] : [],
    );
    setTip(preset.tip);
    onPresetUsed();
  }, [preset, installed, onPresetUsed]);
  // The tip is about choosing a folder; it goes once one is chosen or the text is cleared.
  useEffect(() => {
    if (folder || !props.text.trim()) setTip(undefined);
  }, [folder, props.text]);

  const create = useMutation({
    mutationFn: () =>
      api.create({
        instruction: props.text.trim(),
        modelRole: role,
        network,
        ...(folder && { repo: folder }),
        ...(output && { outputDir: output }),
        ...(skills.length > 0 && { skills }),
        ...(serverChoice && { mcpServers: serverChoice.filter((n) => servers.includes(n)) }),
        ...(attach.ids.length > 0 && { attachments: attach.ids }),
      }),
    onSuccess: (task) => {
      if (output) saveOutputDir(output);
      props.onText("");
      attach.clear();
      setSkills([]);
      setTip(undefined);
      client.invalidateQueries({ queryKey: ["tasks"] });
      props.onCreated(task.id);
    },
  });
  const ready = props.text.trim().length > 0 && !attach.busy && !create.isPending;
  const submit = () => {
    if (ready) create.mutate();
  };
  const enter = useEnterToSend<HTMLTextAreaElement>(submit);
  const pick = (prompt: string, then: (path: string) => void) =>
    api.pickFolder(prompt).then(
      (path) => {
        if (path) then(path);
      },
      () => {},
    );

  const allCommands: Command[] = [
    ...(skillList.data?.skills ?? [])
      .filter((skill) => skill.enabled && !skill.error && !skills.includes(skill.name))
      .map((skill) => ({
        key: `skill:${skill.name}`,
        group: t("slash.skills"),
        icon: <Sparkle size={15} />,
        label: `/${skill.name}`,
        detail: skill.description,
        run: () => setSkills((chosen) => [...chosen, skill.name]),
      })),
    {
      key: "attach",
      group: t("slash.task"),
      icon: <Paperclip size={15} />,
      label: t("slash.attach"),
      keywords: "file image pdf upload attach 文件 图片 上传 附件",
      run: attach.pick,
    },
    {
      key: "folder",
      group: t("slash.task"),
      icon: <Folder size={15} />,
      label: t("slash.folder"),
      hint: folder ? folder.split("/").at(-1) : undefined,
      keywords: "folder repo 文件夹 仓库",
      run: () => pick(t("new.choosePrompt"), setFolder),
    },
    {
      key: "output",
      group: t("slash.task"),
      icon: <Package size={15} />,
      label: t("slash.output"),
      hint: output ? output.split("/").at(-1) : undefined,
      keywords: "output save 保存 产物",
      run: () => pick(t("new.outputPrompt"), setOutput),
    },
    ...ROLES.map((value) => ({
      key: `model:${value}`,
      group: t("slash.task"),
      icon: <Cpu size={15} />,
      label: t("slash.model", { role: t(`new.model.${value}`) }),
      detail: settings.data?.models[value]?.model,
      hint: role === value ? "✓" : undefined,
      keywords: `model ${value} 模型`,
      run: () => setRole(value),
    })),
    {
      key: "network",
      group: t("slash.task"),
      icon: <Globe size={15} />,
      label: network ? t("slash.networkOff") : t("slash.networkOn"),
      keywords: "network web internet 联网 网络",
      run: () => setNetwork(!network),
    },
  ];
  const commands = allCommands.filter((command) =>
    matchesQuery(slash?.query ?? "", command.label, command.detail, command.keywords),
  );

  const closeSlash = () => {
    setSlash(undefined);
    setActive(0);
  };
  /** Runs a command and removes the `/query` that called it. */
  const choose = (command: Command) => {
    const box = props.inputRef.current;
    if (slash) {
      const caret = box?.selectionStart ?? props.text.length;
      props.onText(props.text.slice(0, slash.start) + props.text.slice(caret));
      requestAnimationFrame(() => box?.setSelectionRange(slash.start, slash.start));
    }
    closeSlash();
    command.run();
    box?.focus();
  };
  const track = (text: string, caret: number) => {
    const found = slashQuery(text, caret);
    if (found?.query !== slash?.query) setActive(0);
    setSlash(found);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slash && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      const count = commands.length;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : count - 1;
        if (count > 0) setActive((i) => (i + step) % count);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
        const command = commands[Math.min(active, count - 1)];
        if (command) {
          event.preventDefault();
          choose(command);
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeSlash();
        return;
      }
    }
    enter.onKeyDown(event);
  };

  return (
    <form
      className={`home-composer ${drop.over ? "dropping" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      {...drop.props}
    >
      {drop.over && <DropHint />}
      {attach.picker}
      {slash && (
        <CommandMenu
          commands={commands}
          active={Math.min(active, Math.max(commands.length - 1, 0))}
          empty={t("slash.none")}
          onHover={setActive}
          onChoose={choose}
        />
      )}
      <textarea
        ref={props.inputRef}
        rows={3}
        value={props.text}
        onChange={(e) => {
          props.onText(e.target.value);
          track(e.target.value, e.target.selectionStart);
        }}
        onSelect={(e) => {
          const box = e.currentTarget;
          if (slash) track(box.value, box.selectionStart);
        }}
        onBlur={closeSlash}
        onCompositionStart={enter.onCompositionStart}
        onCompositionEnd={enter.onCompositionEnd}
        onKeyDown={onKeyDown}
        onPaste={attach.onPaste}
        placeholder={t("home.placeholder")}
        // biome-ignore lint/a11y/noAutofocus: the start page exists to take this text
        autoFocus
      />
      <PendingFiles files={attach.files} onRemove={attach.remove} />
      {tip && (
        <p className="composer-tip">
          <Folder size={13} />
          {t(tip)}
        </p>
      )}
      {skills.length > 0 && (
        <div className="composer-chips">
          {skills.map((name) => (
            <span key={name} className="skill-chip">
              <Sparkle size={13} />
              {name}
              <button
                type="button"
                title={t("home.clear")}
                onClick={() => setSkills((chosen) => chosen.filter((n) => n !== name))}
              >
                <Close size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="composer-bar">
        <button
          type="button"
          className="bar-button plus"
          title={t("slash.open")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const box = props.inputRef.current;
            const caret = box?.selectionStart ?? props.text.length;
            setActive(0);
            setSlash(slash ? undefined : { start: caret, query: "" });
            box?.focus();
          }}
        >
          <Plus size={15} />
        </button>
        <AttachButton onClick={attach.pick} />
        <FolderMenu
          icon={<Folder size={14} />}
          label={t("new.repo")}
          value={folder}
          options={recent}
          hint={t("new.repoHint")}
          prompt={t("new.choosePrompt")}
          placeholder={t("new.repoPlaceholder")}
          onChange={setFolder}
        />
        <FolderMenu
          icon={<Package size={14} />}
          label={t("new.output")}
          value={output}
          options={
            lastOutput
              ? [{ name: lastOutput.split("/").at(-1) ?? lastOutput, path: lastOutput }]
              : []
          }
          hint={t("new.outputHint")}
          prompt={t("new.outputPrompt")}
          placeholder={t("new.outputPlaceholder")}
          onChange={setOutput}
        />
        <Menu
          trigger={
            <>
              <Cpu size={14} />
              {t(`new.model.${role}`)}
            </>
          }
          active={role !== "main"}
        >
          {(close) =>
            ROLES.map((value) => (
              <button
                key={value}
                type="button"
                className={`menu-item ${role === value ? "on" : ""}`}
                onClick={() => {
                  setRole(value);
                  close();
                }}
              >
                <span className="menu-item-main">
                  {t(`new.model.${value}`)}
                  <span className="menu-item-sub">{settings.data?.models[value]?.model}</span>
                </span>
                {role === value && <Check size={14} />}
              </button>
            ))
          }
        </Menu>
        {servers.length > 0 && (
          <Menu
            trigger={
              <>
                <Plug size={14} />
                {serverChoice ? t("home.mcpSome", { n: chosenServers.length }) : t("home.mcpAll")}
              </>
            }
            active={chosenServers.length > 0}
            title={t("home.mcpHint")}
          >
            {() => (
              <>
                <p className="menu-hint">{t("home.mcpHint")}</p>
                {servers.map((name) => {
                  const on = chosenServers.includes(name);
                  return (
                    <button
                      key={name}
                      type="button"
                      className={`menu-item ${on ? "on" : ""}`}
                      onClick={() =>
                        setServerChoice(
                          on ? chosenServers.filter((n) => n !== name) : [...chosenServers, name],
                        )
                      }
                    >
                      <span className="menu-item-main">{name}</span>
                      {on && <Check size={14} />}
                    </button>
                  );
                })}
              </>
            )}
          </Menu>
        )}
        <button
          type="button"
          className={`bar-button ${network ? "on" : ""}`}
          aria-pressed={network}
          title={t("new.networkHint")}
          onClick={() => setNetwork(!network)}
        >
          <Globe size={14} />
          {network ? t("home.networkOn") : t("home.networkOff")}
        </button>
        <button type="submit" className="send" disabled={!ready} title={t("composer.send")}>
          <ArrowUp size={16} />
        </button>
      </div>
      {create.error && <p className="form-error">{create.error.message}</p>}
    </form>
  );
}

/** A folder chosen only when wanted: recent ones, the system's picker, or a typed path. */
export function FolderMenu(props: {
  icon: ReactNode;
  label: string;
  value: string;
  options: { name: string; path: string }[];
  hint: string;
  prompt: string;
  placeholder: string;
  placement?: "above" | "below";
  onChange(path: string): void;
}) {
  const { t } = useI18n();
  const [typing, setTyping] = useState(false);
  const pick = useMutation({
    mutationFn: () => api.pickFolder(props.prompt),
    onSuccess: (path) => {
      if (path) props.onChange(path);
    },
  });
  const name = props.value.split("/").filter(Boolean).at(-1) ?? props.value;

  return (
    <Menu
      trigger={
        <>
          {props.icon}
          {props.value ? name : props.label}
        </>
      }
      active={Boolean(props.value)}
      title={props.value || props.hint}
      {...(props.placement && { placement: props.placement })}
      onClear={props.value ? () => props.onChange("") : undefined}
    >
      {(close) => (
        <>
          <p className="menu-hint">{props.hint}</p>
          {props.options.map((option) => (
            <button
              key={option.path}
              type="button"
              className={`menu-item ${props.value === option.path ? "on" : ""}`}
              title={option.path}
              onClick={() => {
                props.onChange(option.path);
                close();
              }}
            >
              <span className="menu-item-main">
                {option.name}
                <span className="menu-item-sub">{option.path}</span>
              </span>
              {props.value === option.path && <Check size={14} />}
            </button>
          ))}
          <button
            type="button"
            className="menu-item"
            disabled={pick.isPending}
            onClick={() => {
              close();
              pick.mutate();
            }}
          >
            <span className="menu-item-main">{t("home.pickFolder")}</span>
          </button>
          {typing ? (
            <PathInput
              placeholder={props.placeholder}
              onApply={(path) => {
                if (path) props.onChange(path);
                setTyping(false);
                close();
              }}
            />
          ) : (
            <button type="button" className="menu-item" onClick={() => setTyping(true)}>
              <span className="menu-item-main">{t("home.typePath")}</span>
            </button>
          )}
          {pick.error && <p className="form-error">{pick.error.message}</p>}
        </>
      )}
    </Menu>
  );
}

/** A typed folder path, applied with Enter (an input method's Enter stays with the input method). */
function PathInput(props: { placeholder: string; onApply(path: string): void }) {
  const [value, setValue] = useState("");
  const enter = useEnterToSend<HTMLInputElement>(() => props.onApply(value.trim()));
  return (
    <input
      className="input mono menu-input"
      value={value}
      placeholder={props.placeholder}
      spellCheck={false}
      // biome-ignore lint/a11y/noAutofocus: shown because the person asked to type a path
      autoFocus
      onChange={(e) => setValue(e.target.value)}
      {...enter}
    />
  );
}

const OUTPUT_KEY = "warren.outputDir";

/** The folder results were last saved to, offered (not chosen) for the next task. */
export function savedOutputDir(): string | undefined {
  try {
    return localStorage.getItem(OUTPUT_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function saveOutputDir(dir: string): void {
  try {
    localStorage.setItem(OUTPUT_KEY, dir);
  } catch {
    // Without storage the folder is simply not offered next time.
  }
}
