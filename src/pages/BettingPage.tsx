import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useQuery, useMutation } from "convex/react";
import { useAdminMutation } from "@/hooks/useAdminMutation";
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
  BadgeCheck, AlertCircle, Timer, Users, X, Medal, Dices,
  Flame, Square, Play, Circle, ArrowDown, Bird,
  Bomb, Gem, Diamond, ShieldCheck, Sparkles,
  Cherry, Bell, Star, DollarSign, Citrus, HelpCircle, CircleCheck, CircleDollarSign, Skull,
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

// -- Types ---------------------------------------------------------------------

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

// -- Helpers -------------------------------------------------------------------

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

// -- Emoji stripping helper ------------------------------------------------------

/** Strip common circle/arrow emojis that were baked into old DB records. */
function stripEmojis(text: string): string {
  return text.replace(/[\u{1F534}\u{1F535}\u{2B06}\u{2B07}\u{26AA}\u{2B55}\u{1F7E0}\u{1F7E1}\u{1F7E2}\u{1F7E3}\u{1F7E4}\u{2764}\u{1F499}\u{1F534}\u{1F535}UPDOWN]/gu, "").replace(/\s{2,}/g, " ").trim();
}

// -- Alliance Label --------------------------------------------------------------

function AllianceLabel({ label }: { label: string }) {
  const cleaned = stripEmojis(label);
  if (cleaned.toLowerCase().includes("red")) return <span className="text-red-500">{cleaned}</span>;
  if (cleaned.toLowerCase().includes("blue")) return <span className="text-blue-500">{cleaned}</span>;
  return <span>{cleaned}</span>;
}

