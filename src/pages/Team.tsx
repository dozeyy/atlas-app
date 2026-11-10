import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatsCircle, MagnifyingGlass, Scales } from "@phosphor-icons/react";
import { EmptyState } from "../components/EmptyState";
import { Button, SegmentedControl } from "../components/controls";
import { AgentSheet } from "../components/team/AgentSheet";
import { RuleSheet } from "../components/team/RuleSheet";
import { ScoreCard } from "../components/team/ScoreCard";
import { ThemeList } from "../components/team/ThemeList";
import { ErrorBlock, Skeleton } from "../components/usage/StateBlocks";
import { SearchField, SelectField } from "../components/usage/fields";
import { getBackend } from "../lib/ipc";
import { openAgentNext, openToolkitItemNext } from "../lib/nav";
import { plural } from "../lib/usage";
import { cacheNotReady, useFetched, useLiveReload, useUsageStatus } from "../lib/useUsage";
import { DEFAULT_PREFS, RANGES, STARTED_OPTIONS, filterCards, historyLine, loadPrefs, rangeDays, savePrefs, scorecardArgs, weeklyLegend } from "../lib/teamModel";
import type { RangeId, TeamPrefs, TeamView } from "../lib/teamModel";
import type { ReviewTheme, RunRow, StartedFrom, ThemeExample } from "../lib/teamTypes";
import { useAtlas } from "../state/AtlasProvider";
import { useSetup } from "../state/setupStore";
import { typeLabel } from "./AgentDetail";

const VIEWS: { value: TeamView; label: string }[] = [
  { value: "scorecard", label: "Scorecard" },
  { value: "review", label: "Caught in review" },
];

/** Shown instead of "none yet" while the first read of the chats is still running. */
/**
 * True while the first read of the chats is running, and until the page has an answer that was
 * asked for after it finished. The status turns ready a moment before the numbers do, and the
 * answer on screen then is still the empty one from the middle of the read: "No helper runs"
 * must not flash up in that gap. When the read finishes, one fresh answer is asked for here.
 */
function useReadingHold(reload: (silent: boolean) => void, answeredAt: number | null): boolean {
  const { status } = useUsageStatus();
  const notReady = cacheNotReady(status);
  const [sawReading, setSawReading] = useState(false);
  const [readyAt, setReadyAt] = useState<number | null>(null);
  useEffect(() => {
    if (status !== null && notReady) {
      setSawReading(true);
      setReadyAt(null);
    } else if (!notReady && sawReading && readyAt === null) {
      setReadyAt(Date.now());
      reload(true);
    }
  }, [status, notReady, sawReading, readyAt, reload]);
  const fresh = !sawReading || (readyAt !== null && answeredAt !== null && answeredAt >= readyAt);
  return notReady || !fresh;
}

const READING_TITLE = "Still reading your chats";
const READING_BODY = "This fills in by itself when the first read finishes.";

const RANGE_OPTIONS = RANGES.map((r) => ({ value: r.value, label: r.label }));

function CardsSkeleton() {
  return (
    <div aria-label="Loading" className="team-grid">
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-[196px]" />
      ))}
    </div>
  );
}

/** "Caught in review" while it loads: the list's own box and rows (two lines, then the button). */
function ThemesSkeleton() {
  return (
    <div role="status" aria-label="Loading" className="rounded-card border border-line bg-surface px-5">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} aria-hidden="true" className="flex items-start gap-3 border-b border-line py-3 last:border-b-0">
          <div className="min-w-0 flex-1">
            <Skeleton className="h-3.5" style={{ width: `${46 + ((i * 19) % 34)}%` }} />
            <Skeleton className="mt-2 h-3 w-40 max-w-full" />
          </div>
          <Skeleton className="h-8 w-[132px] shrink-0" />
        </div>
      ))}
    </div>
  );
}

