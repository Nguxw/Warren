import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import {
  api,
  type ModelSettings,
  type Provider,
  type ReasoningEffort,
  type SecretInfo,
  type Settings,
  type SettingsPatch,
} from "../api.ts";
import { type Theme, useI18n } from "../context.tsx";
import { isMessageKey, type Lang, type Translate } from "../i18n.ts";
import { Check, Cpu, Gear, Key, Shield } from "../icons.tsx";

const ROLE_ORDER = ["main", "cheap", "hard"];
const PROVIDERS: Provider[] = ["openai-responses", "anthropic", "openai-compatible"];
const EFFORTS: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh"];

/** Interface preferences, models, keys and task defaults, edited in place. */
export function SettingsView() {
  const { t } = useI18n();
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [saved, setSaved] = useState(0);
  const apply = (next: Settings) => {
    client.setQueryData(["settings"], next);
    client.invalidateQueries({ queryKey: ["health"] });
    setSaved(Date.now());
  };
  const update = useMutation({ mutationFn: api.updateSettings, onSuccess: apply });
  const patch = (value: SettingsPatch) => update.mutate(value);

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(0), 1800);
    return () => clearTimeout(timer);
  }, [saved]);

  if (settings.error) return <p className="empty-note">{settings.error.message}</p>;
  if (!settings.data) return <p className="empty-note">{t("app.loading")}</p>;
  const data = settings.data;
  const roles = Object.keys(data.models).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

  return (
    <article className="task-view settings-view">
      <header className="task-head settings-head">
        <div className="task-title">
          <h1>{t("settings.title")}</h1>
          <span className={`saved-mark ${saved ? "on" : ""}`} aria-live="polite">
            <Check size={14} />
            {t("settings.saved")}
          </span>
        </div>
      </header>
      {update.error && (
        <p className="notice error">{t("settings.error", { error: update.error.message })}</p>
      )}

      <Section icon={<Gear size={16} />} title={t("settings.general")}>
        <General />
        <Row label={t("settings.notifications")} hint={t("settings.notificationsHint")}>
          <Switch
            checked={data.notifications}
            onChange={(notifications) => patch({ notifications })}
          />
        </Row>
      </Section>

      <Section
        icon={<Cpu size={16} />}
        title={t("settings.models")}
        intro={t("settings.modelsIntro")}
      >
        {roles.map((role) => (
          <ModelCard
            key={role}
            role={role}
            model={data.models[role] as ModelSettings}
            secrets={data.secrets}
            onSave={(model) => update.mutateAsync({ models: { [role]: model } })}
          />
        ))}
      </Section>

      <Section
        icon={<Key size={16} />}
        title={t("settings.keys")}
        intro={t("settings.keysIntro", { file: data.paths.credentials })}
      >
        <div className="setting-group">
          {data.secrets.map((secret) => (
            <SecretRow key={secret.name} secret={secret} onChange={apply} />
          ))}
          <AddSecret onChange={apply} />
        </div>
      </Section>

      <Section icon={<Shield size={16} />} title={t("settings.tasks")}>
        <Row label={t("settings.network")} hint={t("settings.networkHint")}>
          <Switch
            checked={data.tasks.network}
            onChange={(network) => patch({ tasks: { network } })}
          />
        </Row>
        <Row label={t("settings.concurrency")} hint={t("settings.concurrencyHint")}>
          <Stepper
            value={data.concurrency}
            min={1}
            max={32}
            onChange={(concurrency) => patch({ concurrency })}
          />
        </Row>
        <p className="setting-subhead">{t("settings.approvals")}</p>
        {Object.entries(data.approvals).map(([tool, rule]) => (
          <Row
            key={tool}
            label={messageOr(t, `settings.approval.${tool}`, tool)}
            hint={<code className="tool-id">{tool}</code>}
          >
            <Segmented
              value={rule}
              options={[
                { value: "required", label: t("settings.approvalRequired") },
                { value: "auto", label: t("settings.approvalAuto") },
              ]}
              onChange={(value) => patch({ approvals: { [tool]: value } })}
            />
          </Row>
        ))}
      </Section>

      <Section title={t("settings.about")}>
        <UpdateRows settings={data} onCheckChange={(updateCheck) => patch({ updateCheck })} />
        <Row label={t("settings.home")}>
          <code className="setting-path">{data.paths.home}</code>
        </Row>
        <Row label={t("settings.configFile")}>
          <code className="setting-path">{data.paths.config}</code>
        </Row>
        <Row label={t("settings.sandbox")}>
          <span className={`sandbox ${data.sandbox === "none" ? "off" : ""}`}>
            <Shield size={14} />
            {data.sandbox === "none" ? t("app.noSandbox") : `${t("app.sandbox")} · ${data.sandbox}`}
          </span>
        </Row>
        <p className="setting-note">{t("settings.restartNote")}</p>
      </Section>
    </article>
  );
}

