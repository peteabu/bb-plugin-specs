// bb-plugin-specs — frontend entry.
//
// A Notion/Craft-flavored document surface: sidebar of grouped specs, a calm
// document canvas with select-to-comment, and a right rail for comments and
// the spec's agent chat.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode, RefObject } from "react";
import {
  Markdown,
  ThreadChat,
  definePluginApp,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type {
  Annotation,
  Decision,
  LinkMode,
  ProjectSummary,
  Proposal,
  Research,
  SpecDetail,
  SpecMessage,
  SpecSummary,
  ThreadSpecsResult,
  ThreadSpecLink,
  rpcContract,
} from "./server";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import "./app.css";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toISOString().slice(0, 10);
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

function truncate(value: string, max: number): string {
  const oneLine = value.replace(/\s+/gu, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function displayAuthor(author: string): string {
  if (author === "user") return "You";
  if (author === "agent") return "Agent";
  if (author === "cli") return "CLI";
  return author;
}

const SPEC_EMOJIS = [
  "📄", "📝", "📐", "🧭", "🎯", "🔐", "🧪", "⚙️",
  "🧩", "📦", "🚀", "🐛", "🗺️", "💡", "📊", "🧠",
  "🛠️", "🔍", "📅", "💬", "⭐", "🔥", "🌱", "🧱",
  "🎨", "🗂️", "🔒", "🧵", "🧮", "🪄", "📌", "✅",
];

const HIGHLIGHT_NAME = "specs-annotation";
const highlightOwner: { token: object | null } = { token: null };

interface QuoteLocation {
  quote: string;
  prefix: string;
  suffix: string;
}

interface SelectionMenu extends QuoteLocation {
  x: number;
  y: number;
}

interface AnnotationDraft extends SelectionMenu {
  body: string;
  kind: "note" | "question";
}

function collectTextNodes(container: HTMLElement): Text[] {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node = walker.nextNode();
  while (node !== null) {
    nodes.push(node as Text);
    node = walker.nextNode();
  }
  return nodes;
}

function normalizeQuote(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

// Rendered markdown can differ from stored quotes in whitespace (soft line
// breaks, indentation), and quotes can repeat. Normalize both sides and map
// offsets back to real text nodes so ranges stay exact.
function normalizeTextNodes(nodes: Text[]): {
  text: string;
  positions: Array<{ node: Text; offset: number }>;
} {
  let text = "";
  const positions: Array<{ node: Text; offset: number }> = [];
  let pendingSpace: { node: Text; offset: number } | null = null;
  for (const node of nodes) {
    const data = node.data;
    for (let index = 0; index < data.length; index += 1) {
      const char = data[index] ?? "";
      if (/\s/u.test(char)) {
        if (pendingSpace === null) pendingSpace = { node, offset: index };
        continue;
      }
      if (pendingSpace !== null) {
        if (text !== "" && !text.endsWith(" ")) {
          text += " ";
          positions.push(pendingSpace);
        }
        pendingSpace = null;
      }
      text += char;
      positions.push({ node, offset: index });
    }
  }
  return { text, positions };
}

function locateQuote(text: string, annotation: QuoteLocation): number {
  const quote = normalizeQuote(annotation.quote);
  if (quote === "") return -1;
  const prefix = normalizeQuote(annotation.prefix);
  const suffix = normalizeQuote(annotation.suffix);
  const candidates: number[] = [];
  let at = text.indexOf(quote);
  while (at !== -1) {
    candidates.push(at);
    at = text.indexOf(quote, at + 1);
    if (candidates.length > 24) break;
  }
  if (candidates.length <= 1) return candidates[0] ?? -1;
  for (const candidate of candidates) {
    const before = text
      .slice(Math.max(0, candidate - prefix.length - 1), candidate)
      .trim();
    const after = text
      .slice(candidate + quote.length + 1, candidate + quote.length + 1 + suffix.length)
      .trim();
    if (
      (prefix === "" || before.endsWith(prefix)) &&
      (suffix === "" || after.startsWith(suffix))
    ) {
      return candidate;
    }
  }
  return candidates[0] ?? -1;
}

function findAnnotationRange(
  container: HTMLElement,
  annotation: QuoteLocation,
): Range | null {
  const { text, positions } = normalizeTextNodes(collectTextNodes(container));
  const quoteStart = locateQuote(text, annotation);
  if (quoteStart === -1) return null;
  const quote = normalizeQuote(annotation.quote);
  const start = positions[quoteStart];
  const end = positions[quoteStart + quote.length - 1];
  if (start === undefined || end === undefined) return null;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset + 1);
  return range;
}

function applyDomHighlights(container: HTMLElement, ranges: Range[]): () => void {
  const marks: HTMLElement[] = [];
  for (const range of ranges) {
    try {
      const mark = document.createElement("mark");
      mark.className = "specs-annotation-mark";
      range.surroundContents(mark);
      marks.push(mark);
    } catch {
      // Range crosses element boundaries; the comment rail still shows it.
    }
  }
  return () => {
    for (const mark of marks) {
      const parent = mark.parentNode;
      if (parent === null) continue;
      while (mark.firstChild !== null) {
        parent.insertBefore(mark.firstChild, mark);
      }
      parent.removeChild(mark);
    }
    container.normalize();
  };
}

function useAnnotationHighlights(
  containerRef: RefObject<HTMLDivElement | null>,
  annotations: Annotation[],
  revisionKey: string,
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const ranges: Range[] = [];
    for (const annotation of annotations) {
      if (annotation.status !== "open") continue;
      const range = findAnnotationRange(container, annotation);
      if (range !== null) ranges.push(range);
    }
    if (ranges.length === 0) return;
    const css = CSS as unknown as { highlights?: Map<string, unknown> };
    const HighlightCtor = (
      globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }
    ).Highlight;
    if (css.highlights !== undefined && HighlightCtor !== undefined) {
      const token = {};
      css.highlights.set(HIGHLIGHT_NAME, new HighlightCtor(...ranges));
      highlightOwner.token = token;
      return () => {
        if (highlightOwner.token === token) {
          css.highlights?.delete(HIGHLIGHT_NAME);
          highlightOwner.token = null;
        }
      };
    }
    return applyDomHighlights(container, ranges);
  }, [containerRef, annotations, revisionKey]);
}

function captureSelection(container: HTMLElement): QuoteLocation | null {
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const quote = normalizeQuote(selection.toString());
  if (quote === "") return null;
  const { text } = normalizeTextNodes(collectTextNodes(container));
  const at = text.indexOf(quote);
  return {
    quote: quote.slice(0, 1900),
    prefix: at === -1 ? "" : text.slice(Math.max(0, at - 48), at),
    suffix:
      at === -1 ? "" : text.slice(at + quote.length, at + quote.length + 48),
  };
}

// ---------------------------------------------------------------------------
// Presentational primitives
// ---------------------------------------------------------------------------

