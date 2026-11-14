import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AutomationSpec, TaskEvent } from "@warren/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, subscribe, Unauthorized } from "./api.ts";
import { AutomationsView } from "./components/Automations.tsx";
import { DeleteTask } from "./components/DeleteTask.tsx";
import { Home } from "./components/Home.tsx";
import { SettingsView } from "./components/SettingsView.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { TaskView } from "./components/TaskView.tsx";
import { TriggersView } from "./components/TriggersView.tsx";
import { I18nProvider, useI18n } from "./context.tsx";
import { Logo } from "./icons.tsx";

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
  const [page, setPage] = useState<"tasks" | "triggers" | "settings" | "automations">("tasks");
  const [automationDraft, setAutomationDraft] = useState<Partial<AutomationSpec>>();
  const clearDraft = useCallback(() => setAutomationDraft(undefined), []);
  const [deleting, setDeleting] = useState<{ id: string; title: string; status: string }>();
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: api.tasks });
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, staleTime: 60_000 });
  useLiveUpdates(!tasks.isError);

  const select = useCallback((id: string | null) => {
    setSelected(id);
    setPage("tasks");
    history.replaceState(null, "", id ? `?task=${id}` : window.location.pathname);
  }, []);
  const open = useCallback((next: "triggers" | "settings" | "automations") => {
    setPage(next);
    setSelected(null);
    history.replaceState(null, "", window.location.pathname);
  }, []);
  // A new task starts on the start page, whose text box takes the focus.
  const startNew = useCallback(() => {
    select(null);
    requestAnimationFrame(() => composerRef.current?.focus());
  }, [select]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === "n") {
        event.preventDefault();
        startNew();
      } else if (event.key === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key === ",") {
        event.preventDefault();
        open("settings");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, startNew]);

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
        onNew={startNew}
        onDelete={setDeleting}
        page={page}
        onTriggers={() => open("triggers")}
        onSettings={() => open("settings")}
        onAutomations={() => open("automations")}
      />
      <main className="main">
        {page === "settings" ? (
          <SettingsView />
        ) : page === "automations" ? (
          <AutomationsView
            tasks={tasks.data ?? []}
            onOpenTask={(id) => select(id)}
            draft={automationDraft}
            onDraftUsed={clearDraft}
          />
        ) : page === "triggers" ? (
          <TriggersView onOpenTask={(id) => select(id)} />
        ) : selected ? (
          <TaskView
            key={selected}
            id={selected}
            onDelete={setDeleting}
            onSchedule={(draft) => {
              setAutomationDraft(draft);
              open("automations");
            }}
          />
        ) : (
          <Home tasks={tasks.data ?? []} inputRef={composerRef} onCreated={(id) => select(id)} />
        )}
      </main>
      {deleting && (
        <DeleteTask
          task={deleting}
          onClose={() => setDeleting(undefined)}
          onDeleted={(id) => {
            setDeleting(undefined);
            if (id === selected) select(null);
          }}
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
        client.invalidateQueries({ queryKey: ["files", id] });
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
