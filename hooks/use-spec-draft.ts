import { useCallback, useEffect, useRef, useState } from "react";

type Fields = { title: string; summary: string; content: string };
export type DraftSpec = Fields & { id: string; revision: number };
type SaveInput = Fields & { id: string; expectedRevision: number };
type Session = {
  id: string;
  key: string;
  revision: number;
  baseline: Fields;
  values: Fields;
  editing: boolean;
  error: string | null;
  conflict: boolean;
  storageError: boolean;
  editorVersion: number;
  recoveredPending: boolean;
  state: "idle" | "saving" | "saved" | "error";
  pending: Promise<boolean> | null;
  remote: DraftSpec | null;
  listeners: Set<() => void>;
};

// Keep the draft in memory as well, so closing a surface is safe even when
// browser storage is unavailable. sessionStorage also survives a page reload.
const drafts = new Map<string, Session>();
const conflictMessage = "This spec changed elsewhere. Your draft is preserved. Copy it before discarding it to load the latest version.";
const fields = ({ title, summary, content }: Fields): Fields => ({ title, summary, content });
const same = (a: Fields, b: Fields) => a.title === b.title && a.summary === b.summary && a.content === b.content;
const isDirty = (session: Session) => session.recoveredPending || !same(session.values, session.baseline);

function persist(session: Session) {
  try {
    if (isDirty(session) || session.pending !== null) {
      sessionStorage.setItem(session.key, JSON.stringify({
        revision: session.revision,
        baseline: session.baseline,
        values: session.values,
        pending: session.pending !== null || session.recoveredPending,
      }));
    } else {
      sessionStorage.removeItem(session.key);
    }
    session.storageError = false;
  } catch {
    session.storageError = true;
  }
}

function openSession(spec: DraftSpec, key: string): Session {
  const cached = drafts.get(key);
  if (cached !== undefined) return cached;
  const session: Session = {
    id: spec.id, key, revision: spec.revision, baseline: fields(spec),
    values: fields(spec), editing: false, error: null, conflict: false,
    storageError: false, editorVersion: 0, recoveredPending: false,
    state: "idle", pending: null, remote: null, listeners: new Set(),
  };
  try {
    const raw = sessionStorage.getItem(key);
    if (raw !== null) {
      const saved = JSON.parse(raw);
      const validFields = (value: unknown): value is Fields => {
        const candidate = value as Partial<Fields> | null;
        return candidate !== null && typeof candidate === "object" &&
          typeof candidate.title === "string" && typeof candidate.summary === "string" &&
          typeof candidate.content === "string";
      };
      if (Number.isInteger(saved.revision) && validFields(saved.baseline) && validFields(saved.values)) {
        session.revision = saved.revision;
        session.baseline = saved.baseline;
        session.values = saved.values;
        session.recoveredPending = saved.pending === true;
        session.editing = true;
      }
    }
  } catch {
    session.storageError = true;
  }
  drafts.set(key, session);
  return session;
}

function reconcile(session: Session, spec: DraftSpec) {
  if (spec.revision <= session.revision) return;
  if (session.pending !== null) {
    if (session.remote === null || spec.revision > session.remote.revision) session.remote = spec;
  } else if (isDirty(session)) {
    session.conflict = true;
    session.error = conflictMessage;
    session.state = "error";
  } else {
    session.revision = spec.revision;
    session.baseline = fields(spec);
    session.values = fields(spec);
    session.editorVersion += 1;
    session.error = null;
    session.conflict = false;
    persist(session);
  }
}

