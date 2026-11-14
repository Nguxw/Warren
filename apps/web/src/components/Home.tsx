import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TaskSummary } from "@warren/protocol";
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.ts";
import { useI18n } from "../context.tsx";
import type { MessageKey } from "../i18n.ts";
import { ArrowUp, Check, Close, Cpu, Folder, Globe, Logo, Package } from "../icons.tsx";
import { useEnterToSend } from "../keys.ts";

const ROLES = ["main", "hard", "cheap"] as const;
type Role = (typeof ROLES)[number];
const SUGGESTIONS: MessageKey[] = [
  "home.example.research",
  "home.example.fix",
  "home.example.notes",
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
          onCreated={props.onCreated}
        />
        <div className="suggestions">
          {SUGGESTIONS.map((key) => (
            <button
              key={key}
              type="button"
              className="suggestion"
              onClick={() => {
                setText(t(key));
                props.inputRef.current?.focus();
              }}
            >
              {t(key)}
            </button>
          ))}
        </div>
        <p className="shortcuts">{t("home.shortcuts")}</p>
      </div>
    </div>
  );
}

/** Recent folders, newest first, from the tasks the daemon already knows. */
function recentFolders(tasks: readonly TaskSummary[]): { name: string; path: string }[] {
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

  const create = useMutation({
    mutationFn: () =>
      api.create({
        instruction: props.text.trim(),
        modelRole: role,
        network,
        ...(folder && { repo: folder }),
        ...(output && { outputDir: output }),
      }),
    onSuccess: (task) => {
      if (output) saveOutputDir(output);
      props.onText("");
      client.invalidateQueries({ queryKey: ["tasks"] });
      props.onCreated(task.id);
    },
  });
  const ready = props.text.trim().length > 0 && !create.isPending;
  const submit = () => {
    if (ready) create.mutate();
  };
  const enter = useEnterToSend<HTMLTextAreaElement>(submit);

  return (
    <form
      className="home-composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={props.inputRef}
        rows={3}
        value={props.text}
        onChange={(e) => props.onText(e.target.value)}
        {...enter}
        placeholder={t("home.placeholder")}
        // biome-ignore lint/a11y/noAutofocus: the start page exists to take this text
        autoFocus
      />
      <div className="composer-bar">
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
function FolderMenu(props: {
  icon: ReactNode;
  label: string;
  value: string;
  options: { name: string; path: string }[];
  hint: string;
  prompt: string;
  placeholder: string;
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

/** A small button with a menu above it; closes on a choice, a click outside or Escape. */
function Menu(props: {
  trigger: ReactNode;
  active: boolean;
  title?: string;
  onClear?: (() => void) | undefined;
  children(close: () => void): ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="menu-root" ref={root}>
      <span className={`bar-button ${props.active ? "on" : ""} ${open ? "open" : ""}`}>
        <button
          type="button"
          className="bar-trigger"
          title={props.title}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {props.trigger}
        </button>
        {props.onClear && (
          <button
            type="button"
            className="bar-clear"
            title={t("home.clear")}
            onClick={props.onClear}
          >
            <Close size={12} />
          </button>
        )}
      </span>
      {open && <div className="menu">{props.children(() => setOpen(false))}</div>}
    </div>
  );
}

const OUTPUT_KEY = "warren.outputDir";

/** The folder results were last saved to, offered (not chosen) for the next task. */
function savedOutputDir(): string | undefined {
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