function IconButton({
  label,
  active,
  onClick,
  children,
  className,
  compact,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active === true}
      onClick={onClick}
      className={cn(
        "specs-press relative grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground",
        compact
          ? "size-6"
          : "after:absolute after:left-1/2 after:top-1/2 after:size-10 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']",
        active === true && "bg-state-active text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}

function Avatar({ name }: { name: string }) {
  const trimmed = name.trim();
  const initial = trimmed === "" ? "?" : trimmed[0]!.toUpperCase();
  return (
    <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary/15 text-[11px] font-medium text-primary">
      {initial}
    </span>
  );
}

const textareaClassName =
  "w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function SpecsSidebar({
  specs,
  projects,
  selectedSlug,
  query,
  onQuery,
  onSelect,
  onNewDefault,
  onNewInGroup,
}: {
  specs: SpecSummary[] | null;
  projects: ProjectSummary[];
  selectedSlug: string;
  query: string;
  onQuery: (value: string) => void;
  onSelect: (slug: string) => void;
  onNewDefault: () => void;
  onNewInGroup: (projectId: string | null) => void;
}) {
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (specs ?? []).filter((spec) => {
      if (needle === "") return true;
      return `${spec.title} ${spec.slug} ${spec.summary}`
        .toLowerCase()
        .includes(needle);
    });
  }, [specs, query]);

  const groups = useMemo(() => {
    const byKey = new Map<
      string,
      { key: string; label: string; specs: SpecSummary[] }
    >();
    for (const spec of visible) {
      const key = spec.projectIds[0] ?? "__none__";
      const label =
        key === "__none__" ? "No project" : (projectNames.get(key) ?? key);
      const group = byKey.get(key) ?? { key, label, specs: [] };
      group.specs.push(spec);
      byKey.set(key, group);
    }
    return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [visible, projectNames]);

  useEffect(() => {
    const spec = specs?.find((candidate) => candidate.slug === selectedSlug);
    if (spec === undefined) return;
    const key = spec.projectIds[0] ?? "__none__";
    setCollapsed((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }, [selectedSlug, specs]);

  const openComments = (specs ?? []).reduce(
    (total, spec) => total + spec.openAnnotations,
    0,
  );

  return (
    <aside className="hidden w-[264px] shrink-0 flex-col border-r border-border md:flex">
      <div className="space-y-2 px-3 pb-2 pt-3">
        <div className="flex items-center justify-between px-1">
          <span className="text-sm font-semibold tracking-tight">Specs</span>
          <IconButton label="New spec" onClick={onNewDefault}>
            <Icon name="Plus" className="size-4" />
          </IconButton>
        </div>
        <div className="relative">
          <Icon
            name="Search"
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="Search"
            className="h-8 bg-secondary/50 pl-8 text-xs"
          />
        </div>
      </div>

      <div className="specs-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {specs === null ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">Loading…</p>
        ) : groups.length === 0 ? (
          <div className="px-1 py-2">
            <EmptyState>
              {specs.length === 0
                ? "No specs yet. Create one, or let an agent call specs_create."
                : "Nothing matches."}
            </EmptyState>
          </div>
        ) : (
          groups.map((group) => {
            const isCollapsed = collapsed.has(group.key);
            return (
              <div key={group.key} className="group/header mb-1">
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() =>
                      setCollapsed((current) => {
                        const next = new Set(current);
                        if (next.has(group.key)) next.delete(group.key);
                        else next.add(group.key);
                        return next;
                      })
                    }
                    className="specs-row flex min-w-0 flex-1 items-center gap-1 rounded-md px-2 py-1 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground hover:bg-state-hover"
                  >
                    <Icon
                      name={isCollapsed ? "ChevronRight" : "ChevronDown"}
                      className="size-3"
                    />
                    <span className="min-w-0 flex-1 truncate">{group.label}</span>
                  </button>
                  <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums opacity-0 transition-opacity duration-150 group-hover/header:opacity-100">
                    {group.specs.length}
                  </span>
                  <IconButton
                    compact
                    label={`New spec in ${group.label}`}
                    className="opacity-0 focus-visible:opacity-100 group-hover/header:opacity-100"
                    onClick={() =>
                      onNewInGroup(group.key === "__none__" ? null : group.key)
                    }
                  >
                    <Icon name="Plus" className="size-3.5" />
                  </IconButton>
                </div>
                {isCollapsed
                  ? null
                  : group.specs.map((spec) => {
                      const selected = spec.slug === selectedSlug;
                      return (
                        <button
                          key={spec.id}
                          type="button"
                          onClick={() => onSelect(spec.slug)}
                          className={cn(
                            "specs-row group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
                            selected
                              ? "bg-state-active text-foreground"
                              : "text-foreground/90 hover:bg-state-hover",
                          )}
                        >
                          <span className="w-5 shrink-0 text-center text-sm leading-none">
                            {spec.icon}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[13px]">
                            {spec.title}
                          </span>
                          <span
                            className={cn(
                              "shrink-0 text-[10px] text-muted-foreground tabular-nums opacity-0 transition-opacity duration-150 group-hover:opacity-100",
                              spec.openAnnotations > 0 && "opacity-100",
                            )}
                          >
                            {spec.openAnnotations > 0
                              ? `${spec.openAnnotations} 💬`
                              : relativeTime(spec.updatedAt)}
                          </span>
                        </button>
                      );
                    })}
              </div>
            );
          })
        )}
      </div>

      <div className="border-t border-border px-4 py-2 text-[10px] text-muted-foreground tabular-nums">
        {specs === null
          ? ""
          : `${specs.length} spec${specs.length === 1 ? "" : "s"} · ${openComments} open comment${openComments === 1 ? "" : "s"}`}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

const LINK_MODE_LABELS: Record<LinkMode, string> = {
  pinned: "Pinned",
  auto: "Auto",
  available: "Available",
};

// Notion database-page style properties: values are inline chips, and editing
// happens in a small popover anchored to the chip rather than a modal form.
function PropertiesBar({
  projects,
  links,
  status,
  onLinks,
  onStatus,
}: {
  projects: ProjectSummary[];
  links: Array<{ projectId: string; mode: LinkMode }>;
  status: "active" | "archived";
  onLinks: (next: Array<{ projectId: string; mode: LinkMode }>) => void;
  onStatus: (status: "active" | "archived") => void;
}) {
  const [open, setOpen] = useState<"projects" | "status" | null>(null);
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );

  useEffect(() => {
    if (open === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
    };
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target !== null &&
        (target.closest(".specs-property-popover") !== null ||
          target.closest("[data-specs-property]") !== null)
      ) {
        return;
      }
      setOpen(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const toggleProject = (projectId: string) => {
    const existing = links.find((link) => link.projectId === projectId);
    if (existing === undefined) {
      onLinks([...links, { projectId, mode: "auto" }]);
    } else {
      onLinks(links.filter((link) => link.projectId !== projectId));
    }
  };

  const chipClass =
    "inline-flex items-center gap-1 rounded-md bg-secondary/60 text-xs text-foreground";

  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
      <div className="relative flex items-center gap-1.5" data-specs-property>
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Projects
        </span>
        {links.length === 0 ? (
          <span className="text-xs text-muted-foreground">None</span>
        ) : null}
        {links.map((link) => {
          const name = projectNames.get(link.projectId) ?? link.projectId;
          return (
            <span key={link.projectId} className={chipClass}>
              <button
                type="button"
                className="specs-press cursor-pointer px-2 py-1"
                onClick={() => setOpen(open === "projects" ? null : "projects")}
              >
                {name}
                <span className="ml-1 text-muted-foreground">
                  {LINK_MODE_LABELS[link.mode].toLowerCase()}
                </span>
              </button>
              <button
                type="button"
                aria-label={`Unlink ${name}`}
                className="specs-press cursor-pointer px-1.5 py-1 text-muted-foreground hover:text-foreground"
                onClick={() =>
                  onLinks(
                    links.filter((candidate) => candidate.projectId !== link.projectId),
                  )
                }
              >
                <Icon name="X" className="size-3" />
              </button>
            </span>
          );
        })}
        <button
          type="button"
          aria-label="Link a project"
          title="Link a project"
          className="specs-press grid size-6 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground"
          onClick={() => setOpen(open === "projects" ? null : "projects")}
        >
          <Icon name="Plus" className="size-3.5" />
        </button>
        {open === "projects" ? (
          <div className="specs-property-popover left-0 top-full mt-1.5 w-80 p-3">
            <p className="text-xs text-muted-foreground text-pretty">
              Linked projects decide which threads receive this spec in their
              context index. Threads can still attach or detach it individually.
            </p>
            <div className="mt-2.5 max-h-64 space-y-2 overflow-y-auto">
              {projects.map((project) => {
                const mode = links.find(
                  (link) => link.projectId === project.id,
                )?.mode;
                return (
                  <div key={project.id} className="flex items-center gap-2 text-sm">
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                      <Checkbox
                        checked={mode !== undefined}
                        onCheckedChange={() => toggleProject(project.id)}
                      />
                      <span className="min-w-0 truncate">{project.name}</span>
                    </label>
                    <select
                      className="rounded-md border border-input bg-transparent px-2 py-1 text-xs"
                      value={mode ?? "auto"}
                      disabled={mode === undefined}
                      onChange={(event) =>
                        onLinks(
                          links.map((link) =>
                            link.projectId === project.id
                              ? {
                                  projectId: project.id,
                                  mode: event.target.value as LinkMode,
                                }
                              : link,
                          ),
                        )
                      }
                    >
                      {(Object.keys(LINK_MODE_LABELS) as LinkMode[]).map((value) => (
                        <option key={value} value={value}>
                          {LINK_MODE_LABELS[value]}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>

      <div className="relative flex items-center gap-1.5" data-specs-property>
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Status
        </span>
        <button
          type="button"
          className={cn(chipClass, "specs-press cursor-pointer px-2 py-1")}
          onClick={() => setOpen(open === "status" ? null : "status")}
        >
          {status === "active" ? "Active" : "Archived"}
          <Icon name="ChevronDown" className="size-3 text-muted-foreground" />
        </button>
        {open === "status" ? (
          <div className="specs-property-popover left-0 top-full mt-1.5 w-44 p-1">
            {(["active", "archived"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className="specs-press flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-state-hover"
                onClick={() => {
                  onStatus(value);
                  setOpen(null);
                }}
              >
                <Icon
                  name="Check"
                  className={cn(
                    "size-3.5 text-primary",
                    status === value ? "opacity-100" : "opacity-0",
                  )}
                />
                {value === "active" ? "Active" : "Archived"}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface DiffTarget {
  specId: string;
  title: string;
  from: number;
  to: number | null;
  content?: string;
}

function DiffDialog({
  target,
  onOpenChange,
}: {
  target: DiffTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [rows, setRows] = useState<
    Array<{ type: "same" | "add" | "del"; text: string }> | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (target === null) return;
    setRows(null);
    setError(null);
    rpc
      .call("specs_diff", {
        id: target.specId,
        from: target.from,
        ...(target.to === null ? {} : { to: target.to }),
        ...(target.content === undefined ? {} : { content: target.content }),
      })
      .then(
        (result) => setRows(result.rows),
        (cause: unknown) => setError(messageOf(cause)),
      );
  }, [target, rpc]);
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl rounded-2xl">
        <DialogHeader>
          <DialogTitle className="text-base">
            {target === null
              ? "Diff"
              : `${target.title} · v${target.from} → ${target.to === null ? "proposal" : `v${target.to}`}`}
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-auto rounded-xl border border-border bg-secondary/30">
          {error !== null ? (
            <p className="p-4 text-sm text-destructive">{error}</p>
          ) : rows === null ? (
            <p className="p-4 text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="py-2 text-xs leading-relaxed">
              {rows.map((row, index) => (
                <div
                  key={`${index}-${row.type}`}
                  className={cn(
                    "whitespace-pre-wrap px-3 font-mono",
                    row.type === "add" && "bg-primary/10",
                    row.type === "del" && "bg-destructive/10 text-muted-foreground",
                    row.type === "same" && "text-muted-foreground",
                  )}
                >
                  {row.type === "add" ? "+ " : row.type === "del" ? "- " : "  "}
                  {row.text}
                </div>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AgentChangeCard({
  change,
  busy,
  onReview,
  onKeep,
  onRevert,
}: {
  change: NonNullable<SpecDetail["agentChange"]>;
  busy: boolean;
  onReview: () => void;
  onKeep: () => void;
  onRevert: () => void;
}) {
  if (change.acked) return null;
  return (
    <div className="specs-hairline mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-card px-3 py-2.5">
      <Icon name="Edit" className="size-3.5 text-primary" />
      <span className="min-w-0 flex-1 text-sm">
        The agent changed this spec in v{change.revision}.
        {change.previousRevision === null
          ? ""
          : ` Keep it, or revert to v${change.previousRevision}.`}
      </span>
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2.5"
        onClick={onReview}
      >
        Review
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2.5"
        disabled={busy}
        onClick={onKeep}
      >
        Keep
      </Button>
      {change.previousRevision === null ? null : (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2.5 text-muted-foreground"
          disabled={busy}
          onClick={onRevert}
        >
          Revert
        </Button>
      )}
    </div>
  );
}

function ProposalCard({
  proposal,
  busy,
  onReview,
  onApply,
  onReject,
}: {
  proposal: Proposal;
  busy: boolean;
  onReview: () => void;
  onApply: () => void;
  onReject: (note: string) => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  return (
    <div className="specs-hairline mb-3 rounded-xl bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
          Proposal
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {proposal.note === "" ? "Agent proposed a change" : proposal.note}
        </span>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          written against v{proposal.baseRevision}
        </span>
      </div>
      {proposal.questionId === null ? null : (
        <p className="mt-1 text-[11px] text-muted-foreground">
          Answers {proposal.questionId} — applying links the revision to its
          decision.
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          className="h-7 px-2.5"
          disabled={busy}
          onClick={onApply}
        >
          Apply
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2.5"
          onClick={onReview}
        >
          Review diff
        </Button>
        {rejecting ? (
          <span className="flex items-center gap-1.5">
            <Input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Why? (optional)"
              className="h-7 w-44 text-xs"
            />
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              disabled={busy}
              onClick={() => onReject(note)}
            >
              Reject
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={() => setRejecting(false)}
            >
              Cancel
            </Button>
          </span>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2.5 text-muted-foreground"
            onClick={() => setRejecting(true)}
          >
            Reject
          </Button>
        )}
      </div>
    </div>
  );
}

function ResearchCard({
  run,
  onOpenRun,
  onOpenResult,
}: {
  run: Research;
  onOpenRun: () => void;
  onOpenResult: () => void;
}) {
  return (
    <div className="specs-hairline mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-card px-3 py-2.5">
      {run.status === "running" ? (
        <Icon name="Loading" className="size-3.5 animate-spin text-primary" />
      ) : (
        <Icon name="Beaker" className="size-3.5 text-muted-foreground" />
      )}
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground tabular-nums">
        Research · {run.status}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm">{run.brief}</span>
      {run.status === "running" ? (
        <Button size="sm" variant="outline" className="h-7 px-2.5" onClick={onOpenRun}>
          Open run
        </Button>
      ) : null}
      {run.status === "failed" ? (
        <span className="text-[11px] text-destructive">
          {truncate(run.error, 120)}
        </span>
      ) : null}
      {run.resultSpecId === null ? null : (
        <Button size="sm" className="h-7 px-2.5" onClick={onOpenResult}>
          Open result
        </Button>
      )}
    </div>
  );
}

function EmojiPickerDialog({
  open,
  current,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  current: string;
  onOpenChange: (open: boolean) => void;
  onPick: (emoji: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm rounded-2xl">
        <DialogHeader>
          <DialogTitle className="text-base">Spec icon</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-8 gap-0.5">
          {SPEC_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => onPick(emoji)}
              className={cn(
                "specs-press grid size-10 cursor-pointer place-items-center rounded-lg text-xl hover:bg-state-hover",
                emoji === current && "bg-state-active",
              )}
            >
              {emoji}
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onPick("")}>
            Reset to default
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Comments rail
// ---------------------------------------------------------------------------

type QuestionAction = "answer" | "clarify" | "resolve" | "dismiss";

const QUESTION_STATE_LABELS: Record<Annotation["state"], string> = {
  open: "Open",
  answered: "Answered",
  clarify: "Clarifying",
  resolved: "Resolved",
  dismissed: "Dismissed",
};

function questionStateChip(state: Annotation["state"]): string {
  if (state === "open") return "bg-primary/15 text-primary";
  if (state === "answered") return "bg-secondary text-foreground";
  return "bg-secondary/60 text-muted-foreground";
}

const QUESTION_FORMS: Record<
  QuestionAction,
  { placeholder: string; submit: string }
> = {
  answer: { placeholder: "Answer from the spec and project context…", submit: "Save answer" },
  clarify: { placeholder: "What needs to be clearer before this can be decided?", submit: "Ask follow-up" },
  resolve: { placeholder: "The decision, in one or two sentences…", submit: "Resolve" },
  dismiss: { placeholder: "Why is this no longer worth deciding? (optional)", submit: "Dismiss" },
};

function CommentCard({
  annotation,
  onReply,
  onStatus,
  onRemove,
  onLocate,
  onAnswer,
  onClarify,
  onResolve,
  onDismiss,
  onReopen,
}: {
  annotation: Annotation;
  onReply: (body: string) => Promise<void>;
  onStatus: (status: "open" | "resolved") => Promise<void>;
  onRemove: () => Promise<void>;
  onLocate: () => void;
  onAnswer: (answer: string) => Promise<void>;
  onClarify: (question: string) => Promise<void>;
  onResolve: (decision: string) => Promise<void>;
  onDismiss: (reason: string) => Promise<void>;
  onReopen: () => Promise<void>;
}) {
  const [reply, setReply] = useState("");
  const [form, setForm] = useState<QuestionAction | null>(null);
  const [formText, setFormText] = useState("");
  const [eventsOpen, setEventsOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const isQuestion = annotation.kind === "question";
  const closed = annotation.status === "resolved";

  const sendReply = () => {
    const value = reply.trim();
    if (value === "") return;
    setReply("");
    void onReply(value);
  };

  const openForm = (action: QuestionAction) => {
    setForm(action);
    setFormText("");
  };

  const submitForm = async () => {
    if (form === null || busy) return;
    const value = formText.trim();
    if (value === "" && form !== "dismiss") return;
    setBusy(true);
    try {
      if (form === "answer") await onAnswer(value);
      else if (form === "clarify") await onClarify(value);
      else if (form === "resolve") await onResolve(value);
      else await onDismiss(value);
      setForm(null);
      setFormText("");
    } finally {
      setBusy(false);
    }
  };

  const hoverActions = (
    <span className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
      <IconButton label="Find in document" onClick={onLocate} compact>
        <Icon name="Target" className="size-3.5" />
      </IconButton>
      {isQuestion ? null : (
        <IconButton
          label={closed ? "Reopen" : "Resolve"}
          compact
          onClick={() => {
            if (busy) return;
            setBusy(true);
            void onStatus(closed ? "open" : "resolved").finally(() => setBusy(false));
          }}
        >
          <Icon name="Check" className="size-3.5" />
        </IconButton>
      )}
      <IconButton
        label={confirming ? "Confirm delete" : "Delete"}
        compact
        onClick={() => {
          if (!confirming) {
            setConfirming(true);
            return;
          }
          void onRemove();
        }}
        className={confirming ? "text-destructive" : undefined}
      >
        <Icon name="Trash2" className="size-3.5" />
      </IconButton>
    </span>
  );

  return (
    <div
      className={cn(
        "specs-hairline group rounded-xl bg-card p-3",
        closed && "opacity-80",
      )}
    >
      <div className="flex items-start gap-2.5">
        <Avatar name={annotation.author} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium">
              {displayAuthor(annotation.author)}
            </span>
            {isQuestion ? (
              <span className="rounded-md bg-secondary px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Question
              </span>
            ) : null}
            {isQuestion ? (
              <span
                className={cn(
                  "rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                  questionStateChip(annotation.state),
                )}
              >
                {QUESTION_STATE_LABELS[annotation.state]}
              </span>
            ) : null}
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {relativeTime(annotation.createdAt)}
            </span>
            {hoverActions}
          </div>

          <blockquote className="mt-1.5 border-l-2 border-primary/40 pl-2.5 text-xs leading-relaxed text-muted-foreground">
            {truncate(annotation.quote, 180)}
          </blockquote>
          <div className="mt-1.5 text-sm leading-relaxed">
            <Markdown content={annotation.body} />
          </div>

          {isQuestion &&
          !closed &&
          annotation.answer === "" &&
          annotation.dispatchedAt !== null &&
          !annotation.comments.some((comment) => comment.author === "agent") ? (
            <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Icon name="Loading" className="size-3 animate-spin" />
              Agent notified {relativeTime(annotation.dispatchedAt)} — it replies
              in this thread
            </p>
          ) : null}

          {isQuestion && annotation.answer !== "" ? (
            <div className="mt-2 rounded-lg bg-secondary/50 px-2.5 py-2">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Answer · {displayAuthor(annotation.answeredBy)} ·{" "}
                {relativeTime(annotation.answeredAt ?? annotation.updatedAt)}
              </p>
              <div className="mt-0.5 text-sm leading-relaxed">
                <Markdown content={annotation.answer} />
              </div>
            </div>
          ) : null}

          {isQuestion && annotation.decision !== "" ? (
            <div className="mt-2 rounded-lg border border-border px-2.5 py-2">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground tabular-nums">
                Decision · {displayAuthor(annotation.resolvedBy)} ·{" "}
                {relativeTime(annotation.resolvedAt ?? annotation.updatedAt)}
                {annotation.foldedRevision === null
                  ? ""
                  : ` · folded into v${annotation.foldedRevision}`}
              </p>
              <div className="mt-0.5 text-sm leading-relaxed">
                <Markdown content={annotation.decision} />
              </div>
            </div>
          ) : null}

          {isQuestion && annotation.parentId !== null ? (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Follow-up of {annotation.parentId}
            </p>
          ) : null}

          {isQuestion && annotation.events.length > 0 ? (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setEventsOpen((current) => !current)}
                className="specs-press cursor-pointer text-[11px] text-muted-foreground hover:text-foreground"
              >
                {eventsOpen ? "Hide history" : `History (${annotation.events.length})`}
              </button>
              {eventsOpen ? (
                <ul className="mt-1.5 space-y-1 border-l border-border pl-2.5">
                  {annotation.events.map((event) => (
                    <li
                      key={event.id}
                      className="text-[11px] text-muted-foreground tabular-nums"
                    >
                      <span className="font-medium text-foreground/80">
                        {event.event}
                      </span>{" "}
                      · {displayAuthor(event.actor)} · {relativeTime(event.createdAt)}
                      {event.revision === null ? "" : ` · v${event.revision}`}
                      {event.note === "" ? "" : ` — ${truncate(event.note, 120)}`}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {isQuestion ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {closed ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2.5"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void onReopen().finally(() => setBusy(false));
                  }}
                >
                  Reopen
                </Button>
              ) : (
                <>
                  <Button
                    size="sm"
                    className="h-7 px-2.5"
                    onClick={() => openForm("answer")}
                  >
                    {annotation.answer === "" ? "Answer" : "Edit answer"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2.5"
                    onClick={() => openForm("clarify")}
                  >
                    Needs clarification
                  </Button>
                  {annotation.state === "answered" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2.5"
                      onClick={() => openForm("resolve")}
                    >
                      Resolve with decision
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2.5 text-muted-foreground"
                    onClick={() => openForm("dismiss")}
                  >
                    Dismiss
                  </Button>
                </>
              )}
            </div>
          ) : null}

          {form === null ? null : (
            <div className="mt-2">
              <textarea
                autoFocus
                value={formText}
                onChange={(event) => setFormText(event.target.value)}
                placeholder={QUESTION_FORMS[form].placeholder}
                className={cn(textareaClassName, "h-20 rounded-xl text-sm")}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    void submitForm();
                  }
                  if (event.key === "Escape") setForm(null);
                }}
              />
              <div className="mt-1.5 flex items-center justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2"
                  onClick={() => setForm(null)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="h-7 px-2.5"
                  disabled={busy || (form !== "dismiss" && formText.trim() === "")}
                  onClick={() => void submitForm()}
                >
                  {busy ? "Saving…" : QUESTION_FORMS[form].submit}
                </Button>
              </div>
            </div>
          )}

          {annotation.comments.length > 0 ? (
            <ul className="mt-2 space-y-2 border-t border-border pt-2">
              {annotation.comments.map((comment) => (
                <li key={comment.id} className="flex items-start gap-2">
                  <Avatar name={comment.author} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-xs font-medium">
                        {displayAuthor(comment.author)}
                      </span>
                      <span className="text-[11px] text-muted-foreground tabular-nums">
                        {relativeTime(comment.createdAt)}
                      </span>
                    </div>
                    <div className="text-sm leading-relaxed">
                      <Markdown content={comment.body} />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="mt-2 flex items-center gap-2">
            <Input
              value={reply}
              onChange={(event) => setReply(event.target.value)}
              placeholder={isQuestion ? "Reply to the agent…" : "Reply…"}
              className="h-7 text-xs"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  sendReply();
                }
              }}
            />
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              disabled={reply.trim() === ""}
              onClick={sendReply}
            >
              Reply
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CommentsRail({
  annotations,
  decisions,
  textQuestions,
  textDecisions,
  onClose,
  onReply,
  onStatus,
  onRemove,
  onLocate,
  onAnswer,
  onClarify,
  onResolve,
  onDismiss,
  onReopen,
  onPromote,
}: {
  annotations: Annotation[];
  decisions: Decision[];
  textQuestions: Array<{ text: string; source: "section" | "marker" }>;
  textDecisions: string[];
  onClose: () => void;
  onReply: (annotationId: string, body: string) => Promise<void>;
  onStatus: (annotationId: string, status: "open" | "resolved") => Promise<void>;
  onRemove: (annotationId: string) => Promise<void>;
  onLocate: (annotation: Annotation) => void;
  onAnswer: (annotationId: string, answer: string) => Promise<void>;
  onClarify: (annotationId: string, question: string) => Promise<void>;
  onResolve: (annotationId: string, decision: string) => Promise<void>;
  onDismiss: (annotationId: string, reason: string) => Promise<void>;
  onReopen: (annotationId: string) => Promise<void>;
  onPromote: (text: string) => Promise<void>;
}) {
  const [filter, setFilter] = useState<"open" | "answered" | "history">("open");
  const [promoting, setPromoting] = useState<string | null>(null);
  const openItems = annotations.filter((annotation) => annotation.status === "open");
  const answeredItems = annotations.filter(
    (annotation) => annotation.kind === "question" && annotation.state === "answered",
  );
  const historyItems = annotations
    .filter((annotation) => annotation.status === "resolved")
    .sort((a, b) =>
      (b.resolvedAt ?? b.updatedAt).localeCompare(a.resolvedAt ?? a.updatedAt),
    );
  const shown =
    filter === "open"
      ? openItems
      : filter === "answered"
        ? answeredItems
        : historyItems;
  const segments: Array<["open" | "answered" | "history", string, number]> = [
    ["open", "Open", openItems.length],
    ["answered", "Answered", answeredItems.length],
    ["history", "History", historyItems.length],
  ];

  return (
    <>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 flex-1 text-xs font-medium">Comments</span>
        <div className="flex items-center rounded-lg bg-secondary/60 p-0.5">
          {segments.map(([value, label, count]) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              className={cn(
                "specs-press cursor-pointer rounded-[6px] px-2 py-1 text-[11px] tabular-nums",
                filter === value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
              {count > 0 ? ` ${count}` : ""}
            </button>
          ))}
        </div>
        <IconButton label="Close comments" onClick={onClose}>
          <Icon name="X" className="size-3.5" />
        </IconButton>
      </div>
      <div className="specs-scroll min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
        {filter === "open" && textQuestions.length > 0 ? (
          <div className="specs-hairline rounded-xl bg-card p-3">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              From text ({textQuestions.length})
            </p>
            <ul className="mt-1.5 space-y-2.5">
              {textQuestions.map((question) => (
                <li key={question.text} className="flex items-start gap-2">
                  <span className="min-w-0 flex-1 text-sm leading-relaxed text-foreground/90">
                    {question.text}
                    <span className="ml-1.5 text-[10px] text-muted-foreground">
                      {question.source === "marker"
                        ? "TBD marker"
                        : "Open questions section"}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 shrink-0 px-2.5"
                    disabled={promoting === question.text}
                    onClick={() => {
                      setPromoting(question.text);
                      void onPromote(question.text).finally(() =>
                        setPromoting(null),
                      );
                    }}
                  >
                    {promoting === question.text ? "Promoting…" : "Promote"}
                  </Button>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[10px] text-muted-foreground">
              Promoting moves the question into the loop and replaces the prose
              with a reference.
            </p>
          </div>
        ) : null}

        {shown.length === 0 &&
        !(filter === "open" && textQuestions.length > 0) &&
        !(filter === "history" && textDecisions.length > 0) &&
        !(filter === "history" && decisions.length > 0) ? (
          <div className="pt-6">
            <EmptyState>
              {filter === "open"
                ? "No open comments or questions. Select text in the document to add one."
                : filter === "answered"
                  ? "No answers waiting for triage."
                  : "No decisions or resolved comments yet."}
            </EmptyState>
          </div>
        ) : (
          shown.map((annotation) => (
            <CommentCard
              key={annotation.id}
              annotation={annotation}
              onReply={(body) => onReply(annotation.id, body)}
              onStatus={(status) => onStatus(annotation.id, status)}
              onRemove={() => onRemove(annotation.id)}
              onLocate={() => onLocate(annotation)}
              onAnswer={(answer) => onAnswer(annotation.id, answer)}
              onClarify={(question) => onClarify(annotation.id, question)}
              onResolve={(decision) => onResolve(annotation.id, decision)}
              onDismiss={(reason) => onDismiss(annotation.id, reason)}
              onReopen={() => onReopen(annotation.id)}
            />
          ))
        )}

        {filter === "history" && decisions.length > 0 ? (
          <div className="specs-hairline rounded-xl bg-card p-3">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Decision log ({decisions.length})
            </p>
            <ul className="mt-2 space-y-3">
              {decisions.map((decision) => (
                <li key={decision.id}>
                  <div className="flex items-center gap-2">
                    <Avatar name={decision.decidedBy} />
                    <span className="text-xs font-medium">
                      {displayAuthor(decision.decidedBy)}
                    </span>
                    <span className="text-[11px] text-muted-foreground tabular-nums">
                      {relativeTime(decision.createdAt)}
                      {decision.revision === null ? "" : ` · v${decision.revision}`}
                    </span>
                    {decision.status === "dismissed" ? (
                      <span className="text-[10px] uppercase text-muted-foreground">
                        dismissed
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1 text-sm leading-relaxed">
                    <Markdown content={decision.decision} />
                  </div>
                  {decision.rationale === "" ? null : (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Rationale: {truncate(decision.rationale, 240)}
                    </p>
                  )}
                  {decision.questionId === null ? null : (
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      From {decision.questionId}
                    </p>
                  )}
                  {decision.acceptedComments.length === 0 ? null : (
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {decision.acceptedComments.length} accepted comment
                      {decision.acceptedComments.length === 1 ? "" : "s"}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {filter === "history" && textDecisions.length > 0 ? (
          <div className="specs-hairline rounded-xl bg-card p-3">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Decisions in text ({textDecisions.length})
            </p>
            <ul className="mt-1.5 space-y-1.5">
              {textDecisions.map((decision) => (
                <li
                  key={decision}
                  className="text-sm leading-relaxed text-foreground/90"
                >
                  {decision}
                  <span className="ml-1.5 text-[10px] text-muted-foreground">
                    not audited
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Specs page
// ---------------------------------------------------------------------------

function SpecsWorkspace({
  selectedSlug,
  tabPart,
  showSidebar,
  chrome,
  onSelectSpec,
  onSelectTab,
}: {
  selectedSlug: string;
  tabPart: string;
  showSidebar: boolean;
  chrome: "route" | "panel" | "overlay";
  onSelectSpec: (slug: string) => void;
  onSelectTab: (tab: "document" | "annotations" | "chat") => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const bbContext = useBbContext();
  const [specs, setSpecs] = useState<SpecSummary[] | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<SpecDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [rail, setRail] = useState<"none" | "comments" | "chat">("none");
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [summaryDraft, setSummaryDraft] = useState("");
  const [contentDraft, setContentDraft] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [creating, setCreating] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [selectionMenu, setSelectionMenu] = useState<SelectionMenu | null>(null);
  const [annotationDraft, setAnnotationDraft] = useState<AnnotationDraft | null>(
    null,
  );
  const [chatBusy, setChatBusy] = useState(false);
  const [chatText, setChatText] = useState("");
  const [proposalBusy, setProposalBusy] = useState(false);
  const [changeBusy, setChangeBusy] = useState(false);
  const [diffTarget, setDiffTarget] = useState<DiffTarget | null>(null);
  const [researchOpen, setResearchOpen] = useState(false);
  const [researchBrief, setResearchBrief] = useState("");
  const [researchBusy, setResearchBusy] = useState(false);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const detailRef = useRef<SpecDetail | null>(null);
  const draftsRef = useRef({ title: "", summary: "", content: "" });
  const savingRef = useRef(false);
  const editingSpecRef = useRef<string | null>(null);
  const pendingCreateRef = useRef<string | null>(null);
  const focusTitleRef = useRef(false);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const contentInputRef = useRef<HTMLTextAreaElement | null>(null);

  const refetchList = useCallback(() => {
    rpc.call("specs_list", {}).then(
      (result) => {
        setSpecs(result.specs);
        setProjects(result.projects);
        setListError(null);
      },
      (cause: unknown) => setListError(messageOf(cause)),
    );
  }, [rpc]);

  const refetchDetail = useCallback(
    (slug: string) => {
      rpc.call("specs_get", { idOrSlug: slug }).then(
        (result) => {
          setDetail(result as SpecDetail);
          setDetailError(null);
        },
        (cause: unknown) => {
          setDetail(null);
          setDetailError(messageOf(cause));
        },
      );
    },
    [rpc],
  );

  useEffect(() => {
    refetchList();
  }, [refetchList]);

  useEffect(() => {
    if (selectedSlug === "") {
      setDetail(null);
      return;
    }
    refetchDetail(selectedSlug);
  }, [selectedSlug, refetchDetail]);

  useEffect(() => {
    if (tabPart === "annotations") setRail("comments");
    else if (tabPart === "chat") setRail("chat");
    else setRail("none");
  }, [tabPart, selectedSlug]);

  useRealtime("specs-changed", () => {
    refetchList();
    if (selectedSlug !== "") refetchDetail(selectedSlug);
  });

  const detailKey =
    detail === null ? "" : `${detail.spec.id}:${detail.spec.revision}`;
  useEffect(() => {
    if (detail === null) return;
    if (pendingCreateRef.current === detail.spec.id) {
      pendingCreateRef.current = null;
      editingSpecRef.current = detail.spec.id;
      setTitleDraft(detail.spec.title);
      setSummaryDraft(detail.spec.summary);
      setContentDraft(detail.spec.content);
      setEditing(true);
      focusTitleRef.current = true;
      return;
    }
    if (editingSpecRef.current === detail.spec.id) return;
    setTitleDraft(detail.spec.title);
    setSummaryDraft(detail.spec.summary);
    setContentDraft(detail.spec.content);
    setEditing(false);
    editingSpecRef.current = null;
  }, [detailKey, detail]);

  useEffect(() => {
    if (!editing || !focusTitleRef.current) return;
    focusTitleRef.current = false;
    const input = titleInputRef.current;
    if (input !== null) {
      input.focus();
      input.select();
    }
  }, [editing, detailKey]);

  useEffect(() => {
    detailRef.current = detail;
  }, [detail]);

  useEffect(() => {
    draftsRef.current = {
      title: titleDraft,
      summary: summaryDraft,
      content: contentDraft,
    };
  }, [titleDraft, summaryDraft, contentDraft]);

  useAnnotationHighlights(previewRef, detail?.annotations ?? [], detailKey);

  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );

  const openAnnotations = (detail?.annotations ?? []).filter(
    (annotation) => annotation.status === "open",
  );

  const dirty =
    editing &&
    detail !== null &&
    (titleDraft !== detail.spec.title ||
      summaryDraft !== detail.spec.summary ||
      contentDraft !== detail.spec.content);

  useEffect(() => {
    if (saveState !== "saved") return;
    const timer = setTimeout(() => setSaveState("idle"), 2500);
    return () => clearTimeout(timer);
  }, [saveState]);

  const save = useCallback(
    async (options?: { silent?: boolean }) => {
      const current = detailRef.current;
      if (current === null || savingRef.current) return;
      savingRef.current = true;
      setSaveState("saving");
      const drafts = draftsRef.current;
      try {
        await rpc.call("specs_save", {
          id: current.spec.id,
          title: drafts.title.trim() === "" ? current.spec.title : drafts.title.trim(),
          summary: drafts.summary,
          content: drafts.content,
          expectedRevision: current.spec.revision,
        });
        setSaveState("saved");
        if (options?.silent !== true) toast.success("Spec saved");
        refetchList();
        refetchDetail(selectedSlug);
      } catch (cause) {
        setSaveState("error");
        toast.error(messageOf(cause));
      } finally {
        savingRef.current = false;
      }
    },
    [rpc, refetchList, refetchDetail, selectedSlug],
  );

  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(() => {
      void save({ silent: true });
    }, 1200);
    return () => clearTimeout(timer);
  }, [dirty, titleDraft, summaryDraft, contentDraft, save]);

  // Dismiss floating pieces on Escape or outside press.
  useEffect(() => {
    if (selectionMenu === null && annotationDraft === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectionMenu(null);
        setAnnotationDraft(null);
      }
    };
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target !== null &&
        (target.closest(".specs-toolbar") !== null ||
          target.closest(".specs-popover") !== null)
      ) {
        return;
      }
      setSelectionMenu(null);
      setAnnotationDraft(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [selectionMenu, annotationDraft]);

  const beginEdit = () => {
    if (detail === null) return;
    editingSpecRef.current = detail.spec.id;
    setTitleDraft(detail.spec.title);
    setSummaryDraft(detail.spec.summary);
    setContentDraft(detail.spec.content);
    setEditing(true);
  };

  const finishEdit = () => {
    editingSpecRef.current = null;
    setEditing(false);
    if (dirty) void save();
  };

  const cancelEdit = () => {
    if (detail === null) return;
    editingSpecRef.current = null;
    setTitleDraft(detail.spec.title);
    setSummaryDraft(detail.spec.summary);
    setContentDraft(detail.spec.content);
    setEditing(false);
    setSaveState("idle");
  };

  const selectSpec = (slug: string) => {
    if (slug === selectedSlug) return;
    setEditing(false);
    editingSpecRef.current = null;
    onSelectSpec(slug);
  };

  const defaultProjectId =
    detail?.links[0]?.projectId ?? bbContext.projectId ?? null;

  // Notion/Craft-style creation: make an Untitled spec immediately, open it,
  // and put the caret in the title instead of showing a form.
  const createSpec = async (projectId: string | null) => {
    if (creating) return;
    setCreating(true);
    try {
      const created = await rpc.call("specs_create", {
        title: "Untitled",
        projectIds: projectId === null ? [] : [projectId],
      });
      pendingCreateRef.current = created.id;
      refetchList();
      navigate.toPluginPanel("specs", { subPath: created.slug });
    } catch (cause) {
      toast.error(messageOf(cause));
    } finally {
      setCreating(false);
    }
  };

  const setRailAndNavigate = (next: "none" | "comments" | "chat") => {
    setRail(next);
    onSelectTab(
      next === "none" ? "document" : next === "comments" ? "annotations" : "chat",
    );
  };

  const openEmoji = async (emoji: string) => {
    setEmojiOpen(false);
    if (detail === null) return;
    try {
      await rpc.call("specs_save", {
        id: detail.spec.id,
        icon: emoji,
        expectedRevision: detail.spec.revision,
      });
      refetchList();
      refetchDetail(selectedSlug);
    } catch (cause) {
      toast.error(messageOf(cause));
    }
  };

  const applyLinks = async (
    next: Array<{ projectId: string; mode: LinkMode }>,
  ) => {
    if (detail === null) return;
    try {
      await rpc.call("specs_set_projects", { id: detail.spec.id, links: next });
      refetchList();
      refetchDetail(selectedSlug);
    } catch (cause) {
      toast.error(messageOf(cause));
      refetchDetail(selectedSlug);
    }
  };

  const setStatus = async (status: "active" | "archived") => {
    if (detail === null) return;
    try {
      await rpc.call("specs_archive", {
        id: detail.spec.id,
        archived: status === "archived",
      });
      toast.success(status === "archived" ? "Spec archived" : "Spec restored");
      refetchList();
      refetchDetail(selectedSlug);
    } catch (cause) {
      toast.error(messageOf(cause));
    }
  };

  const deleteCurrentSpec = async () => {
    if (detail === null || deleteBusy) return;
    setDeleteBusy(true);
    try {
      const result = await rpc.call("specs_delete", { id: detail.spec.id });
      setDeleteOpen(false);
      toast.success(
        result.archivedThreadId === null
          ? "Spec deleted"
          : "Spec deleted · chat thread archived",
      );
      setDetail(null);
      refetchList();
      navigate.toPluginPanel("specs");
    } catch (cause) {
      toast.error(messageOf(cause));
    } finally {
      setDeleteBusy(false);
    }
  };

  const startChat = async () => {
    if (detail === null || chatBusy) return;
    setChatBusy(true);
    try {
      const result = await rpc.call("chat_ensure", { specId: detail.spec.id });
      toast.success(result.created ? "Chat thread created" : "Chat thread ready");
      refetchDetail(selectedSlug);
      setRailAndNavigate("chat");
    } catch (cause) {
      toast.error(messageOf(cause));
    } finally {
      setChatBusy(false);
    }
  };

  const postDiscussion = async () => {
    const value = chatText.trim();
    if (detail === null || value === "" || chatBusy) return;
    setChatBusy(true);
    try {
      await rpc.call("discussion_post", { specId: detail.spec.id, body: value });
      setChatText("");
      refetchDetail(selectedSlug);
    } catch (cause) {
      toast.error(messageOf(cause));
    } finally {
      setChatBusy(false);
    }
  };

  const askAgentChat = async () => {
    const raw = chatText.trim();
    if (detail === null || raw === "" || chatBusy) return;
    const value = raw.toLowerCase().startsWith("@agent")
      ? raw.slice(6).trim()
      : raw;
    if (value === "") return;
    setChatBusy(true);
    try {
      await rpc.call("chat_ask", { specId: detail.spec.id, text: value });
      setChatText("");
      toast.success("Sent to the agent");
      refetchDetail(selectedSlug);
    } catch (cause) {
      toast.error(messageOf(cause));
    } finally {
      setChatBusy(false);
    }
  };

  const sendChat = async () => {
    const value = chatText.trim();
    if (value === "") return;
    if (value.toLowerCase().startsWith("@agent")) {
      await askAgentChat();
      return;
    }
    await postDiscussion();
  };

  const applyProposal = async (proposalId: string) => {
    if (proposalBusy) return;
    setProposalBusy(true);
    try {
      const result = await rpc.call("proposals_apply", { proposalId });
      toast.success(`Applied as v${result.revision}`);
      refetchList();
      refetchDetail(selectedSlug);
    } catch (cause) {
      toast.error(messageOf(cause));
      refetchDetail(selectedSlug);
    } finally {
      setProposalBusy(false);
    }
  };

  const rejectProposal = async (proposalId: string, note: string) => {
    if (proposalBusy) return;
    setProposalBusy(true);
    try {
      await rpc.call("proposals_reject", { proposalId, note });
      toast.success("Proposal rejected");
      refetchDetail(selectedSlug);
    } catch (cause) {
      toast.error(messageOf(cause));
    } finally {
      setProposalBusy(false);
    }
  };

  const ackChange = async (revision: number) => {
    if (detail === null || changeBusy) return;
    setChangeBusy(true);
    try {
      await rpc.call("specs_ack_agent_change", {
        id: detail.spec.id,
        revision,
      });
      refetchDetail(selectedSlug);
    } catch (cause) {
      toast.error(messageOf(cause));
    } finally {
      setChangeBusy(false);
    }
  };

  const revertChange = async (toRevision: number) => {
    if (detail === null || changeBusy) return;
    setChangeBusy(true);
    try {
      const result = await rpc.call("specs_revert", {
        id: detail.spec.id,
        toRevision,
      });
      toast.success(`Reverted to v${toRevision}'s content (new v${result.revision})`);
      refetchList();
      refetchDetail(selectedSlug);
    } catch (cause) {
      toast.error(messageOf(cause));
    } finally {
      setChangeBusy(false);
    }
  };

  const startResearch = async () => {
    const brief = researchBrief.trim();
    if (detail === null || brief === "" || researchBusy) return;
    setResearchBusy(true);
    try {
      await rpc.call("research_start", { specId: detail.spec.id, brief });
      setResearchOpen(false);
      setResearchBrief("");
      toast.success("Research started — the report lands as a child spec");
      refetchDetail(selectedSlug);
    } catch (cause) {
      toast.error(messageOf(cause));
    } finally {
      setResearchBusy(false);
    }
  };

  const submitAnnotation = async () => {
    if (detail === null || annotationDraft === null) return;
    const body = annotationDraft.body.trim();
    if (body === "") return;
    try {
      await rpc.call("annotations_create", {
        specId: detail.spec.id,
        quote: annotationDraft.quote,
        prefix: annotationDraft.prefix,
        suffix: annotationDraft.suffix,
        body,
        kind: annotationDraft.kind,
      });
      const wasQuestion = annotationDraft.kind === "question";
      setAnnotationDraft(null);
      setRailAndNavigate("comments");
      toast.success(
        wasQuestion
          ? "Question sent — the agent replies in this thread"
          : "Comment added",
      );
      refetchDetail(selectedSlug);
    } catch (cause) {
      toast.error(messageOf(cause));
    }
  };

  const locateAnnotation = (annotation: Annotation) => {
    const container = previewRef.current;
    if (container === null) return;
    if (editing) {
      toast("Leave edit mode to find the quote.");
      return;
    }
    const range = findAnnotationRange(container, annotation);
    if (range === null) {
      toast.error("That quote is no longer in the document.");
      return;
    }
    const element =
      range.startContainer.parentElement ??
      (range.startContainer as HTMLElement | null);
    element?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const handleMouseUp = () => {
    if (editing) return;
    const container = previewRef.current;
    if (container === null) {
      setSelectionMenu(null);
      return;
    }
    const location = captureSelection(container);
    if (location === null) {
      setSelectionMenu(null);
      return;
    }
    const selection = window.getSelection();
    if (selection === null || selection.rangeCount === 0) return;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    setSelectionMenu({
      ...location,
      x: rect.left + rect.width / 2,
      y: rect.top,
    });
  };

  const toolbarTop =
    selectionMenu === null
      ? 0
      : selectionMenu.y - 48 < 8
        ? selectionMenu.y + 28
        : selectionMenu.y - 48;

  const popoverLeft =
    annotationDraft === null
      ? 0
      : Math.min(Math.max(annotationDraft.x, 182), window.innerWidth - 182);
  const popoverTop =
    annotationDraft === null
      ? 0
      : annotationDraft.y + 220 > window.innerHeight
        ? Math.max(12, annotationDraft.y - 232)
        : annotationDraft.y + 16;

  const projectLabel =
    detail === null || detail.links.length === 0
      ? "No project"
      : detail.links
          .map((link) => projectNames.get(link.projectId) ?? link.projectId)
          .join(", ");

  return (
    <div className="specs-root relative flex h-full min-h-0 w-full bg-background text-foreground">
      {showSidebar ? (
        <SpecsSidebar
          specs={specs}
          projects={projects}
          selectedSlug={selectedSlug}
          query={query}
          onQuery={setQuery}
          onSelect={selectSpec}
          onNewDefault={() => void createSpec(defaultProjectId)}
          onNewInGroup={(projectId) => void createSpec(projectId)}
        />
      ) : null}

      <main className="flex min-w-0 flex-1 flex-col">
        {detail === null ? (
          chrome === "route" ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-8">
            <div className="w-full max-w-sm space-y-3">
              {detailError === null ? (
                <div className="space-y-3 text-center">
                  <div className="text-4xl">📄</div>
                  <p className="text-sm text-muted-foreground">
                    Select a spec, or start a new one.
                  </p>
                  {(specs ?? []).length > 0 ? (
                    <select
                      aria-label="Select spec"
                      defaultValue=""
                      className="mx-auto block w-full max-w-xs rounded-md border border-input bg-transparent px-2 py-1.5 text-sm"
                      onChange={(event) => {
                        if (event.target.value !== "") selectSpec(event.target.value);
                      }}
                    >
                      <option value="" disabled>
                        Choose a spec…
                      </option>
                      {(specs ?? []).map((spec) => (
                        <option key={spec.id} value={spec.slug}>
                          {spec.title}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </div>
              ) : (
                <ErrorText>{detailError}</ErrorText>
              )}
              <div className="flex justify-center">
                <Button
                  variant="outline"
                  disabled={creating}
                  onClick={() => void createSpec(defaultProjectId)}
                >
                  <Icon name="Plus" className="size-4" />
                  New spec
                </Button>
              </div>
            </div>
          </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              {detailError === null ? null : (
                <p className="border-b border-border px-4 py-2 text-sm text-destructive">
                  {detailError}
                </p>
              )}
              <SpecPicker
                specs={specs}
                projects={projects}
                selectedSlug={selectedSlug}
                onSelect={selectSpec}
                onNew={() => void createSpec(defaultProjectId)}
              />
            </div>
          )
        ) : (
          <>
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
              {chrome === "route" || selectedSlug === "" ? null : (
                <IconButton label="All specs" onClick={() => onSelectSpec("")}>
                  <Icon name="ChevronLeft" className="size-4" />
                </IconButton>
              )}
              <div className="min-w-0 flex-1 md:hidden">
                <select
                  aria-label="Select spec"
                  className="h-8 w-full truncate rounded-md bg-secondary/50 px-2 text-xs text-foreground"
                  value={selectedSlug}
                  onChange={(event) => selectSpec(event.target.value)}
                >
                  {(specs ?? []).map((spec) => (
                    <option key={spec.id} value={spec.slug}>
                      {spec.title}
                    </option>
                  ))}
                </select>
              </div>
              <span className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground md:block">
                {projectLabel}
                <span className="px-1.5 opacity-50">/</span>
                <span className="text-foreground/80">{detail.spec.title}</span>
              </span>
              <span className="md:hidden">
                <IconButton
                  label="New spec"
                  onClick={() => void createSpec(defaultProjectId)}
                >
                  <Icon name="Plus" className="size-4" />
                </IconButton>
              </span>
              {editing ? (
                <>
                  <span className="pr-1 text-[11px] text-muted-foreground tabular-nums">
                    {saveState === "saving"
                      ? "Saving…"
                      : saveState === "saved"
                        ? "Saved"
                        : saveState === "error"
                          ? "Not saved"
                          : "Draft"}
                  </span>
                  <Button size="sm" variant="ghost" onClick={cancelEdit}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={finishEdit}>
                    Done
                  </Button>
                </>
              ) : (
                <>
                  <IconButton
                    label="Comments"
                    active={rail === "comments"}
                    onClick={() =>
                      setRailAndNavigate(rail === "comments" ? "none" : "comments")
                    }
                  >
                    <span className="relative">
                      <Icon name="MessageSquare" className="size-4" />
                      {openAnnotations.length > 0 ? (
                        <span className="absolute -right-1 -top-1 size-1.5 rounded-full bg-primary" />
                      ) : null}
                    </span>
                  </IconButton>
                  <IconButton
                    label="Chat"
                    active={rail === "chat"}
                    onClick={() => setRailAndNavigate(rail === "chat" ? "none" : "chat")}
                  >
                    <Icon name="MessageCirclePlus" className="size-4" />
                  </IconButton>
                  <span className="mx-1 h-4 w-px bg-border" />
                  <IconButton label="Edit" onClick={beginEdit}>
                    <Icon name="Edit" className="size-4" />
                  </IconButton>
                  <IconButton
                    label="Run research"
                    onClick={() => setResearchOpen(true)}
                  >
                    <Icon name="Beaker" className="size-4" />
                  </IconButton>
                  <IconButton
                    label="Delete spec"
                    onClick={() => setDeleteOpen(true)}
                  >
                    <Icon name="Trash2" className="size-4" />
                  </IconButton>
                </>
              )}
            </div>

            <div
              ref={scrollRef}
              onScroll={() => setSelectionMenu(null)}
              onMouseUp={handleMouseUp}
              className="specs-scroll min-h-0 flex-1 overflow-y-auto"
            >
              <div className="mx-auto w-full max-w-[720px] px-6 pb-40 pt-12 md:px-10">
                <div className="mb-2">
                  <button
                    type="button"
                    onClick={() => setEmojiOpen(true)}
                    title="Change icon"
                    className="specs-press cursor-pointer rounded-lg p-1 text-[38px] leading-none hover:bg-state-hover"
                  >
                    {detail.spec.icon}
                  </button>
                </div>

                {editing ? (
                  <input
                    ref={titleInputRef}
                    value={titleDraft}
                    onChange={(event) => setTitleDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key === "s") {
                        event.preventDefault();
                        void save();
                      }
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        contentInputRef.current?.focus();
                      }
                      if (event.key === "Escape") cancelEdit();
                    }}
                    placeholder="Untitled"
                    className="w-full bg-transparent text-3xl font-semibold tracking-tight text-foreground outline-none placeholder:text-muted-foreground/40 md:text-4xl"
                  />
                ) : (
                  <h1
                    onClick={beginEdit}
                    title="Click to edit"
                    className="cursor-text text-3xl font-semibold tracking-tight text-balance md:text-4xl"
                  >
                    {detail.spec.title}
                  </h1>
                )}

                {editing ? (
                  <input
                    value={summaryDraft}
                    onChange={(event) => setSummaryDraft(event.target.value)}
                    placeholder="Add a one-line summary…"
                    className="mt-2 w-full bg-transparent text-sm text-muted-foreground outline-none placeholder:text-muted-foreground/40"
                  />
                ) : detail.spec.summary === "" ? null : (
                  <p className="mt-2 text-sm text-muted-foreground text-pretty">
                    {detail.spec.summary}
                  </p>
                )}

                <div className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums">
                  <span>v{detail.spec.revision}</span>
                  <span className="opacity-50">·</span>
                  <span>Updated {relativeTime(detail.spec.updatedAt)}</span>
                  {openAnnotations.length > 0 ? (
                    <>
                      <span className="opacity-50">·</span>
                      <button
                        type="button"
                        onClick={() => setRailAndNavigate("comments")}
                        className="cursor-pointer text-primary hover:underline"
                      >
                        {openAnnotations.length} open comment
                        {openAnnotations.length === 1 ? "" : "s"}
                      </button>
                    </>
                  ) : null}
                  {detail.spec.status === "archived" ? (
                    <>
                      <span className="opacity-50">·</span>
                      <span className="uppercase">archived</span>
                    </>
                  ) : null}
                </div>

                <PropertiesBar
                  projects={projects}
                  links={detail.links}
                  status={detail.spec.status}
                  onLinks={(next) => void applyLinks(next)}
                  onStatus={(next) => void setStatus(next)}
                />

                {detail.agentChange === null &&
                detail.proposals.length === 0 &&
                detail.research.length === 0 ? null : (
                  <div className="mt-4">
                    {detail.agentChange === null ? null : (
                      <AgentChangeCard
                        change={detail.agentChange}
                        busy={changeBusy}
                        onReview={() =>
                          setDiffTarget({
                            specId: detail.spec.id,
                            title: detail.spec.title,
                            from:
                              detail.agentChange?.previousRevision ??
                              detail.agentChange?.revision ??
                              1,
                            to: detail.agentChange?.revision ?? null,
                          })
                        }
                        onKeep={() =>
                          void ackChange(detail.agentChange?.revision ?? 0)
                        }
                        onRevert={() =>
                          void revertChange(
                            detail.agentChange?.previousRevision ?? 1,
                          )
                        }
                      />
                    )}
                    {detail.proposals.map((proposal) => (
                      <ProposalCard
                        key={proposal.id}
                        proposal={proposal}
                        busy={proposalBusy}
                        onReview={() =>
                          setDiffTarget({
                            specId: detail.spec.id,
                            title:
                              proposal.note === ""
                                ? detail.spec.title
                                : proposal.note,
                            from: proposal.baseRevision,
                            to: null,
                            content: proposal.content,
                          })
                        }
                        onApply={() => void applyProposal(proposal.id)}
                        onReject={(note) => void rejectProposal(proposal.id, note)}
                      />
                    ))}
                    {detail.research.slice(0, 3).map((run) => (
                      <ResearchCard
                        key={run.id}
                        run={run}
                        onOpenRun={() => navigate.toThread(run.threadId)}
                        onOpenResult={() => {
                          if (run.resultSpecId !== null) {
                            selectSpec(run.resultSpecId);
                          }
                        }}
                      />
                    ))}
                  </div>
                )}

                <div className="mt-6 border-t border-border pt-6">
                  {editing ? (
                    <textarea
                      ref={contentInputRef}
                      value={contentDraft}
                      onChange={(event) => setContentDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === "s") {
                          event.preventDefault();
                          void save();
                        }
                        if (event.key === "Escape") cancelEdit();
                      }}
                      placeholder="# Overview&#10;&#10;Write the spec in markdown. Select text in the reading view to comment on it."
                      className="specs-editor min-h-[50vh] w-full"
                    />
                  ) : detail.spec.content.trim() === "" ? (
                    <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center">
                      <p className="text-sm text-muted-foreground">
                        This spec is empty.
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-3"
                        onClick={beginEdit}
                      >
                        Start writing
                      </Button>
                    </div>
                  ) : (
                    <div ref={previewRef} className="specs-doc">
                      <Markdown content={detail.spec.content} />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </main>

      {detail !== null && rail !== "none" ? (
        <aside className="specs-rail absolute inset-y-0 right-0 z-40 flex w-full flex-col overflow-hidden border-l border-border bg-background md:static md:w-[340px] md:shrink-0">
          {rail === "comments" ? (
            <CommentsRail
              annotations={detail.annotations}
              decisions={detail.decisions}
              textQuestions={detail.textQuestions}
              textDecisions={detail.textDecisions}
              onClose={() => setRailAndNavigate("none")}
              onReply={async (annotationId, body) => {
                try {
                  await rpc.call("annotations_comment", { annotationId, body });
                  refetchDetail(selectedSlug);
                } catch (cause) {
                  toast.error(messageOf(cause));
                }
              }}
              onStatus={async (annotationId, status) => {
                try {
                  await rpc.call("annotations_set_status", { annotationId, status });
                  refetchDetail(selectedSlug);
                } catch (cause) {
                  toast.error(messageOf(cause));
                }
              }}
              onRemove={async (annotationId) => {
                try {
                  await rpc.call("annotations_remove", { annotationId });
                  toast.success("Comment removed");
                  refetchDetail(selectedSlug);
                } catch (cause) {
                  toast.error(messageOf(cause));
                }
              }}
              onLocate={locateAnnotation}
              onAnswer={async (annotationId, answer) => {
                try {
                  await rpc.call("questions_answer", { annotationId, answer });
                  toast.success("Answered — waiting for triage");
                  refetchDetail(selectedSlug);
                } catch (cause) {
                  toast.error(messageOf(cause));
                }
              }}
              onClarify={async (annotationId, question) => {
                try {
                  await rpc.call("questions_clarify", { annotationId, question });
                  toast.success("Follow-up question added");
                  refetchDetail(selectedSlug);
                } catch (cause) {
                  toast.error(messageOf(cause));
                }
              }}
              onResolve={async (annotationId, decision) => {
                try {
                  await rpc.call("questions_resolve", { annotationId, decision });
                  toast.success("Question resolved");
                  refetchDetail(selectedSlug);
                } catch (cause) {
                  toast.error(messageOf(cause));
                }
              }}
              onDismiss={async (annotationId, reason) => {
                try {
                  await rpc.call("questions_dismiss", { annotationId, reason });
                  toast.success("Question dismissed");
                  refetchDetail(selectedSlug);
                } catch (cause) {
                  toast.error(messageOf(cause));
                }
              }}
              onReopen={async (annotationId) => {
                try {
                  await rpc.call("questions_reopen", { annotationId });
                  refetchDetail(selectedSlug);
                } catch (cause) {
                  toast.error(messageOf(cause));
                }
              }}
              onPromote={async (text) => {
                try {
                  const result = await rpc.call("questions_promote", {
                    specId: detail.spec.id,
                    text,
                  });
                  toast.success(`Promoted to ${result.annotationId}`);
                  refetchDetail(selectedSlug);
                  refetchList();
                } catch (cause) {
                  toast.error(messageOf(cause));
                }
              }}
            />
          ) : detail.chatThreadId === null ? (
            <>
              <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
                <span className="min-w-0 flex-1 text-xs font-medium">Chat</span>
                <IconButton label="Close chat" onClick={() => setRailAndNavigate("none")}>
                  <Icon name="X" className="size-3.5" />
                </IconButton>
              </div>
              <div className="flex min-h-0 flex-1 items-center justify-center p-6">
                <div className="space-y-3 text-center">
                  <EmptyState>
                    Chat creates a real BB thread linked to this spec, so the agent
                    can read and update it and the conversation stays in the
                    sidebar.
                  </EmptyState>
                  <Button onClick={() => void startChat()} disabled={chatBusy}>
                    <Icon name="MessageCirclePlus" className="size-4" />
                    {chatBusy ? "Starting…" : "Start chat"}
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
                <button
                  type="button"
                  onClick={() => navigate.toThread(detail.chatThreadId!)}
                  className="min-w-0 flex-1 cursor-pointer truncate text-left text-xs font-medium hover:underline"
                >
                  Chat
                </button>
                <IconButton
                  label="Open thread in sidebar"
                  onClick={() => navigate.toThread(detail.chatThreadId!)}
                >
                  <Icon name="NewTab" className="size-3.5" />
                </IconButton>
                <IconButton label="Close chat" onClick={() => setRailAndNavigate("none")}>
                  <Icon name="X" className="size-3.5" />
                </IconButton>
              </div>
              <div className="min-h-0 flex-1">
                <ThreadChat
                  threadId={detail.chatThreadId}
                  variant="timeline"
                  className="h-full"
                />
              </div>
              <div className="shrink-0 border-t border-border p-3">
                {detail.discussion.length === 0 ? null : (
                  <div className="specs-scroll max-h-32 space-y-1.5 overflow-y-auto pb-1">
                    {detail.discussion.slice(-8).map((message) => (
                      <div key={message.id} className="text-xs leading-relaxed">
                        <span className="font-medium">
                          {displayAuthor(message.author)}
                        </span>
                        <span className="ml-1.5 text-[10px] text-muted-foreground tabular-nums">
                          {relativeTime(message.createdAt)}
                        </span>
                        <p
                          className={cn(
                            "text-foreground/90",
                            message.consumedAt === null
                              ? undefined
                              : "text-muted-foreground",
                          )}
                        >
                          {truncate(message.body, 300)}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
                <textarea
                  value={chatText}
                  onChange={(event) => setChatText(event.target.value)}
                  placeholder="Discuss — or start with @agent to run the agent…"
                  className={cn(textareaClassName, "mt-2 h-16 rounded-xl text-sm")}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void sendChat();
                    }
                  }}
                />
                <div className="mt-1.5 flex items-center justify-between gap-2">
                  <span className="text-[10px] text-muted-foreground">
                    Posts are context; only @agent runs the agent.
                  </span>
                  <span className="flex shrink-0 gap-1.5">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      disabled={chatBusy || chatText.trim() === ""}
                      onClick={() => void postDiscussion()}
                    >
                      Post
                    </Button>
                    <Button
                      size="sm"
                      className="h-7 px-2.5"
                      disabled={chatBusy || chatText.trim() === ""}
                      onClick={() => void askAgentChat()}
                    >
                      Ask agent
                    </Button>
                  </span>
                </div>
              </div>
            </div>
          )}
        </aside>
      ) : null}

      {selectionMenu === null ? null : (
        <div
          className="specs-toolbar"
          style={{ left: selectionMenu.x, top: toolbarTop }}
          onMouseDown={(event) => event.preventDefault()}
        >
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(selectionMenu.quote).then(
                () => toast.success("Copied"),
                () => toast.error("Could not copy"),
              );
              setSelectionMenu(null);
            }}
            className="specs-press flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground"
          >
            <Icon name="Copy" className="size-3.5" />
            Copy
          </button>
          <span className="mx-0.5 h-4 w-px bg-border" />
          <button
            type="button"
            onClick={() => {
              setAnnotationDraft({ ...selectionMenu, body: "", kind: "note" });
              setSelectionMenu(null);
            }}
            className="specs-press flex cursor-pointer items-center gap-1.5 rounded-lg bg-foreground px-2.5 py-1.5 text-xs font-medium text-background hover:bg-foreground/90"
          >
            <Icon name="MessageSquare" className="size-3.5" />
            Comment
          </button>
          <button
            type="button"
            onClick={() => {
              setAnnotationDraft({ ...selectionMenu, body: "", kind: "question" });
              setSelectionMenu(null);
            }}
            className="specs-press flex cursor-pointer items-center gap-1.5 rounded-lg border border-input px-2.5 py-1.5 text-xs font-medium hover:bg-state-hover"
          >
            <Icon name="MessageQuestion" className="size-3.5" />
            Question
          </button>
        </div>
      )}

      {annotationDraft === null ? null : (
        <div
          className="specs-popover p-3"
          style={{ left: popoverLeft, top: popoverTop }}
        >
          <blockquote className="border-l-2 border-primary/40 pl-2.5 text-xs leading-relaxed text-muted-foreground">
            {truncate(annotationDraft.quote, 180)}
          </blockquote>
          <div className="mt-2 flex items-center rounded-lg bg-secondary/60 p-0.5">
            {(
              [
                ["note", "Comment"],
                ["question", "Question"],
              ] as Array<["note" | "question", string]>
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() =>
                  setAnnotationDraft((current) =>
                    current === null ? current : { ...current, kind: value },
                  )
                }
                className={cn(
                  "specs-press flex-1 cursor-pointer rounded-[6px] px-2 py-1 text-[11px]",
                  annotationDraft.kind === value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <textarea
            autoFocus
            value={annotationDraft.body}
            onChange={(event) =>
              setAnnotationDraft((current) =>
                current === null
                  ? current
                  : { ...current, body: event.target.value },
              )
            }
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void submitAnnotation();
              }
              if (event.key === "Escape") setAnnotationDraft(null);
            }}
            placeholder={
              annotationDraft.kind === "question"
                ? "Ask a question an agent should answer or decide…"
                : "Add a comment…"
            }
            className={cn(textareaClassName, "mt-2 h-24 rounded-xl")}
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <span className="mr-auto text-[10px] text-muted-foreground">
              ⌘↵ to add
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={() => setAnnotationDraft(null)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-7 px-2.5"
              disabled={annotationDraft.body.trim() === ""}
              onClick={() => void submitAnnotation()}
            >
              {annotationDraft.kind === "question" ? "Ask" : "Comment"}
            </Button>
          </div>
        </div>
      )}

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-base">
              Delete “{detail?.spec.title ?? ""}”?
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground text-pretty">
            This permanently removes the document, its annotations, and its
            revision history.
            {detail?.chatThreadId === null || detail?.chatThreadId === undefined
              ? ""
              : " Its chat thread is archived, not deleted."}
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteBusy}
              onClick={() => void deleteCurrentSpec()}
            >
              {deleteBusy ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={researchOpen} onOpenChange={setResearchOpen}>
        <DialogContent className="max-w-lg rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-base">Run research</DialogTitle>
          </DialogHeader>
          <textarea
            autoFocus
            value={researchBrief}
            onChange={(event) => setResearchBrief(event.target.value)}
            placeholder="What should the agent investigate? e.g. compare the two export formats and recommend one."
            className={cn(textareaClassName, "h-24 rounded-xl")}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void startResearch();
              }
            }}
          />
          <p className="text-xs text-muted-foreground">
            A background agent investigates read-only and publishes the report as
            a child spec with its own questions and decisions. Progress shows at
            the top of this page.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setResearchOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={researchBusy || researchBrief.trim() === ""}
              onClick={() => void startResearch()}
            >
              {researchBusy ? "Starting…" : "Start research"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DiffDialog
        target={diffTarget}
        onOpenChange={(open) => {
          if (!open) setDiffTarget(null);
        }}
      />

      <EmojiPickerDialog
        open={emojiOpen}
        current={detail?.spec.icon ?? "📄"}
        onOpenChange={setEmojiOpen}
        onPick={(emoji) => void openEmoji(emoji)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Spec pickers and shells (route page, thread panel tab, app overlay)
// ---------------------------------------------------------------------------

function SpecPicker({
  specs,
  projects,
  selectedSlug,
  onSelect,
  onNew,
}: {
  specs: SpecSummary[] | null;
  projects: ProjectSummary[];
  selectedSlug: string;
  onSelect: (slug: string) => void;
  onNew: () => void;
}) {
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  const [query, setQuery] = useState("");
  const visible = (specs ?? []).filter((spec) => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return true;
    return `${spec.title} ${spec.slug} ${spec.summary}`
      .toLowerCase()
      .includes(needle);
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border p-3">
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Icon
              name="Search"
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search specs"
              className="h-8 bg-secondary/50 pl-8 text-xs"
              autoFocus
            />
          </div>
          <Button size="sm" className="h-8 shrink-0 px-2.5" onClick={onNew}>
            <Icon name="Plus" className="size-3.5" />
            New
          </Button>
        </div>
      </div>
      <div className="specs-scroll min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
        {specs === null ? (
          <p className="p-2 text-sm text-muted-foreground">Loading…</p>
        ) : visible.length === 0 ? (
          <div className="p-1">
            <EmptyState>
              {specs.length === 0
                ? "No specs yet. Create one, or let an agent call specs_create."
                : "Nothing matches."}
            </EmptyState>
          </div>
        ) : (
          visible.map((spec) => {
            const selected = spec.slug === selectedSlug;
            const projectLabel = spec.projectIds
              .map((id) => projectNames.get(id) ?? id)
              .join(", ");
            return (
              <button
                key={spec.id}
                type="button"
                onClick={() => onSelect(spec.slug)}
                className={cn(
                  "specs-row flex w-full items-center gap-2 rounded-md px-2 py-2 text-left",
                  selected
                    ? "bg-state-active text-foreground"
                    : "text-foreground/90 hover:bg-state-hover",
                )}
              >
                <span className="w-5 shrink-0 text-center text-sm leading-none">
                  {spec.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{spec.title}</span>
                  <span className="block truncate text-[11px] text-muted-foreground tabular-nums">
                    {projectLabel === "" ? "unlinked" : projectLabel} · v
                    {spec.revision} · {relativeTime(spec.updatedAt)}
                  </span>
                </span>
                {spec.openAnnotations > 0 ? (
                  <span className="shrink-0 rounded-full bg-primary/15 px-1.5 text-[10px] text-primary tabular-nums">
                    {spec.openAnnotations}
                  </span>
                ) : null}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

/** The classic sidebar page: full spec list plus the workspace. */
function SpecsPage({ subPath }: { subPath: string }) {
  const navigate = useBbNavigate();
  const [slugPart = "", tabPart = ""] = subPath.split("/");
  return (
    <SpecsWorkspace
      selectedSlug={slugPart}
      tabPart={tabPart}
      showSidebar
      chrome="route"
      onSelectSpec={(slug) => navigate.toPluginPanel("specs", { subPath: slug })}
      onSelectTab={(tab) => {
        navigate.toPluginPanel("specs", {
          subPath: tab === "document" ? slugPart : `${slugPart}/${tab}`,
        });
      }}
    />
  );
}

/** Specs rendered as a closable tab in a thread's right panel. */
function SpecsPanelTab({ params }: { params: unknown }) {
  const initial =
    typeof params === "object" &&
    params !== null &&
    typeof (params as { specId?: unknown }).specId === "string"
      ? (params as { specId: string }).specId
      : "";
  const [slug, setSlug] = useState(initial);
  const [tab, setTab] = useState<"document" | "annotations" | "chat">("document");
  return (
    <SpecsWorkspace
      selectedSlug={slug}
      tabPart={tab}
      showSidebar={false}
      chrome="panel"
      onSelectSpec={(next) => {
        setSlug(next);
        setTab("document");
      }}
      onSelectTab={setTab}
    />
  );
}

/** Full-screen, chrome-less Specs surface toggled from the palette or footer. */
function SpecsOverlay() {
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState(
    () => window.localStorage.getItem("specs:lastSlug") ?? "",
  );
  const [tab, setTab] = useState<"document" | "annotations" | "chat">("document");

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("specs:open", onOpen);
    return () => window.removeEventListener("specs:open", onOpen);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (slug !== "") window.localStorage.setItem("specs:lastSlug", slug);
  }, [slug]);

  if (!open) return null;
  return (
    <div className="specs-root fixed inset-0 z-[120] flex flex-col bg-background text-foreground">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <Icon name="FileText" className="size-4 text-muted-foreground" />
        <span className="text-sm font-semibold tracking-tight">Specs</span>
        <span className="min-w-0 flex-1" />
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2.5"
          onClick={() => setOpen(false)}
        >
          Close ⎋
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        <SpecsWorkspace
          selectedSlug={slug}
          tabPart={tab}
          showSidebar={false}
          chrome="overlay"
          onSelectSpec={(next) => {
            setSlug(next);
            setTab("document");
          }}
          onSelectTab={setTab}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Thread right-panel action: this thread's spec context
// ---------------------------------------------------------------------------

function linkAction(
  link: ThreadSpecLink,
): { label: string; mode: "attached" | "detached" | "default" } {
  switch (link.linkMode) {
    case "attached":
      return { label: "Detach", mode: "detached" };
    case "detached":
      return { label: "Restore", mode: "default" };
    case "project-pinned":
    case "project-auto":
      return { label: "Exclude", mode: "detached" };
    case "project-available":
      return { label: "Attach", mode: "attached" };
    default:
      return { label: "Attach", mode: "attached" };
  }
}

function ThreadSpecsPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [data, setData] = useState<ThreadSpecsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    rpc.call("thread_specs", { threadId }).then(
      (result) => {
        setData(result as ThreadSpecsResult);
        setError(null);
      },
      (cause: unknown) => setError(messageOf(cause)),
    );
  }, [rpc, threadId]);

  useEffect(load, [load]);
  useRealtime("specs-changed", load);

  const setMode = async (
    specId: string,
    mode: "attached" | "detached" | "default",
  ) => {
    setBusyId(specId);
    try {
      await rpc.call("thread_set_spec", { threadId, specId, mode });
      load();
    } catch (cause) {
      toast.error(messageOf(cause));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="specs-root space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">
            Spec context
          </h2>
          <p className="mt-1 text-xs text-muted-foreground text-pretty">
            The specs this thread receives. Attach adds one that project links
            miss; exclude removes one they include.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={() => navigate.toPluginPanel("specs")}
        >
          <Icon name="FileText" className="size-3.5" />
          Open Specs
        </Button>
      </div>

      {error !== null ? <ErrorText>{error}</ErrorText> : null}

      {data === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : data.specs.length === 0 ? (
        <EmptyState>
          No specs are linked to this thread's project. Create one from the Specs
          page to give every thread in this project shared context.
        </EmptyState>
      ) : (
        <ul className="specs-hairline overflow-hidden rounded-xl bg-card">
          {data.specs.map((link) => {
            const action = linkAction(link);
            return (
              <li
                key={link.id}
                className="group flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{link.title}</p>
                  <p className="truncate text-[11px] text-muted-foreground tabular-nums">
                    {link.slug} · v{link.revision} ·{" "}
                    {link.included ? "in context" : "not in context"}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100"
                  disabled={busyId === link.id}
                  onClick={() => void setMode(link.id, action.mode)}
                >
                  {busyId === link.id ? "…" : action.label}
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <div>
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Injected context
        </h3>
        <pre className="specs-hairline mt-1.5 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-xl bg-secondary p-3 text-xs leading-relaxed text-muted-foreground">
          {data?.digest ?? "Nothing is injected for this thread right now."}
        </pre>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "specs",
    title: "Specs",
    icon: "FileText",
    path: "specs",
    component: SpecsPage,
  });
  app.slots.threadPanelAction({
    id: "specs-workspace",
    title: "Specs",
    icon: "FileText",
    component: SpecsPanelTab,
    layout: "flush",
  });
  app.slots.threadPanelAction({
    id: "specs-context",
    title: "Spec context",
    icon: "FileText",
    component: ThreadSpecsPanel,
  });
  app.slots.experimental_appOverlay({
    id: "specs-overlay",
    component: SpecsOverlay,
  });
  app.slots.commandPaletteAction({
    id: "open-specs",
    title: "Specs: open the workspace",
    run: () => {
      window.dispatchEvent(new CustomEvent("specs:open"));
    },
  });
  app.composer.customize({
    id: "specs-open",
    plusMenu: [
      {
        id: "open-specs",
        label: "Open Specs",
        icon: "FileText",
        description: "Open the Specs workspace without leaving this thread",
        run: () => {
          window.dispatchEvent(new CustomEvent("specs:open"));
        },
      },
    ],
  });
});