/**
 * The version and updates: whether to check daily, the last check, and installing the latest
 * signed release. After an install under launchd the daemon restarts, and the page reloads once
 * it answers again.
 */
function UpdateRows(props: { settings: Settings; onCheckChange(on: boolean): void }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const status = useQuery({ queryKey: ["update"], queryFn: api.update });
  const [restarting, setRestarting] = useState(false);
  /** A version installed by a daemon that is not under launchd, so it runs after a restart. */
  const [installed, setInstalled] = useState<string>();
  const check = useMutation({
    mutationFn: api.checkUpdate,
    onSuccess: (next) => client.setQueryData(["update"], next),
  });
  const install = useMutation({
    mutationFn: api.installUpdate,
    onSuccess: ({ version, restarting: now }) => {
      if (!now) return setInstalled(version);
      setRestarting(true);
      const wait = setInterval(() => {
        api.health().then(
          () => {
            clearInterval(wait);
            window.location.reload();
          },
          () => {},
        );
      }, 2000);
    },
  });
  const update = status.data;
  const error = (check.error ?? install.error)?.message ?? update?.error;

  return (
    <>
      <Row
        label={t("update.version")}
        hint={
          update?.available ? t("update.available", { version: update.latest ?? "" }) : undefined
        }
      >
        <code className="setting-path">{props.settings.version}</code>
      </Row>
      <Row label={t("update.check")} hint={t("update.checkHint")}>
        <Switch checked={props.settings.updateCheck} onChange={props.onCheckChange} />
      </Row>
      <Row
        label={t("update.title")}
        hint={
          restarting
            ? t("update.restarting")
            : installed
              ? t("update.installed", { version: installed })
              : error
                ? error
                : update?.available
                  ? update.canInstall
                    ? t("update.ready", { version: update.latest ?? "" })
                    : t("update.fromSource")
                  : update?.unpublished
                    ? t("update.unpublished")
                    : update?.checkedAt
                      ? t("update.latest")
                      : t("update.never")
        }
      >
        <button
          type="button"
          className="button small"
          disabled={check.isPending || restarting}
          onClick={() => check.mutate()}
        >
          {check.isPending ? t("update.checking") : t("update.checkNow")}
        </button>
        {update?.available && update.canInstall && !installed && (
          <button
            type="button"
            className="button primary small"
            disabled={install.isPending || restarting}
            onClick={() => install.mutate()}
          >
            {install.isPending
              ? t("update.installing")
              : t("update.install", { version: update.latest ?? "" })}
          </button>
        )}
      </Row>
    </>
  );
}

/** The message for a key built at run time, or a fallback for names it does not know. */
function messageOr(t: Translate, key: string, fallback: string): string {
  return isMessageKey(key) ? t(key) : fallback;
}

function rank(role: string): number {
  const i = ROLE_ORDER.indexOf(role);
  return i === -1 ? ROLE_ORDER.length : i;
}

