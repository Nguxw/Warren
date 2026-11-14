import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { api, type McpServer, type Settings } from "../api.ts";
import { useI18n } from "../context.tsx";
import { Check, Folder, Plus } from "../icons.tsx";
import { parseCommandLine, parseLines } from "../model.ts";

/**
 * Skills and MCP servers: what Warren can draw on beyond its built-in tools. Each has its own
 * page in the sidebar; changes apply to tasks started afterwards.
 */

/** A page around one of the two lists, with the settings both are saved in. */
function ExtensionPage(props: {
  title: string;
  intro: string;
  children(settings: Settings, onSaved: (next: Settings) => void): ReactNode;
}) {
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  return (
    <article className="task-view extension-view">
      <header className="task-head">
        <div className="task-title">
          <h1>{props.title}</h1>
        </div>
        <p className="triggers-intro">{props.intro}</p>
      </header>
      {settings.error && <p className="notice error">{settings.error.message}</p>}
      {settings.data && (
        <div className="setting-card">
          {props.children(settings.data, (next) => client.setQueryData(["settings"], next))}
        </div>
      )}
    </article>
  );
}

export function SkillsView() {
  const { t } = useI18n();
  return (
    <ExtensionPage title={t("skills.title")} intro={t("skills.intro")}>
      {(settings, onSaved) => <SkillsSettings settings={settings} onSaved={onSaved} />}
    </ExtensionPage>
  );
}

export function McpView() {
  const { t } = useI18n();
  return (
    <ExtensionPage title={t("mcp.title")} intro={t("mcp.intro")}>
      {(settings, onSaved) => <McpSettings settings={settings} onSaved={onSaved} />}
    </ExtensionPage>
  );
}

export function SkillsSettings(props: { settings: Settings; onSaved(next: Settings): void }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const skills = useQuery({ queryKey: ["skills"], queryFn: api.skills });
  const refresh = () => client.invalidateQueries({ queryKey: ["skills"] });
  const install = useMutation({
    mutationFn: async () => {
      const path = await api.pickFolder(t("skills.pickPrompt"));
      return path ? api.installSkill(path) : undefined;
    },
    onSuccess: refresh,
  });
  const reveal = useMutation({ mutationFn: api.revealSkills });
  const toggle = useMutation({
    mutationFn: (change: { name: string; on: boolean }) => {
      const off = new Set(props.settings.disabledSkills);
      if (change.on) off.delete(change.name);
      else off.add(change.name);
      return api.updateSettings({ disabledSkills: [...off] });
    },
    onSuccess: (next) => {
      props.onSaved(next);
      refresh();
    },
  });
  const list = skills.data?.skills ?? [];
  const error = (install.error ?? reveal.error ?? toggle.error)?.message;

  return (
    <div className="setting-group">
      {list.length === 0 && skills.data && <p className="setting-empty">{t("skills.empty")}</p>}
      {list.map((skill) => (
        <div key={skill.name} className="secret-row">
          <div className="secret-main">
            <code className="secret-name">{skill.name}</code>
            <span className={`ext-description ${skill.error ? "warn" : ""}`}>
              {skill.error ?? skill.description}
            </span>
          </div>
          <div className="secret-state">
            <label className="toggle" title={t("skills.toggle")}>
              <input
                type="checkbox"
                checked={skill.enabled}
                disabled={Boolean(skill.error) || toggle.isPending}
                onChange={(e) => toggle.mutate({ name: skill.name, on: e.target.checked })}
              />
              <span className="switch" aria-hidden="true" />
            </label>
            <RemoveButton
              onRemove={() => api.deleteSkill(skill.name).then(refresh)}
              label={t("settings.keyRemove")}
              confirm={t("settings.keyRemoveConfirm")}
            />
          </div>
        </div>
      ))}
      <div className="ext-actions">
        <button
          type="button"
          className="button ghost small"
          disabled={install.isPending}
          onClick={() => install.mutate()}
        >
          <Plus size={14} />
          {t("skills.add")}
        </button>
        <button type="button" className="button ghost small" onClick={() => reveal.mutate()}>
          <Folder size={14} />
          {t("skills.openFolder")}
        </button>
      </div>
      {error && <p className="form-error ext-error">{error}</p>}
    </div>
  );
}