export function useSpecDraft(
  spec: DraftSpec | null,
  options: {
    scope: string;
    save: (input: SaveInput) => Promise<{ revision: number }>;
    onSettled: (id: string) => void;
  },
) {
  const [, render] = useState(0);
  const active = useRef<Session | null>(null);
  const mounted = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const refresh = useCallback(() => {
    if (mounted.current) render((value) => value + 1);
  }, []);
  const notify = useCallback((session = active.current) => {
    session?.listeners.forEach((listener) => listener());
  }, []);

  // Every save uses the revision captured with the draft. Subsequent edits are
  // drained by the same promise, including those made while a request is slow.
  const flush = useCallback((session: Session, retry = false): Promise<boolean> => {
    if (session.pending !== null) return session.pending;
    if (session.conflict || (session.error !== null && !retry)) return Promise.resolve(false);
    if (!isDirty(session)) return Promise.resolve(true);
    session.error = null;
    session.state = "saving";
    const save = optionsRef.current.save;
    session.pending = Promise.resolve().then(async () => {
      try {
        while (isDirty(session)) {
          const snapshot = session.values;
          const submitted = { ...snapshot, title: snapshot.title.trim() || session.baseline.title };
          const result = await save({ id: session.id, ...submitted, expectedRevision: session.revision });
          session.revision = result.revision;
          session.recoveredPending = false;
          session.baseline = submitted;
          if (session.values === snapshot) session.values = submitted;
          persist(session);
          const remote = session.remote;
          session.remote = null;
          if (remote !== null && remote.revision > result.revision) {
            if (isDirty(session)) {
              session.conflict = true;
              throw new Error(conflictMessage);
            }
            session.revision = remote.revision;
            session.baseline = fields(remote);
            session.values = fields(remote);
            session.editorVersion += 1;
          }
          notify(session);
        }
        session.state = "saved";
        return true;
      } catch (cause) {
        // A disconnected request may have reached the server. Retain the
        // user's final intent even if they typed back to the old baseline.
        session.recoveredPending = true;
        session.error = cause instanceof Error ? cause.message : String(cause);
        session.state = "error";
        persist(session);
        return false;
      } finally {
        session.pending = null;
        persist(session);
        if (session.remote !== null) {
          const remote = session.remote;
          session.remote = null;
          reconcile(session, remote);
        }
        optionsRef.current.onSettled(session.id);
        notify(session);
      }
    });
    notify(session);
    return session.pending;
  }, [notify]);

  useEffect(() => {
    mounted.current = true;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (active.current !== null && (isDirty(active.current) || active.current.pending !== null)) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      mounted.current = false;
      window.removeEventListener("beforeunload", beforeUnload);
      if (active.current !== null) {
        active.current.listeners.delete(refresh);
        void flush(active.current);
      }
    };
  }, [flush, refresh]);

  useEffect(() => {
    const key = spec === null ? null : `specs:draft:${options.scope}:${spec.id}`;
    if (active.current?.key !== key) {
      if (active.current !== null) {
        active.current.listeners.delete(refresh);
        void flush(active.current);
      }
      active.current = spec === null || key === null ? null : openSession(spec, key);
    }
    active.current?.listeners.add(refresh);
    if (spec !== null && active.current !== null) reconcile(active.current, spec);
    refresh();
  }, [spec, options.scope, flush, refresh]);

  const session = active.current?.id === spec?.id ? active.current : null;
  const values = session?.values ?? (spec === null ? { title: "", summary: "", content: "" } : fields(spec));
  const dirty = session !== null && isDirty(session);
  useEffect(() => {
    if (session === null || !session.editing || !dirty || session.error !== null) return;
    const timer = setTimeout(() => void flush(session), 1200);
    return () => clearTimeout(timer);
  }, [session, values, dirty, session?.editing, session?.error, flush]);

  const update = (patch: Partial<Fields>) => {
    if (session === null) return;
    session.values = { ...session.values, ...patch };
    if (!session.conflict) session.error = null;
    if (session.pending === null && !session.conflict) session.state = "idle";
    persist(session);
    notify(session);
  };

  return {
    values,
    dirty,
    editing: session?.editing ?? false,
    saveState: session?.state ?? "idle",
    saveError: session?.error ?? null,
    conflict: session?.conflict ?? false,
    storageError: session?.storageError ?? false,
    editorVersion: session?.editorVersion ?? 0,
    update,
    beginEdit() {
      if (active.current !== null) { active.current.editing = true; notify(); }
    },
    async save() { return session === null || await flush(session, true); },
    async finishEdit() {
      if (session === null || !await flush(session, true)) return false;
      session.editing = false;
      notify(session);
      return true;
    },
    discard() {
      if (session === null || spec === null || session.pending !== null) return;
      session.revision = spec.revision;
      session.baseline = fields(spec);
      session.values = fields(spec);
      session.recoveredPending = false;
      session.editing = false;
      session.error = null;
      session.conflict = false;
      session.state = "idle";
      persist(session);
      notify(session);
    },
  };
}