function General() {
  const { t, lang, setLang, theme, setTheme } = useI18n();
  return (
    <>
      <Row label={t("settings.language")} hint={t("settings.languageHint")}>
        <Segmented<Lang>
          value={lang}
          options={[
            { value: "zh", label: "中文" },
            { value: "en", label: "English" },
          ]}
          onChange={setLang}
        />
      </Row>
      <Row label={t("settings.theme")}>
        <Segmented<Theme>
          value={theme}
          options={(["system", "light", "dark"] as const).map((value) => ({
            value,
            label: t(`settings.theme.${value}`),
          }))}
          onChange={setTheme}
        />
      </Row>
    </>
  );
}

/** The secret a model would use, the same rule as the daemon's `secretOf`. */
function secretName(model: ModelSettings): string | undefined {
  if (model.apiKeySecret) return model.apiKeySecret;
  if (model.provider === "openai-responses") return "WARREN_OPENAI_API_KEY";
  if (model.provider === "anthropic") return "WARREN_ANTHROPIC_API_KEY";
  return undefined;
}

function ModelCard(props: {
  role: string;
  model: ModelSettings;
  secrets: SecretInfo[];
  onSave(model: ModelSettings): Promise<unknown>;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(props.model);
  useEffect(() => setDraft(props.model), [props.model]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(props.model);
  const set = (change: Partial<ModelSettings>) => setDraft((d) => clean({ ...d, ...change }));
  const secret = secretName(draft);
  const secretSet = props.secrets.find((s) => s.name === secret)?.set;
  const roleLabel = messageOr(t, `new.model.${props.role}`, props.role);
  const valid =
    draft.model.trim() !== "" && (draft.provider !== "openai-compatible" || draft.baseUrl);

  return (
    <div className="model-card">
      <header>
        <span className="model-role">{roleLabel}</span>
        <code className="model-role-id">{props.role}</code>
        <span className={`key-state ${secret && !secretSet ? "missing" : ""}`}>
          {secret ? (
            <>
              <Key size={13} />
              {secret}
              {!secretSet && ` · ${t("settings.keyMissing")}`}
            </>
          ) : (
            t("settings.usesNoKey")
          )}
        </span>
      </header>
      <div className="model-fields">
        <label className="field">
          <span className="field-label">{t("settings.provider")}</span>
          <select
            className="input"
            value={draft.provider}
            onChange={(e) => set({ provider: e.target.value as Provider })}
          >
            {PROVIDERS.map((provider) => (
              <option key={provider} value={provider}>
                {t(`settings.provider.${provider}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">{t("settings.model")}</span>
          <input
            className="input mono"
            value={draft.model}
            spellCheck={false}
            onChange={(e) => set({ model: e.target.value })}
          />
        </label>
        <label className="field">
          <span className="field-label">{t("settings.effort")}</span>
          <select
            className="input"
            value={draft.reasoningEffort ?? ""}
            onChange={(e) =>
              set({ reasoningEffort: (e.target.value || undefined) as ReasoningEffort | undefined })
            }
          >
            <option value="">{t("settings.effortDefault")}</option>
            {EFFORTS.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </label>
        {(draft.provider === "openai-compatible" || draft.baseUrl) && (
          <label className="field wide">
            <span className="field-label">{t("settings.baseUrl")}</span>
            <input
              className="input mono"
              value={draft.baseUrl ?? ""}
              placeholder="http://localhost:11434/v1"
              spellCheck={false}
              onChange={(e) => set({ baseUrl: e.target.value || undefined })}
            />
          </label>
        )}
        {draft.provider === "openai-compatible" && (
          <label className="field">
            <span className="field-label">{t("settings.keyName")}</span>
            <input
              className="input mono"
              value={draft.apiKeySecret ?? ""}
              placeholder="WARREN_DEEPSEEK_API_KEY"
              spellCheck={false}
              onChange={(e) => set({ apiKeySecret: e.target.value || undefined })}
            />
          </label>
        )}
        <div className="field">
          <span className="field-label">{t("settings.price")}</span>
          <div className="price-inputs">
            <PriceInput
              label={t("settings.priceIn")}
              value={draft.price?.input}
              onChange={(input) => set({ price: priceWith(draft.price, { input }) })}
            />
            <PriceInput
              label={t("settings.priceOut")}
              value={draft.price?.output}
              onChange={(output) => set({ price: priceWith(draft.price, { output }) })}
            />
          </div>
        </div>
      </div>
      {dirty && (
        <footer className="model-actions">
          <button
            type="button"
            className="button ghost small"
            onClick={() => setDraft(props.model)}
          >
            {t("settings.revert")}
          </button>
          <button
            type="button"
            className="button primary small"
            disabled={!valid}
            onClick={() => props.onSave(draft).catch(() => {})}
          >
            {t("settings.save")}
          </button>
        </footer>
      )}
    </div>
  );
}

/** Drops empty optional fields so an untouched draft compares equal to the saved model. */
function clean(model: ModelSettings): ModelSettings {
  const result = { ...model };
  for (const key of Object.keys(result) as (keyof ModelSettings)[]) {
    if (result[key] === undefined) delete result[key];
  }
  return result;
}

function priceWith(
  price: ModelSettings["price"],
  change: { input?: number | undefined; output?: number | undefined },
): ModelSettings["price"] {
  const input = "input" in change ? change.input : price?.input;
  const output = "output" in change ? change.output : price?.output;
  if (input === undefined && output === undefined) return undefined;
  return { ...price, input: input ?? 0, output: output ?? 0 };
}

function PriceInput(props: {
  label: string;
  value: number | undefined;
  onChange(value: number | undefined): void;
}) {
  return (
    <label className="price-input">
      <span>{props.label}</span>
      <input
        className="input mono"
        type="number"
        min={0}
        step="any"
        value={props.value ?? ""}
        onChange={(e) => props.onChange(e.target.value === "" ? undefined : Number(e.target.value))}
      />
    </label>
  );
}

function SecretRow(props: { secret: SecretInfo; onChange(settings: Settings): void }) {
  const { t } = useI18n();
  const { secret } = props;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [confirming, setConfirming] = useState(false);
  const save = useMutation({
    mutationFn: () => api.setSecret(secret.name, value.trim()),
    onSuccess: (next) => {
      setEditing(false);
      setValue("");
      props.onChange(next);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteSecret(secret.name),
    onSuccess: (next) => {
      setConfirming(false);
      props.onChange(next);
    },
  });
  const hint = `settings.keyHint.${secret.name}`;

  return (
    <div className="secret-row">
      <div className="secret-main">
        <code className="secret-name">{secret.name}</code>
        <span className="secret-hint">
          {messageOr(t, hint, "")}
          {secret.usedBy.length > 0 && (
            <span className="secret-used">
              {t("settings.keyUsedBy", { roles: secret.usedBy.join(", ") })}
            </span>
          )}
        </span>
      </div>
      {editing ? (
        <form
          className="secret-edit"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) save.mutate();
          }}
        >
          <input
            className="input mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("settings.keyPlaceholder")}
            value={value}
            // biome-ignore lint/a11y/noAutofocus: the field appears because the person asked for it
            autoFocus
            onChange={(e) => setValue(e.target.value)}
          />
          <button type="button" className="button ghost small" onClick={() => setEditing(false)}>
            {t("settings.keyCancel")}
          </button>
          <button
            type="submit"
            className="button primary small"
            disabled={!value.trim() || save.isPending}
          >
            {t("settings.save")}
          </button>
        </form>
      ) : (
        <div className="secret-state">
          {secret.set ? (
            <span className="badge success">
              <Check size={12} />
              {secret.masked ?? t("settings.keySet")}
            </span>
          ) : (
            <span className="badge">{t("settings.keyUnset")}</span>
          )}
          {secret.fromEnv ? (
            <span className="secret-env">{t("settings.keyEnv")}</span>
          ) : (
            <>
              <button type="button" className="button small" onClick={() => setEditing(true)}>
                {secret.set ? t("settings.keyReplace") : t("settings.keySetAction")}
              </button>
              {secret.set && (
                <button
                  type="button"
                  className="button ghost small danger"
                  onClick={() => (confirming ? remove.mutate() : setConfirming(true))}
                  onBlur={() => setConfirming(false)}
                >
                  {confirming ? t("settings.keyRemoveConfirm") : t("settings.keyRemove")}
                </button>
              )}
            </>
          )}
        </div>
      )}
      {(save.error || remove.error) && (
        <p className="form-error">{(save.error ?? remove.error)?.message}</p>
      )}
    </div>
  );
}

function AddSecret(props: { onChange(settings: Settings): void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const save = useMutation({
    mutationFn: () => api.setSecret(name.trim(), value.trim()),
    onSuccess: (next) => {
      setOpen(false);
      setName("");
      setValue("");
      props.onChange(next);
    },
  });
  if (!open) {
    return (
      <button type="button" className="button ghost small add-secret" onClick={() => setOpen(true)}>
        + {t("settings.keyCustom")}
      </button>
    );
  }
  return (
    <form
      className="secret-row secret-add"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() && value.trim()) save.mutate();
      }}
    >
      <input
        className="input mono"
        placeholder={t("settings.keyNamePlaceholder")}
        value={name}
        spellCheck={false}
        onChange={(e) => setName(e.target.value.toUpperCase())}
      />
      <input
        className="input mono"
        type="password"
        autoComplete="off"
        placeholder={t("settings.keyPlaceholder")}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button type="button" className="button ghost small" onClick={() => setOpen(false)}>
        {t("settings.keyCancel")}
      </button>
      <button
        type="submit"
        className="button primary small"
        disabled={!name.trim() || !value.trim() || save.isPending}
      >
        {t("settings.save")}
      </button>
      {save.error && <p className="form-error">{save.error.message}</p>}
    </form>
  );
}

function Section(props: { icon?: ReactNode; title: string; intro?: string; children: ReactNode }) {
  return (
    <section className="setting-section">
      <h2>
        {props.icon}
        {props.title}
      </h2>
      {props.intro && <p className="setting-intro">{props.intro}</p>}
      <div className="setting-card">{props.children}</div>
    </section>
  );
}

function Row(props: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-text">
        <span className="setting-label">{props.label}</span>
        {props.hint && <span className="setting-hint">{props.hint}</span>}
      </div>
      <div className="setting-control">{props.children}</div>
    </div>
  );
}

function Switch(props: { checked: boolean; onChange(checked: boolean): void }) {
  return (
    <label className="toggle">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span className="switch" aria-hidden="true" />
    </label>
  );
}

function Segmented<T extends string>(props: {
  value: T;
  options: { value: T; label: string }[];
  onChange(value: T): void;
}) {
  return (
    <div className="segmented">
      {props.options.map((option) => (
        <label key={option.value} className={props.value === option.value ? "on" : ""}>
          <input
            type="radio"
            checked={props.value === option.value}
            onChange={() => props.onChange(option.value)}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}

function Stepper(props: { value: number; min: number; max: number; onChange(n: number): void }) {
  return (
    <div className="stepper">
      <button
        type="button"
        disabled={props.value <= props.min}
        onClick={() => props.onChange(props.value - 1)}
      >
        −
      </button>
      <span>{props.value}</span>
      <button
        type="button"
        disabled={props.value >= props.max}
        onClick={() => props.onChange(props.value + 1)}
      >
        +
      </button>
    </div>
  );
}