/** Render a market description with emojis stripped and Red/Blue words colorized. */
function ColorizedDescription({ text }: { text: string }) {
  const cleaned = stripEmojis(text);
  // Split on "Red" and "Blue" (case-insensitive) to wrap them in colored spans
  const parts = cleaned.split(/(\bRed\b|\bBlue\b)/gi);
  return (
    <>
      {parts.map((part, i) => {
        if (part.toLowerCase() === "red") return <span key={i} className="text-red-500 font-semibold">{part}</span>;
        if (part.toLowerCase() === "blue") return <span key={i} className="text-blue-500 font-semibold">{part}</span>;
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

// -- Probability Bar -----------------------------------------------------------

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
    "bg-yellow-400",
    "bg-yellow-400",
    "bg-yellow-400",
    "bg-yellow-400",
    "bg-yellow-400",
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
                <AllianceLabel label={opt.label} />
              </span>
              <span className="font-mono text-muted-foreground">
                {(pct * 100).toFixed(1)}%
              </span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-700 ${colors[i % colors.length]} ${isLoser ? "opacity-30" : ""}`}
                style={{ width: `${Math.max(pct * 100, 2)}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// -- Bet Placement Panel -------------------------------------------------------

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
            <AllianceLabel label={opt.label} />
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
        className="w-full font-bold bg-yellow-400 hover:bg-yellow-500 text-black border-0"
      >
        {placing ? <RefreshCw className="h-4 w-4 animate-spin mr-2" /> : <Coins className="h-4 w-4 mr-2" />}
        {placing ? "Placing..." : `Bet ${amount} coins`}
      </Button>
    </div>
  );
}

// -- Market Card ---------------------------------------------------------------

function MarketCard({
  market,
  myBalance,
  onResolved,
  isAdmin,
}: {
  market: Market;
  myBalance: number;
  onResolved: () => void;
  isAdmin: boolean;
  hasBet?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolveOption, setResolveOption] = useState(market.options[0]?.id ?? "");

  const poolDataLive = useQuery(api.betting.getMarketPool, { marketId: market._id });
  const poolData = useCached(poolDataLive, `betting_pool_${market._id}`);
  const realBets: Record<string, number> = poolData ?? {};

  const resolveMarket = useAdminMutation(api.betting.resolveMarket);
  const lockMarket = useAdminMutation(api.betting.lockMarket);
  const unlockMarket = useAdminMutation(api.betting.unlockMarket);

  const TypeIcon = TYPE_ICONS[market.type];
  const sc = STATUS_CONFIG[market.status];
  const StatusIcon = sc.icon;

  const totalRealBets = Object.values(realBets).reduce((s, v) => s + v, 0);

  const handleResolve = async () => {
    try {
      const result = await resolveMarket({ marketId: market._id, resolvedOptionId: resolveOption });
      const r = result as { settledBets: number; totalPool: number };
      toast.success(`Market resolved! ${r.settledBets} bets settled.`);
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
              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                <ColorizedDescription text={market.description} />
              </p>
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
                  <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider"><AllianceLabel label={opt.label} /></p>
                  <p className="text-sm font-mono font-bold flex items-center gap-1">
                    {formatCoins(opt.seedPool + (realBets[opt.id] ?? 0))} <Coins className="h-3 w-3 text-amber-400" />
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {formatCoins(realBets[opt.id] ?? 0)} real  -  {formatCoins(opt.seedPool)} seed
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
                <Button size="sm" className="h-7 text-xs bg-yellow-400 hover:bg-yellow-500 text-black border-0"
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
            className="w-full bg-yellow-400 hover:bg-yellow-500 text-black border-0 font-bold"
            onClick={handleResolve}
          >
            Confirm Resolution
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}

// -- Create Market Panel -------------------------------------------------------


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
            ? "Select matches..."
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
  const createMarket = useAdminMutation(api.betting.createMarket);

  const isMultiMatch = type === "multi_match_numeric" || type === "multi_match_count";

  // Match options from TBA  -  show all matches, marking played ones
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


  // Selected template's bettable fields  -  filtered by the current market type
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
      case "match_winner":       return `${mStr}  -  Match Winner`;
      case "alliance_score_ou":  return `${mStr} ${alliance.toUpperCase()} Score ${threshold ? `Over/Under ${threshold}` : "O/U"}`;
      case "point_differential": return `${mStr} Point Diff ${threshold ? `Over/Under ${threshold}` : "O/U"}`;
      case "team_field_bool":    return `${mStr} Team ${teamNum}  -  ${fieldStr} Yes/No`;
      case "team_field_numeric": return `${mStr} Team ${teamNum}  -  ${fieldStr} Over/Under ${threshold ?? "?"}`;
      case "team_field_select":  return `${mStr} Team ${teamNum}  -  ${fieldStr} = "${targetValue}"`;
      case "multi_match_numeric":
        return `${scopeStr}  -  Total ${fieldStr} O/U ${threshold ?? "?"} across ${multiMatchLabels || "?"}`;
      case "multi_match_count":
        return `${scopeStr}  -  ${fieldStr} in >=${minCount || "?"} of ${multiMatchLabels || "?"}`;
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

            {/* Market Type  -  inline label + select side by side */}
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

            {/* Match (single)  -  for non-multi-match types */}
            {!isMultiMatch && (
              <div className="flex items-center gap-3">
                <Label className="shrink-0 w-24 text-right text-xs text-muted-foreground">Match</Label>
                <Select value={matchNum} onValueChange={(v) => { setMatchNum(v ?? ""); setTeamNum(""); }}>
                  <SelectTrigger className="flex-1 h-8 text-sm [&>span]:truncate">
                    <SelectValue placeholder="Select match...">
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

            {/* Multi-match selector  -  checkbox dropdown */}
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

            {/* Alliance toggle  -  for alliance_score_ou */}
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

            {/* Target scope toggle  -  for multi-match types */}
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

            {/* Alliance selector  -  shown for multi-match alliance scope */}
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

            {/* Team dropdown  -  for single-match team types (uses match teams) */}
            {(type === "team_field_bool" || type === "team_field_numeric" || type === "team_field_select") && (
              <div className="flex items-center gap-3">
                <Label className="shrink-0 w-24 text-right text-xs text-muted-foreground">Team #</Label>
                <Select
                  value={teamNum}
                  onValueChange={(v) => setTeamNum(v ?? "")}
                  disabled={matchTeams.length === 0}
                >
                  <SelectTrigger className="flex-1 h-8 text-sm [&>span]:truncate">
                    <SelectValue placeholder={matchTeams.length === 0 ? "Select a match first..." : "Select team..."} />
                  </SelectTrigger>
                  <SelectContent>
                    {matchTeams.map((t) => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Team dropdown  -  for multi-match team scope (uses intersection of teams) */}
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
                      selectedMatchKeys.size < 2 ? "Select >=2 matches first..." :
                      multiMatchTeams.length === 0 ? "No teams in all matches" :
                      "Select team..."
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
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 text-xs font-medium ml-[calc(6rem+0.75rem)]">
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

            {/* Data source toggle  -  for multi_match_numeric */}
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

            {/* TBA stat picker  -  shown when multi_match_numeric + tba source */}
            {useTbaSource && (
              <div className="flex items-center gap-3">
                <Label className="shrink-0 w-24 text-right text-xs text-muted-foreground">TBA Stat</Label>
                <Select value={tbaField} onValueChange={(v) => setTbaField(v ?? "")}>
                  <SelectTrigger className="flex-1 h-8 text-sm [&>span]:truncate">
                    <SelectValue placeholder="Select stat...">
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
                      <SelectValue placeholder="Select form...">
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
                      <SelectValue placeholder="Select field...">
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
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 text-xs font-medium">
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
                    <SelectValue placeholder="Select value..." />
                  </SelectTrigger>
                  <SelectContent>
                    {selectedField.options.map((o) => (
                      <SelectItem key={o} value={o}>{o}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Min count  -  for multi_match_count */}
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
                    {"  -  "}{selectedMatchKeys.size} matches
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
              {creating ? "Creating..." : "Create Market"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// -- Markets Tab ---------------------------------------------------------------

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

  const marketsQuery = useQuery(api.betting.listMarkets, { eventKey });
  const marketsLive = useCached(marketsQuery, `betting_markets_${eventKey}`);
  const batchCreateRandom = useAdminMutation(api.betting.batchCreateRandomMarkets);
  const clearAll = useAdminMutation(api.betting.clearAllMarkets);

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
      // Win probability seeds (1-99, summing to 100)
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
    if (all.length === 0) return; // no TBA data yet  -  wait

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
      const pool = tbaMatches;
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
        toast.info("All matches already have markets  -  nothing new to create.");
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
  const myBetsQuery = useQuery(api.betting.listMyBets, { eventKey });
  const myBetsLive = useCached(myBetsQuery, `betting_my_bets_${eventKey}`);
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
      {/* Admin toolbar  -  only visible to admins */}
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
              {autoGenerating ? "Generating..." : "Auto-Generate"}
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

// -- My Bets Tab ---------------------------------------------------------------

function MyBetsTab({ eventKey }: { eventKey: string }) {
  const balanceQuery2 = useQuery(api.betting.getMyBalance, { eventKey });
  const balanceLive = useCached(balanceQuery2, `betting_balance_${eventKey}`);
  const myBetsQuery2 = useQuery(api.betting.listMyBets, { eventKey });
  const myBetsLive = useCached(myBetsQuery2, `betting_my_bets_${eventKey}`);
  const marketsQuery2 = useQuery(api.betting.listMarkets, { eventKey });
  const marketsLive = useCached(marketsQuery2, `betting_markets_${eventKey}`);
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
      toast("+1 coin. The humiliation is complete.", { duration: 2000 });
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
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-yellow-500/15 via-amber-500/10 to-yellow-400/5 border border-yellow-500/30 p-6">
        <div className="absolute top-0 right-0 h-32 w-32 rounded-full bg-amber-500/10 blur-2xl -translate-y-8 translate-x-8" />
        <div className="relative">
          <p className="text-sm text-amber-400/80 font-medium uppercase tracking-wider">Your Balance</p>
          <div className="flex items-end gap-3 mt-1">
            <span className="text-5xl font-black text-amber-400 font-mono tabular-nums">
              {balance ? formatCoins(balance.balance) : "..."}
            </span>
            <Coins className="h-7 w-7 text-amber-400/60 mb-1" />
          </div>
          <div className="flex gap-4 mt-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><TrendingUp className="h-3 w-3 text-amber-400" /> Won: <span className="text-amber-400 font-mono">{balance ? formatCoins(balance.totalWon) : "..."}</span></span>
            <span className="flex items-center gap-1"><TrendingDown className="h-3 w-3 text-red-400" /> Lost: <span className="text-red-400 font-mono">{balance ? formatCoins(balance.totalLost) : "..."}</span></span>
            <span className="flex items-center gap-1"><Coins className="h-3 w-3 text-amber-300" /> Bet: <span className="text-amber-300 font-mono">{balance ? formatCoins(balance.totalBet) : "..."}</span></span>
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
            {begging ? "begging..." : begCooldown > 0 ? `wait ${begCooldown}s...` : "pls beg"}
            {lastBegResult !== null && (
              <span className="absolute -top-6 left-1/2 -translate-x-1/2 text-amber-400 font-bold text-xs animate-bounce">
                +1
              </span>
            )}
          </Button>
          <p className="text-[10px] text-muted-foreground/50 mt-1">grants +1 coin. 60s cooldown. Scout to actually earn.</p>
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
                    {market ? STATUS_CONFIG[market.status].label : "..."}
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

// -- Leaderboard Tab -----------------------------------------------------------

function LeaderboardTab({ eventKey }: { eventKey: string }) {
  const leaderboardLive = useQuery(api.betting.getLeaderboard, { eventKey });
  const leaderboard = useCached(leaderboardLive, `betting_leaderboard_${eventKey}`);

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
              {/* Total coins is the headline; net profit is the footnote. */}
              <p className="font-mono font-bold text-lg text-amber-400 flex items-center gap-1 justify-end">
                {formatCoins(entry.balance)} <Coins className="h-4 w-4" />
              </p>
              <p className={`text-[10px] flex items-center gap-1 justify-end ${netProfit >= 0 ? "text-muted-foreground" : "text-red-400/70"}`}>
                {netProfit >= 0 ? "+" : ""}{formatCoins(netProfit)} net
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

// -- Slot Machine --------------------------------------------------------------

const SLOT_SYMBOLS_UI = [
  { id: "lemon",  icon: Citrus,     label: "Lemon",   color: "text-yellow-300",  gradient: "from-yellow-300 to-lime-400" },
  { id: "cherry", icon: Cherry,      label: "Cherry",  color: "text-red-400",     gradient: "from-red-400 to-pink-500" },
  { id: "bell",   icon: Bell,        label: "Bell",    color: "text-amber-400",   gradient: "from-amber-400 to-orange-500" },
  { id: "star",   icon: Star,        label: "Star",    color: "text-yellow-400",  gradient: "from-yellow-400 to-amber-500" },
  { id: "seven",  icon: Diamond,     label: "Seven",   color: "text-purple-400",  gradient: "from-purple-400 to-violet-500" },
  { id: "money",  icon: DollarSign,  label: "Jackpot", color: "text-emerald-400", gradient: "from-emerald-400 to-green-500" },
] as const;

const SLOT_PAYOUTS_UI: { symbol: string; icon: React.ElementType; x5: number; x4: number; x3: number; x2: number; color: string }[] = [
  { symbol: "money",  icon: DollarSign, x5: 500, x4: 75, x3: 15,  x2: 0.5,  color: "text-emerald-400" },
  { symbol: "seven",  icon: Diamond,    x5: 150, x4: 30, x3: 8,   x2: 0.4,  color: "text-purple-400" },
  { symbol: "star",   icon: Star,       x5: 75,  x4: 15, x3: 4,   x2: 0.3,  color: "text-yellow-400" },
  { symbol: "bell",   icon: Bell,       x5: 30,  x4: 8,  x3: 2,   x2: 0.2,  color: "text-amber-400" },
  { symbol: "cherry", icon: Cherry,     x5: 15,  x4: 5,  x3: 1.5, x2: 0.15, color: "text-red-400" },
  { symbol: "lemon",  icon: Citrus,     x5: 8,   x4: 3,  x3: 1,   x2: 0.1,  color: "text-yellow-300" },
];

function getSymbolDef(id: string) {
  return SLOT_SYMBOLS_UI.find((s) => s.id === id) ?? SLOT_SYMBOLS_UI[0];
}

/** Render a slot symbol icon */
function SlotIcon({ symbolId, size = "md" }: { symbolId: string; size?: "sm" | "md" | "lg" }) {
  const def = getSymbolDef(symbolId);
  const Icon = def.icon;
  const sizeClasses = size === "sm" ? "h-4 w-4" : size === "lg" ? "h-8 w-8 sm:h-9 sm:w-9" : "h-6 w-6 sm:h-7 sm:w-7";
  return <Icon className={`${sizeClasses} ${def.color} drop-shadow-[0_0_6px_currentColor]`} strokeWidth={2.5} />;
}

/** Coin particle for win animation */
function CoinParticle({ index: _index }: { index: number }) {
  const left = Math.random() * 100;
  const delay = Math.random() * 0.8;
  const size = 16 + Math.random() * 16;
  const rotation = Math.random() * 360;
  return (
    <div
      className="slot-coin absolute text-yellow-400 z-50 pointer-events-none"
      style={{
        left: `${left}%`,
        top: "-20px",
        fontSize: `${size}px`,
        animationDelay: `${delay}s`,
        animationDuration: `${1.5 + Math.random() * 1}s`,
        transform: `rotate(${rotation}deg)`,
      }}
    >
      <Coins className="h-full w-full" />
    </div>
  );
}

/** Generate a random symbol ID */
function randomSymbolId(): string {
  return SLOT_SYMBOLS_UI[Math.floor(Math.random() * SLOT_SYMBOLS_UI.length)].id;
}

/**
 * Generate near-miss adjacent rows. On losing spins, bias toward placing the
 * pay-line's most-common symbol in above/below slots so it *looks* like you
 * almost hit a big match.
 */
function generateAdjacentRow(centerReels: string[]): string[] {
  // Find the most common symbol on the center pay line
  const counts: Record<string, number> = {};
  for (const s of centerReels) counts[s] = (counts[s] ?? 0) + 1;
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const bestSym = best?.[0] ?? "lemon";
  const bestCnt = best?.[1] ?? 0;

  // High-value symbols that feel painful to "almost" match
  const highValue = ["money", "seven", "star"];

  return centerReels.map((_centerSym) => {
    // 35% chance: place the best pay-line symbol here (near-miss tease)
    if (bestCnt >= 2 && Math.random() < 0.35) return bestSym;
    // 25% chance: place a high-value symbol to tease jackpot
    if (Math.random() < 0.25) return highValue[Math.floor(Math.random() * highValue.length)];
    // Otherwise random
    return randomSymbolId();
  });
}

function SlotMachine({ eventKey, myBalance, onBalanceOverride }: { eventKey: string; myBalance: number; onBalanceOverride: (v: number | null) => void }) {
  // Reel results (center pay line)
  const [reels, setReels] = useState<string[]>(["star", "cherry", "bell", "seven", "lemon"]);
  const [displayReels, setDisplayReels] = useState<string[]>(["star", "cherry", "bell", "seven", "lemon"]);
  // Above & below rows (cosmetic only  -  near-miss tease)
  const [displayAbove, setDisplayAbove] = useState<string[]>(["money", "seven", "star", "cherry", "bell"]);
  const [displayBelow, setDisplayBelow] = useState<string[]>(["bell", "lemon", "money", "star", "seven"]);
  const [reelStopped, setReelStopped] = useState<boolean[]>([true, true, true, true, true]);
  const [isSpinning, setIsSpinning] = useState(false);

  // Bet controls
  const [betAmount, setBetAmount] = useState(50);
  const [multiSpins, setMultiSpins] = useState(1);
  const [spinsLeft, setSpinsLeft] = useState(0);
  const [multiSpinTotal, setMultiSpinTotal] = useState(0);
  const [multiSpinWins, setMultiSpinWins] = useState(0);

  // Win state
  const [lastWin, setLastWin] = useState(0);
  const [showWin, setShowWin] = useState(false);
  const [winStreak, setWinStreak] = useState(0);
  const [showPayouts, setShowPayouts] = useState(false);
  const [totalSpins, setTotalSpins] = useState(0);
  const [sessionWins, setSessionWins] = useState(0);
  const [sessionLosses, setSessionLosses] = useState(0);

  // Local display balance: freezes during animation so Convex reactivity doesn't spoil the result
  const [displayBalance, setDisplayBalance] = useState(myBalance);
  const isAnimatingRef = useRef(false);

  // Sync displayBalance with server balance ONLY when not animating
  useEffect(() => {
    if (!isAnimatingRef.current) {
      setDisplayBalance(myBalance);
      onBalanceOverride(null);
    }
  }, [myBalance, onBalanceOverride]);

  // Clear override on unmount
  useEffect(() => {
    return () => { onBalanceOverride(null); };
  }, [onBalanceOverride]);

  // Refs
  const isAutoRef = useRef(false);
  const spinTimerRef = useRef<ReturnType<typeof setInterval>[]>([]);

  const spinSlot = useMutation(api.betting.spinSlot);

  // Clean up spin timers on unmount
  useEffect(() => {
    return () => {
      spinTimerRef.current.forEach(clearInterval);
    };
  }, []);

  /** Single spin with animation */
  const doSpin = useCallback(async (isSingleSpin = false): Promise<{ payout: number } | null> => {
    if (displayBalance < betAmount) {
      toast.error("Not enough coins!");
      return null;
    }

    // Freeze the display balance: deduct bet locally before the server responds
    isAnimatingRef.current = true;
    setDisplayBalance(prev => {
      const newBal = prev - betAmount;
      onBalanceOverride(newBal);
      return newBal;
    });

    setIsSpinning(true);
    setShowWin(false);
    setReelStopped([false, false, false, false, false]);

    // Start rapid symbol cycling on all 3 rows
    const intervals: ReturnType<typeof setInterval>[] = [];
    for (let i = 0; i < 5; i++) {
      const interval = setInterval(() => {
        setDisplayReels((prev) => { const n = [...prev]; n[i] = randomSymbolId(); return n; });
        setDisplayAbove((prev) => { const n = [...prev]; n[i] = randomSymbolId(); return n; });
        setDisplayBelow((prev) => { const n = [...prev]; n[i] = randomSymbolId(); return n; });
      }, 60 + i * 15);
      intervals.push(interval);
    }
    spinTimerRef.current = intervals;

    try {
      const result = await spinSlot({ eventKey, betAmount });

      // For single spins, add a deceleration effect before each reel stops
      if (isSingleSpin) {
        // Gradually slow down each reel before stopping it
        for (let i = 0; i < 5; i++) {
          // Deceleration: 7 fine-grained steps for a smooth slowdown curve
          const decelSteps = [75, 100, 130, 170, 220, 285, 370];
          for (const speed of decelSteps) {
            clearInterval(intervals[i]);
            const slowInterval = setInterval(() => {
              setDisplayReels((prev) => { const n = [...prev]; n[i] = randomSymbolId(); return n; });
              setDisplayAbove((prev) => { const n = [...prev]; n[i] = randomSymbolId(); return n; });
              setDisplayBelow((prev) => { const n = [...prev]; n[i] = randomSymbolId(); return n; });
            }, speed);
            intervals[i] = slowInterval;
            await new Promise((r) => setTimeout(r, speed * 1.3));
          }

          // Now stop this reel
          clearInterval(intervals[i]);
          setDisplayReels((prev) => {
            const next = [...prev];
            next[i] = result.reels[i];
            return next;
          });
          setDisplayAbove((prev) => {
            const next = [...prev];
            const adj = generateAdjacentRow(result.reels);
            next[i] = adj[i];
            return next;
          });
          setDisplayBelow((prev) => {
            const next = [...prev];
            const adj = generateAdjacentRow(result.reels);
            next[i] = adj[i];
            return next;
          });
          setReelStopped((prev) => {
            const next = [...prev];
            next[i] = true;
            return next;
          });

          // Pause between reels stopping (builds anticipation for later reels)
          if (i < 4) {
            await new Promise((r) => setTimeout(r, 200 + i * 120));
          }
        }
      } else {
        // Multi-spin: fast stagger-stop (original behavior)
        for (let i = 0; i < 5; i++) {
          await new Promise<void>((resolve) =>
            setTimeout(() => {
              clearInterval(intervals[i]);
              setDisplayReels((prev) => {
                const next = [...prev];
                next[i] = result.reels[i];
                return next;
              });
              setDisplayAbove((prev) => {
                const next = [...prev];
                const adj = generateAdjacentRow(result.reels);
                next[i] = adj[i];
                return next;
              });
              setDisplayBelow((prev) => {
                const next = [...prev];
                const adj = generateAdjacentRow(result.reels);
                next[i] = adj[i];
                return next;
              });
              setReelStopped((prev) => {
                const next = [...prev];
                next[i] = true;
                return next;
              });
              resolve();
            }, 80 + i * 60)
          );
        }
      }

      // Wait for the last reel to finish its landing animation
      await new Promise((r) => setTimeout(r, isSingleSpin ? 450 : 100));

      setReels(result.reels);
      setTotalSpins((s) => s + 1);

      if (result.payout > 0) {
        setLastWin(result.payout);
        setShowWin(true);
        setWinStreak((s) => s + 1);
        setSessionWins((s) => s + result.payout);
        setTimeout(() => setShowWin(false), 3500);
      } else {
        setLastWin(0);
        setWinStreak(0);
        setSessionLosses((s) => s + betAmount);
      }

      // Animation finished: apply payout locally, then unfreeze to let server sync
      setDisplayBalance(prev => {
        const newBal = prev + result.payout;
        onBalanceOverride(newBal);
        return newBal;
      });
      // Allow a brief delay then unfreeze so the server value takes over
      setTimeout(() => {
        isAnimatingRef.current = false;
      }, 300);

      setIsSpinning(false);
      return { payout: result.payout };
    } catch (e: unknown) {
      toast.error((e as Error).message ?? "Spin failed!");
      intervals.forEach(clearInterval);
      // On error, unfreeze immediately so server balance resumes
      isAnimatingRef.current = false;
      onBalanceOverride(null);
      setIsSpinning(false);
      setReelStopped([true, true, true, true, true]);
      return null;
    }
  }, [betAmount, eventKey, displayBalance, spinSlot, onBalanceOverride]);

  /** Multi-spin handler */
  const handleMultiSpin = useCallback(async () => {
    const count = multiSpins;
    isAutoRef.current = true;
    setSpinsLeft(count);
    setMultiSpinTotal(0);
    setMultiSpinWins(0);

    for (let i = 0; i < count; i++) {
      if (!isAutoRef.current) break;
      setSpinsLeft(count - i);
      const result = await doSpin();
      if (!result) break;
      setMultiSpinTotal((t) => t + betAmount);
      if (result.payout > 0) {
        setMultiSpinWins((w) => w + result.payout);
      }
      if (i < count - 1 && isAutoRef.current) {
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    isAutoRef.current = false;
    setSpinsLeft(0);
  }, [multiSpins, doSpin, betAmount]);

  const cancelMultiSpin = useCallback(() => {
    isAutoRef.current = false;
  }, []);

  const quickBets = [10, 25, 50, 100, 250];
  const multiSpinOptions = [1, 5, 10, 25, 50];
  const isMultiSpinning = spinsLeft > 0;

  // Count matching symbols for highlight
  const matchCounts: Record<string, number> = {};
  for (const s of reels) matchCounts[s] = (matchCounts[s] ?? 0) + 1;
  const bestMatchCount = Math.max(...Object.values(matchCounts));
  const bestMatchSymbol = Object.entries(matchCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";

  return (
    <div className="space-y-4">
      {/* Slot Machine Frame */}
      <div
        className={`relative rounded-2xl border-2 overflow-hidden transition-all duration-300 ${
          showWin
            ? "slot-win-container border-yellow-400"
            : "border-yellow-400/20 hover:border-yellow-400/40"
        }`}
        style={{
          background: "linear-gradient(180deg, #0a0a0a 0%, #111111 50%, #0a0a0a 100%)",
        }}
      >
        {/* Coin shower on win */}
        {showWin && (
          <div className="absolute inset-0 overflow-hidden pointer-events-none z-40">
            {Array.from({ length: 20 }).map((_, i) => (
              <CoinParticle key={i} index={i} />
            ))}
          </div>
        )}

        {/* Header */}
        <div className="text-center pt-5 pb-3 relative">
          <div
            className="inline-block px-6 py-1.5 rounded-full text-sm font-black tracking-widest"
            style={{
              background: "linear-gradient(90deg, #b8860b, #ffd700, #b8860b)",
              color: "#000",
              backgroundSize: "200% 100%",
              animation: "slot-jackpot-flash 3s ease-in-out infinite",
            }}
          >
            FALCON SLOTS
          </div>
          {winStreak >= 3 && winStreak <= 10 && (
            <div className="absolute top-3 right-4 flex items-center gap-1 px-2 py-1 rounded-full bg-red-500/20 border border-red-500/40">
              <Flame className="h-3.5 w-3.5 text-red-400 slot-streak" />
              <span className="text-xs font-black text-red-400 slot-streak">
                {winStreak}x STREAK
              </span>
            </div>
          )}
        </div>

        {/* 3x5 Reel Grid */}
        <div className="relative px-4 py-3">
          {/* Pay line indicator  -  wraps only the emoji columns */}
          <div className="flex justify-center pointer-events-none absolute inset-0 z-20 items-center">
            <div className="flex items-center">
              <div className="text-[10px] font-black text-yellow-400/70 select-none mr-1">{"\u25B6"}</div>
              <div
                className="rounded-xl border-2 border-yellow-400/40"
                style={{
                  width: "calc(5 * clamp(52px, 16vw, 76px) + 4 * 6px + 8px)",
                  height: "calc(clamp(44px, 13vw, 64px) + 8px)",
                  boxShadow: "0 0 12px rgba(234,179,8,0.15), inset 0 0 12px rgba(234,179,8,0.05)",
                }}
              />
              <div className="text-[10px] font-black text-yellow-400/70 select-none ml-1">{"\u25C0"}</div>
            </div>
          </div>

          {/* Grid: 3 rows x 5 columns */}
          <div className="flex justify-center gap-1.5 sm:gap-2">
            {[0, 1, 2, 3, 4].map((col) => {
              const centerSym = displayReels[col];
              const aboveSym = displayAbove[col];
              const belowSym = displayBelow[col];
              const stopped = reelStopped[col];
              const isMatch = stopped && !isSpinning && bestMatchCount >= 3 && centerSym === bestMatchSymbol;

              const rows = [
                { sym: aboveSym, row: "above" as const },
                { sym: centerSym, row: "center" as const },
                { sym: belowSym, row: "below" as const },
              ];

              return (
                <div
                  key={col}
                  className={`rounded-xl border transition-all duration-300 overflow-hidden ${
                    isMatch && showWin
                      ? "border-yellow-400/60"
                      : "border-yellow-400/10"
                  }`}
                  style={{
                    width: "clamp(52px, 16vw, 76px)",
                    background: "rgba(0,0,0,0.5)",
                    boxShadow: isMatch && showWin
                      ? "0 0 20px rgba(234, 179, 8, 0.3)"
                      : "inset 0 2px 8px rgba(0,0,0,0.6)",
                  }}
                >
                  {rows.map(({ sym, row }) => {
                    const isCenter = row === "center";
                    const isCenterMatch = isCenter && isMatch;

                    return (
                      <div
                        key={row}
                        className={`flex items-center justify-center transition-all ${
                          isCenter
                            ? "bg-black/30"
                            : "bg-black/60"
                        } ${
                          isCenterMatch && showWin ? "bg-yellow-400/10" : ""
                        }`}
                        style={{
                          height: "clamp(44px, 13vw, 64px)",
                        }}
                      >
                        <span
                          className={`select-none transition-all flex items-center justify-center ${
                            !isCenter ? "opacity-40 grayscale-[30%]" : ""
                          } ${
                            !stopped ? "slot-spinning opacity-60" : ""
                          } ${
                            stopped && !isSpinning && isCenter ? "slot-landed" : ""
                          } ${
                            isCenterMatch && showWin ? "slot-match-symbol opacity-100" : ""
                          }`}
                          style={{ lineHeight: 1 }}
                        >
                          <SlotIcon symbolId={sym} size={isCenter ? "lg" : "md"} />
                        </span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>

        {/* Win Display */}
        <div className="h-12 flex items-center justify-center relative">
          {showWin && lastWin > 0 ? (
            <div className="slot-win-text flex items-center gap-2">
              <span
                className="text-lg sm:text-xl font-black tracking-wide"
                style={{
                  background: "linear-gradient(90deg, #ffd700, #ffed4a, #ffd700)",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                  backgroundSize: "200% 100%",
                  animation: "slot-jackpot-flash 1s ease-in-out infinite",
                }}
              >
                !! WIN {formatCoins(lastWin)} COINS! !!
              </span>
            </div>
          ) : isSpinning ? (
            <span className="text-xs text-yellow-400/50 font-mono animate-pulse">
              SPINNING...
            </span>
          ) : lastWin === 0 && totalSpins > 0 ? (
            <span className="text-xs text-muted-foreground/50">
              Try again...
            </span>
          ) : null}
        </div>

        {/* Multi-spin progress */}
        {isMultiSpinning && (
          <div className="px-4 pb-2">
            <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-yellow-400/5 border border-yellow-400/20">
              <div className="flex-1">
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="text-yellow-400/70 font-medium">
                    Auto-Spin: {spinsLeft} left
                  </span>
                  <span className="text-muted-foreground font-mono">
                    Net: <span className={multiSpinWins - multiSpinTotal >= 0 ? "text-green-400" : "text-red-400"}>
                      {multiSpinWins - multiSpinTotal >= 0 ? "+" : ""}{multiSpinWins - multiSpinTotal}
                    </span>
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-black/40 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-yellow-400 transition-all duration-300"
                    style={{
                      width: `${((multiSpins - spinsLeft) / multiSpins) * 100}%`,
                    }}
                  />
                </div>
              </div>
              <button
                onClick={cancelMultiSpin}
                className="p-1.5 rounded-lg bg-red-500/20 border border-red-500/30 text-red-400 hover:bg-red-500/30 transition-colors"
              >
                <Square className="h-3 w-3" />
              </button>
            </div>
          </div>
        )}

        {/* Controls */}
        <div className="px-4 pb-4 space-y-3">
          {/* Bet amount */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold text-yellow-400/60 uppercase tracking-wider">Bet Amount</span>
              <span className="text-[10px] text-muted-foreground/60 font-mono">
                Balance: <span className="text-yellow-400">{formatCoins(displayBalance)}</span>
              </span>
            </div>
            <div className="flex gap-1.5 flex-wrap">
              {quickBets.map((q) => (
                <button
                  key={q}
                  onClick={() => setBetAmount(q)}
                  disabled={isSpinning || isMultiSpinning}
                  className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition-all border ${
                    betAmount === q
                      ? "bg-yellow-400 text-black border-yellow-400 shadow-lg shadow-yellow-400/20"
                      : "border-yellow-400/20 text-yellow-400/70 hover:border-yellow-400/50 hover:bg-yellow-400/5 bg-black/30"
                  }`}
                >
                  {q}
                </button>
              ))}
              <button
                onClick={() => setBetAmount(displayBalance)}
                disabled={isSpinning || isMultiSpinning}
                className={`px-3 py-1.5 rounded-lg text-xs font-black tracking-wide transition-all border ${
                  betAmount === displayBalance
                    ? "bg-red-500 text-white border-red-500 shadow-lg shadow-red-500/20"
                    : "border-red-500/30 text-red-400/70 hover:border-red-500/50 hover:bg-red-500/5 bg-black/30"
                }`}
              >
                ALL IN
              </button>
            </div>
          </div>

          {/* Multi-spin selector */}
          <div className="space-y-1.5">
            <span className="text-[10px] font-semibold text-yellow-400/60 uppercase tracking-wider">Spins</span>
            <div className="flex gap-1.5 flex-wrap">
              {multiSpinOptions.map((n) => (
                <button
                  key={n}
                  onClick={() => setMultiSpins(n)}
                  disabled={isSpinning || isMultiSpinning}
                  className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition-all border ${
                    multiSpins === n
                      ? "bg-yellow-400/20 text-yellow-400 border-yellow-400/50"
                      : "border-yellow-400/10 text-yellow-400/40 hover:border-yellow-400/30 hover:text-yellow-400/60 bg-black/30"
                  }`}
                >
                  {n === 1 ? "1x" : `${n}x`}
                </button>
              ))}
            </div>
          </div>

          {/* Spin button */}
          <button
            onClick={multiSpins > 1 ? handleMultiSpin : () => doSpin(true)}
            disabled={isSpinning || isMultiSpinning || displayBalance < betAmount}
            className={`w-full py-3.5 rounded-xl font-black text-base tracking-wide transition-all border-2 relative overflow-hidden ${
              isSpinning || isMultiSpinning || displayBalance < betAmount
                ? "bg-yellow-400/10 text-yellow-400/30 border-yellow-400/10 cursor-not-allowed"
                : "bg-yellow-400 text-black border-yellow-500 hover:bg-yellow-300 hover:shadow-xl hover:shadow-yellow-400/30 active:scale-[0.98]"
            }`}
          >
            {isSpinning ? (
              <span className="flex items-center justify-center gap-2">
                <RefreshCw className="h-5 w-5 animate-spin" />
                SPINNING...
              </span>
            ) : isMultiSpinning ? (
              <span className="flex items-center justify-center gap-2">
                <RefreshCw className="h-5 w-5 animate-spin" />
                AUTO-SPINNING ({spinsLeft} left)
              </span>
            ) : (
              <span className="flex items-center justify-center gap-2">
                <Play className="h-5 w-5" />
                {multiSpins > 1
                  ? `SPIN ${multiSpins}x (${formatCoins(betAmount * multiSpins)} total)`
                  : `SPIN  -  ${formatCoins(betAmount)} coins`}
              </span>
            )}
          </button>
        </div>

        {/* Session stats */}
        <div className="px-4 pb-4">
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-lg bg-black/40 border border-yellow-400/10 p-2 text-center">
              <div className="text-[9px] text-yellow-400/40 uppercase font-semibold">Spins</div>
              <div className="text-sm font-mono font-bold text-yellow-400/80">{totalSpins}</div>
            </div>
            <div className="rounded-lg bg-black/40 border border-green-400/10 p-2 text-center">
              <div className="text-[9px] text-green-400/40 uppercase font-semibold">Won</div>
              <div className="text-sm font-mono font-bold text-green-400/80">{formatCoins(sessionWins)}</div>
            </div>
            <div className="rounded-lg bg-black/40 border border-red-400/10 p-2 text-center">
              <div className="text-[9px] text-red-400/40 uppercase font-semibold">Lost</div>
              <div className="text-sm font-mono font-bold text-red-400/80">{formatCoins(sessionLosses)}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Payout Table Toggle */}
      <button
        onClick={() => setShowPayouts(!showPayouts)}
        className="w-full flex items-center justify-between px-4 py-2.5 rounded-xl border border-yellow-400/20 bg-black/30 hover:border-yellow-400/40 transition-all group"
      >
        <span className="text-xs font-semibold text-yellow-400/60 uppercase tracking-wider flex items-center gap-2">
          <Coins className="h-3.5 w-3.5" />
          Payout Table
        </span>
        {showPayouts ? (
          <ChevronUp className="h-4 w-4 text-yellow-400/40 group-hover:text-yellow-400/60 transition-colors" />
        ) : (
          <ChevronDown className="h-4 w-4 text-yellow-400/40 group-hover:text-yellow-400/60 transition-colors" />
        )}
      </button>

      {showPayouts && (
        <div className="rounded-xl border border-yellow-400/20 overflow-hidden" style={{ background: "#0a0a0a" }}>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-yellow-400/10">
                <th className="text-left px-3 py-2 text-yellow-400/50 font-semibold">Symbol</th>
                <th className="text-center px-2 py-2 text-yellow-400/50 font-semibold">5x</th>
                <th className="text-center px-2 py-2 text-yellow-400/50 font-semibold">4x</th>
                <th className="text-center px-2 py-2 text-yellow-400/50 font-semibold">3x</th>
                <th className="text-center px-2 py-2 text-yellow-400/50 font-semibold">2x</th>
              </tr>
            </thead>
            <tbody>
              {SLOT_PAYOUTS_UI.map((row) => (
                <tr key={row.symbol} className="border-b border-yellow-400/5 hover:bg-yellow-400/5 transition-colors">
                  <td className="px-3 py-2 font-medium">
                    <span className="inline-flex items-center gap-2">
                      {(() => { const Icon = row.icon; return <Icon className={`h-4 w-4 ${row.color} drop-shadow-[0_0_4px_currentColor]`} strokeWidth={2.5} />; })()}
                      <span className="text-muted-foreground/70 capitalize">{row.symbol}</span>
                    </span>
                  </td>
                  <td className="text-center px-2 py-2 font-mono font-bold text-yellow-400">{row.x5}x</td>
                  <td className="text-center px-2 py-2 font-mono font-bold text-yellow-400/70">{row.x4}x</td>
                  <td className="text-center px-2 py-2 font-mono font-bold text-yellow-400/50">{row.x3}x</td>
                  <td className="text-center px-2 py-2 font-mono font-bold text-yellow-400/30">{row.x2}x</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// -- Plinko Game --------------------------------------------------------------

const PLINKO_ROWS = 10;
const PLINKO_SLOTS = 11;

const PLINKO_MULTIPLIERS_UI: Record<string, number[]> = {
  low:    [5.0, 2.0, 1.5, 1.2, 0.7, 0.4, 0.7, 1.2, 1.5, 2.0, 5.0],
  medium: [12.0, 4.0, 2.0, 1.3, 0.8, 0.3, 0.8, 1.3, 2.0, 4.0, 12.0],
  high:   [50.0, 10.0, 3.0, 0.8, 0.4, 0.2, 0.4, 0.8, 3.0, 10.0, 50.0],
};

function getMultiplierColor(mult: number): string {
  if (mult >= 50) return "text-yellow-200";
  if (mult >= 10) return "text-yellow-300";
  if (mult >= 3) return "text-yellow-400";
  if (mult >= 1.5) return "text-amber-400";
  if (mult >= 1) return "text-amber-300/70";
  if (mult >= 0.5) return "text-red-300/70";
  return "text-red-400/70";
}

function getMultiplierBg(mult: number): string {
  if (mult >= 10) return "bg-yellow-400/20 border-yellow-400/40";
  if (mult >= 3) return "bg-yellow-400/15 border-yellow-400/30";
  if (mult >= 1.5) return "bg-amber-400/10 border-amber-400/25";
  if (mult >= 1) return "bg-amber-300/5 border-amber-300/15";
  if (mult >= 0.5) return "bg-red-400/5 border-red-400/15";
  return "bg-red-400/10 border-red-400/20";
}

// Position helpers (pure functions  -  constant peg/slot layout)
function plinkoPegX(row: number, col: number): number {
  const pegsInRow = row + 2;
  const spacing = 100 / (PLINKO_SLOTS + 1);
  const offset = (PLINKO_SLOTS + 1 - pegsInRow) * spacing / 2;
  return offset + (col + 1) * spacing;
}

function plinkoPegY(row: number): number {
  return ((row + 1) / (PLINKO_ROWS + 2)) * 100;
}

/**
 * Generate physics-based bounce keyframes for the Web Animations API.
 * Each peg bounce has a spring-up -> arc -> fall sequence that creates a
 * satisfying, realistic ball motion. All movement uses `transform: translate()`
 * for 100% GPU compositing  -  no layout thrashing.
 */
function computeBounceKeyframes(path: number[], W: number, H: number): Keyframe[] {
  const frames: Keyframe[] = [];
  const ballR = 7; // half ball size for centering
  const tx = (pos: number) => ((pos + 1) / (PLINKO_SLOTS + 1)) * W - ballR;
  const ty = (row: number) => ((row + 1) / (PLINKO_ROWS + 2)) * H - ballR;

  const tStart = 0.06;
  const tEnd = 0.82;
  const dt = (tEnd - tStart) / PLINKO_ROWS;

  // Entry: ball drops in from above with a slight scale pop
  frames.push({
    transform: `translate(${tx(path[0])}px, -20px) scale(0.4)`,
    opacity: "0",
    offset: 0,
  });
  frames.push({
    transform: `translate(${tx(path[0])}px, ${ty(0) * 0.25}px) scale(1)`,
    opacity: "1",
    offset: 0.04,
    easing: "ease-out",
  });

  // Bounce through each row of pegs
  for (let r = 0; r < PLINKO_ROWS; r++) {
    const t0 = tStart + r * dt;
    const fromX = tx(path[r]);
    const toX = tx(path[r + 1]);
    const fromY = ty(r);
    const toY = ty(r + 1);
    // Bounce height decreases as ball speeds up (gravity feel)
    const bounceH = Math.max(3, 11 - r * 0.8);

    // (1) Hit peg  -  arrive at peg position
    frames.push({
      transform: `translate(${fromX}px, ${fromY}px) scale(1)`,
      opacity: "1",
      offset: t0,
      easing: "cubic-bezier(0.4, 0, 0.6, 1)",
    });

    // (2) Spring up  -  satisfying bounce off peg with slight sideways motion
    frames.push({
      transform: `translate(${fromX + (toX - fromX) * 0.22}px, ${fromY - bounceH}px) scale(1.08)`,
      opacity: "1",
      offset: t0 + dt * 0.26,
      easing: "cubic-bezier(0.34, 1.4, 0.64, 1)",
    });

    // (3) Arc down  -  accelerate toward next peg (gravity)
    frames.push({
      transform: `translate(${fromX + (toX - fromX) * 0.68}px, ${fromY + (toY - fromY) * 0.55}px) scale(0.97)`,
      opacity: "1",
      offset: t0 + dt * 0.65,
      easing: "ease-in",
    });
  }

  // Final peg arrival
  const finalX = tx(path[PLINKO_ROWS]);
  const finalPegY = ty(PLINKO_ROWS);
  frames.push({
    transform: `translate(${finalX}px, ${finalPegY}px) scale(1)`,
    opacity: "1",
    offset: tEnd,
    easing: "ease-in",
  });

  // Settle into multiplier slot with a bouncy landing
  const slotY = ((PLINKO_ROWS + 1.4) / (PLINKO_ROWS + 2)) * H - ballR;
  frames.push({
    transform: `translate(${finalX}px, ${slotY + 7}px) scale(1.14, 0.88)`,
    opacity: "1",
    offset: 0.88,
    easing: "ease-in",
  });
  frames.push({
    transform: `translate(${finalX}px, ${slotY - 3}px) scale(0.94, 1.06)`,
    opacity: "1",
    offset: 0.92,
    easing: "ease-out",
  });
  frames.push({
    transform: `translate(${finalX}px, ${slotY + 1}px) scale(1.02)`,
    opacity: "1",
    offset: 0.95,
    easing: "ease-in-out",
  });
  frames.push({
    transform: `translate(${finalX}px, ${slotY}px) scale(1)`,
    opacity: "1",
    offset: 0.97,
  });

  // Shrink + fade out
  frames.push({
    transform: `translate(${finalX}px, ${slotY}px) scale(0)`,
    opacity: "0",
    offset: 1,
    easing: "ease-in",
  });

  return frames;
}

function PlinkoGame({ eventKey, myBalance, onBalanceOverride }: { eventKey: string; myBalance: number; onBalanceOverride: (v: number | null) => void }) {
  // --- Controls state ---
  const [betAmount, setBetAmount] = useState(50);
  const [risk, setRisk] = useState<"low" | "medium" | "high">("medium");

  // --- Result / display state ---
  const [lastResult, setLastResult] = useState<{
    multiplier: number; payout: number; slotIndex: number; bet: number;
  } | null>(null);
  const [showWin, setShowWin] = useState(false);
  const [winSlot, setWinSlot] = useState<number | null>(null);
  const [showCoins, setShowCoins] = useState(false);

  // --- Session / addiction state ---
  const [sessionDrops, setSessionDrops] = useState(0);
  const [sessionProfit, setSessionProfit] = useState(0);
  const [bestMultiplier, setBestMultiplier] = useState(0);
  const [winStreak, setWinStreak] = useState(0);
  const [autoDrop, setAutoDrop] = useState(false);
  const [activeBallCount, setActiveBallCount] = useState(0);

  // Local display balance: freezes during animation so Convex reactivity doesn't spoil the result
  const [displayBalance, setDisplayBalance] = useState(myBalance);
  const displayBalanceRef = useRef(myBalance);
  const hasBallsInFlightRef = useRef(false);

  // Sync displayBalance with server balance ONLY when no balls are in flight
  useEffect(() => {
    if (!hasBallsInFlightRef.current) {
      setDisplayBalance(myBalance);
      displayBalanceRef.current = myBalance;
      onBalanceOverride(null);
    }
  }, [myBalance, onBalanceOverride]);

  // Clear override on unmount
  useEffect(() => {
    return () => { onBalanceOverride(null); };
  }, [onBalanceOverride]);

  // --- Refs (animation state lives outside React for performance) ---
  const boardRef = useRef<HTMLDivElement>(null);
  const activeBallsRef = useRef(0);
  const autoDropRef = useRef(false);
  const cleanupFnsRef = useRef<(() => void)[]>([]);
  const betAmountRef = useRef(betAmount);
  const riskRef = useRef(risk);

  const dropPlinko = useMutation(api.betting.dropPlinko);
  const multipliers = PLINKO_MULTIPLIERS_UI[risk];

  // Keep refs in sync with state
  useEffect(() => { autoDropRef.current = autoDrop; }, [autoDrop]);
  useEffect(() => { betAmountRef.current = betAmount; }, [betAmount]);
  useEffect(() => { riskRef.current = risk; }, [risk]);

  // Cleanup on unmount: cancel all running animations + remove ball elements
  useEffect(() => {
    return () => {
      cleanupFnsRef.current.forEach(fn => fn());
      cleanupFnsRef.current = [];
    };
  }, []);

  // Pre-compute peg layout (static  -  never changes)
  const pegs = useMemo(() => {
    const result: { key: string; x: number; y: number }[] = [];
    for (let row = 0; row < PLINKO_ROWS; row++) {
      const pegsInRow = row + 2;
      for (let col = 0; col < pegsInRow; col++) {
        result.push({
          key: `${row}-${col}`,
          x: plinkoPegX(row, col),
          y: plinkoPegY(row),
        });
      }
    }
    return result;
  }, []);

  // --- Core drop handler ---
  const doDrop = useCallback(async () => {
    if (activeBallsRef.current >= 8) return;
    const currentBet = betAmountRef.current;
    const currentRisk = riskRef.current;

    if (displayBalanceRef.current < currentBet) {
      toast.error("Not enough coins!");
      setAutoDrop(false);
      return;
    }

    // Freeze display balance: deduct bet locally before the server responds
    hasBallsInFlightRef.current = true;
    displayBalanceRef.current -= currentBet;
    setDisplayBalance(displayBalanceRef.current);
    onBalanceOverride(displayBalanceRef.current);

    try {
      const result = await dropPlinko({ eventKey, betAmount: currentBet, risk: currentRisk });
      const board = boardRef.current;
      if (!board) return;

      activeBallsRef.current++;
      setActiveBallCount(c => c + 1);
      setSessionDrops(d => d + 1);

      const W = board.offsetWidth;
      const H = board.offsetHeight;

      // -- Create ball DOM element (outside React for zero re-render cost) --
      const ballEl = document.createElement("div");
      ballEl.className = "plinko-active-ball";
      ballEl.style.cssText = `
        position:absolute; left:0; top:0; width:14px; height:14px;
        border-radius:50%; z-index:30; pointer-events:none;
        background:radial-gradient(circle at 35% 35%, #ffd700, #b8860b, #8b6914);
        box-shadow:0 0 10px rgba(255,215,0,0.5), 0 2px 6px rgba(0,0,0,0.4);
      `;
      board.appendChild(ballEl);

      // -- Generate physics keyframes & animate --
      const keyframes = computeBounceKeyframes(result.path, W, H);
      const duration = 2500; // 2.5s total
      const animation = ballEl.animate(keyframes, {
        duration,
        easing: "linear",
        fill: "forwards",
      });

      // -- Schedule peg flashes (direct DOM  -  zero React re-renders) --
      const pegTimers: ReturnType<typeof setTimeout>[] = [];
      for (let r = 0; r < PLINKO_ROWS; r++) {
        const flashTime = (0.06 + r * ((0.82 - 0.06) / PLINKO_ROWS)) * duration;
        // Compute which peg column the ball hits at this row
        const pegCol = Math.round(result.path[r] - (10 - r) / 2);
        const clamped = Math.max(0, Math.min(r + 1, pegCol));
        const timer = setTimeout(() => {
          const pegEl = board.querySelector(`[data-peg="${r}-${clamped}"]`) as HTMLElement | null;
          if (pegEl) {
            pegEl.classList.add("plinko-peg-flash");
            setTimeout(() => pegEl.classList.remove("plinko-peg-flash"), 280);
          }
        }, flashTime);
        pegTimers.push(timer);
      }

      // -- Cleanup registration --
      const cleanup = () => {
        animation.cancel();
        pegTimers.forEach(clearTimeout);
        if (ballEl.parentNode) ballEl.remove();
        activeBallsRef.current = Math.max(0, activeBallsRef.current - 1);
        setActiveBallCount(c => Math.max(0, c - 1));
      };
      cleanupFnsRef.current.push(cleanup);

      // -- On animation finish: show results, near-miss, cleanup --
      animation.onfinish = () => {
        cleanupFnsRef.current = cleanupFnsRef.current.filter(fn => fn !== cleanup);
        activeBallsRef.current = Math.max(0, activeBallsRef.current - 1);
        setActiveBallCount(c => Math.max(0, c - 1));

        // Remove ball element (it's already faded to opacity 0 by the last keyframe)
        setTimeout(() => { if (ballEl.parentNode) ballEl.remove(); }, 100);

        // Show result
        setLastResult({
          multiplier: result.multiplier,
          payout: result.payout,
          slotIndex: result.slotIndex,
          bet: currentBet,
        });
        setWinSlot(result.slotIndex);

        const isWin = result.payout > currentBet;
        if (isWin) {
          setShowWin(true);
          setSessionProfit(p => p + (result.payout - currentBet));
          setBestMultiplier(prev => Math.max(prev, result.multiplier));
          setWinStreak(s => s + 1);
          if (result.multiplier >= 3) {
            setShowCoins(true);
            setTimeout(() => setShowCoins(false), 2500);
          }
          setTimeout(() => setShowWin(false), 3000);
        } else {
          setSessionProfit(p => p - (currentBet - result.payout));
          setWinStreak(0);
        }

        // Near-miss: shimmer adjacent high-value slots to tease the player
        const mults = PLINKO_MULTIPLIERS_UI[currentRisk];
        for (const adj of [result.slotIndex - 1, result.slotIndex + 1]) {
          if (adj >= 0 && adj < PLINKO_SLOTS && mults[adj] > result.multiplier * 2) {
            setTimeout(() => {
              const slotEl = board.querySelector(`[data-slot="${adj}"]`) as HTMLElement | null;
              if (slotEl) {
                slotEl.classList.add("plinko-near-miss");
                setTimeout(() => slotEl.classList.remove("plinko-near-miss"), 1200);
              }
            }, 150);
          }
        }

        setTimeout(() => setWinSlot(null), 2000);

        // Apply payout to local display balance
        displayBalanceRef.current += result.payout;
        setDisplayBalance(displayBalanceRef.current);
        // If no more balls in flight, unfreeze; otherwise keep override
        if (activeBallsRef.current <= 0) {
          hasBallsInFlightRef.current = false;
          onBalanceOverride(null); // server value will take over
        } else {
          onBalanceOverride(displayBalanceRef.current);
        }
      };
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Drop failed");
      setAutoDrop(false);
      // Refund the local deduction on error
      displayBalanceRef.current += betAmountRef.current;
      setDisplayBalance(displayBalanceRef.current);
      if (activeBallsRef.current <= 0) {
        hasBallsInFlightRef.current = false;
        onBalanceOverride(null);
      } else {
        onBalanceOverride(displayBalanceRef.current);
      }
    }
  }, [eventKey, dropPlinko, onBalanceOverride]);

  // Keep doDrop ref current for auto-drop timer
  const doDropRef = useRef(doDrop);
  useEffect(() => { doDropRef.current = doDrop; }, [doDrop]);

  // --- Auto-drop loop ---
  useEffect(() => {
    if (!autoDrop) return;
    let cancelled = false;

    const loop = async () => {
      while (!cancelled && autoDropRef.current) {
        await doDropRef.current();
        if (cancelled) break;
        await new Promise(r => setTimeout(r, 900)); // pace: ~1 drop/sec
      }
    };

    loop();
    return () => { cancelled = true; };
  }, [autoDrop]);

  // --- Render ---
  return (
    <div className="space-y-4">
      <div
        className="rounded-2xl border border-yellow-400/20 overflow-hidden relative"
        style={{
          background: "linear-gradient(180deg, #0a0a0a 0%, #111111 50%, #0a0a0a 100%)",
        }}
      >
        {/* Coin rain on big win */}
        {showCoins && (
          <div className="absolute inset-0 overflow-hidden pointer-events-none z-50">
            {Array.from({ length: 24 }).map((_, i) => (
              <div
                key={i}
                className="plinko-coin absolute text-yellow-400 z-50"
                style={{
                  left: `${Math.random() * 100}%`,
                  top: "-20px",
                  fontSize: `${14 + Math.random() * 14}px`,
                  animationDelay: `${Math.random() * 0.8}s`,
                  animationDuration: `${1.5 + Math.random() * 1}s`,
                }}
              >
                $
              </div>
            ))}
          </div>
        )}

        {/* Title bar */}
        <div
          className="px-4 py-3 flex items-center justify-between"
          style={{
            background: "linear-gradient(90deg, #0d0d0d, #1a1a0a, #0d0d0d)",
            borderBottom: "1px solid rgba(234, 179, 8, 0.15)",
          }}
        >
          <div className="flex items-center gap-2">
            <div
              className="text-lg font-black tracking-wider"
              style={{
                background: "linear-gradient(90deg, #b8860b, #ffd700, #b8860b)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                backgroundSize: "200% 100%",
              }}
            >
               PLINKO
            </div>
            {/* Win streak badge */}
            {winStreak >= 2 && (
              <div className="px-2 py-0.5 rounded-full bg-yellow-400/15 border border-yellow-400/30 text-[10px] font-black text-yellow-400 plinko-streak flex items-center gap-1">
                FIRE {winStreak}
              </div>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs">
            <span className="text-muted-foreground">Balance:</span>
            <span className="text-yellow-400 font-mono font-bold">{formatCoins(displayBalance)}</span>
            <Coins className="h-3.5 w-3.5 text-yellow-400" />
          </div>
        </div>

        <div className="p-4 space-y-4">
          {/* Risk selector + Bet controls row */}
          <div className="flex flex-wrap gap-3 items-end">
            {/* Risk level */}
            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Risk</label>
              <div className="flex gap-1">
                {(["low", "medium", "high"] as const).map((r) => (
                  <button
                    key={r}
                    onClick={() => setRisk(r)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all border ${
                      risk === r
                        ? r === "high"
                          ? "bg-red-500/20 border-red-500/40 text-red-400"
                          : r === "medium"
                            ? "bg-yellow-400/20 border-yellow-400/40 text-yellow-400"
                            : "bg-green-400/20 border-green-400/40 text-green-400"
                        : "bg-muted/30 border-border/30 text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {r.charAt(0).toUpperCase() + r.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {/* Bet amount */}
            <div className="space-y-1.5 flex-1 min-w-[140px]">
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Bet Amount</label>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setBetAmount(prev => Math.max(10, Math.floor(prev / 2)))}
                  className="px-2 py-1.5 rounded-lg bg-muted/40 border border-border/30 text-xs font-bold text-muted-foreground hover:text-foreground transition-all"
                >
                  1/2
                </button>
                <input
                  type="number"
                  min={10}
                  max={displayBalance}
                  value={betAmount}
                  onChange={(e) => setBetAmount(Math.max(10, parseInt(e.target.value) || 10))}
                  className="flex-1 bg-black/40 border border-yellow-400/20 rounded-lg px-3 py-1.5 text-center font-mono font-bold text-yellow-400 text-sm focus:outline-none focus:border-yellow-400/50 transition-all"
                />
                <button
                  onClick={() => setBetAmount(prev => Math.min(displayBalance, prev * 2))}
                  className="px-2 py-1.5 rounded-lg bg-muted/40 border border-border/30 text-xs font-bold text-muted-foreground hover:text-foreground transition-all"
                >
                  2x
                </button>
                <button
                  onClick={() => setBetAmount(displayBalance)}
                  className="px-2 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-xs font-bold text-red-400 hover:bg-red-500/20 transition-all"
                >
                  MAX
                </button>
              </div>
            </div>
          </div>

          {/* Quick bet buttons */}
          <div className="flex gap-1.5">
            {[10, 25, 50, 100, 250, 500].map((amount) => (
              <button
                key={amount}
                onClick={() => setBetAmount(Math.min(amount, displayBalance))}
                className={`flex-1 py-1 rounded-md text-xs font-mono font-bold transition-all border ${
                  betAmount === amount
                    ? "bg-yellow-400/20 border-yellow-400/40 text-yellow-400"
                    : "bg-black/30 border-border/20 text-muted-foreground hover:text-foreground hover:border-border/40"
                }`}
              >
                {amount}
              </button>
            ))}
          </div>

          {/* == Plinko Board == */}
          <div
            ref={boardRef}
            className="relative rounded-xl border border-yellow-400/10 overflow-hidden"
            style={{
              background: "linear-gradient(180deg, #0d0d0d 0%, #080808 100%)",
              aspectRatio: "1 / 1.1",
              maxHeight: "420px",
              margin: "0 auto",
            }}
          >
            {/* Static pegs (rendered once via React, animated via direct DOM class toggle) */}
            {pegs.map((peg) => (
              <div
                key={peg.key}
                data-peg={peg.key}
                className="absolute rounded-full"
                style={{
                  left: `${peg.x}%`,
                  top: `${peg.y}%`,
                  width: "6px",
                  height: "6px",
                  transform: "translate(-50%, -50%)",
                  background: "radial-gradient(circle, rgba(245, 197, 24, 0.5), rgba(245, 197, 24, 0.2))",
                  boxShadow: "0 0 4px rgba(245, 197, 24, 0.15)",
                }}
              />
            ))}

            {/* Ball elements are injected here via direct DOM manipulation  -  not in JSX */}

            {/* Multiplier slots at the bottom */}
            <div
              className="absolute bottom-0 left-0 right-0 flex px-1 pb-1"
              style={{ gap: "2px" }}
            >
              {multipliers.map((mult, i) => (
                <div
                  key={`slot-${i}`}
                  data-slot={i}
                  className={`flex-1 rounded-md flex items-center justify-center text-[9px] sm:text-[10px] font-mono font-black py-2 border transition-all duration-300 ${
                    winSlot === i
                      ? "plinko-win-slot " + getMultiplierBg(mult)
                      : getMultiplierBg(mult)
                  } ${getMultiplierColor(mult)}`}
                  style={{
                    boxShadow: winSlot === i
                      ? "0 0 15px rgba(234, 179, 8, 0.4)"
                      : "none",
                  }}
                >
                  {mult}x
                </div>
              ))}
            </div>
          </div>

          {/* Drop + Auto-drop buttons */}
          <div className="flex gap-2">
            <button
              onClick={doDrop}
              disabled={activeBallCount >= 8 || displayBalance < betAmount}
              className="flex-1 py-3 rounded-xl font-black text-base tracking-wide transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                background: activeBallCount >= 8
                  ? "linear-gradient(135deg, #333, #222)"
                  : "linear-gradient(135deg, #f5c518, #d4a017)",
                color: activeBallCount >= 8 ? "#888" : "#000",
                boxShadow: activeBallCount >= 8
                  ? "none"
                  : "0 4px 20px rgba(245, 197, 24, 0.3), 0 2px 8px rgba(245, 197, 24, 0.2)",
              }}
            >
              <span className="flex items-center justify-center gap-2">
                <ArrowDown className="h-4 w-4" />
                DROP  -  {formatCoins(betAmount)}
                {activeBallCount > 0 && (
                  <span className="text-xs opacity-70">({activeBallCount} !)</span>
                )}
              </span>
            </button>
            <button
              onClick={() => setAutoDrop(prev => !prev)}
              className={`px-4 py-3 rounded-xl font-black text-sm transition-all border ${
                autoDrop
                  ? "bg-red-500/20 border-red-500/40 text-red-400 plinko-auto-active"
                  : "bg-muted/30 border-border/30 text-muted-foreground hover:text-foreground hover:border-border/50"
              }`}
            >
              {autoDrop ? "STOP" : "AUTO"}
            </button>
          </div>

          {/* Result display */}
          {lastResult && (
            <div
              className={`rounded-xl border p-3 text-center transition-all duration-500 ${
                showWin
                  ? "border-yellow-400/40 bg-yellow-400/10"
                  : lastResult.payout >= lastResult.bet
                    ? "border-yellow-400/20 bg-yellow-400/5"
                    : "border-border/30 bg-muted/20"
              }`}
            >
              <div className="flex items-center justify-center gap-3">
                <span className={`text-2xl font-black font-mono plinko-multiplier ${
                  lastResult.multiplier >= 3 ? "text-yellow-400" :
                  lastResult.multiplier >= 1 ? "text-amber-400" : "text-red-400"
                }`}>
                  {lastResult.multiplier}x
                </span>
                <span className="text-muted-foreground">{"\u2192"}</span>
                <span className={`text-lg font-bold font-mono ${
                  lastResult.payout > lastResult.bet ? "text-green-400" :
                  lastResult.payout > 0 ? "text-amber-300" : "text-red-400"
                }`}>
                  {lastResult.payout >= lastResult.bet ? "+" : ""}{formatCoins(lastResult.payout - lastResult.bet)}
                </span>
                <Coins className="h-3.5 w-3.5 text-yellow-400" />
              </div>
              {showWin && lastResult.multiplier >= 3 && (
                <div className="text-yellow-400 text-sm font-bold mt-1 slot-win-text">
                  !! BIG WIN! !!
                </div>
              )}
            </div>
          )}

          {/* Session stats */}
          <div className="flex gap-2">
            <div className="flex-1 rounded-lg bg-black/40 border border-yellow-400/10 px-3 py-2 text-center">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Drops</div>
              <div className="text-sm font-mono font-bold text-foreground">{sessionDrops}</div>
            </div>
            <div className="flex-1 rounded-lg bg-black/40 border border-yellow-400/10 px-3 py-2 text-center">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Profit</div>
              <div className={`text-sm font-mono font-bold ${sessionProfit >= 0 ? "text-green-400/80" : "text-red-400/80"}`}>
                {sessionProfit >= 0 ? "+" : ""}{formatCoins(sessionProfit)}
              </div>
            </div>
            <div className="flex-1 rounded-lg bg-black/40 border border-yellow-400/10 px-3 py-2 text-center">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Best</div>
              <div className="text-sm font-mono font-bold text-yellow-400/80">
                {bestMultiplier > 0 ? `${bestMultiplier}x` : " - "}
              </div>
            </div>
          </div>

          {/* Payout table */}
          <details className="group">
            <summary className="flex items-center gap-2 cursor-pointer text-xs text-muted-foreground hover:text-foreground transition-colors py-1">
              <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
              Payout Table
            </summary>
            <div className="mt-2 rounded-lg bg-black/30 border border-border/20 p-3">
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="font-bold text-muted-foreground text-center">Low</div>
                <div className="font-bold text-muted-foreground text-center">Medium</div>
                <div className="font-bold text-muted-foreground text-center">High</div>
                {PLINKO_MULTIPLIERS_UI.low.map((_, i) => (
                  <div key={`payout-row-${i}`} className="contents">
                    <div className={`text-center font-mono ${getMultiplierColor(PLINKO_MULTIPLIERS_UI.low[i])}`}>
                      {PLINKO_MULTIPLIERS_UI.low[i]}x
                    </div>
                    <div className={`text-center font-mono ${getMultiplierColor(PLINKO_MULTIPLIERS_UI.medium[i])}`}>
                      {PLINKO_MULTIPLIERS_UI.medium[i]}x
                    </div>
                    <div className={`text-center font-mono ${getMultiplierColor(PLINKO_MULTIPLIERS_UI.high[i])}`}>
                      {PLINKO_MULTIPLIERS_UI.high[i]}x
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground/50 mt-2 text-center">
                Multipliers are symmetric. Edge slots pay the most on High risk.
              </p>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}

// -- Crossy Road (Chicken Cross) Game -----------------------------------------

const CROSSY_ROWS = 10;
const CROSSY_DIFFICULTIES_UI: Record<string, { tilesPerRow: number; trapsPerRow: number; baseMultiplier: number; label: string; color: string }> = {
  easy:   { tilesPerRow: 4, trapsPerRow: 1, baseMultiplier: 1.31, label: "Easy",   color: "text-green-400" },
  medium: { tilesPerRow: 3, trapsPerRow: 1, baseMultiplier: 1.47, label: "Medium", color: "text-yellow-400" },
  hard:   { tilesPerRow: 2, trapsPerRow: 1, baseMultiplier: 1.96, label: "Hard",   color: "text-orange-400" },
  expert: { tilesPerRow: 3, trapsPerRow: 2, baseMultiplier: 2.94, label: "Expert", color: "text-red-400" },
};

type CrossyTileState = "hidden" | "safe" | "trap" | "selected";
type CrossyGameState = "idle" | "playing" | "won" | "lost";

interface CrossyRowData {
  tiles: CrossyTileState[];
  selectedIndex?: number;
  trapIndices?: number[];
}

function CrossyRoadGame({ eventKey, myBalance, onBalanceOverride }: { eventKey: string; myBalance: number; onBalanceOverride: (v: number | null) => void }) {
  const [betAmount, setBetAmount] = useState(50);
  const [difficulty, setDifficulty] = useState<"easy" | "medium" | "hard" | "expert">("medium");
  const [gameState, setGameState] = useState<CrossyGameState>("idle");
  const [currentRow, setCurrentRow] = useState(0);
  const [currentMultiplier, setCurrentMultiplier] = useState(1);
  const [rows, setRows] = useState<CrossyRowData[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [lastPayout, setLastPayout] = useState(0);
  const [showCoinShower, setShowCoinShower] = useState(false);
  const [hopKey, setHopKey] = useState(0);
  const [shakeBoard, setShakeBoard] = useState(false);

  // Session stats
  const [sessionRounds, setSessionRounds] = useState(0);
  const [sessionProfit, setSessionProfit] = useState(0);
  const [bestMultiplier, setBestMultiplier] = useState(0);

  // Local display balance
  const [displayBalance, setDisplayBalance] = useState(myBalance);
  const isAnimatingRef = useRef(false);

  useEffect(() => {
    if (!isAnimatingRef.current) {
      setDisplayBalance(myBalance);
      onBalanceOverride(null);
    }
  }, [myBalance, onBalanceOverride]);

  useEffect(() => {
    return () => { onBalanceOverride(null); };
  }, [onBalanceOverride]);

  const crossyStart = useMutation(api.betting.crossyStart);
  const crossyStep = useMutation(api.betting.crossyStep);
  const crossyCashOut = useMutation(api.betting.crossyCashOut);

  const config = CROSSY_DIFFICULTIES_UI[difficulty];

  // Initialize/reset rows when game starts
  const initRows = useCallback(() => {
    const newRows: CrossyRowData[] = [];
    for (let i = 0; i < CROSSY_ROWS; i++) {
      newRows.push({
        tiles: Array(config.tilesPerRow).fill("hidden"),
      });
    }
    return newRows;
  }, [config.tilesPerRow]);

  // The round is opened on the server, which deducts the stake and owns the
  // board from here on. The client no longer tells it the row or multiplier.
  const startGame = useCallback(async () => {
    if (isProcessing) return;
    if (displayBalance < betAmount) {
      toast.error("Insufficient balance!");
      return;
    }
    setIsProcessing(true);
    try {
      const { newBalance } = await crossyStart({ eventKey, betAmount, difficulty });
      setGameState("playing");
      setCurrentRow(0);
      setCurrentMultiplier(1);
      setRows(initRows());
      setLastPayout(0);
      setShowCoinShower(false);
      setShakeBoard(false);

      isAnimatingRef.current = true;
      setDisplayBalance(newBalance);
      onBalanceOverride(newBalance);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Couldn't start the round");
    } finally {
      setIsProcessing(false);
    }
  }, [isProcessing, displayBalance, betAmount, crossyStart, eventKey, difficulty, initRows, onBalanceOverride]);

  const handleTileClick = useCallback(async (tileIndex: number) => {
    if (gameState !== "playing" || isProcessing) return;
    if (tileIndex < 0 || tileIndex >= config.tilesPerRow) return;

    setIsProcessing(true);

    try {
      const result = await crossyStep({ eventKey, tileIndex });

      // Update row with results
      setRows(prev => {
        const updated = [...prev];
        const row = { ...updated[currentRow] };
        const newTiles = [...row.tiles];

        // Mark all tiles in this row
        for (let i = 0; i < newTiles.length; i++) {
          if (i === tileIndex) {
            newTiles[i] = result.safe ? "safe" : "trap";
          } else if (result.trapIndices.includes(i)) {
            newTiles[i] = "trap";
          } else {
            newTiles[i] = "safe";
          }
        }

        row.tiles = newTiles;
        row.selectedIndex = tileIndex;
        row.trapIndices = result.trapIndices;
        updated[currentRow] = row;
        return updated;
      });

      if (result.safe) {
        // Safe! Advance
        setCurrentMultiplier(result.multiplier);
        setHopKey(k => k + 1);

        if (result.gameOver) {
          // Completed all rows — auto cash out
          const cashResult = await crossyCashOut({ eventKey });
          setGameState("won");
          setLastPayout(cashResult.payout);
          setShowCoinShower(true);
          setSessionRounds(r => r + 1);
          setSessionProfit(p => p + cashResult.payout - betAmount);
          if (result.multiplier > bestMultiplier) setBestMultiplier(result.multiplier);

          setDisplayBalance(cashResult.newBalance);
          onBalanceOverride(cashResult.newBalance);
          isAnimatingRef.current = false;

          toast.success(`Max row! Won ${formatCoins(cashResult.payout)} coins at ${result.multiplier}x!`);
          setTimeout(() => setShowCoinShower(false), 2500);
        } else {
          setCurrentRow(r => r + 1);
        }
      } else {
        // Hit trap!
        setGameState("lost");
        setShakeBoard(true);
        setSessionRounds(r => r + 1);
        setSessionProfit(p => p - betAmount);

        setDisplayBalance(result.newBalance);
        onBalanceOverride(result.newBalance);
        isAnimatingRef.current = false;

        toast.error(`Hit a trap on row ${currentRow + 1}! Lost ${formatCoins(betAmount)} coins.`);
        setTimeout(() => setShakeBoard(false), 600);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      toast.error(msg);
      isAnimatingRef.current = false;
      onBalanceOverride(null);
    } finally {
      setIsProcessing(false);
    }
  }, [gameState, isProcessing, config.tilesPerRow, crossyStep, eventKey, betAmount, currentRow, crossyCashOut, onBalanceOverride, bestMultiplier]);

  const handleCashOut = useCallback(async () => {
    if (gameState !== "playing" || isProcessing || currentRow === 0) return;

    setIsProcessing(true);
    try {
      const result = await crossyCashOut({ eventKey });

      setGameState("won");
      setLastPayout(result.payout);
      setShowCoinShower(true);
      setSessionRounds(r => r + 1);
      setSessionProfit(p => p + result.payout - betAmount);
      if (currentMultiplier > bestMultiplier) setBestMultiplier(currentMultiplier);

      setDisplayBalance(result.newBalance);
      onBalanceOverride(result.newBalance);
      isAnimatingRef.current = false;

      toast.success(`Cashed out ${formatCoins(result.payout)} coins at ${currentMultiplier}x!`);
      setTimeout(() => setShowCoinShower(false), 2500);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      toast.error(msg);
    } finally {
      setIsProcessing(false);
    }
  }, [gameState, isProcessing, currentRow, crossyCashOut, eventKey, betAmount, currentMultiplier, onBalanceOverride, bestMultiplier]);

  // Get the multiplier for a completed row number
  // Row 0 = 0.9x (hook), then rows 1+ compound: 0.9 * baseMultiplier^row
  const HOOK_MULT = 0.9;
  const getRowMultiplier = (row: number) => {
    if (row === 0) return HOOK_MULT;
    return parseFloat((HOOK_MULT * Math.pow(config.baseMultiplier, row)).toFixed(2));
  };

  // Tile icon helper
  const getTileDisplay = (state: CrossyTileState, isSelected: boolean) => {
    switch (state) {
      case "hidden": return <HelpCircle className="h-5 w-5 text-muted-foreground/60" />;
      case "safe": return isSelected ? <Bird className="h-5 w-5 text-yellow-400" /> : <CircleCheck className="h-5 w-5 text-green-400" />;
      case "trap": return isSelected ? <Skull className="h-5 w-5 text-red-400" /> : <Skull className="h-5 w-5 text-red-400/60" />;
      default: return <HelpCircle className="h-5 w-5 text-muted-foreground/60" />;
    }
  };

  return (
    <div className="space-y-2 lg:space-y-4">
      {/* Coin shower effect */}
      {showCoinShower && (
        <div className="fixed inset-0 pointer-events-none z-50">
          {Array.from({ length: 20 }).map((_, i) => (
            <span
              key={`crossy-coin-${i}`}
              className="crossy-coin absolute text-yellow-400 z-50"
              style={{
                left: `${Math.random() * 100}%`,
                top: `-20px`,
                fontSize: `${16 + Math.random() * 16}px`,
                animationDelay: `${Math.random() * 0.8}s`,
                animationDuration: `${1.5 + Math.random() * 1}s`,
              }}
            >
              <DollarSign className="h-full w-full" />
            </span>
          ))}
        </div>
      )}

      {/* == Mobile Compact Controls (visible < lg) == */}
      <div className="lg:hidden space-y-2">
        {/* Bet + Difficulty + Start in one compact row */}
        <div className="rounded-xl border border-border/50 bg-card/60 p-2.5 space-y-2">
          <div className="flex items-end gap-2">
            {/* Bet */}
            <div className="flex-1 min-w-0 space-y-1">
              <Label className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Bet</Label>
              <div className="flex items-center gap-1">
                <Coins className="h-3.5 w-3.5 text-yellow-400 shrink-0" />
                <Input
                  type="number"
                  min={10}
                  value={betAmount}
                  onChange={e => setBetAmount(Math.max(10, parseInt(e.target.value) || 10))}
                  disabled={gameState === "playing"}
                  className="h-7 font-mono font-bold text-xs bg-muted/40"
                />
              </div>
            </div>
            {/* Quick bet buttons */}
            <div className="flex gap-0.5 shrink-0">
              {[{ l: "½", fn: () => setBetAmount(Math.max(10, Math.floor(betAmount / 2))) },
                { l: "2×", fn: () => setBetAmount(betAmount * 2) },
              ].map(({ l, fn }) => (
                <Button
                  key={l}
                  variant="outline"
                  size="sm"
                  className="h-7 w-8 text-[10px] font-bold px-0"
                  disabled={gameState === "playing"}
                  onClick={fn}
                >
                  {l}
                </Button>
              ))}
            </div>
            {/* Difficulty */}
            <div className="w-24 shrink-0 space-y-1">
              <Label className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Diff</Label>
              <Select value={difficulty} onValueChange={(v) => setDifficulty(v as typeof difficulty)} disabled={gameState === "playing"}>
                <SelectTrigger className="h-7 text-xs font-semibold bg-muted/40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(CROSSY_DIFFICULTIES_UI).map(([key, val]) => (
                    <SelectItem key={key} value={key}>
                      <span className={val.color}>{val.label}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Start/CashOut/Result row */}
          <div className="flex items-center gap-2">
            {gameState !== "playing" && (
              <Button
                onClick={startGame}
                className="flex-1 h-9 font-black text-sm bg-yellow-400 hover:bg-yellow-300 text-black"
                disabled={displayBalance < betAmount}
              >
                {gameState === "idle" ? (
                  <><Play className="h-4 w-4 mr-1" /> START</>
                ) : (
                  <><RefreshCw className="h-4 w-4 mr-1" /> AGAIN</>
                )}
              </Button>
            )}
            {gameState === "playing" && currentRow > 0 && (
              <>
                <div className="text-center shrink-0">
                  <div className="text-lg font-black text-yellow-400 crossy-mult-pop leading-tight" key={`mult-m-${currentRow}`}>
                    {currentMultiplier}x
                  </div>
                  <div className="text-[10px] font-mono text-muted-foreground">
                    {formatCoins(Math.floor(betAmount * currentMultiplier))}
                  </div>
                </div>
                <Button
                  onClick={handleCashOut}
                  disabled={isProcessing}
                  className="flex-1 h-9 font-black text-sm bg-yellow-400 hover:bg-yellow-300 text-black crossy-cashout-pulse"
                >
                  <CircleDollarSign className="h-4 w-4 mr-1" /> CASH OUT
                </Button>
              </>
            )}
            {gameState === "playing" && currentRow === 0 && (
              <div className="flex-1 text-center text-xs text-muted-foreground/70 py-1">
                Pick a tile on row 1 to begin
              </div>
            )}
            {/* Inline result on mobile */}
            {gameState === "won" && (
              <div className="flex-1 flex items-center justify-center gap-2 rounded-lg border border-yellow-400/40 bg-yellow-400/10 px-3 py-1.5">
                <Trophy className="h-5 w-5 text-yellow-400 shrink-0" />
                <div>
                  <span className="text-sm font-black text-yellow-400">{formatCoins(lastPayout)}</span>
                  <span className="text-[10px] text-muted-foreground ml-1">at {currentMultiplier}x</span>
                </div>
              </div>
            )}
            {gameState === "lost" && (
              <div className="flex-1 flex items-center justify-center gap-2 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-1.5">
                <Skull className="h-5 w-5 text-red-400 shrink-0" />
                <div>
                  <span className="text-sm font-black text-red-400">-{formatCoins(betAmount)}</span>
                  <span className="text-[10px] text-muted-foreground ml-1">Row {currentRow + 1}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-2 lg:gap-4">
        {/* == Controls Panel (Left - desktop only) == */}
        <div className="hidden lg:block lg:w-64 shrink-0 space-y-3">
          {/* Bet Amount */}
          <div className="rounded-xl border border-border/50 bg-card/60 p-3 space-y-2">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Bet Amount</Label>
            <div className="flex items-center gap-1">
              <Coins className="h-4 w-4 text-yellow-400 shrink-0" />
              <Input
                type="number"
                min={10}
                value={betAmount}
                onChange={e => setBetAmount(Math.max(10, parseInt(e.target.value) || 10))}
                disabled={gameState === "playing"}
                className="h-8 font-mono font-bold text-sm bg-muted/40"
              />
            </div>
            <div className="flex gap-1">
              {[{ l: "½", fn: () => setBetAmount(Math.max(10, Math.floor(betAmount / 2))) },
                { l: "2×", fn: () => setBetAmount(betAmount * 2) },
                { l: "Max", fn: () => setBetAmount(displayBalance) },
              ].map(({ l, fn }) => (
                <Button
                  key={l}
                  variant="outline"
                  size="sm"
                  className="flex-1 h-7 text-xs font-bold"
                  disabled={gameState === "playing"}
                  onClick={fn}
                >
                  {l}
                </Button>
              ))}
            </div>
          </div>

          {/* Difficulty */}
          <div className="rounded-xl border border-border/50 bg-card/60 p-3 space-y-2">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Difficulty</Label>
            <Select value={difficulty} onValueChange={(v) => setDifficulty(v as typeof difficulty)} disabled={gameState === "playing"}>
              <SelectTrigger className="h-8 text-sm font-semibold bg-muted/40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(CROSSY_DIFFICULTIES_UI).map(([key, val]) => (
                  <SelectItem key={key} value={key}>
                    <span className={val.color}>{val.label}</span>
                    <span className="text-muted-foreground ml-2 text-xs">
                      ({val.tilesPerRow - val.trapsPerRow}/{val.tilesPerRow} safe)
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="text-[10px] text-muted-foreground/70 leading-tight">
              {config.trapsPerRow} trap{config.trapsPerRow > 1 ? "s" : ""} per row · {config.baseMultiplier}x per step
            </div>
          </div>

          {/* Current Multiplier & Cash Out */}
          {gameState === "playing" && currentRow > 0 && (
            <div className={`rounded-xl border-2 border-yellow-400/50 bg-yellow-400/5 p-3 space-y-2 ${
              currentMultiplier >= 5 ? "crossy-win-glow" : ""
            }`}>
              <div className="text-center">
                <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Current Multiplier</div>
                <div className="text-3xl font-black text-yellow-400 crossy-mult-pop" key={`mult-${currentRow}`}>
                  {currentMultiplier}x
                </div>
                <div className="text-sm font-mono text-muted-foreground">
                  Payout: <span className="text-yellow-400 font-bold">{formatCoins(Math.floor(betAmount * currentMultiplier))}</span>
                </div>
              </div>
              <Button
                onClick={handleCashOut}
                disabled={isProcessing}
                className={`w-full h-10 font-black text-base bg-yellow-400 hover:bg-yellow-300 text-black crossy-cashout-pulse`}
              >
                <CircleDollarSign className="h-5 w-5 mr-1" /> CASH OUT
              </Button>
            </div>
          )}

          {/* Start / Play Again */}
          {gameState !== "playing" && (
            <Button
              onClick={startGame}
              className="w-full h-11 font-black text-base bg-yellow-400 hover:bg-yellow-300 text-black"
              disabled={displayBalance < betAmount}
            >
              {gameState === "idle" ? (
                <><Play className="h-5 w-5 mr-2" /> START GAME</>
              ) : (
                <><RefreshCw className="h-5 w-5 mr-2" /> PLAY AGAIN</>
              )}
            </Button>
          )}

          {/* Result Display */}
          {gameState === "won" && (
            <div className="rounded-xl border-2 border-yellow-400/60 bg-yellow-400/10 p-3 text-center crossy-win-glow">
              <div className="flex justify-center"><Trophy className="h-7 w-7 text-yellow-400" /></div>
              <div className="text-xs text-muted-foreground uppercase">You Won!</div>
              <div className="text-xl font-black text-yellow-400">{formatCoins(lastPayout)}</div>
              <div className="text-xs text-muted-foreground">at {currentMultiplier}x</div>
            </div>
          )}
          {gameState === "lost" && (
            <div className="rounded-xl border-2 border-red-400/40 bg-red-400/10 p-3 text-center">
              <div className="flex justify-center"><Skull className="h-7 w-7 text-red-400" /></div>
              <div className="text-xs text-muted-foreground uppercase">Game Over</div>
              <div className="text-xl font-black text-red-400">-{formatCoins(betAmount)}</div>
              <div className="text-xs text-muted-foreground">Row {currentRow + 1} trap</div>
            </div>
          )}

          {/* Session Stats */}
          <div className="rounded-xl border border-border/50 bg-card/60 p-3 space-y-1.5">
            <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Session Stats</div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <div className="text-xs text-muted-foreground">Rounds</div>
                <div className="text-sm font-bold">{sessionRounds}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Profit</div>
                <div className={`text-sm font-bold font-mono ${sessionProfit >= 0 ? "text-green-400" : "text-red-400"}`}>
                  {sessionProfit >= 0 ? "+" : ""}{formatCoins(sessionProfit)}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Best</div>
                <div className="text-sm font-bold text-yellow-400">{bestMultiplier > 0 ? `${bestMultiplier}x` : "—"}</div>
              </div>
            </div>
          </div>
        </div>

        {/* == Game Board (Center) == */}
        <div className="flex-1 min-w-0">
          <div className={`rounded-2xl border border-border/50 bg-card/80 p-2.5 lg:p-4 relative overflow-hidden ${
            shakeBoard ? "crossy-death-shake" : ""
          } ${gameState === "won" ? "crossy-win-glow" : ""}`}>
            {/* Title bar */}
            <div className="flex items-center justify-between mb-2 lg:mb-4">
              <div className="flex items-center gap-2">
                <Bird className="h-5 w-5 lg:h-7 lg:w-7 text-yellow-400" />
                <div>
                  <h3 className="font-black text-xs lg:text-sm tracking-tight">CHICKEN CROSS</h3>
                  <p className="text-[9px] lg:text-[10px] text-muted-foreground">Pick a tile, dodge the traps</p>
                </div>
              </div>
              <div className="flex items-center gap-2 text-[10px] lg:text-xs">
                <span className={`font-semibold ${config.color}`}>{config.label}</span>
                <span className="text-muted-foreground">·</span>
                <span className="text-muted-foreground">Row {gameState === "playing" ? currentRow + 1 : 0}/{CROSSY_ROWS}</span>
              </div>
            </div>

            {/* Road / Grid */}
            <div className="space-y-1 lg:space-y-1.5">
              {/* Rows displayed top-to-bottom (row 9 at top, row 0 at bottom) */}
              {Array.from({ length: CROSSY_ROWS }).map((_, displayIdx) => {
                const rowIdx = CROSSY_ROWS - 1 - displayIdx; // reverse: top = highest row
                const rowData = rows[rowIdx];
                const isCurrentRow = gameState === "playing" && rowIdx === currentRow;
                const isCompletedRow = rowData && rowData.selectedIndex !== undefined;
                const isFutureRow = gameState === "playing" && rowIdx > currentRow;
                const rowMult = getRowMultiplier(rowIdx);

                return (
                  <div
                    key={`row-${rowIdx}`}
                    className={`flex items-center gap-1 lg:gap-2 rounded-lg p-1 lg:p-1.5 transition-all duration-200 ${
                      isCurrentRow
                        ? "bg-yellow-400/10 border border-yellow-400/30 shadow-[0_0_15px_rgba(234,179,8,0.15)]"
                        : isCompletedRow
                          ? "bg-muted/20 border border-border/20"
                          : isFutureRow
                            ? "bg-muted/5 border border-border/10 opacity-40"
                            : "bg-muted/10 border border-border/15"
                    } ${isCurrentRow ? "crossy-row-unlock" : ""}`}
                  >
                    {/* Row number */}
                    <div className="w-5 lg:w-7 text-center shrink-0">
                      <span className={`text-[10px] lg:text-xs font-bold ${
                        isCurrentRow ? "text-yellow-400" : isCompletedRow ? "text-muted-foreground" : "text-muted-foreground/40"
                      }`}>
                        {rowIdx + 1}
                      </span>
                    </div>

                    {/* Tiles */}
                    <div className="flex-1 flex gap-1 lg:gap-1.5 justify-center">
                      {Array.from({ length: config.tilesPerRow }).map((_, tileIdx) => {
                        const tileState = rowData?.tiles[tileIdx] ?? "hidden";
                        const isSelected = rowData?.selectedIndex === tileIdx;
                        const isTrap = tileState === "trap";
                        const isSafe = tileState === "safe";
                        const isClickable = isCurrentRow && tileState === "hidden" && !isProcessing;

                        return (
                          <button
                            key={`tile-${rowIdx}-${tileIdx}`}
                            onClick={() => isClickable && handleTileClick(tileIdx)}
                            disabled={!isClickable}
                            className={`
                              relative flex items-center justify-center
                              w-full aspect-square max-w-[42px] lg:max-w-[56px] rounded-md lg:rounded-lg
                              text-base lg:text-lg font-bold transition-all duration-200
                              border-2
                              ${isClickable
                                ? "bg-yellow-400/10 border-yellow-400/40 hover:bg-yellow-400/20 hover:border-yellow-400/60 hover:shadow-[0_0_12px_rgba(234,179,8,0.3)] cursor-pointer crossy-tile-active"
                                : isSafe && isSelected
                                  ? "bg-yellow-400/20 border-yellow-400/50 crossy-safe"
                                  : isSafe
                                    ? "bg-green-400/10 border-green-400/20 crossy-tile-reveal"
                                    : isTrap && isSelected
                                      ? "bg-red-500/30 border-red-400/60 crossy-trap"
                                      : isTrap
                                        ? "bg-red-400/10 border-red-400/20 crossy-tile-reveal"
                                        : "bg-muted/10 border-border/20 opacity-40"
                              }
                            `}
                          >
                            <span className={`text-base lg:text-lg ${
                              isClickable ? "opacity-50" : ""
                            } ${isSelected && isSafe ? "crossy-hop" : ""}`}
                              key={isSelected && isSafe ? `hop-${hopKey}` : undefined}
                            >
                              {getTileDisplay(tileState, isSelected)}
                            </span>
                          </button>
                        );
                      })}
                    </div>

                    {/* Multiplier for this row */}
                    <div className="w-12 lg:w-16 text-right shrink-0">
                      <span className={`text-[10px] lg:text-xs font-mono font-bold ${
                        isCompletedRow && rowData?.tiles[rowData.selectedIndex!] === "safe"
                          ? "text-yellow-400"
                          : isCompletedRow && rowData?.tiles[rowData.selectedIndex!] === "trap"
                            ? "text-red-400"
                            : isCurrentRow
                              ? "text-yellow-400/80"
                              : "text-muted-foreground/40"
                      }`}>
                        {rowMult}x
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Idle state overlay */}
            {gameState === "idle" && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-sm rounded-2xl">
                <div className="text-center space-y-2">
                  <div className="flex justify-center"><Bird className="h-10 w-10 lg:h-12 lg:w-12 text-yellow-400" /></div>
                  <p className="text-xs lg:text-sm font-semibold text-muted-foreground">Set your bet and start the game</p>
                  <p className="text-[10px] lg:text-xs text-muted-foreground/60">Pick tiles to cross the road. Cash out anytime!</p>
                </div>
              </div>
            )}
          </div>

          {/* Session stats - mobile only (compact inline) */}
          <div className="lg:hidden mt-2 rounded-xl border border-border/50 bg-card/60 p-2">
            <div className="flex items-center justify-around text-center">
              <div>
                <div className="text-[10px] text-muted-foreground">Rounds</div>
                <div className="text-xs font-bold">{sessionRounds}</div>
              </div>
              <div className="w-px h-6 bg-border/30" />
              <div>
                <div className="text-[10px] text-muted-foreground">Profit</div>
                <div className={`text-xs font-bold font-mono ${sessionProfit >= 0 ? "text-green-400" : "text-red-400"}`}>
                  {sessionProfit >= 0 ? "+" : ""}{formatCoins(sessionProfit)}
                </div>
              </div>
              <div className="w-px h-6 bg-border/30" />
              <div>
                <div className="text-[10px] text-muted-foreground">Best</div>
                <div className="text-xs font-bold text-yellow-400">{bestMultiplier > 0 ? `${bestMultiplier}x` : "—"}</div>
              </div>
            </div>
          </div>

          {/* Multiplier ladder reference */}
          <details className="mt-2 lg:mt-3 text-xs">
            <summary className="text-muted-foreground/60 cursor-pointer hover:text-muted-foreground transition-colors">
              View multiplier table
            </summary>
            <div className="mt-2 rounded-xl border border-border/30 bg-card/40 p-3">
              <div className="grid grid-cols-5 gap-1 text-center text-[10px] font-semibold">
                <div className="text-muted-foreground">Row</div>
                <div className="text-green-400">Easy</div>
                <div className="text-yellow-400">Med</div>
                <div className="text-orange-400">Hard</div>
                <div className="text-red-400">Expert</div>
                {Array.from({ length: CROSSY_ROWS }).map((_, i) => (
                  <div key={`table-row-${i}`} className="contents">
                    <div className="text-muted-foreground">{i + 1}</div>
                    {["easy", "medium", "hard", "expert"].map(d => {
                      const m = i === 0 ? 0.9 : parseFloat((0.9 * Math.pow(CROSSY_DIFFICULTIES_UI[d].baseMultiplier, i)).toFixed(2));
                      return (
                        <div key={d} className={`font-mono ${
                          m >= 100 ? "text-yellow-300" : m >= 10 ? "text-yellow-400" : m >= 3 ? "text-amber-400" : "text-muted-foreground"
                        }`}>
                          {m >= 1000 ? `${(m / 1000).toFixed(1)}K` : m.toFixed(2)}x
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground/50 mt-2 text-center">
                Multipliers compound each row. Higher difficulty = more risk, bigger rewards.
              </p>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}

// -- Mines Game ----------------------------------------------------------------

const MINES_PRESETS = [1, 3, 5, 10, 24];

type MinesTileState = "hidden" | "gem" | "bomb";
type MinesGameState = "idle" | "playing" | "won" | "lost";

/** Combinatorial C(n, k) */
function minesCombination(n: number, k: number): number {
  if (k > n || k < 0) return 0;
  if (k === 0 || k === n) return 1;
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}

/** Calculate mines multiplier: 0.97 * C(25, s) / C(25 - N, s) */
function getMinesMultiplier(mineCount: number, gemsRevealed: number): number {
  if (gemsRevealed === 0) return 1;
  const HOUSE_EDGE = 0.97;
  const safeTotal = 25 - mineCount;
  // Past the last safe tile the denominator is 0 and this reads "Infinityx".
  if (gemsRevealed > safeTotal) return 1;
  return parseFloat(
    (
      HOUSE_EDGE *
      (minesCombination(25, gemsRevealed) /
        minesCombination(safeTotal, gemsRevealed))
    ).toFixed(2)
  );
}

function MinesGame({
  eventKey,
  myBalance,
  onBalanceOverride,
}: {
  eventKey: string;
  myBalance: number;
  onBalanceOverride: (v: number | null) => void;
}) {
  const [betAmount, setBetAmount] = useState(50);
  const [mineCount, setMineCount] = useState(3);
  const [gameState, setGameState] = useState<MinesGameState>("idle");
  const [tiles, setTiles] = useState<MinesTileState[]>(
    Array(25).fill("hidden")
  );
  const [minePositions, setMinePositions] = useState<number[]>([]);
  const [gemsRevealed, setGemsRevealed] = useState(0);
  const [currentMultiplier, setCurrentMultiplier] = useState(1);
  const [isProcessing, setIsProcessing] = useState(false);
  const [lastPayout, setLastPayout] = useState(0);
  const [showCoinShower, setShowCoinShower] = useState(false);
  const [shakeBoard, setShakeBoard] = useState(false);

  // Session stats
  const [sessionRounds, setSessionRounds] = useState(0);
  const [sessionProfit, setSessionProfit] = useState(0);
  const [bestMultiplier, setBestMultiplier] = useState(0);

  // Local display balance
  const [displayBalance, setDisplayBalance] = useState(myBalance);
  const isAnimatingRef = useRef(false);

  useEffect(() => {
    if (!isAnimatingRef.current) {
      setDisplayBalance(myBalance);
      onBalanceOverride(null);
    }
  }, [myBalance, onBalanceOverride]);

  useEffect(() => {
    return () => {
      onBalanceOverride(null);
    };
  }, [onBalanceOverride]);

  const minesStart = useMutation(api.betting.minesStart);
  const minesReveal = useMutation(api.betting.minesReveal);
  const minesCashOutMut = useMutation(api.betting.minesCashOut);

  const nextMultiplier = getMinesMultiplier(mineCount, gemsRevealed + 1);

  // The server deals the board and deducts the stake. Mine positions used to be
  // derived from a seed generated here, which meant losing a round revealed the
  // layout and replaying the same seed walked the safe path every time.
  const startGame = useCallback(async () => {
    if (isProcessing) return;
    if (displayBalance < betAmount) {
      toast.error("Insufficient balance!");
      return;
    }
    setIsProcessing(true);
    try {
      const { newBalance } = await minesStart({ eventKey, betAmount, mineCount });
      setGameState("playing");
      setTiles(Array(25).fill("hidden"));
      setMinePositions([]);
      setGemsRevealed(0);
      setCurrentMultiplier(1);
      setLastPayout(0);
      setShowCoinShower(false);
      setShakeBoard(false);

      isAnimatingRef.current = true;
      setDisplayBalance(newBalance);
      onBalanceOverride(newBalance);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Couldn't start the round");
    } finally {
      setIsProcessing(false);
    }
  }, [isProcessing, displayBalance, betAmount, minesStart, eventKey, mineCount, onBalanceOverride]);

  const handleTileClick = useCallback(
    async (tileIndex: number) => {
      if (gameState !== "playing" || isProcessing) return;
      if (tiles[tileIndex] !== "hidden") return;

      setIsProcessing(true);

      try {
        const result = await minesReveal({ eventKey, tileIndex });

        if (result.safe) {
          // Reveal gem
          setTiles((prev) => {
            const updated = [...prev];
            updated[tileIndex] = "gem";
            return updated;
          });
          const newGems = gemsRevealed + 1;
          setGemsRevealed(newGems);
          setCurrentMultiplier(result.multiplier);

          if (result.gameOver) {
            // All gems found - auto cashout
            setGameState("won");
            setLastPayout(result.payout);
            setSessionRounds((p) => p + 1);
            setSessionProfit((p) => p + (result.payout - betAmount));
            if (result.multiplier > bestMultiplier)
              setBestMultiplier(result.multiplier);

            // Reveal all mines
            if (result.minePositions.length > 0) {
              setMinePositions(result.minePositions);
              setTiles((prev) => {
                const updated = [...prev];
                result.minePositions.forEach((pos: number) => {
                  if (updated[pos] === "hidden") updated[pos] = "bomb";
                });
                return updated;
              });
            }

            setShowCoinShower(true);
            setTimeout(() => setShowCoinShower(false), 2500);
            setDisplayBalance(result.newBalance);
            onBalanceOverride(result.newBalance);
            isAnimatingRef.current = false;
          }
        } else {
          // Hit a bomb
          setTiles((prev) => {
            const updated = [...prev];
            updated[tileIndex] = "bomb";
            // Reveal all mines
            result.minePositions.forEach((pos: number) => {
              if (updated[pos] === "hidden") updated[pos] = "bomb";
            });
            // Reveal remaining safe tiles as gems
            for (let i = 0; i < 25; i++) {
              if (
                updated[i] === "hidden" &&
                !result.minePositions.includes(i)
              ) {
                updated[i] = "gem";
              }
            }
            return updated;
          });
          setMinePositions(result.minePositions);
          setGameState("lost");
          setShakeBoard(true);
          setTimeout(() => setShakeBoard(false), 500);
          setSessionRounds((p) => p + 1);
          setSessionProfit((p) => p - betAmount);
          setDisplayBalance(result.newBalance);
          onBalanceOverride(result.newBalance);
          isAnimatingRef.current = false;
        }
      } catch (err: unknown) {
        const msg =
          err instanceof Error ? err.message : "An error occurred";
        toast.error(msg);
        isAnimatingRef.current = false;
      } finally {
        setIsProcessing(false);
      }
    },
    [
      gameState,
      isProcessing,
      tiles,
      gemsRevealed,
      minesReveal,
      eventKey,
      betAmount,
      bestMultiplier,
      onBalanceOverride,
    ]
  );

  const handleCashOut = useCallback(async () => {
    if (gameState !== "playing" || isProcessing || gemsRevealed === 0) return;

    setIsProcessing(true);
    try {
      const result = await minesCashOutMut({ eventKey });

      setGameState("won");
      setLastPayout(result.payout);
      setSessionRounds((p) => p + 1);
      setSessionProfit((p) => p + (result.payout - betAmount));
      if (currentMultiplier > bestMultiplier)
        setBestMultiplier(currentMultiplier);

      setShowCoinShower(true);
      setTimeout(() => setShowCoinShower(false), 2500);
      setDisplayBalance(result.newBalance);
      onBalanceOverride(result.newBalance);
      isAnimatingRef.current = false;
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "An error occurred";
      toast.error(msg);
    } finally {
      setIsProcessing(false);
    }
  }, [
    gameState,
    isProcessing,
    gemsRevealed,
    minesCashOutMut,
    eventKey,
    betAmount,
    currentMultiplier,
    bestMultiplier,
    onBalanceOverride,
  ]);

  return (
    <div className="space-y-2 lg:space-y-4">
      {/* Coin shower effect */}
      {showCoinShower && (
        <div className="fixed inset-0 pointer-events-none z-50">
          {Array.from({ length: 20 }).map((_, i) => (
            <span
              key={`mines-coin-${i}`}
              className="mines-coin absolute text-yellow-400 z-50"
              style={{
                left: `${Math.random() * 100}%`,
                top: "-20px",
                fontSize: `${16 + Math.random() * 16}px`,
                animationDelay: `${Math.random() * 0.8}s`,
                animationDuration: `${1.5 + Math.random() * 1}s`,
              }}
            >
              <Coins className="h-5 w-5" />
            </span>
          ))}
        </div>
      )}

      {/* == Mobile Compact Controls (visible < lg) == */}
      <div className="lg:hidden space-y-2">
        <div className="rounded-xl border border-border/50 bg-card/60 p-2.5 space-y-2">
          {/* Row 1: Bet + Mine presets */}
          <div className="flex items-end gap-2">
            {/* Bet */}
            <div className="flex-1 min-w-0 space-y-1">
              <Label className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Bet</Label>
              <div className="flex items-center gap-1">
                <Coins className="h-3.5 w-3.5 text-yellow-400 shrink-0" />
                <Input
                  type="number"
                  min={10}
                  value={betAmount}
                  onChange={(e) =>
                    setBetAmount(Math.max(10, parseInt(e.target.value) || 10))
                  }
                  disabled={gameState === "playing"}
                  className="h-7 font-mono font-bold text-xs bg-muted/40"
                />
              </div>
            </div>
            {/* Quick bet */}
            <div className="flex gap-0.5 shrink-0">
              {[
                { l: "½", fn: () => setBetAmount(Math.max(10, Math.floor(betAmount / 2))) },
                { l: "2×", fn: () => setBetAmount(betAmount * 2) },
              ].map(({ l, fn }) => (
                <Button
                  key={l}
                  variant="outline"
                  size="sm"
                  className="h-7 w-8 text-[10px] font-bold px-0"
                  disabled={gameState === "playing"}
                  onClick={fn}
                >
                  {l}
                </Button>
              ))}
            </div>
            {/* Mines count */}
            <div className="shrink-0 space-y-1">
              <Label className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Mines</Label>
              <div className="flex gap-0.5">
                {MINES_PRESETS.map((count) => (
                  <button
                    key={count}
                    onClick={() => setMineCount(count)}
                    disabled={gameState === "playing"}
                    className={`w-7 h-7 rounded-md text-[10px] font-mono font-bold transition-all border ${
                      mineCount === count
                        ? "bg-yellow-400 text-black border-yellow-400"
                        : "border-yellow-400/20 text-yellow-400/70 bg-black/30"
                    } ${gameState === "playing" ? "opacity-50 cursor-not-allowed" : ""}`}
                  >
                    {count}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Row 2: Start/CashOut/Result */}
          <div className="flex items-center gap-2">
            {gameState !== "playing" && (
              <Button
                onClick={startGame}
                className="flex-1 h-9 font-black text-sm bg-yellow-400 hover:bg-yellow-300 text-black"
                disabled={displayBalance < betAmount}
              >
                {gameState === "idle" ? (
                  <><Play className="h-4 w-4 mr-1" /> START</>
                ) : (
                  <><RefreshCw className="h-4 w-4 mr-1" /> AGAIN</>
                )}
              </Button>
            )}
            {gameState === "playing" && gemsRevealed > 0 && (
              <>
                <div className="text-center shrink-0">
                  <div className="text-lg font-black text-yellow-400 mines-multiplier-pop leading-tight" key={`mult-m-${gemsRevealed}`}>
                    {currentMultiplier}x
                  </div>
                  <div className="text-[10px] font-mono text-muted-foreground">
                    {formatCoins(Math.floor(betAmount * currentMultiplier))}
                  </div>
                </div>
                <Button
                  onClick={handleCashOut}
                  disabled={isProcessing}
                  className="flex-1 h-9 font-black text-sm bg-yellow-400 hover:bg-yellow-300 text-black mines-cashout-pulse"
                >
                  <ShieldCheck className="h-4 w-4 mr-1" /> CASH OUT
                </Button>
              </>
            )}
            {gameState === "playing" && gemsRevealed === 0 && (
              <div className="flex-1 text-center text-xs text-muted-foreground/70 py-1">
                <span className="text-yellow-400/70 font-bold">{nextMultiplier}x</span> · Click a tile to begin
              </div>
            )}
            {/* Inline result on mobile */}
            {gameState === "won" && (
              <div className="flex-1 flex items-center justify-center gap-2 rounded-lg border border-yellow-400/40 bg-yellow-400/10 px-3 py-1.5">
                <Trophy className="h-5 w-5 text-yellow-400 shrink-0" />
                <div>
                  <span className="text-sm font-black text-yellow-400">{formatCoins(lastPayout)}</span>
                  <span className="text-[10px] text-muted-foreground ml-1">at {currentMultiplier}x</span>
                </div>
              </div>
            )}
            {gameState === "lost" && (
              <div className="flex-1 flex items-center justify-center gap-2 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-1.5">
                <Bomb className="h-5 w-5 text-red-400 shrink-0" />
                <div>
                  <span className="text-sm font-black text-red-400">-{formatCoins(betAmount)}</span>
                  <span className="text-[10px] text-muted-foreground ml-1">{gemsRevealed} gems</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-2 lg:gap-4">
        {/* == Controls Panel (Left - desktop only) == */}
        <div className="hidden lg:block lg:w-64 shrink-0 space-y-3">
          {/* Bet Amount */}
          <div className="rounded-xl border border-border/50 bg-card/60 p-3 space-y-2">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">
              Bet Amount
            </Label>
            <div className="flex items-center gap-1">
              <Coins className="h-4 w-4 text-yellow-400 shrink-0" />
              <Input
                type="number"
                min={10}
                value={betAmount}
                onChange={(e) =>
                  setBetAmount(Math.max(10, parseInt(e.target.value) || 10))
                }
                disabled={gameState === "playing"}
                className="h-8 font-mono font-bold text-sm bg-muted/40"
              />
            </div>
            <div className="flex gap-1">
              {[
                {
                  l: "½",
                  fn: () =>
                    setBetAmount(Math.max(10, Math.floor(betAmount / 2))),
                },
                { l: "2×", fn: () => setBetAmount(betAmount * 2) },
                { l: "Max", fn: () => setBetAmount(displayBalance) },
              ].map(({ l, fn }) => (
                <Button
                  key={l}
                  variant="outline"
                  size="sm"
                  className="flex-1 h-7 text-xs font-bold"
                  disabled={gameState === "playing"}
                  onClick={fn}
                >
                  {l}
                </Button>
              ))}
            </div>
          </div>

          {/* Mine Count */}
          <div className="rounded-xl border border-border/50 bg-card/60 p-3 space-y-2">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">
              Mines
            </Label>
            <div className="flex flex-wrap gap-1">
              {MINES_PRESETS.map((count) => (
                <button
                  key={count}
                  onClick={() => setMineCount(count)}
                  disabled={gameState === "playing"}
                  className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition-all border ${
                    mineCount === count
                      ? "bg-yellow-400 text-black border-yellow-400 shadow-lg shadow-yellow-400/20"
                      : "border-yellow-400/20 text-yellow-400/70 hover:border-yellow-400/50 hover:bg-yellow-400/5 bg-black/30"
                  } ${gameState === "playing" ? "opacity-50 cursor-not-allowed" : ""}`}
                >
                  {count}
                </button>
              ))}
            </div>
            {/* Custom slider */}
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={1}
                max={24}
                value={mineCount}
                onChange={(e) => setMineCount(parseInt(e.target.value))}
                disabled={gameState === "playing"}
                className="flex-1 accent-yellow-400 h-1.5"
              />
              <span className="text-xs font-mono font-bold text-yellow-400 w-6 text-right">
                {mineCount}
              </span>
            </div>
            <div className="text-[10px] text-muted-foreground/70 leading-tight">
              {mineCount} mine{mineCount > 1 ? "s" : ""} · {25 - mineCount}{" "}
              gems · Next: {nextMultiplier}x
            </div>
          </div>

          {/* Current Multiplier & Cash Out */}
          {gameState === "playing" && gemsRevealed > 0 && (
            <div
              className={`rounded-xl border-2 border-yellow-400/50 bg-yellow-400/5 p-3 space-y-2 ${
                currentMultiplier >= 5 ? "mines-win-glow" : ""
              }`}
            >
              <div className="text-center">
                <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">
                  Current Multiplier
                </div>
                <div
                  className="text-3xl font-black text-yellow-400 mines-multiplier-pop"
                  key={`mult-${gemsRevealed}`}
                >
                  {currentMultiplier}x
                </div>
                <div className="text-sm font-mono text-muted-foreground">
                  Payout:{" "}
                  <span className="text-yellow-400 font-bold">
                    {formatCoins(
                      Math.floor(betAmount * currentMultiplier)
                    )}
                  </span>
                </div>
              </div>
              <Button
                onClick={handleCashOut}
                disabled={isProcessing}
                className="w-full h-10 font-black text-base bg-yellow-400 hover:bg-yellow-300 text-black mines-cashout-pulse"
              >
                <ShieldCheck className="h-5 w-5 mr-2" /> CASH OUT
              </Button>
            </div>
          )}

          {/* Next Multiplier Preview (when playing, before any reveal) */}
          {gameState === "playing" && gemsRevealed === 0 && (
            <div className="rounded-xl border border-yellow-400/20 bg-yellow-400/5 p-3 text-center">
              <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">
                First Gem
              </div>
              <div className="text-xl font-black text-yellow-400/70">
                {nextMultiplier}x
              </div>
              <div className="text-[10px] text-muted-foreground/60">
                Click a tile to begin
              </div>
            </div>
          )}

          {/* Start / Play Again */}
          {gameState !== "playing" && (
            <Button
              onClick={startGame}
              className="w-full h-11 font-black text-base bg-yellow-400 hover:bg-yellow-300 text-black"
              disabled={displayBalance < betAmount}
            >
              {gameState === "idle" ? (
                <>
                  <Play className="h-5 w-5 mr-2" /> START GAME
                </>
              ) : (
                <>
                  <RefreshCw className="h-5 w-5 mr-2" /> PLAY AGAIN
                </>
              )}
            </Button>
          )}

          {/* Result Display */}
          {gameState === "won" && (
            <div className="rounded-xl border-2 border-yellow-400/60 bg-yellow-400/10 p-3 text-center mines-win-banner">
              <Trophy className="h-7 w-7 text-yellow-400 mx-auto mb-1" />
              <div className="text-xs text-muted-foreground uppercase">
                You Won!
              </div>
              <div className="text-xl font-black text-yellow-400">
                {formatCoins(lastPayout)}
              </div>
              <div className="text-xs text-muted-foreground">
                at {currentMultiplier}x
              </div>
            </div>
          )}
          {gameState === "lost" && (
            <div className="rounded-xl border-2 border-red-400/40 bg-red-400/10 p-3 text-center">
              <Bomb className="h-7 w-7 text-red-400 mx-auto mb-1" />
              <div className="text-xs text-muted-foreground uppercase">
                Game Over
              </div>
              <div className="text-xl font-black text-red-400">
                -{formatCoins(betAmount)}
              </div>
              <div className="text-xs text-muted-foreground">
                {gemsRevealed} gem{gemsRevealed !== 1 ? "s" : ""} found
              </div>
            </div>
          )}

          {/* Session Stats */}
          <div className="rounded-xl border border-border/50 bg-card/60 p-3 space-y-1.5">
            <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">
              Session Stats
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <div className="text-xs text-muted-foreground">Rounds</div>
                <div className="text-sm font-bold">{sessionRounds}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Profit</div>
                <div
                  className={`text-sm font-bold font-mono ${sessionProfit >= 0 ? "text-green-400" : "text-red-400"}`}
                >
                  {sessionProfit >= 0 ? "+" : ""}
                  {formatCoins(sessionProfit)}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Best</div>
                <div className="text-sm font-bold text-yellow-400">
                  {bestMultiplier > 0 ? `${bestMultiplier}x` : "\u2014"}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* == Game Board (Center) == */}
        <div className="flex-1 min-w-0">
          <div
            className={`rounded-2xl border border-border/50 bg-card/80 p-2.5 lg:p-4 relative overflow-hidden ${
              shakeBoard ? "mines-board-shake" : ""
            } ${gameState === "won" ? "mines-win-glow" : ""}`}
          >
            {/* Title bar */}
            <div className="flex items-center justify-between mb-2 lg:mb-4">
              <div className="flex items-center gap-2">
                <div className="h-6 w-6 lg:h-8 lg:w-8 rounded-lg bg-yellow-400/10 border border-yellow-400/30 flex items-center justify-center">
                  <Bomb className="h-3 w-3 lg:h-4 lg:w-4 text-yellow-400" />
                </div>
                <div>
                  <h3 className="font-black text-xs lg:text-sm tracking-tight">
                    MINES
                  </h3>
                  <p className="text-[9px] lg:text-[10px] text-muted-foreground">
                    Reveal gems, avoid the bombs
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 text-[10px] lg:text-xs">
                <span className="font-semibold text-yellow-400">
                  {mineCount} mine{mineCount > 1 ? "s" : ""}
                </span>
                <span className="text-muted-foreground">&middot;</span>
                <span className="text-muted-foreground">
                  {gemsRevealed}/{25 - mineCount} gems
                </span>
              </div>
            </div>

            {/* 5x5 Grid */}
            <div
              className="grid gap-1.5 lg:gap-2 mx-auto"
              style={{
                gridTemplateColumns: "repeat(5, 1fr)",
                maxWidth: "320px",
              }}
            >
              {tiles.map((tileState, idx) => {
                const isClickable =
                  gameState === "playing" &&
                  tileState === "hidden" &&
                  !isProcessing;
                const isGem = tileState === "gem";
                const isBomb = tileState === "bomb";
                const isHitBomb =
                  isBomb &&
                  gameState === "lost" &&
                  minePositions.includes(idx);
                const isRevealedBomb =
                  isBomb && gameState === "lost" && !isHitBomb;

                return (
                  <button
                    key={`mine-tile-${idx}`}
                    onClick={() => isClickable && handleTileClick(idx)}
                    disabled={!isClickable}
                    className={`
                      relative flex items-center justify-center
                      aspect-square rounded-lg lg:rounded-xl
                      text-base lg:text-lg font-bold transition-all duration-200
                      border-2
                      ${
                        isClickable
                          ? "bg-yellow-400/8 border-yellow-400/25 hover:bg-yellow-400/15 hover:border-yellow-400/50 hover:shadow-[0_0_16px_rgba(234,179,8,0.25)] cursor-pointer mines-tile-active"
                          : isGem
                            ? "bg-yellow-400/15 border-yellow-400/40 mines-tile-reveal"
                            : isHitBomb
                              ? "bg-red-500/30 border-red-400/60 mines-bomb-explode"
                              : isRevealedBomb
                                ? "bg-red-400/10 border-red-400/25 mines-tile-reveal"
                                : tileState === "hidden"
                                  ? "bg-muted/10 border-border/20 opacity-40"
                                  : "bg-muted/10 border-border/20"
                      }
                    `}
                  >
                    {tileState === "hidden" && isClickable && (
                      <Sparkles className="h-4 w-4 lg:h-5 lg:w-5 text-yellow-400/30" />
                    )}
                    {isGem && (
                      <Gem
                        className={`h-5 w-5 lg:h-6 lg:w-6 text-yellow-400 ${
                          gameState === "playing" ? "mines-gem-pulse" : ""
                        }`}
                      />
                    )}
                    {isHitBomb && (
                      <Bomb className="h-5 w-5 lg:h-6 lg:w-6 text-red-400" />
                    )}
                    {isRevealedBomb && (
                      <Bomb className="h-4 w-4 lg:h-5 lg:w-5 text-red-400/60" />
                    )}
                  </button>
                );
              })}
            </div>

            {/* Idle state overlay */}
            {gameState === "idle" && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-sm rounded-2xl">
                <div className="text-center space-y-2">
                  <div className="flex items-center justify-center gap-2">
                    <Bomb className="h-8 w-8 lg:h-10 lg:w-10 text-yellow-400/80" />
                  </div>
                  <p className="text-xs lg:text-sm font-semibold text-muted-foreground">
                    Set your bet and start the game
                  </p>
                  <p className="text-[10px] lg:text-xs text-muted-foreground/60">
                    Reveal gems to increase your multiplier. Cash out
                    anytime!
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Session stats - mobile only (compact inline) */}
          <div className="lg:hidden mt-2 rounded-xl border border-border/50 bg-card/60 p-2">
            <div className="flex items-center justify-around text-center">
              <div>
                <div className="text-[10px] text-muted-foreground">Rounds</div>
                <div className="text-xs font-bold">{sessionRounds}</div>
              </div>
              <div className="w-px h-6 bg-border/30" />
              <div>
                <div className="text-[10px] text-muted-foreground">Profit</div>
                <div className={`text-xs font-bold font-mono ${sessionProfit >= 0 ? "text-green-400" : "text-red-400"}`}>
                  {sessionProfit >= 0 ? "+" : ""}{formatCoins(sessionProfit)}
                </div>
              </div>
              <div className="w-px h-6 bg-border/30" />
              <div>
                <div className="text-[10px] text-muted-foreground">Best</div>
                <div className="text-xs font-bold text-yellow-400">{bestMultiplier > 0 ? `${bestMultiplier}x` : "—"}</div>
              </div>
            </div>
          </div>

          {/* Multiplier table */}
          <details className="mt-2 lg:mt-3 text-xs">
            <summary className="text-muted-foreground/60 cursor-pointer hover:text-muted-foreground transition-colors">
              View multiplier table
            </summary>
            <div className="mt-2 rounded-xl border border-border/30 bg-card/40 p-3">
              <div className="grid grid-cols-6 gap-1 text-center text-[10px] font-semibold">
                <div className="text-muted-foreground">Gems</div>
                {[1, 3, 5, 10, 24].map((mc) => (
                  <div
                    key={mc}
                    className={
                      mc === mineCount
                        ? "text-yellow-400"
                        : "text-muted-foreground/60"
                    }
                  >
                    {mc}m
                  </div>
                ))}
                {Array.from({ length: Math.min(10, 25 - mineCount) }).map(
                  (_, i) => {
                    const gems = i + 1;
                    return (
                      <div key={`table-${i}`} className="contents">
                        <div className="text-muted-foreground">{gems}</div>
                        {[1, 3, 5, 10, 24].map((mc) => {
                          const safe = 25 - mc;
                          if (gems > safe) {
                            return (
                              <div
                                key={mc}
                                className="text-muted-foreground/30"
                              >
                                -
                              </div>
                            );
                          }
                          const m = getMinesMultiplier(mc, gems);
                          return (
                            <div
                              key={mc}
                              className={`font-mono ${
                                mc === mineCount
                                  ? m >= 100
                                    ? "text-yellow-300"
                                    : m >= 10
                                      ? "text-yellow-400"
                                      : m >= 3
                                        ? "text-amber-400"
                                        : "text-yellow-400/70"
                                  : "text-muted-foreground/50"
                              }`}
                            >
                              {m >= 1000
                                ? `${(m / 1000).toFixed(1)}K`
                                : m.toFixed(2)}
                              x
                            </div>
                          );
                        })}
                      </div>
                    );
                  }
                )}
              </div>
              <p className="text-[10px] text-muted-foreground/50 mt-2 text-center">
                More mines = higher risk, bigger multipliers. 3% house
                edge.
              </p>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}

type Tab = "markets" | "casino" | "my-bets" | "leaderboard";
type CasinoGame = "slots" | "plinko" | "crossy" | "mines";

export default function BettingPage() {
  const [activeTab, setActiveTab] = useState<Tab>("markets");
  const [activeGame, setActiveGame] = useState<CasinoGame>("slots");

  const currentEventLive = useQuery(api.events.getCurrentEvent);
  const currentEvent = useCached(currentEventLive, "current_event");
  const eventKey = currentEvent?.eventKey ?? "";
  const { isAdminMode } = useUIStore();

  const balanceQuery = useQuery(api.betting.getMyBalance, eventKey ? { eventKey } : "skip");
  const balanceLive = useCached(balanceQuery, `betting_balance_${eventKey}`);
  const getOrCreate = useMutation(api.betting.getOrCreateBalance);

  // Ensure the user has a balance record
  useEffect(() => {
    if (eventKey) {
      getOrCreate({ eventKey }).catch(() => {});
    }
  }, [eventKey]);

  const myBalance = balanceLive?.balance ?? 1000;

  // Override balance shown in header while games are animating
  const [balanceOverride, setBalanceOverride] = useState<number | null>(null);
  const headerBalance = balanceOverride ?? myBalance;

  // ── Retention tracking (invisible to player) ──────────────────────────────
  const startRetentionSession = useMutation(api.retention.startSession);
  const recordRetentionAbandon = useMutation(api.retention.recordAbandon);
  const abandonFiredRef = useRef(false);

  // Start session when page loads (also retroactively records prior abandons)
  useEffect(() => {
    if (eventKey) {
      startRetentionSession({ eventKey }).catch(() => {});
      abandonFiredRef.current = false;
    }
  }, [eventKey]);

  // Record abandon when player leaves the page while losing
  useEffect(() => {
    if (!eventKey) return;

    const handleAbandon = () => {
      if (abandonFiredRef.current) return;
      abandonFiredRef.current = true;
      recordRetentionAbandon({ eventKey }).catch(() => {});
    };

    const handleVisibilityChange = () => {
      if (document.hidden) handleAbandon();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("beforeunload", handleAbandon);
    window.addEventListener("pagehide", handleAbandon);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("beforeunload", handleAbandon);
      window.removeEventListener("pagehide", handleAbandon);
    };
  }, [eventKey]);

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
    { id: "casino",      label: "Casino",      icon: Dices },
    { id: "my-bets",     label: "My Bets",     icon: Coins },
    { id: "leaderboard", label: "Leaderboard", icon: Trophy },
  ];

  const casinoGames: { id: CasinoGame; label: string; icon: React.ElementType }[] = [
    { id: "slots",  label: "Slots",  icon: Dices },
    { id: "plinko", label: "Plinko", icon: Circle },
    { id: "crossy", label: "Crossy", icon: Bird },
    { id: "mines",  label: "Mines",  icon: Bomb },
  ];

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-yellow-400 flex items-center justify-center shadow-lg shadow-yellow-400/20">
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
          <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-muted/40 border border-border/50">
            <span className="text-yellow-400 font-black font-mono text-lg">{formatCoins(headerBalance)}</span>
            <Coins className="h-5 w-5 text-yellow-400" />
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
      {activeTab === "casino" && (
        <div className="space-y-4">
          {/* Game picker — the four games used to be four top-level tabs, which
              buried Markets and My Bets under a row of slot machines. */}
          <div className="flex flex-wrap gap-2">
            {casinoGames.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveGame(id)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all border ${
                  activeGame === id
                    ? "bg-card text-foreground border-border shadow-sm"
                    : "bg-muted/40 text-muted-foreground border-transparent hover:text-foreground"
                }`}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                {label}
              </button>
            ))}
          </div>
          {activeGame === "slots"  && <SlotMachine     eventKey={eventKey} myBalance={myBalance} onBalanceOverride={setBalanceOverride} />}
          {activeGame === "plinko" && <PlinkoGame      eventKey={eventKey} myBalance={myBalance} onBalanceOverride={setBalanceOverride} />}
          {activeGame === "crossy" && <CrossyRoadGame  eventKey={eventKey} myBalance={myBalance} onBalanceOverride={setBalanceOverride} />}
          {activeGame === "mines"  && <MinesGame       eventKey={eventKey} myBalance={myBalance} onBalanceOverride={setBalanceOverride} />}
        </div>
      )}
      {activeTab === "my-bets" && <MyBetsTab eventKey={eventKey} />}
      {activeTab === "leaderboard" && <LeaderboardTab eventKey={eventKey} />}
    </div>
  );
}
