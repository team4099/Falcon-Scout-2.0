import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
import { useCached } from "@/hooks/useCached";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useUIStore } from "@/store/uiStore";
import {
  fetchTBAEventMatches,
  fetchStatboticsEventTeams,
} from "@/lib/api";
import type { TBAMatch } from "@/lib/api";
import { toast } from "sonner";
import {
  Coins, TrendingUp, TrendingDown, Trophy, ChevronDown, ChevronUp,
  Plus, Zap, Lock, CheckCircle2, XCircle, RefreshCw,
  HandCoins, Swords, BarChart3, Target, ListFilter,
  BadgeCheck, AlertCircle, Timer, Users, X, Medal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// ── Types ─────────────────────────────────────────────────────────────────────

type MarketStatus = "open" | "locked" | "resolved" | "cancelled";
type MarketType =
  | "match_winner"
  | "alliance_score_ou"
  | "point_differential"
  | "team_field_bool"
  | "team_field_numeric"
  | "team_field_select"
  | "multi_match_numeric"
  | "multi_match_count";

interface BetOption { id: string; label: string; seedPool: number; }

interface Market {
  _id: Id<"bettingMarkets">;
  eventKey: string;
  title: string;
  description?: string;
  type: MarketType;
  matchNumber?: number;
  matchNumbers?: number[];
  teamNumber?: number;
  alliance?: "red" | "blue";
  templateId?: Id<"formTemplates">;
  fieldId?: string;
  fieldLabel?: string;
  threshold?: number;
  targetValue?: string;
  minCount?: number;
  targetScope?: "team" | "alliance" | "match";
  options: BetOption[];
  status: MarketStatus;
  resolvedOptionId?: string;
  createdAt: number;
  resolvedAt?: number;
}

interface FormField {
  id: string;
  type: "text" | "number" | "checkbox" | "select" | "counter" | "textarea" | "teamNumber" | "rating";
  label: string;
  required: boolean;
  options?: string[];
  section?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function matchLabel(m: TBAMatch): string {
  const lvl: Record<string, string> = { qm: "Q", ef: "EF", qf: "QF", sf: "SF", f: "F" };
  const prefix = lvl[m.comp_level] ?? m.comp_level.toUpperCase();
  if (m.comp_level === "qm") return `${prefix}${m.match_number}`;
  return `${prefix}${m.set_number}M${m.match_number}`;
}

function isPlayed(m: TBAMatch): boolean {
  return m.alliances.red.score >= 0 && m.alliances.blue.score >= 0;
}

function formatCoins(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Compute implied probability % for an option given seed + real bets. */
function impliedPct(option: BetOption, realBets: Record<string, number>, allOptions: BetOption[]): number {
  const totalPool =
    allOptions.reduce((s, o) => s + o.seedPool, 0) +
    Object.values(realBets).reduce((s, v) => s + v, 0);
  if (totalPool === 0) return 1 / allOptions.length;
  const optionPool = option.seedPool + (realBets[option.id] ?? 0);
  return optionPool / totalPool;
}

/** Estimated payout multiplier if you bet X on this option and win. */
function estimatePayout(
  betAmount: number,
  option: BetOption,
  realBets: Record<string, number>,
  allOptions: BetOption[]
): number {
  const totalPool =
    allOptions.reduce((s, o) => s + o.seedPool, 0) +
    Object.values(realBets).reduce((s, v) => s + v, 0) + betAmount;
  const winPool = option.seedPool + (realBets[option.id] ?? 0) + betAmount;
  if (winPool === 0) return 0;
  return Math.floor((betAmount / winPool) * totalPool);
}

const STATUS_CONFIG: Record<MarketStatus, { label: string; color: string; icon: React.ElementType }> = {
  open:      { label: "Open",     color: "text-yellow-400 bg-yellow-400/10 border-yellow-400/30", icon: Zap },
  locked:    { label: "Locked",   color: "text-amber-400 bg-amber-400/10 border-amber-400/30",    icon: Lock },
  resolved:  { label: "Resolved", color: "text-amber-300/70 bg-amber-300/10 border-amber-300/30", icon: CheckCircle2 },
  cancelled: { label: "Cancelled", color: "text-muted-foreground bg-muted/40 border-border/30",   icon: XCircle },
};

const TYPE_ICONS: Record<MarketType, React.ElementType> = {
  match_winner:       Swords,
  alliance_score_ou:  BarChart3,
  point_differential: TrendingUp,
  team_field_bool:    CheckCircle2,
  team_field_numeric: BarChart3,
  team_field_select:  Target,
  multi_match_numeric: BarChart3,
  multi_match_count:   ListFilter,
};

// ── Probability Bar ───────────────────────────────────────────────────────────

function ProbBar({
  options,
  realBets,
  resolvedOptionId,
}: {
  options: BetOption[];
  realBets: Record<string, number>;
  resolvedOptionId?: string;
}) {
  const pcts = options.map((o) => impliedPct(o, realBets, options));
  const colors = [
    "from-amber-500 to-yellow-400",
    "from-yellow-500 to-amber-300",
    "from-amber-600 to-yellow-500",
    "from-yellow-400 to-amber-200",
    "from-amber-400 to-yellow-300",
  ];
  return (
    <div className="space-y-2">
      {options.map((opt, i) => {
        const pct = pcts[i];
        const isWinner = resolvedOptionId === opt.id;
        const isLoser = resolvedOptionId && resolvedOptionId !== opt.id;
        return (
          <div key={opt.id} className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className={`font-medium ${isLoser ? "opacity-40" : isWinner ? "text-amber-400" : "text-foreground"}`}>
                {isWinner && <CheckCircle2 className="inline h-3 w-3 mr-1" />}
                {opt.label}
              </span>
              <span className="font-mono text-muted-foreground">
                {(pct * 100).toFixed(1)}%
              </span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full rounded-full bg-gradient-to-r transition-all duration-700 ${colors[i % colors.length]} ${isLoser ? "opacity-30" : ""}`}
                style={{ width: `${Math.max(pct * 100, 2)}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Bet Placement Panel ───────────────────────────────────────────────────────

function BetPanel({
  market,
  realBets,
  myBalance,
  onBetPlaced,
}: {
  market: Market;
  realBets: Record<string, number>;
  myBalance: number;
  onBetPlaced: () => void;
}) {
  const [selectedOption, setSelectedOption] = useState(market.options[0]?.id ?? "");
  const [amount, setAmount] = useState(50);
  const placeBet = useMutation(api.betting.placeBet);
  const [placing, setPlacing] = useState(false);

  const selected = market.options.find((o) => o.id === selectedOption);
  const estPayout = selected ? estimatePayout(amount, selected, realBets, market.options) : 0;
  const profit = estPayout - amount;

  async function handleBet() {
    if (!selectedOption || amount < 10) return;
    setPlacing(true);
    try {
      await placeBet({
        marketId: market._id,
        optionId: selectedOption,
        amount,
      });
      toast.success(`Bet placed! ${amount} coins on "${selected?.label}"`);
      onBetPlaced();
    } catch (e: unknown) {
      toast.error((e as Error).message ?? "Failed to place bet");
    } finally {
      setPlacing(false);
    }
  }

  const quickAmounts = [10, 50, 100, 250, 500];

  return (
    <div className="border-t border-border/60 pt-4 mt-4 space-y-3">
      {/* Option selector */}
      <div className="grid gap-2">
        {market.options.map((opt) => (
          <button
            key={opt.id}
            onClick={() => setSelectedOption(opt.id)}
            className={`flex items-center justify-between px-3 py-2 rounded-lg border text-sm font-medium transition-all ${
              selectedOption === opt.id
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-card hover:border-primary/40 hover:bg-primary/5 text-muted-foreground"
            }`}
          >
            <span>{opt.label}</span>
            <span className="text-xs opacity-70">
              {((impliedPct(opt, realBets, market.options)) * 100).toFixed(1)}%
            </span>
          </button>
        ))}
      </div>

      {/* Amount */}
      <div className="space-y-2">
        <div className="flex gap-1.5 flex-wrap">
          {quickAmounts.map((q) => (
            <button
              key={q}
              onClick={() => setAmount(q)}
              className={`px-2.5 py-1 rounded-md text-xs font-mono font-semibold transition-colors border ${
                amount === q
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground bg-card"
              }`}
            >
              {q}
            </button>
          ))}
          <Input
            type="number"
            min={10}
            max={myBalance}
            value={amount}
            onChange={(e) => setAmount(Math.max(10, Math.min(myBalance, Number(e.target.value))))}
            className="h-7 w-20 text-xs font-mono"
          />
        </div>
        <p className="text-[10px] text-muted-foreground">
          Balance: <span className="text-amber-400 font-mono font-semibold flex items-center gap-1 inline-flex">{formatCoins(myBalance)} <Coins className="h-3 w-3" /></span>
        </p>
      </div>

      {/* Payout preview */}
      {selected && amount >= 10 && (
        <div className="flex items-center justify-between rounded-lg bg-muted/60 px-3 py-2 text-xs">
          <span className="text-muted-foreground">Est. payout if win</span>
          <span className={`font-mono font-bold flex items-center gap-1 ${profit >= 0 ? "text-amber-400" : "text-red-400"}`}>
            {estPayout} <Coins className="h-3 w-3" /> (+{profit})
          </span>
        </div>
      )}

      <Button
        onClick={handleBet}
        disabled={placing || amount < 10 || amount > myBalance || !selectedOption}
        className="w-full font-bold bg-gradient-to-r from-amber-500 to-yellow-400 hover:from-amber-600 hover:to-yellow-500 text-black border-0"
      >
        {placing ? <RefreshCw className="h-4 w-4 animate-spin mr-2" /> : <Coins className="h-4 w-4 mr-2" />}
        {placing ? "Placing…" : `Bet ${amount} coins`}
      </Button>
    </div>
  );
}

// ── Market Card ───────────────────────────────────────────────────────────────

function MarketCard({
  market,
  myBalance,
  onResolved,
  isAdmin,
  hasBet,
}: {
  market: Market;
  myBalance: number;
  onResolved: () => void;
  isAdmin: boolean;
  hasBet: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolveOption, setResolveOption] = useState(market.options[0]?.id ?? "");

  const poolData = useQuery(api.betting.getMarketPool, { marketId: market._id });
  const realBets: Record<string, number> = poolData ?? {};

  const resolveMarket = useMutation(api.betting.resolveMarket);
  const lockMarket = useMutation(api.betting.lockMarket);
  const unlockMarket = useMutation(api.betting.unlockMarket);

  const TypeIcon = TYPE_ICONS[market.type];
  const sc = STATUS_CONFIG[market.status];
  const StatusIcon = sc.icon;

  const totalRealBets = Object.values(realBets).reduce((s, v) => s + v, 0);

  const handleResolve = async () => {
    try {
      const result = await resolveMarket({ marketId: market._id, resolvedOptionId: resolveOption });
      const r = result as { settledBets: number; penalised: number };
      toast.success(`Market resolved! ${r.settledBets} bets settled. ${r.penalised} scouts penalised.`);
      setResolveOpen(false);
      onResolved();
    } catch (e: unknown) {
      toast.error((e as Error).message ?? "Failed to resolve");
    }
  };

  if (market.status === "cancelled") return null;

  return (
    <>
      <div className={`rounded-2xl border bg-card transition-all duration-200 overflow-hidden ${
        market.status === "resolved" ? "border-border/50 opacity-80" :
        "border-border hover:border-primary/30 hover:shadow-lg hover:shadow-primary/5"
      }`}>
        {/* Card header */}
        <button
          className="w-full text-left p-4 flex items-start gap-3"
          onClick={() => setExpanded((e) => !e)}
        >
          <div className="h-9 w-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
            <TypeIcon className="h-4 w-4 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-sm leading-tight">{market.title}</span>
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${sc.color}`}>
                <StatusIcon className="h-2.5 w-2.5" />
                {sc.label}
              </span>
            </div>
            {market.description && (
              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{market.description}</p>
            )}
            <div className="flex items-center gap-3 mt-1.5 text-[10px] text-muted-foreground flex-wrap">
              {totalRealBets > 0 && (
                <span className="flex items-center gap-1">
                  <Coins className="h-3 w-3" /> {formatCoins(totalRealBets)} wagered
                </span>
              )}
              {market.matchNumber && <span>Match #{market.matchNumber}</span>}
              {market.matchNumbers && market.matchNumbers.length > 0 && (
                <span className="flex items-center gap-1 flex-wrap">
                  {market.matchNumbers.map((n) => (
                    <span key={n} className="px-1.5 py-0 rounded bg-primary/10 text-primary border border-primary/20 font-semibold">
                      #{n}
                    </span>
                  ))}
                </span>
              )}
              {market.teamNumber && <span>Team {market.teamNumber}</span>}
              {market.targetScope && (
                <span className="px-1.5 py-0 rounded bg-muted border border-border font-semibold capitalize">
                  {market.targetScope === "match" ? "Anyone" : market.targetScope}
                </span>
              )}
              {market.threshold !== undefined && <span>Threshold: {market.threshold}</span>}
            </div>
          </div>
          <div className="shrink-0 mt-1">
            {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </div>
        </button>

        {/* No-bet penalty warning — shown on open markets where user hasn't placed a bet */}
        {market.status === "open" && !hasBet && (
          <div className="mx-4 mb-3 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-orange-500/10 border border-orange-500/30 text-orange-400 text-[11px] font-semibold">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            No bet placed — <span className="font-black">10% penalty</span> on your balance if you skip this market
          </div>
        )}

        {/* Collapsed prob bar preview */}
        {!expanded && (
          <div className="px-4 pb-3">
            <ProbBar options={market.options} realBets={realBets} resolvedOptionId={market.resolvedOptionId} />
          </div>
        )}

        {/* Expanded content */}
        {expanded && (
          <div className="px-4 pb-4 space-y-4 border-t border-border/40 pt-4">
            <ProbBar options={market.options} realBets={realBets} resolvedOptionId={market.resolvedOptionId} />

            {/* Live pool breakdown */}
            <div className="grid grid-cols-2 gap-2">
              {market.options.map((opt) => (
                <div key={opt.id} className="rounded-xl bg-muted/60 p-3 space-y-1">
                  <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">{opt.label}</p>
                  <p className="text-sm font-mono font-bold flex items-center gap-1">
                    {formatCoins(opt.seedPool + (realBets[opt.id] ?? 0))} <Coins className="h-3 w-3 text-amber-400" />
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {formatCoins(realBets[opt.id] ?? 0)} real · {formatCoins(opt.seedPool)} seed
                  </p>
                </div>
              ))}
            </div>

            {/* Bet panel */}
            {market.status === "open" && (
              <BetPanel
                market={market}
                realBets={realBets}
                myBalance={myBalance}
                onBetPlaced={() => {}}
              />
            )}

            {/* Resolved outcome */}
            {market.status === "resolved" && market.resolvedOptionId && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30">
                <BadgeCheck className="h-4 w-4 text-amber-400 shrink-0" />
                <span className="text-sm text-amber-400 font-medium">
                  Winner: {market.options.find((o) => o.id === market.resolvedOptionId)?.label ?? market.resolvedOptionId}
                </span>
              </div>
            )}

            {/* Admin controls */}
            {isAdmin && market.status !== "resolved" && (
              <div className="flex gap-2 flex-wrap border-t border-border/40 pt-3">
                {market.status === "open" ? (
                  <Button size="sm" variant="outline" className="h-7 text-xs border-amber-400/40 text-amber-400 hover:bg-amber-400/10"
                    onClick={() => lockMarket({ marketId: market._id }).then(() => toast.success("Market locked"))}>
                    <Lock className="h-3 w-3 mr-1" /> Lock
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" className="h-7 text-xs"
                    onClick={() => unlockMarket({ marketId: market._id }).then(() => toast.success("Market unlocked"))}>
                    <Zap className="h-3 w-3 mr-1" /> Unlock
                  </Button>
                )}
                <Button size="sm" className="h-7 text-xs bg-amber-500 hover:bg-amber-600 text-black border-0"
                  onClick={() => setResolveOpen(true)}>
                  <CheckCircle2 className="h-3 w-3 mr-1" /> Resolve
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Resolve dialog */}
      <Dialog open={resolveOpen} onOpenChange={setResolveOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Resolve Market</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{market.title}</p>
          <div className="space-y-2 py-2">
            {market.options.map((opt) => (
              <button
                key={opt.id}
                onClick={() => setResolveOption(opt.id)}
                className={`w-full text-left px-3 py-2.5 rounded-lg border text-sm font-medium transition-all ${
                  resolveOption === opt.id
                    ? "border-amber-400 bg-amber-400/10 text-amber-400"
                    : "border-border hover:border-primary/40 text-muted-foreground"
                }`}
              >
                {resolveOption === opt.id && <CheckCircle2 className="inline h-3.5 w-3.5 mr-1.5" />}
                {opt.label}
              </button>
            ))}
          </div>
          <Button
            className="w-full bg-amber-500 hover:bg-amber-600 text-black border-0 font-bold"
            onClick={handleResolve}
          >
            Confirm Resolution
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Create Market Panel ───────────────────────────────────────────────────────


/** Custom multi-select dropdown for picking matches (checkboxes). */
function MatchMultiSelect({
  options,
  selected,
  onChange,
}: {
  options: { value: string; label: string }[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);

  function toggle(val: string) {
    const next = new Set(selected);
    if (next.has(val)) next.delete(val);
    else next.add(val);
    onChange(next);
  }

  return (
    <div className="relative flex-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full h-8 flex items-center justify-between rounded-md border border-input bg-background px-3 text-sm ring-offset-background hover:bg-accent hover:text-accent-foreground"
      >
        <span className="truncate text-left">
          {selected.size === 0
            ? "Select matches…"
            : `${selected.size} match${selected.size !== 1 ? "es" : ""} selected`}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute z-50 mt-1 w-full max-h-52 overflow-y-auto rounded-lg border border-border bg-popover shadow-lg">
            {options.length === 0 && (
              <p className="px-3 py-2 text-xs text-muted-foreground">No matches available</p>
            )}
            {options.map((opt) => (
              <label
                key={opt.value}
                className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-accent text-sm"
              >
                <input
                  type="checkbox"
                  checked={selected.has(opt.value)}
                  onChange={() => toggle(opt.value)}
                  className="rounded border-border"
                />
                <span className="truncate">{opt.label}</span>
              </label>
            ))}
            {options.length > 0 && (
              <div className="flex gap-2 border-t border-border/40 px-3 py-1.5">
                <button
                  type="button"
                  className="text-[10px] text-primary font-semibold hover:underline"
                  onClick={() => onChange(new Set(options.map((o) => o.value)))}
                >
                  Select All
                </button>
                <button
                  type="button"
                  className="text-[10px] text-muted-foreground font-semibold hover:underline"
                  onClick={() => onChange(new Set())}
                >
                  Clear
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function CreateMarketPanel({
  eventKey,
  tbaMatches,
  onCreated,
}: {
  eventKey: string;
  tbaMatches: TBAMatch[];
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<MarketType>("match_winner");
  const [matchNum, setMatchNum] = useState("");
  const [selectedMatchKeys, setSelectedMatchKeys] = useState<Set<string>>(new Set());
  const [teamNum, setTeamNum] = useState("");
  const [alliance, setAlliance] = useState<"red" | "blue">("red");
  const [targetScope, setTargetScope] = useState<"team" | "alliance" | "match">("team");
  const [dataSource, setDataSource] = useState<"scouting" | "tba">("scouting");
  const [tbaField, setTbaField] = useState<string>("");
  const [threshold, setThreshold] = useState("");
  const [minCount, setMinCount] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [selectedFieldId, setSelectedFieldId] = useState("");
  const [targetValue, setTargetValue] = useState("");
  const [customTitle, setCustomTitle] = useState("");
  const [creating, setCreating] = useState(false);

  const templatesLive = useQuery(api.forms.listActiveTemplates);
  const templates = useCached(templatesLive, "active_templates");
  const createMarket = useMutation(api.betting.createMarket);

  const isMultiMatch = type === "multi_match_numeric" || type === "multi_match_count";

  // Match options from TBA — show all matches, marking played ones
  const sortedMatches = [...tbaMatches].sort((a, b) => {
    const levelOrder: Record<string, number> = { qm: 0, ef: 1, qf: 2, sf: 3, f: 4 };
    const la = levelOrder[a.comp_level] ?? 5;
    const lb = levelOrder[b.comp_level] ?? 5;
    if (la !== lb) return la - lb;
    if (a.set_number !== b.set_number) return a.set_number - b.set_number;
    return a.match_number - b.match_number;
  });
  const matchOpts = sortedMatches.map((m) => ({
    value: m.key,
    label: isPlayed(m) ? `${matchLabel(m)} (played)` : matchLabel(m),
  }));
  const selectedMatch = tbaMatches.find((m) => m.key === matchNum);

  // Selected TBA match objects for multi-match
  const selectedMultiMatches = useMemo(
    () => tbaMatches.filter((m) => selectedMatchKeys.has(m.key)),
    [tbaMatches, selectedMatchKeys],
  );

  // Teams in the selected single match
  const matchTeams: string[] = selectedMatch
    ? [
        ...selectedMatch.alliances.red.team_keys,
        ...selectedMatch.alliances.blue.team_keys,
      ].map((k) => k.replace(/^frc/, ""))
    : [];

  // Teams that appear in ALL selected multi-matches (intersection)
  const multiMatchTeams: string[] = useMemo(() => {
    if (selectedMultiMatches.length === 0) return [];
    const teamSets = selectedMultiMatches.map((m) => {
      const allKeys = [...m.alliances.red.team_keys, ...m.alliances.blue.team_keys];
      return new Set(allKeys.map((k) => k.replace(/^frc/, "")));
    });
    // Intersect all sets
    const first = teamSets[0];
    return [...first].filter((t) => teamSets.every((s) => s.has(t)));
  }, [selectedMultiMatches]);

  // Labels for selected multi-matches (for title)
  const multiMatchLabels = selectedMultiMatches.map((m) => matchLabel(m)).join(", ");

  // Match numbers for selected multi-matches
  const multiMatchNumbers = selectedMultiMatches.map((m) => m.match_number);


  // Selected template's bettable fields — filtered by the current market type
  const selectedTemplate = templates?.find((t) => t._id === selectedTemplateId);
  const allowedFieldTypes: string[] =
    type === "team_field_bool"       ? ["checkbox"] :
    type === "team_field_numeric"    ? ["number", "counter"] :
    type === "team_field_select"     ? ["select"] :
    type === "multi_match_count"     ? ["checkbox"] :
    type === "multi_match_numeric"   ? ["number", "counter"] :
    ["checkbox", "number", "counter", "select"];
  const bettableFields = (selectedTemplate?.fields as FormField[] | undefined)
    ?.filter((f) => allowedFieldTypes.includes(f.type));
  const selectedField = bettableFields?.find((f) => f.id === selectedFieldId);

  // TBA stat options for multi_match_numeric
  const TBA_STAT_OPTIONS = [
    { id: "_tba_alliance_score", label: "Alliance Score" },
    { id: "_tba_point_diff", label: "Point Differential" },
  ];
  const selectedTbaStat = TBA_STAT_OPTIONS.find((s) => s.id === tbaField);

  // Does this type need a scouting form?
  const useTbaSource = type === "multi_match_numeric" && dataSource === "tba";
  const needsForm = (type === "team_field_bool" || type === "team_field_numeric"
    || type === "team_field_select" || type === "multi_match_numeric" || type === "multi_match_count")
    && !useTbaSource;

  // Does this type need a team selector?
  const needsTeamOrScope = type === "team_field_bool" || type === "team_field_numeric"
    || type === "team_field_select" || isMultiMatch;

  function buildTitle(): string {
    if (customTitle.trim()) return customTitle.trim();
    const mStr = selectedMatch ? matchLabel(selectedMatch) : "";
    const scopeStr =
      targetScope === "team" ? `Team ${teamNum}` :
      targetScope === "alliance" ? `${alliance === "red" ? "Red" : "Blue"} Alliance` :
      "Any Team";
    const fieldStr = useTbaSource
      ? (selectedTbaStat?.label ?? "TBA Stat")
      : (selectedField?.label ?? "Field");
    switch (type) {
      case "match_winner":       return `${mStr} — Match Winner`;
      case "alliance_score_ou":  return `${mStr} ${alliance.toUpperCase()} Score ${threshold ? `Over/Under ${threshold}` : "O/U"}`;
      case "point_differential": return `${mStr} Point Diff ${threshold ? `Over/Under ${threshold}` : "O/U"}`;
      case "team_field_bool":    return `${mStr} Team ${teamNum} — ${fieldStr} Yes/No`;
      case "team_field_numeric": return `${mStr} Team ${teamNum} — ${fieldStr} Over/Under ${threshold ?? "?"}`;
      case "team_field_select":  return `${mStr} Team ${teamNum} — ${fieldStr} = "${targetValue}"`;
      case "multi_match_numeric":
        return `${scopeStr} — Total ${fieldStr} O/U ${threshold ?? "?"} across ${multiMatchLabels || "?"}`;
      case "multi_match_count":
        return `${scopeStr} — ${fieldStr} in ≥${minCount || "?"} of ${multiMatchLabels || "?"}`;
      default: return "Custom Market";
    }
  }

  function buildOptions(): BetOption[] {
    switch (type) {
      case "match_winner": {
        const m = selectedMatch;
        const redPct = 50; const bluePct = 50;
        void m;
        return [
          { id: "red",  label: "Red Alliance",  seedPool: redPct },
          { id: "blue", label: "Blue Alliance", seedPool: bluePct },
        ];
      }
      case "alliance_score_ou":
      case "point_differential":
        return [
          { id: "over",  label: "Over",  seedPool: 50 },
          { id: "under", label: "Under", seedPool: 50 },
        ];
      case "team_field_bool":
        return [
          { id: "yes", label: "Yes", seedPool: 50 },
          { id: "no",  label: "No",  seedPool: 50 },
        ];
      case "team_field_numeric":
      case "multi_match_numeric":
        return [
          { id: "over",  label: "Over",  seedPool: 50 },
          { id: "under", label: "Under", seedPool: 50 },
        ];
      case "multi_match_count":
        return [
          { id: "over",  label: "Over",  seedPool: 50 },
          { id: "under", label: "Under", seedPool: 50 },
        ];
      case "team_field_select": {
        const opts = selectedField?.options ?? [];
        return opts.length > 0
          ? opts.map((o) => ({ id: o, label: o, seedPool: Math.floor(100 / opts.length) }))
          : [{ id: "yes", label: "Yes", seedPool: 50 }, { id: "no", label: "No", seedPool: 50 }];
      }
      default: return [];
    }
  }

  async function handleCreate() {
    const options = buildOptions();
    if (options.length === 0) { toast.error("No options defined"); return; }
    setCreating(true);
    try {
      await createMarket({
        eventKey,
        title:       buildTitle(),
        type,
        options,
        ...(selectedMatch && !isMultiMatch ? { matchNumber: selectedMatch.match_number } : {}),
        ...(isMultiMatch && multiMatchNumbers.length > 0
          ? { matchNumbers: multiMatchNumbers }
          : {}),
        ...(needsTeamOrScope && targetScope === "team" && teamNum ? { teamNumber: Number(teamNum) } : {}),
        ...(type === "alliance_score_ou" || (isMultiMatch && targetScope === "alliance") ? { alliance } : {}),
        ...(threshold ? { threshold: Number(threshold) } : {}),
        ...(targetValue ? { targetValue } : {}),
        ...(minCount ? { minCount: Number(minCount) } : {}),
        ...(isMultiMatch ? { targetScope } : {}),
        ...(selectedTemplateId && !useTbaSource ? { templateId: selectedTemplateId as Id<"formTemplates"> } : {}),
        ...(useTbaSource && tbaField
          ? { fieldId: tbaField, fieldLabel: selectedTbaStat?.label }
          : selectedFieldId ? { fieldId: selectedFieldId, fieldLabel: selectedField?.label } : {}),
      });
      toast.success("Market created!");
      setOpen(false);
      setCustomTitle("");
      setMatchNum("");
      setSelectedMatchKeys(new Set());
      setTeamNum("");
      setThreshold("");
      setMinCount("");
      onCreated();
    } catch (e: unknown) {
      toast.error((e as Error).message ?? "Failed to create market");
    } finally {
      setCreating(false);
    }
  }

  // Disable create button validation
  const createDisabled = creating
    || (needsForm && !selectedFieldId)
    || (useTbaSource && !tbaField)
    || (isMultiMatch && selectedMatchKeys.size < 2);

  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        variant="outline"
        className="gap-2 border-primary/40 text-primary hover:bg-primary/10"
      >
        <Plus className="h-4 w-4" />
        Create Market
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg overflow-y-auto max-h-[85vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-primary" />
              Create Betting Market
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-3 py-1">

            {/* Market Type — inline label + select side by side */}
            <div className="flex items-center gap-3">
              <Label className="shrink-0 w-24 text-right text-xs text-muted-foreground">Market Type</Label>
              <Select value={type} onValueChange={(v) => { setType(v as MarketType); setSelectedFieldId(""); setTeamNum(""); setSelectedMatchKeys(new Set()); setDataSource("scouting"); setTbaField(""); }}>
                <SelectTrigger className="flex-1 h-8 text-sm [&>span]:truncate">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="match_winner">Match Winner</SelectItem>
                  <SelectItem value="alliance_score_ou">Alliance Score O/U</SelectItem>
                  <SelectItem value="point_differential">Point Differential</SelectItem>
                  <SelectItem value="team_field_bool">Team Checkbox (Yes/No)</SelectItem>
                  <SelectItem value="team_field_numeric">Team Numeric O/U</SelectItem>
                  <SelectItem value="team_field_select">Team Select Field</SelectItem>
                  <SelectItem value="multi_match_numeric">Multi-Match Numeric O/U</SelectItem>
                  <SelectItem value="multi_match_count">Multi-Match Boolean Count</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="border-t border-border/40" />

            {/* Match (single) — for non-multi-match types */}
            {!isMultiMatch && (
              <div className="flex items-center gap-3">
                <Label className="shrink-0 w-24 text-right text-xs text-muted-foreground">Match</Label>
                <Select value={matchNum} onValueChange={(v) => { setMatchNum(v ?? ""); setTeamNum(""); }}>
                  <SelectTrigger className="flex-1 h-8 text-sm [&>span]:truncate">
                    <SelectValue placeholder="Select match…">
                      {selectedMatch ? (isPlayed(selectedMatch) ? `${matchLabel(selectedMatch)} (played)` : matchLabel(selectedMatch)) : undefined}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {matchOpts.map((m) => (
                      <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Multi-match selector — checkbox dropdown */}
            {isMultiMatch && (
              <div className="flex items-center gap-3">
                <Label className="shrink-0 w-24 text-right text-xs text-muted-foreground">Matches</Label>
                <MatchMultiSelect
                  options={matchOpts}
                  selected={selectedMatchKeys}
                  onChange={(next) => { setSelectedMatchKeys(next); setTeamNum(""); }}
                />
              </div>
            )}

            {/* Show selected match tags */}
            {isMultiMatch && selectedMultiMatches.length > 0 && (
              <div className="flex flex-wrap gap-1 pl-[calc(6rem+0.75rem)]">
                {selectedMultiMatches.map((m) => (
                  <span key={m.key} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-primary/10 text-primary border border-primary/20">
                    {matchLabel(m)}
                    <button
                      type="button"
                      onClick={() => {
                        const next = new Set(selectedMatchKeys);
                        next.delete(m.key);
                        setSelectedMatchKeys(next);
                      }}
                      className="hover:text-red-400"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            {/* Alliance toggle — for alliance_score_ou */}
            {type === "alliance_score_ou" && (
              <div className="flex items-center gap-3">
                <Label className="shrink-0 w-24 text-right text-xs text-muted-foreground">Alliance</Label>
                <div className="flex rounded-lg overflow-hidden border border-border">
                  {(["red", "blue"] as const).map((a) => (
                    <button
                      key={a}
                      type="button"
                      onClick={() => setAlliance(a)}
                      className={`px-4 py-1.5 text-sm font-semibold transition-colors ${
                        alliance === a
                          ? a === "red" ? "bg-red-500 text-white" : "bg-blue-500 text-white"
                          : "bg-background text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      {a === "red" ? "Red" : "Blue"}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Target scope toggle — for multi-match types */}
            {isMultiMatch && (
              <div className="flex items-center gap-3">
                <Label className="shrink-0 w-24 text-right text-xs text-muted-foreground">Scope</Label>
                <div className="flex rounded-lg overflow-hidden border border-border">
                  {(["team", "alliance", "match"] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => { setTargetScope(s); setTeamNum(""); }}
                      className={`px-3 py-1.5 text-sm font-semibold transition-colors ${
                        targetScope === s
                          ? "bg-primary text-primary-foreground"
                          : "bg-background text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      {s === "team" ? "Team" : s === "alliance" ? "Alliance" : "Anyone"}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Alliance selector — shown for multi-match alliance scope */}
            {isMultiMatch && targetScope === "alliance" && (
              <div className="flex items-center gap-3">
                <Label className="shrink-0 w-24 text-right text-xs text-muted-foreground">Alliance</Label>
                <div className="flex rounded-lg overflow-hidden border border-border">
                  {(["red", "blue"] as const).map((a) => (
                    <button
                      key={a}
                      type="button"
                      onClick={() => setAlliance(a)}
                      className={`px-4 py-1.5 text-sm font-semibold transition-colors ${
                        alliance === a
                          ? a === "red" ? "bg-red-500 text-white" : "bg-blue-500 text-white"
                          : "bg-background text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      {a === "red" ? "Red" : "Blue"}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Team dropdown — for single-match team types (uses match teams) */}
            {(type === "team_field_bool" || type === "team_field_numeric" || type === "team_field_select") && (
              <div className="flex items-center gap-3">
                <Label className="shrink-0 w-24 text-right text-xs text-muted-foreground">Team #</Label>
                <Select
                  value={teamNum}
                  onValueChange={(v) => setTeamNum(v ?? "")}
                  disabled={matchTeams.length === 0}
                >
                  <SelectTrigger className="flex-1 h-8 text-sm [&>span]:truncate">
                    <SelectValue placeholder={matchTeams.length === 0 ? "Select a match first…" : "Select team…"} />
                  </SelectTrigger>
                  <SelectContent>
                    {matchTeams.map((t) => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Team dropdown — for multi-match team scope (uses intersection of teams) */}
            {isMultiMatch && targetScope === "team" && (
              <div className="flex items-center gap-3">
                <Label className="shrink-0 w-24 text-right text-xs text-muted-foreground">Team #</Label>
                <Select
                  value={teamNum}
                  onValueChange={(v) => setTeamNum(v ?? "")}
                  disabled={multiMatchTeams.length === 0}
                >
                  <SelectTrigger className="flex-1 h-8 text-sm [&>span]:truncate">
                    <SelectValue placeholder={
                      selectedMatchKeys.size < 2 ? "Select ≥2 matches first…" :
                      multiMatchTeams.length === 0 ? "No teams in all matches" :
                      "Select team…"
                    } />
                  </SelectTrigger>
                  <SelectContent>
                    {multiMatchTeams.map((t) => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Warning if no teams appear in all selected matches */}
            {isMultiMatch && targetScope === "team" && selectedMatchKeys.size >= 2 && multiMatchTeams.length === 0 && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-orange-500/10 border border-orange-500/30 text-orange-400 text-xs font-medium ml-[calc(6rem+0.75rem)]">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                No team appears in all selected matches. Try different matches or use Alliance/Anyone scope.
              </div>
            )}

            {(type === "alliance_score_ou" || type === "point_differential" || type === "team_field_numeric" || type === "multi_match_numeric") && (
              <div className="flex items-center gap-3">
                <Label className="shrink-0 w-24 text-right text-xs text-muted-foreground">Threshold</Label>
                <Input
                  type="number"
                  className="flex-1 h-8 text-sm"
                  placeholder={type === "multi_match_numeric" ? "e.g. 15 (combined total)" : "e.g. 120"}
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                />
              </div>
            )}

            {/* Data source toggle — for multi_match_numeric */}
            {type === "multi_match_numeric" && (
              <div className="flex items-center gap-3">
                <Label className="shrink-0 w-24 text-right text-xs text-muted-foreground">Source</Label>
                <div className="flex rounded-lg overflow-hidden border border-border">
                  {(["scouting", "tba"] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => { setDataSource(s); setSelectedFieldId(""); setTbaField(""); setSelectedTemplateId(""); }}
                      className={`px-3 py-1.5 text-sm font-semibold transition-colors ${
                        dataSource === s
                          ? "bg-primary text-primary-foreground"
                          : "bg-background text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      {s === "scouting" ? "Scouting Form" : "TBA Stats"}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* TBA stat picker — shown when multi_match_numeric + tba source */}
            {useTbaSource && (
              <div className="flex items-center gap-3">
                <Label className="shrink-0 w-24 text-right text-xs text-muted-foreground">TBA Stat</Label>
                <Select value={tbaField} onValueChange={(v) => setTbaField(v ?? "")}>
                  <SelectTrigger className="flex-1 h-8 text-sm [&>span]:truncate">
                    <SelectValue placeholder="Select stat…">
                      {selectedTbaStat ? selectedTbaStat.label : undefined}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {TBA_STAT_OPTIONS.map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Scouting form + field */}
            {needsForm && (
              <>
                <div className="flex items-center gap-3">
                  <Label className="shrink-0 w-24 text-right text-xs text-muted-foreground">Form</Label>
                  <Select value={selectedTemplateId} onValueChange={(v) => { setSelectedTemplateId(v ?? ""); setSelectedFieldId(""); }}>
                    <SelectTrigger className="flex-1 h-8 text-sm [&>span]:truncate">
                      <SelectValue placeholder="Select form…">
                        {selectedTemplate ? selectedTemplate.name : undefined}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {(templates ?? []).map((t) => (
                        <SelectItem key={t._id} value={t._id}>{t.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {bettableFields && bettableFields.length > 0 && (
                  <div className="flex items-center gap-3">
                    <Label className="shrink-0 w-24 text-right text-xs text-muted-foreground">Field</Label>
                    <Select value={selectedFieldId} onValueChange={(v) => setSelectedFieldId(v ?? "")}>
                      <SelectTrigger className="flex-1 h-8 text-sm [&>span]:truncate">
                      <SelectValue placeholder="Select field…">
                        {selectedField ? `${selectedField.label} (${selectedField.type})` : undefined}
                      </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {bettableFields.map((f) => (
                          <SelectItem key={f.id} value={f.id}>{f.label} <span className="text-muted-foreground">({f.type})</span></SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {selectedTemplateId && bettableFields && bettableFields.length === 0 && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-orange-500/10 border border-orange-500/30 text-orange-400 text-xs font-medium">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    This form has no compatible {allowedFieldTypes.join("/")} fields for this market type.
                  </div>
                )}
              </>
            )}

            {/* Target value */}
            {type === "team_field_select" && selectedField?.options && (
              <div className="flex items-center gap-3">
                <Label className="shrink-0 w-24 text-right text-xs text-muted-foreground">Target</Label>
                <Select value={targetValue} onValueChange={(v) => setTargetValue(v ?? "")}>
                  <SelectTrigger className="flex-1 h-8 text-sm [&>span]:truncate">
                    <SelectValue placeholder="Select value…" />
                  </SelectTrigger>
                  <SelectContent>
                    {selectedField.options.map((o) => (
                      <SelectItem key={o} value={o}>{o}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Min count — for multi_match_count */}
            {type === "multi_match_count" && (
              <div className="flex items-center gap-3">
                <Label className="shrink-0 w-24 text-right text-xs text-muted-foreground">Threshold</Label>
                <Input
                  type="number"
                  className="flex-1 h-8 text-sm"
                  placeholder={`e.g. 3 (of ${selectedMatchKeys.size || "?"} matches)`}
                  value={minCount}
                  onChange={(e) => setMinCount(e.target.value)}
                />
              </div>
            )}

            <div className="border-t border-border/40" />

            {/* Custom title */}
            <div className="flex items-center gap-3">
              <Label className="shrink-0 w-24 text-right text-xs text-muted-foreground">Title</Label>
              <Input
                className="flex-1 h-8 text-sm"
                placeholder={buildTitle()}
                value={customTitle}
                onChange={(e) => setCustomTitle(e.target.value)}
              />
            </div>

            {/* Preview */}
            <div className="rounded-xl bg-muted/40 border border-border/50 px-3 py-2.5 space-y-2">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Preview</p>
              <p className="text-sm font-medium leading-snug">{buildTitle()}</p>
              <div className="flex gap-1.5 flex-wrap">
                {buildOptions().map((o) => (
                  <span key={o.id} className="px-2 py-0.5 rounded-full text-xs bg-primary/10 text-primary border border-primary/20">
                    {o.label}
                  </span>
                ))}
              </div>
              {isMultiMatch && (
                <div className="flex gap-1.5 flex-wrap mt-1">
                  <span className="text-[10px] text-muted-foreground">
                    Scope: {targetScope === "team" ? `Team ${teamNum || "?"}` : targetScope === "alliance" ? `${alliance} alliance` : "Anyone"}
                    {" · "}{selectedMatchKeys.size} matches
                  </span>
                </div>
              )}
            </div>

            <Button
              onClick={handleCreate}
              disabled={createDisabled}
              className="w-full font-bold"
            >
              {creating ? <RefreshCw className="h-4 w-4 animate-spin mr-2" /> : <Plus className="h-4 w-4 mr-2" />}
              {creating ? "Creating…" : "Create Market"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Markets Tab ───────────────────────────────────────────────────────────────

const TYPE_FILTER_LABELS: Record<string, string> = {
  all:                "All",
  match_winner:       "Match Winner",
  alliance_score_ou:  "Score",
  point_differential: "Differential",
  team_field_bool:    "Team Bool",
  team_field_numeric: "Team Numeric",
  team_field_select:  "Team Select",
  multi_match_numeric: "Multi Numeric",
  multi_match_count:    "Multi Bool",
};

function MarketsTab({
  eventKey,
  myBalance,
  isAdmin,
}: {
  eventKey: string;
  myBalance: number;
  isAdmin: boolean;
}) {
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | MarketStatus>("all");
  const [tbaMatches, setTbaMatches] = useState<TBAMatch[]>([]);
  const [autoGenerating, setAutoGenerating] = useState(false);
  const [didAutoGenerate, setDidAutoGenerate] = useState(false);
  const [wiping, setWiping] = useState(false);

  const marketsLive = useQuery(api.betting.listMarkets, { eventKey });
  const batchCreateRandom = useMutation(api.betting.batchCreateRandomMarkets);
  const clearAll = useMutation(api.betting.clearAllMarkets);

  useEffect(() => {
    fetchTBAEventMatches(eventKey).then((m) => {
      if (m) setTbaMatches(m);
    });
  }, [eventKey]);

  /** Shared helper: builds the match list with EPA-seeded win probabilities and predicted margin */
  async function buildMatchList(matches: TBAMatch[]) {
    type SBTeamEvent = { team: number; epa?: { mean?: number; total?: { mean?: number } } };
    let sbTeams: SBTeamEvent[] = [];
    try {
      const raw = await fetchStatboticsEventTeams(eventKey);
      if (Array.isArray(raw)) sbTeams = raw as SBTeamEvent[];
    } catch {}

    const epaMap: Record<number, number> = {};
    for (const t of sbTeams) {
      const mean =
        typeof t.epa?.mean === "number" ? t.epa.mean :
        typeof t.epa?.total?.mean === "number" ? t.epa.total.mean : null;
      if (mean !== null && mean !== undefined) epaMap[t.team] = mean;
    }

    return matches.map((m) => {
      const redTeams  = m.alliances.red.team_keys.map((k) => parseInt(k.replace("frc", ""), 10));
      const blueTeams = m.alliances.blue.team_keys.map((k) => parseInt(k.replace("frc", ""), 10));
      const redEpa  = redTeams.reduce((s, t) => s + (epaMap[t] ?? 30), 0);
      const blueEpa = blueTeams.reduce((s, t) => s + (epaMap[t] ?? 30), 0);
      const total   = redEpa + blueEpa || 1;
      // Win probability seeds (1–99, summing to 100)
      const rawRedPct  = redEpa / total;
      const seedRed  = Math.max(1, Math.min(99, Math.round(rawRedPct * 100)));
      const seedBlue = 100 - seedRed;
      // Predicted margin: |redEPA - blueEPA|, rounded to nearest 5, min 5
      const rawMargin = Math.abs(redEpa - blueEpa);
      const predictedMargin = Math.max(5, Math.round(rawMargin / 5) * 5);
      return { matchNumber: m.match_number, matchLabel: matchLabel(m), seedRed, seedBlue, predictedMargin };
    });
  }

  // Auto-generate markets the first time data arrives and there are none
  useEffect(() => {
    if (
      !isAdmin ||
      didAutoGenerate ||
      autoGenerating ||
      marketsLive === undefined // still loading
    ) return;
    if (marketsLive.length > 0) return;

    // Use all matches (played or not) for initial seeding
    const all = tbaMatches.length > 0 ? tbaMatches : [];
    if (all.length === 0) return; // no TBA data yet — wait

    setDidAutoGenerate(true);
    setAutoGenerating(true);
    buildMatchList(all)
      .then((list) => batchCreateRandom({ eventKey, limit: 4, matches: list }))
      .then((r) => {
        const { created } = r as { created: number };
        if (created > 0) toast.success(`Auto-generated ${created} markets!`);
      })
      .catch(() => {})
      .finally(() => setAutoGenerating(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketsLive, tbaMatches, isAdmin]);

  async function handleAutoGenerate() {
    setAutoGenerating(true);
    try {
      const unplayed = tbaMatches.filter((m) => !isPlayed(m));
      const matchList = await buildMatchList(unplayed);

      if (matchList.length === 0) {
        toast.info("No unplayed matches to generate markets for");
        return;
      }

      const result = await batchCreateRandom({ eventKey, limit: 4, matches: matchList });
      const { created } = result as { created: number };
      toast.success(`Auto-generated ${created} new markets!`);
    } catch (e: unknown) {
      toast.error((e as Error).message ?? "Auto-generation failed");
    } finally {
      setAutoGenerating(false);
    }
  }

  async function handleTestGenerate() {
    setAutoGenerating(true);
    try {
      // Use ALL matches (including played) so you can test even post-event.
      // If TBA returned nothing at all, fall back to 5 synthetic dummy matches.
      let pool = tbaMatches;
      if (pool.length === 0) {
        // Synthetic dummy matches: just need matchNumber + matchLabel + seeds
        const dummyList = [1, 2, 3, 4, 5].map((n) => ({
          matchNumber:     n,
          matchLabel:      `Q${n}`,
          seedRed:         50,
          seedBlue:        50,
          predictedMargin: 15,
        }));
        const result = await batchCreateRandom({ eventKey, limit: 4, matches: dummyList });
        const { created } = result as { created: number };
        toast.success(`Test: generated ${created} dummy markets!`);
        return;
      }

      const matchList = await buildMatchList(pool);
      const result = await batchCreateRandom({ eventKey, limit: 4, matches: matchList });
      const { created } = result as { created: number };
      if (created > 0) {
        toast.success(`Test: generated ${created} markets from all matches!`);
      } else {
        toast.info("All matches already have markets — nothing new to create.");
      }
    } catch (e: unknown) {
      toast.error((e as Error).message ?? "Test generation failed");
    } finally {
      setAutoGenerating(false);
    }
  }

  async function handleWipeAll() {
    if (!window.confirm(
      "This will permanently delete ALL markets and bets for this event, and reset every balance to 1,000 coins.\n\nAre you sure?"
    )) return;
    setWiping(true);
    try {
      const result = await clearAll({ eventKey }) as {
        marketsDeleted: number;
        betsDeleted: number;
        balancesReset: number;
      };
      toast.success(
        `Wiped ${result.marketsDeleted} markets, ${result.betsDeleted} bets. ${result.balancesReset} balances reset.`
      );
      setDidAutoGenerate(false); // allow auto-generate to re-trigger
    } catch (e: unknown) {
      toast.error((e as Error).message ?? "Wipe failed");
    } finally {
      setWiping(false);
    }
  }

  const markets = (marketsLive ?? []) as Market[];
  const myBetsLive = useQuery(api.betting.listMyBets, { eventKey });
  const bettedMarketIds = new Set((myBetsLive ?? []).map((b) => b.marketId));

  const filtered = useMemo(() => {
    return markets
      .filter((m) => typeFilter === "all" || m.type === typeFilter)
      .filter((m) => statusFilter === "all" || m.status === statusFilter)
      .sort((a, b) => {
        // Open markets first, then by match number
        const statusOrder = { open: 0, locked: 1, resolved: 2, cancelled: 3 };
        if (a.status !== b.status) return statusOrder[a.status] - statusOrder[b.status];
        return (a.matchNumber ?? 9999) - (b.matchNumber ?? 9999);
      });
  }, [markets, typeFilter, statusFilter]);

  return (
    <div className="space-y-4">
      {/* Admin toolbar — only visible to admins */}
      {isAdmin && (
        <div className="flex flex-wrap gap-2 items-center p-3 rounded-xl bg-primary/5 border border-primary/20">
          <span className="text-xs font-semibold text-primary/70 uppercase tracking-wider flex items-center gap-1.5">
            <Zap className="h-3 w-3" /> Admin Controls
          </span>
          <div className="flex flex-wrap gap-2 ml-auto">
            <Button
              size="sm"
              variant="outline"
              className="gap-2 border-amber-400/40 text-amber-400 hover:bg-amber-400/10"
              onClick={handleAutoGenerate}
              disabled={autoGenerating || tbaMatches.filter((m) => !isPlayed(m)).length === 0}
            >
              {autoGenerating
                ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                : <Zap className="h-3.5 w-3.5" />}
              {autoGenerating ? "Generating…" : "Auto-Generate"}
            </Button>

            <Button
              size="sm"
              variant="outline"
              className="gap-2 border-amber-400/40 text-amber-400 hover:bg-amber-400/10"
              onClick={handleTestGenerate}
              disabled={autoGenerating}
            >
              {autoGenerating
                ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                : <Target className="h-3.5 w-3.5" />}
              Test Generate
            </Button>

            <CreateMarketPanel
              eventKey={eventKey}
              tbaMatches={tbaMatches}
              onCreated={() => {}}
            />

            <Button
              size="sm"
              variant="outline"
              className="gap-2 border-red-500/40 text-red-500 hover:bg-red-500/10"
              onClick={handleWipeAll}
              disabled={wiping || autoGenerating}
            >
              {wiping
                ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                : <XCircle className="h-3.5 w-3.5" />}
              Wipe All
            </Button>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-1.5">
        {Object.entries(TYPE_FILTER_LABELS).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTypeFilter(k)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors border ${
              typeFilter === k
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex gap-1.5">
        {(["all", "open", "locked", "resolved"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium transition-colors border ${
              statusFilter === s
                ? "bg-primary/20 text-primary border-primary/40"
                : "border-border/50 text-muted-foreground hover:border-primary/30"
            }`}
          >
            {s === "all" ? "All Status" : STATUS_CONFIG[s].label}
          </button>
        ))}
      </div>

      {/* Market list */}
      {markets.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
          <div className="h-16 w-16 rounded-2xl bg-primary/10 flex items-center justify-center">
            <Swords className="h-8 w-8 text-primary/60" />
          </div>
          <p className="font-semibold text-lg">No markets yet</p>
          <p className="text-sm text-muted-foreground max-w-xs">
            Hit "Auto-Generate Markets" to create match winner markets from the TBA schedule, or create a custom market.
          </p>
        </div>
      )}

      <div className="space-y-3">
        {filtered.map((m) => (
          <MarketCard
            key={m._id}
            market={m}
            myBalance={myBalance}
            onResolved={() => {}}
            isAdmin={isAdmin}
            hasBet={bettedMarketIds.has(m._id)}
          />
        ))}
        {filtered.length === 0 && markets.length > 0 && (
          <p className="text-center text-sm text-muted-foreground py-8">No markets match filters</p>
        )}
      </div>
    </div>
  );
}

// ── My Bets Tab ───────────────────────────────────────────────────────────────

function MyBetsTab({ eventKey }: { eventKey: string }) {
  const balanceLive = useQuery(api.betting.getMyBalance, { eventKey });
  const myBetsLive = useQuery(api.betting.listMyBets, { eventKey });
  const marketsLive = useQuery(api.betting.listMarkets, { eventKey });
  const getOrCreate = useMutation(api.betting.getOrCreateBalance);
  const beg = useMutation(api.betting.beg);
  const [begging, setBegging] = useState(false);
  const [lastBegResult, setLastBegResult] = useState<number | null>(null);
  const [begCooldown, setBegCooldown] = useState(0);

  // Ensure balance exists
  useEffect(() => {
    getOrCreate({ eventKey }).catch(() => {});
  }, [eventKey]);

  const balance = balanceLive;
  const myBets = (myBetsLive ?? []).sort((a, b) => b.placedAt - a.placedAt);
  const markets = (marketsLive ?? []) as Market[];
  const marketMap = Object.fromEntries(markets.map((m) => [m._id, m]));

  async function handleBeg() {
    if (begCooldown > 0) return;
    setBegging(true);
    try {
      const result = await beg({ eventKey }) as { newBalance: number; totalBegs: number };
      setLastBegResult(result.newBalance);
      toast("+10 coins. The humiliation is complete.", { duration: 2000 });
      // Start 3-second cooldown
      setBegCooldown(3);
      const interval = setInterval(() => {
        setBegCooldown((prev) => {
          if (prev <= 1) { clearInterval(interval); return 0; }
          return prev - 1;
        });
      }, 1000);
    } catch {
      toast.error("Even begging failed. Impressive.");
    } finally {
      setBegging(false);
      setTimeout(() => setLastBegResult(null), 2000);
    }
  }

  const pendingBets = myBets.filter((b) => !b.settled);
  const settledBets = myBets.filter((b) => b.settled);
  const totalWagered = myBets.reduce((s, b) => s + b.amount, 0);
  const totalPayout = settledBets.reduce((s, b) => s + (b.payout ?? 0), 0);

  return (
    <div className="space-y-6">
      {/* Balance card */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-amber-500/20 via-yellow-500/10 to-orange-500/10 border border-amber-500/30 p-6">
        <div className="absolute top-0 right-0 h-32 w-32 rounded-full bg-amber-500/10 blur-2xl -translate-y-8 translate-x-8" />
        <div className="relative">
          <p className="text-sm text-amber-400/80 font-medium uppercase tracking-wider">Your Balance</p>
          <div className="flex items-end gap-3 mt-1">
            <span className="text-5xl font-black text-amber-400 font-mono tabular-nums">
              {balance ? formatCoins(balance.balance) : "…"}
            </span>
            <Coins className="h-7 w-7 text-amber-400/60 mb-1" />
          </div>
          <div className="flex gap-4 mt-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><TrendingUp className="h-3 w-3 text-amber-400" /> Won: <span className="text-amber-400 font-mono">{balance ? formatCoins(balance.totalWon) : "…"}</span></span>
            <span className="flex items-center gap-1"><TrendingDown className="h-3 w-3 text-red-400" /> Lost: <span className="text-red-400 font-mono">{balance ? formatCoins(balance.totalLost) : "…"}</span></span>
            <span className="flex items-center gap-1"><Coins className="h-3 w-3 text-amber-300" /> Bet: <span className="text-amber-300 font-mono">{balance ? formatCoins(balance.totalBet) : "…"}</span></span>
          </div>
          {(balance?.totalBegs ?? 0) > 0 && (
            <p className="text-[10px] text-muted-foreground/60 mt-1 flex items-center gap-1">
              <HandCoins className="h-3 w-3" /> You have begged {balance!.totalBegs} time{balance!.totalBegs === 1 ? "" : "s"}. Be proud.
            </p>
          )}
        </div>

        {/* pls beg button */}
        <div className="relative mt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={handleBeg}
            disabled={begging || begCooldown > 0}
            className="border-amber-500/40 text-amber-400 hover:bg-amber-500/10 font-semibold gap-2 relative overflow-hidden"
          >
            <HandCoins className="h-4 w-4" />
            {begging ? "begging…" : begCooldown > 0 ? `wait ${begCooldown}s…` : "pls beg"}
            {lastBegResult !== null && (
              <span className="absolute -top-6 left-1/2 -translate-x-1/2 text-amber-400 font-bold text-xs animate-bounce">
                +10
              </span>
            )}
          </Button>
          <p className="text-[10px] text-muted-foreground/50 mt-1">grants +10 coins. 3s cooldown.</p>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl bg-card border border-border p-4 text-center">
          <p className="text-2xl font-bold font-mono text-primary">{myBets.length}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Total Bets</p>
        </div>
        <div className="rounded-xl bg-card border border-border p-4 text-center">
          <p className="text-2xl font-bold font-mono text-amber-400">{formatCoins(totalWagered)}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Wagered</p>
        </div>
        <div className="rounded-xl bg-card border border-border p-4 text-center">
          <p className={`text-2xl font-bold font-mono ${totalPayout - totalWagered >= 0 ? "text-amber-400" : "text-red-400"}`}>
            {totalPayout - totalWagered >= 0 ? "+" : ""}{formatCoins(totalPayout - totalWagered)}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">Net P&L</p>
        </div>
      </div>

      {/* Pending bets */}
      {pendingBets.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <Timer className="h-4 w-4 text-amber-400" />
            Pending ({pendingBets.length})
          </h3>
          {pendingBets.map((bet) => {
            const market = marketMap[bet.marketId];
            const optLabel = market?.options.find((o) => o.id === bet.optionId)?.label ?? bet.optionId;
            return (
              <div key={bet._id} className="rounded-xl bg-card border border-amber-500/20 p-4 flex items-center gap-3">
                <div className="h-8 w-8 rounded-lg bg-amber-500/10 flex items-center justify-center shrink-0">
                  <Coins className="h-4 w-4 text-amber-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{market?.title ?? "Unknown Market"}</p>
                  <p className="text-xs text-muted-foreground">Bet on: <span className="text-foreground">{optLabel}</span></p>
                </div>
                <div className="text-right shrink-0">
                  <p className="font-mono font-bold text-amber-400 flex items-center gap-1 justify-end">{bet.amount} <Coins className="h-3 w-3" /></p>
                  <span className={`text-[10px] border px-1.5 py-0.5 rounded-full ${STATUS_CONFIG[market?.status ?? "open"].color}`}>
                    {market ? STATUS_CONFIG[market.status].label : "…"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Settled bets */}
      {settledBets.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-amber-400" />
            Settled ({settledBets.length})
          </h3>
          {settledBets.map((bet) => {
            const market = marketMap[bet.marketId];
            const optLabel = market?.options.find((o) => o.id === bet.optionId)?.label ?? bet.optionId;
            const payout = bet.payout ?? 0;
            const won = payout > 0;
            const profit = payout - bet.amount;
            return (
              <div key={bet._id} className={`rounded-xl bg-card border p-4 flex items-center gap-3 ${won ? "border-amber-500/20" : "border-red-500/20 opacity-70"}`}>
                <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${won ? "bg-amber-500/10" : "bg-red-500/10"}`}>
                  {won ? <TrendingUp className="h-4 w-4 text-amber-400" /> : <X className="h-4 w-4 text-red-400" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{market?.title ?? "Unknown Market"}</p>
                  <p className="text-xs text-muted-foreground">Bet on: <span className="text-foreground">{optLabel}</span></p>
                </div>
                <div className="text-right shrink-0">
                  <p className={`font-mono font-bold text-sm flex items-center gap-1 justify-end ${won ? "text-amber-400" : "text-red-400"}`}>
                    {won ? `+${profit}` : `-${bet.amount}`} <Coins className="h-3 w-3" />
                  </p>
                  <p className="text-[10px] text-muted-foreground">{bet.amount} wagered</p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {myBets.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
          <div className="h-16 w-16 rounded-2xl bg-amber-500/10 flex items-center justify-center">
            <Coins className="h-8 w-8 text-amber-400/60" />
          </div>
          <p className="font-semibold text-lg">No bets yet</p>
          <p className="text-sm text-muted-foreground">Head over to Markets and put your coins to work.</p>
        </div>
      )}
    </div>
  );
}

// ── Leaderboard Tab ───────────────────────────────────────────────────────────

function LeaderboardTab({ eventKey }: { eventKey: string }) {
  const leaderboard = useQuery(api.betting.getLeaderboard, { eventKey });

  if (!leaderboard) {
    return (
      <div className="flex items-center justify-center py-16">
        <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (leaderboard.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
        <div className="h-16 w-16 rounded-2xl bg-primary/10 flex items-center justify-center">
          <Trophy className="h-8 w-8 text-primary/60" />
        </div>
        <p className="font-semibold text-lg">No bettors yet</p>
        <p className="text-sm text-muted-foreground">Be the first to place a bet!</p>
      </div>
    );
  }

  const medalColors = ["text-amber-400", "text-slate-300", "text-amber-600"];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Users className="h-4 w-4" />
        <span>{leaderboard.length} participant{leaderboard.length !== 1 ? "s" : ""}</span>
      </div>

      {leaderboard.map((entry, i) => {
        const netProfit = entry.totalWon - entry.totalLost;
        const winRate = entry.totalBet > 0 ? (entry.totalWon / entry.totalBet) * 100 : 0;
        const isTop3 = i < 3;

        return (
          <div
            key={entry._id}
            className={`rounded-2xl border p-4 flex items-center gap-4 transition-all ${
              isTop3
                ? "bg-gradient-to-r from-primary/5 to-transparent border-primary/20"
                : "bg-card border-border"
            }`}
          >
            <div className={`flex items-center justify-center w-8 shrink-0 ${isTop3 ? medalColors[i] : "text-muted-foreground"}`}>
              {isTop3 ? <Medal className="h-5 w-5" /> : <span className="text-base font-mono">{i + 1}</span>}
            </div>

            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm truncate">{entry.displayName}</p>
              <div className="flex gap-3 text-[11px] text-muted-foreground mt-0.5">
                <span className="flex items-center gap-1"><Coins className="h-3 w-3" /> {entry.totalBet > 0 ? formatCoins(entry.totalBet) : "0"} bet</span>
                <span className="flex items-center gap-1"><TrendingUp className="h-3 w-3" /> {winRate.toFixed(0)}% ROI</span>
                {(entry.totalBegs ?? 0) > 0 && (
                  <span className="flex items-center gap-1 text-muted-foreground/50"><HandCoins className="h-3 w-3" /> {entry.totalBegs}x beg</span>
                )}
              </div>
            </div>

            <div className="text-right shrink-0">
              <p className={`font-mono font-bold text-lg ${netProfit >= 0 ? "text-amber-400" : "text-red-400"}`}>
                {netProfit >= 0 ? "+" : ""}{formatCoins(netProfit)}
              </p>
              <p className="text-[10px] text-muted-foreground flex items-center gap-1 justify-end">
                {formatCoins(entry.balance)} <Coins className="h-3 w-3" /> left
              </p>
            </div>
          </div>
        );
      })}

      {/* Leaderboard of shame */}
      {leaderboard.some((e) => (e.totalBegs ?? 0) > 0) && (
        <div className="mt-6 rounded-2xl border border-border/50 bg-card p-4">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
            <HandCoins className="h-3.5 w-3.5" />
            Leaderboard of Shame
          </p>
          <div className="space-y-2">
            {leaderboard
              .filter((e) => (e.totalBegs ?? 0) > 0)
              .sort((a, b) => (b.totalBegs ?? 0) - (a.totalBegs ?? 0))
              .map((e, i) => (
                <div key={e._id} className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground/50 w-5 text-right text-xs">{i + 1}.</span>
                  <span className="flex-1 text-muted-foreground truncate">{e.displayName}</span>
                  <span className="font-mono text-xs text-muted-foreground/70 flex items-center gap-1"><HandCoins className="h-3 w-3" /> {e.totalBegs}</span>
                </div>
              ))
            }
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

type Tab = "markets" | "my-bets" | "leaderboard";

export default function BettingPage() {
  const [activeTab, setActiveTab] = useState<Tab>("markets");

  const currentEventLive = useQuery(api.events.getCurrentEvent);
  const currentEvent = useCached(currentEventLive, "current_event");
  const eventKey = currentEvent?.eventKey ?? "";
  const { isAdminMode } = useUIStore();

  const balanceLive = useQuery(api.betting.getMyBalance, eventKey ? { eventKey } : "skip");
  const getOrCreate = useMutation(api.betting.getOrCreateBalance);

  // Ensure the user has a balance record
  useEffect(() => {
    if (eventKey) {
      getOrCreate({ eventKey }).catch(() => {});
    }
  }, [eventKey]);

  const myBalance = balanceLive?.balance ?? 1000;

  if (!eventKey) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4 text-center">
        <div className="h-16 w-16 rounded-2xl bg-primary/10 flex items-center justify-center">
          <AlertCircle className="h-8 w-8 text-primary/60" />
        </div>
        <p className="font-semibold text-lg">No Event Selected</p>
        <p className="text-sm text-muted-foreground max-w-xs">
          Go to Settings and set a current event to start betting.
        </p>
      </div>
    );
  }

  const tabs: { id: Tab; label: string; icon: React.ElementType }[] = [
    { id: "markets",     label: "Markets",     icon: Swords },
    { id: "my-bets",     label: "My Bets",     icon: Coins },
    { id: "leaderboard", label: "Leaderboard", icon: Trophy },
  ];

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-amber-500 to-yellow-400 flex items-center justify-center shadow-lg shadow-amber-500/20">
              <Coins className="h-5 w-5 text-black" />
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-tight">FalconBet</h1>
              <p className="text-xs text-muted-foreground">{currentEvent?.eventName ?? eventKey}</p>
            </div>
          </div>
        </div>
        {/* Balance pill */}
        {balanceLive && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/30">
            <span className="text-amber-400 font-black font-mono text-lg">{formatCoins(myBalance)}</span>
            <Coins className="h-5 w-5 text-amber-400" />
          </div>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex rounded-xl bg-muted/60 p-1 gap-1 border border-border/50">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-semibold transition-all ${
              activeTab === id
                ? "bg-card shadow-sm text-foreground border border-border/40"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "markets" && (
        <MarketsTab eventKey={eventKey} myBalance={myBalance} isAdmin={isAdminMode} />
      )}
      {activeTab === "my-bets" && <MyBetsTab eventKey={eventKey} />}
      {activeTab === "leaderboard" && <LeaderboardTab eventKey={eventKey} />}
    </div>
  );
}