function Scorecard({
  prefs,
  filter,
  onClearFilter,
  onOpenType,
  onSheetRuns,
  openType,
  closeSheet,
  onOpenFile,
  fileFor,
}: {
  prefs: TeamPrefs;
  filter: string;
  onClearFilter: () => void;
  onOpenType: (t: string) => void;
  onSheetRuns: (r: RunRow) => void;
  openType: string | null;
  closeSheet: () => void;
  onOpenFile: (type: string) => void;
  fileFor: (type: string) => boolean;
}) {
  const backend = getBackend();
  const args = scorecardArgs(prefs);
  const score = useFetched(() => backend.teamScorecard(args), [prefs.range, prefs.startedFrom]);
  useLiveReload(score.reload);
  const reading = useReadingHold(score.reload, score.at);

  const data = score.data;
  const cards = useMemo(() => (data ? filterCards(data.types, filter) : []), [data, filter]);

  if (score.error && !data) return <ErrorBlock title="Could not read the team's runs" message={score.error} onRetry={() => score.reload()} />;
  if (!data) return <CardsSkeleton />;

  const narrowed = prefs.range !== "all" || prefs.startedFrom !== "all";
  const open = openType ? data.types.find((c) => c.agentType === openType) : undefined;
  const history = historyLine(data.historyDays);

  return (
    <>
      {data.types.length === 0 ? (
        <EmptyState
          icon={ChatsCircle}
          title={reading ? READING_TITLE : narrowed ? "No helper runs match" : "No helper runs yet"}
          body={
            reading
              ? READING_BODY
              : narrowed
                ? "Try a longer range, or all the ways a run can start."
                : "When Claude hands a job to a helper, its runs are counted here, one card for each kind of helper."
          }
          seed={11}
          fill
        />
      ) : cards.length === 0 ? (
        <EmptyState icon={MagnifyingGlass} title={`No helper matches ${filter.trim()}`} body="Try fewer words." seed={7} fill>
          <Button onClick={onClearFilter}>Clear search</Button>
        </EmptyState>
      ) : (
        <div className="team-grid">
          {cards.map((c) => (
            <ScoreCard key={c.agentType} card={c} onOpen={() => onOpenType(c.agentType)} />
          ))}
        </div>
      )}
      <p className="mt-4 text-caption text-ink-2">
        {plural(data.totalRuns, "helper run")} in this range.
        {cards.length > 0 ? ` ${weeklyLegend(cards[0].weekly.length)}` : ""}
        {history ? ` ${history}` : ""}
      </p>
      {open && (
        <AgentSheet
          card={open}
          toTs={data.toTs}
          onClose={closeSheet}
          onOpenRun={onSheetRuns}
          onOpenFile={fileFor(open.agentType) ? () => onOpenFile(open.agentType) : undefined}
        />
      )}
    </>
  );
}

function ReviewView({
  prefs,
  onOpenExample,
  ruleTheme,
  setRuleTheme,
}: {
  prefs: TeamPrefs;
  onOpenExample: (e: ThemeExample) => void;
  ruleTheme: ReviewTheme | null;
  setRuleTheme: (t: ReviewTheme | null) => void;
}) {
  const backend = getBackend();
  const days = rangeDays(prefs.range);
  const themes = useFetched(() => backend.teamThemes({ days }), [prefs.range]);
  useLiveReload(themes.reload);
  const reload = useCallback(() => themes.reload(true), [themes]);
  const reading = useReadingHold(themes.reload, themes.at);

  const data = themes.data;
  if (themes.error && !data) return <ErrorBlock title="Could not read the reviews" message={themes.error} onRetry={() => themes.reload()} />;
  if (!data) return <ThemesSkeleton />;

  return (
    <>
      {data.themes.length === 0 ? (
        <EmptyState
          icon={Scales}
          title={reading ? READING_TITLE : data.findings > 0 ? "No problem keeps coming back yet" : "Nothing caught in review yet"}
          body={
            reading
              ? READING_BODY
              : data.findings > 0
                ? `${plural(data.findings, "finding")} so far. A problem shows up here once at least 2 reviews raise it, 3 times in all.`
                : "When a reviewer sends work back, the problems it keeps finding collect here, and you can turn one into a rule."
          }
          seed={23}
          fill
        />
      ) : (
        <>
          <ThemeList data={data} nameOf={typeLabel} onMakeRule={setRuleTheme} onOpenExample={onOpenExample} />
          <p className="mt-4 text-caption text-ink-2">
            {`${plural(data.findings, "finding")} grouped into ${plural(data.total, "theme")}, most often first.`}
          </p>
        </>
      )}
      {ruleTheme && <RuleSheet theme={ruleTheme} onClose={() => setRuleTheme(null)} onChanged={reload} />}
    </>
  );
}