export function McpSettings(props: { settings: Settings; onSaved(next: Settings): void }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const status = useQuery({ queryKey: ["mcp"], queryFn: api.mcp, refetchInterval: 15_000 });
  const [editing, setEditing] = useState<{ name?: string }>();
  const save = useMutation({
    mutationFn: (servers: Record<string, McpServer | null>) =>
      api.updateSettings({ mcpServers: servers }),
    onSuccess: (next) => {
      props.onSaved(next);
      client.invalidateQueries({ queryKey: ["mcp"] });
    },
  });
  const servers = Object.entries(props.settings.mcpServers);

  return (
    <div className="setting-group">
      {servers.length === 0 && !editing && <p className="setting-empty">{t("mcp.empty")}</p>}
      {servers.map(([name, server]) =>
        editing?.name === name ? (
          <McpEditor
            key={name}
            name={name}
            server={server}
            onCancel={() => setEditing(undefined)}
            onSave={(next) => save.mutateAsync({ [name]: next }).then(() => setEditing(undefined))}
          />
        ) : (
          <McpRow
            key={name}
            name={name}
            server={server}
            status={status.data?.find((s) => s.name === name)}
            onChange={(next) => save.mutate({ [name]: next })}
            onEdit={() => setEditing({ name })}
          />
        ),
      )}
      {editing && editing.name === undefined && (
        <McpEditor
          onCancel={() => setEditing(undefined)}
          onSave={(next, name) =>
            save.mutateAsync({ [name]: next }).then(() => setEditing(undefined))
          }
        />
      )}
      {!editing && (
        <div className="ext-actions">
          <button type="button" className="button ghost small" onClick={() => setEditing({})}>
            <Plus size={14} />
            {t("mcp.add")}
          </button>
        </div>
      )}
      {save.error && <p className="form-error ext-error">{save.error.message}</p>}
    </div>
  );
}

function McpRow(props: {
  name: string;
  server: McpServer;
  status: { state: string; tools?: number; error?: string } | undefined;
  onChange(server: McpServer | null): void;
  onEdit(): void;
}) {
  const { t } = useI18n();
  const { server } = props;
  const test = useMutation({ mutationFn: () => api.testMcp(props.name) });
  const target = server.url ?? [server.command, ...(server.args ?? [])].join(" ");
  const state = test.data
    ? { state: "connected", tools: test.data.length }
    : test.error
      ? { state: "error", error: test.error.message }
      : props.status;

  return (
    <div className="secret-row mcp-row">
      <div className="secret-main">
        <span className="mcp-title">
          <code className="secret-name">{props.name}</code>
          <span className="badge">{server.url ? t("mcp.remote") : t("mcp.local")}</span>
          {state?.state === "connected" && (
            <span className="badge success">
              <Check size={12} />
              {t("mcp.connected", { n: state.tools ?? 0 })}
            </span>
          )}
          {state?.state === "error" && <span className="badge warn">{t("mcp.failed")}</span>}
        </span>
        <code className="mcp-target" title={target}>
          {target}
        </code>
        {state?.state === "error" && state.error && (
          <span className="ext-description warn">{state.error}</span>
        )}
        {test.data && test.data.length > 0 && (
          <span className="ext-description">
            {test.data
              .map((tool) => (tool.readOnly ? `${tool.name} (${t("mcp.readOnly")})` : tool.name))
              .join(" · ")}
          </span>
        )}
      </div>
      <div className="secret-state mcp-controls">
        <div className="segmented small" title={t("mcp.approvalHint")}>
          {(["required", "auto"] as const).map((value) => (
            <label key={value} className={server.approval === value ? "on" : ""}>
              <input
                type="radio"
                checked={server.approval === value}
                onChange={() => props.onChange({ ...server, approval: value })}
              />
              {value === "required" ? t("settings.approvalRequired") : t("settings.approvalAuto")}
            </label>
          ))}
        </div>
        <label className="toggle" title={t("mcp.toggle")}>
          <input
            type="checkbox"
            checked={server.enabled}
            onChange={(e) => props.onChange({ ...server, enabled: e.target.checked })}
          />
          <span className="switch" aria-hidden="true" />
        </label>
        <button
          type="button"
          className="button small"
          disabled={test.isPending}
          onClick={() => test.mutate()}
        >
          {test.isPending ? t("mcp.testing") : t("mcp.test")}
        </button>
        <button type="button" className="button ghost small" onClick={props.onEdit}>
          {t("auto.edit")}
        </button>
        <RemoveButton
          onRemove={async () => props.onChange(null)}
          label={t("settings.keyRemove")}
          confirm={t("settings.keyRemoveConfirm")}
        />
      </div>
    </div>
  );
}

