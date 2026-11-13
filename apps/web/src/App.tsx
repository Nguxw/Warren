import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TaskEvent } from "@warren/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, subscribe, Unauthorized } from "./api.ts";
import { NewTaskDialog } from "./components/NewTaskDialog.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { TaskView } from "./components/TaskView.tsx";
import { TriggersView } from "./components/TriggersView.tsx";
import { I18nProvider, useI18n } from "./context.tsx";
import { Logo, Plus } from "./icons.tsx";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof Unauthorized) && count < 2,
      refetchOnWindowFocus: true,
    },
  },
});

export function App() {
  return (
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <Shell />
      </QueryClientProvider>
    </I18nProvider>
  );
}

function Shell() {
  const [selected, setSelected] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get("task"),
  );
  const [creating, setCreating] = useState(false);
  const [showTriggers, setShowTriggers] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: api.tasks });
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, staleTime: 60_000 });
  useLiveUpdates(!tasks.isError);

  const select = useCallback((id: string | null) => {
    setSelected(id);
    setCreating(false);
    setShowTriggers(false);
    history.replaceState(null, "", id ? `?task=${id}` : window.location.pathname);
  }, []);
  const closeDialog = useCallback(() => setCreating(false), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === "n") {
        event.preventDefault();
        setCreating(true);
      } else if (event.key === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (tasks.error instanceof Unauthorized) return <SignIn />;

  return (
    <div className="app">
      <Sidebar
        tasks={tasks.data}
        loading={tasks.isLoading}
        unreachable={Boolean(tasks.error)}
        selected={selected}
        query={query}
        searchRef={searchRef}
        sandbox={health.data?.sandbox}
        onQuery={setQuery}
        onSelect={select}
        onNew={() => setCreating(true)}
        showingTriggers={showTriggers}
        onTriggers={() => {
          setShowTriggers(true);
          setSelected(null);
          history.replaceState(null, "", window.location.pathname);
        }}
      />
      <main className="main">
        {showTriggers ? (
          <TriggersView onOpenTask={(id) => select(id)} />
        ) : selected ? (
          <TaskView key={selected} id={selected} />
        ) : (
          <Empty onNew={() => setCreating(true)} hasTasks={(tasks.data?.length ?? 0) > 0} />
        )}
      </main>
      {creating && (
        <NewTaskDialog
          tasks={tasks.data ?? []}
          onClose={closeDialog}
          onCreated={(id) => select(id)}
        />
      )}
    </div>
  );
}

/** Keeps every query current from the daemon's event stream. */
function useLiveUpdates(enabled: boolean) {
  const client = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    let stop = () => {};
    let cancelled = false;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const touched = new Set<string>();
    const flush = () => {
      pending = undefined;
      client.invalidateQueries({ queryKey: ["tasks"] });
      client.invalidateQueries({ queryKey: ["triggers"] });
      for (const id of touched) {
        client.invalidateQueries({ queryKey: ["task", id] });
        client.invalidateQueries({ queryKey: ["diff", id] });
      }
      touched.clear();
    };
    api
      .cursor()
      .then((cursor) => {
        if (cancelled) return;
        stop = subscribe(cursor, (event) => {
          client.setQueryData<TaskEvent[]>(["events", event.taskId], (events) =>
            events && !events.some((e) => e.seq === event.seq) ? [...events, event] : events,
          );
          touched.add(event.taskId);
          pending ??= setTimeout(flush, 150);
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      stop();
      if (pending) clearTimeout(pending);
    };
  }, [enabled, client]);
}

function SignIn() {
  const { t } = useI18n();
  return (
    <div className="centered">
      <Logo size={40} />
      <h1>{t("signin.title")}</h1>
      <p className="muted">{t("signin.body")}</p>
      <pre className="command">warren open</pre>
    </div>
  );
}

function Empty({ onNew, hasTasks }: { onNew(): void; hasTasks: boolean }) {
  const { t } = useI18n();
  return (
    <div className="centered">
      <span className="hero-mark">
        <Logo size={56} />
      </span>
      <h1>{t("empty.title")}</h1>
      <p className="muted">{hasTasks ? t("empty.select") : t("empty.body")}</p>
      <button type="button" className="button primary large" onClick={onNew}>
        <Plus size={16} />
        {t("app.newTask")}
      </button>
      <p className="shortcuts">{t("empty.shortcuts")}</p>
    </div>
  );
}