/**
 * The Toolkit's Team tab: how each kind of helper is doing (Scorecard), and what reviewers
 * keep catching (Caught in review), with a way to make a catch a standing rule. This frame is
 * one window tall; the cards and the list scroll inside it.
 */
export function Team({ onShowSetup }: { onShowSetup: () => void }) {
  const { setView } = useAtlas();
  const setup = useSetup();
  const [prefs, setPrefsState] = useState<TeamPrefs>(() => (typeof localStorage === "undefined" ? DEFAULT_PREFS : loadPrefs()));
  const [filter, setFilter] = useState("");
  const [openType, setOpenType] = useState<string | null>(null);
  const [ruleTheme, setRuleTheme] = useState<ReviewTheme | null>(null);
  const search = useRef<HTMLDivElement>(null);

  const setPrefs = useCallback((next: Partial<TeamPrefs>) => {
    setPrefsState((p) => {
      const v = { ...p, ...next };
      savePrefs(v);
      return v;
    });
  }, []);

  // "/" jumps to the search box, as it does on the other lists.
  useEffect(() => {
    if (prefs.view !== "scorecard") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      search.current?.querySelector("input")?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prefs.view]);

  const agentItem = useCallback(
    (type: string) => setup.snapshot?.items.find((i) => i.kind === "agent" && i.name === type && !i.backup && !i.worktree) ?? null,
    [setup.snapshot],
  );

  const openRun = (sessionId: string, agentId: string) => {
    openAgentNext(sessionId, agentId);
    setView("sessions");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SegmentedControl label="Team view" value={prefs.view} options={VIEWS} onChange={(view) => setPrefs({ view })} />
        <SegmentedControl label="Range" value={prefs.range} options={RANGE_OPTIONS} onChange={(r: RangeId) => setPrefs({ range: r })} />
        {prefs.view === "scorecard" && (
          <>
            <SelectField label="Started from" value={prefs.startedFrom} options={STARTED_OPTIONS} onChange={(v) => setPrefs({ startedFrom: v as StartedFrom })} />
            <div ref={search} className="flex min-w-[200px] flex-1">
              <SearchField value={filter} onChange={setFilter} label="Find a helper" placeholder="Find a helper" />
            </div>
          </>
        )}
      </div>
      <div className="team-pane flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden">
        {prefs.view === "scorecard" ? (
          <Scorecard
            prefs={prefs}
            filter={filter}
            onClearFilter={() => setFilter("")}
            openType={openType}
            onOpenType={setOpenType}
            closeSheet={() => setOpenType(null)}
            onSheetRuns={(r) => openRun(r.sessionId, r.agentId)}
            fileFor={(t) => agentItem(t) !== null}
            onOpenFile={(t) => {
              const item = agentItem(t);
              if (!item) return;
              setOpenType(null);
              onShowSetup();
              openToolkitItemNext(item.id);
            }}
          />
        ) : (
          <ReviewView prefs={prefs} ruleTheme={ruleTheme} setRuleTheme={setRuleTheme} onOpenExample={(e) => openRun(e.sessionId, e.agentId)} />
        )}
      </div>
    </div>
  );
}