function McpEditor(props: {
  name?: string;
  server?: McpServer;
  onCancel(): void;
  onSave(server: McpServer, name: string): Promise<unknown>;
}) {
  const { t } = useI18n();
  const start = props.server;
  const [name, setName] = useState(props.name ?? "");
  const [remote, setRemote] = useState(Boolean(start?.url));
  const [command, setCommand] = useState(
    start?.command ? [start.command, ...(start.args ?? [])].map(quote).join(" ") : "",
  );
  const [url, setUrl] = useState(start?.url ?? "");
  const [vars, setVars] = useState(
    Object.entries((remote ? start?.headers : start?.env) ?? {})
      .map(([k, v]) => `${k}${remote ? ": " : "="}${v}`)
      .join("\n"),
  );
  const [error, setError] = useState<string>();

  const submit = () => {
    const words = parseCommandLine(command);
    const pairs = parseLines(vars, remote ? ":" : "=");
    if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(name)) return setError(t("mcp.badName"));
    if (remote ? !url.trim() : words.length === 0) return setError(t("mcp.needTarget"));
    const server: McpServer = {
      enabled: start?.enabled ?? true,
      approval: start?.approval ?? "required",
      ...(remote
        ? { url: url.trim(), ...(Object.keys(pairs).length > 0 && { headers: pairs }) }
        : {
            command: words[0] as string,
            args: words.slice(1),
            ...(Object.keys(pairs).length > 0 && { env: pairs }),
          }),
    };
    setError(undefined);
    props.onSave(server, name).catch((e: Error) => setError(e.message));
  };

  return (
    <div className="mcp-editor">
      <div className="mcp-editor-row">
        <label className="field">
          <span className="field-label">{t("mcp.name")}</span>
          <input
            className="input mono"
            value={name}
            placeholder="github"
            disabled={props.name !== undefined}
            spellCheck={false}
            onChange={(e) => setName(e.target.value.toLowerCase())}
          />
        </label>
        <div className="field">
          <span className="field-label">{t("mcp.kind")}</span>
          <div className="segmented small">
            {[false, true].map((value) => (
              <label key={String(value)} className={remote === value ? "on" : ""}>
                <input type="radio" checked={remote === value} onChange={() => setRemote(value)} />
                {value ? t("mcp.remote") : t("mcp.local")}
              </label>
            ))}
          </div>
        </div>
      </div>
      {remote ? (
        <label className="field">
          <span className="field-label">URL</span>
          <input
            className="input mono"
            value={url}
            placeholder="https://example.com/mcp"
            spellCheck={false}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
      ) : (
        <label className="field">
          <span className="field-label">{t("mcp.command")}</span>
          <input
            className="input mono"
            value={command}
            placeholder="npx -y @modelcontextprotocol/server-filesystem /Users/you/Documents"
            spellCheck={false}
            onChange={(e) => setCommand(e.target.value)}
          />
        </label>
      )}
      <label className="field">
        <span className="field-label">{remote ? t("mcp.headers") : t("mcp.env")}</span>
        <textarea
          className="input mono editor-text"
          rows={2}
          value={vars}
          placeholder={
            remote
              ? "Authorization: Bearer $WARREN_EXAMPLE_TOKEN"
              : "GITHUB_TOKEN=$WARREN_GITHUB_TOKEN"
          }
          spellCheck={false}
          onChange={(e) => setVars(e.target.value)}
        />
        <span className="field-hint">{t("mcp.secretHint")}</span>
      </label>
      {error && <p className="form-error">{error}</p>}
      <div className="model-actions">
        <button type="button" className="button ghost small" onClick={props.onCancel}>
          {t("settings.keyCancel")}
        </button>
        <button type="button" className="button primary small" onClick={submit}>
          {t("settings.save")}
        </button>
      </div>
    </div>
  );
}

function RemoveButton(props: { label: string; confirm: string; onRemove(): Promise<unknown> }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <button
      type="button"
      className="button ghost small danger"
      onClick={() => (confirming ? props.onRemove().catch(() => {}) : setConfirming(true))}
      onBlur={() => setConfirming(false)}
    >
      {confirming ? props.confirm : props.label}
    </button>
  );
}

function quote(word: string): string {
  return /[\s"']/.test(word) ? `"${word.replace(/"/g, '\\"')}"` : word;
}
