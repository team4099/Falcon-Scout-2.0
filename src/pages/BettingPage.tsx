import { useState, useEffect, useMemo, useRef } from "react";
import { stripEmojis } from "@/lib/utils";
import { useQuery, useMutation } from "convex/react";
import { useAdminMutation } from "@/hooks/useAdminMutation";
import { useCached } from "@/hooks/useCached";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { totalEpa } from "@/lib/epa";
import { useUIStore } from "@/store/uiStore";
import {
  fetchTBAEventMatches,
  fetchStatboticsEventTeams,
  fetchStatboticsEventMatches,
  type StatboticsMatch,
} from "@/lib/api";
import type { TBAMatch } from "@/lib/api";
import { toast } from "sonner";
import {
  Coins, TrendingUp, TrendingDown, Trophy, ChevronDown, ChevronUp,
  Zap, Lock, CheckCircle2, XCircle, RefreshCw,
  HandCoins, Swords, Target, ListFilter,
  BadgeCheck, AlertCircle, Timer, Users, X, Medal, Gift,
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

interface BetOption {
  id: string;
  label: string;
  /** Statbotics win probability, 1-99. `seedPool` is the legacy name for it. */
  winProb?: number;
  seedPool: number;
}

interface Market {
  _id: Id<"bettingMarkets">;
  eventKey: string;
  title: string;
  description?: string;
  matchNumber?: number;
  options: BetOption[];
  status: MarketStatus;
  resolvedOptionId?: string;
  createdAt: number;
  resolvedAt?: number;
}

/** A bet belonging to the signed-in scout, as returned by listMyBets. */
interface MyBet {
  _id: Id<"bets">;
  marketId: Id<"bettingMarkets">;
  optionId: string;
  amount: number;
  /** Fixed at placement. Absent on bets predating fixed odds. */
  multiplier?: number;
  payout?: number;
  settled?: boolean;
  placedAt: number;
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

// Odds mirror convex/betting.ts exactly. They are fixed when a market is
// created, so these are display helpers only — the server recomputes the
// multiplier from the market row when the bet is actually placed.
const MIN_MULTIPLIER = 1.05;
const MAX_MULTIPLIER = 10;

/** Statbotics win probability for an option, as a percent (1-99). */
function winProbPct(option: BetOption): number {
  return option.winProb ?? option.seedPool;
}

/** Fixed payout multiplier: the reciprocal of the win probability, clamped. */
function multiplierFor(option: BetOption): number {
  const pct = winProbPct(option);
  if (!Number.isFinite(pct) || pct <= 0) return MAX_MULTIPLIER;
  const clamped = Math.min(MAX_MULTIPLIER, Math.max(MIN_MULTIPLIER, 100 / pct));
  return Math.round(clamped * 100) / 100;
}

/** Total coins returned (stake included) if this bet wins. */
function payoutFor(betAmount: number, option: BetOption): number {
  return Math.floor(betAmount * multiplierFor(option));
}

const STATUS_CONFIG: Record<MarketStatus, { label: string; color: string; icon: React.ElementType }> = {
  open:      { label: "Open",     color: "text-yellow-400 bg-yellow-400/10 border-yellow-400/30", icon: Zap },
  locked:    { label: "Locked",   color: "text-amber-400 bg-amber-400/10 border-amber-400/30",    icon: Lock },
  resolved:  { label: "Resolved", color: "text-amber-300/70 bg-amber-300/10 border-amber-300/30", icon: CheckCircle2 },
  cancelled: { label: "Cancelled", color: "text-muted-foreground bg-muted/40 border-border/30",   icon: XCircle },
};


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
  resolvedOptionId,
}: {
  options: BetOption[];
  resolvedOptionId?: string;
}) {
  return (
    <div className="space-y-2">
      {options.map((opt) => {
        const pct = winProbPct(opt);
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
                {pct.toFixed(0)}% &middot;{" "}
                <span className="text-amber-400 font-semibold">{multiplierFor(opt).toFixed(2)}x</span>
              </span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-700 bg-yellow-400 ${isLoser ? "opacity-30" : ""}`}
                style={{ width: `${Math.max(pct, 2)}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// -- Bet Placement Panel -------------------------------------------------------

/**
 * Placing a bet is a one-shot action: no raising, no switching sides, no
 * cashing out. `myBet` being present is what puts this panel into its
 * read-only state, and the server rejects a second bet regardless.
 */
function BetPanel({
  market,
  myBalance,
  myBet,
}: {
  market: Market;
  myBalance: number;
  myBet?: MyBet;
}) {
  const [selectedOption, setSelectedOption] = useState(market.options[0]?.id ?? "");
  const [amount, setAmount] = useState(50);
  const [confirming, setConfirming] = useState(false);
  const placeBet = useMutation(api.betting.placeBet);
  const [placing, setPlacing] = useState(false);

  const selected = market.options.find((o) => o.id === selectedOption);

  // Already bet — show the locked-in stake and odds instead of the form.
  if (myBet) {
    const betOption = market.options.find((o) => o.id === myBet.optionId);
    const mult = myBet.multiplier ?? (betOption ? multiplierFor(betOption) : 2);
    const toWin = Math.floor(myBet.amount * mult);
    return (
      <div className="border-t border-border/60 pt-4 mt-4 space-y-2">
        <div className="rounded-xl border border-amber-400/30 bg-amber-400/5 p-3 space-y-1.5">
          <p className="text-[10px] uppercase tracking-wider text-amber-400/80 font-semibold flex items-center gap-1">
            <Lock className="h-3 w-3" /> Your bet is locked in
          </p>
          <p className="text-sm font-semibold">
            {formatCoins(myBet.amount)} on <AllianceLabel label={betOption?.label ?? myBet.optionId} />
            {" "}at <span className="font-mono text-amber-400">{mult.toFixed(2)}x</span>
          </p>
          <p className="text-xs text-muted-foreground">
            Pays <span className="font-mono text-amber-400 font-semibold">{toWin}</span> coins if it wins
            {" "}(+{toWin - myBet.amount}).
          </p>
        </div>
        <p className="text-[10px] text-muted-foreground">
          One bet per match. It can&apos;t be raised, switched, or taken back.
        </p>
      </div>
    );
  }

  async function handleBet() {
    if (!selectedOption || amount < 10) return;
    setPlacing(true);
    try {
      await placeBet({ marketId: market._id, optionId: selectedOption, amount });
      toast.success(`Bet placed! ${amount} coins on "${selected?.label}"`);
    } catch (e: unknown) {
      toast.error((e as Error).message ?? "Failed to place bet");
    } finally {
      setPlacing(false);
      setConfirming(false);
    }
  }

  const quickAmounts = [10, 50, 100, 250, 500];
  const payout = selected ? payoutFor(amount, selected) : 0;
  const profit = payout - amount;

  return (
    <div className="border-t border-border/60 pt-4 mt-4 space-y-3">
      {/* Option selector — odds are fixed, so they ride on the button itself */}
      <div className="grid gap-2">
        {market.options.map((opt) => (
          <button
            key={opt.id}
            onClick={() => { setSelectedOption(opt.id); setConfirming(false); }}
            className={`flex items-center justify-between px-3 py-2 rounded-lg border text-sm font-medium transition-all ${
              selectedOption === opt.id
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-card hover:border-primary/40 hover:bg-primary/5 text-muted-foreground"
            }`}
          >
            <AllianceLabel label={opt.label} />
            <span className="text-xs font-mono">
              <span className="opacity-60">{winProbPct(opt).toFixed(0)}%</span>{" "}
              <span className="text-amber-400 font-bold">{multiplierFor(opt).toFixed(2)}x</span>
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
              onClick={() => { setAmount(q); setConfirming(false); }}
              disabled={q > myBalance}
              className={`px-2.5 py-1 rounded-md text-xs font-mono font-semibold transition-colors border disabled:opacity-30 ${
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
            onChange={(e) => {
              setAmount(Math.max(10, Math.min(myBalance, Math.floor(Number(e.target.value)) || 10)));
              setConfirming(false);
            }}
            className="h-7 w-20 text-xs font-mono"
          />
        </div>
        <p className="text-[10px] text-muted-foreground">
          Balance: <span className="text-amber-400 font-mono font-semibold flex items-center gap-1 inline-flex">{formatCoins(myBalance)} <Coins className="h-3 w-3" /></span>
        </p>
      </div>

      {/* Payout preview — exact, not an estimate: the multiplier is fixed */}
      {selected && amount >= 10 && (
        <div className="flex items-center justify-between rounded-lg bg-muted/60 px-3 py-2 text-xs">
          <span className="text-muted-foreground">Pays if it wins</span>
          <span className="font-mono font-bold flex items-center gap-1 text-amber-400">
            {payout} <Coins className="h-3 w-3" /> (+{profit})
          </span>
        </div>
      )}

      {/* Two-step confirm: the bet is final, so a mistimed tap must not place it */}
      {confirming ? (
        <div className="space-y-2">
          <p className="text-[11px] text-center text-amber-400 font-medium">
            Final — {amount} coins on {stripEmojis(selected?.label ?? "")}. You can&apos;t change or cancel this.
          </p>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setConfirming(false)} disabled={placing}>
              Back
            </Button>
            <Button
              onClick={handleBet}
              disabled={placing}
              className="flex-1 font-bold bg-yellow-400 hover:bg-yellow-500 text-black border-0"
            >
              {placing ? <RefreshCw className="h-4 w-4 animate-spin mr-2" /> : <CheckCircle2 className="h-4 w-4 mr-2" />}
              {placing ? "Placing..." : "Confirm"}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          onClick={() => setConfirming(true)}
          disabled={amount < 10 || amount > myBalance || !selectedOption}
          className="w-full font-bold bg-yellow-400 hover:bg-yellow-500 text-black border-0"
        >
          <Coins className="h-4 w-4 mr-2" />
          {`Bet ${amount} coins`}
        </Button>
      )}
    </div>
  );
}

// -- Market Card ---------------------------------------------------------------

function MarketCard({
  market,
  myBalance,
  myBet,
  isAdmin,
}: {
  market: Market;
  myBalance: number;
  myBet?: MyBet;
  isAdmin: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolveOption, setResolveOption] = useState(market.options[0]?.id ?? "");

  // Only used for the "N coins wagered" line — payouts no longer depend on it.
  const poolDataLive = useQuery(api.betting.getMarketPool, { marketId: market._id });
  const poolData = useCached(poolDataLive, `betting_pool_${market._id}`);
  const realBets: Record<string, number> = poolData ?? {};

  const resolveMarket = useAdminMutation(api.betting.resolveMarket);
  const lockMarket = useAdminMutation(api.betting.lockMarket);
  const unlockMarket = useAdminMutation(api.betting.unlockMarket);

  const sc = STATUS_CONFIG[market.status];
  const StatusIcon = sc.icon;

  const totalRealBets = Object.values(realBets).reduce((s, v) => s + v, 0);

  const handleResolve = async () => {
    try {
      const result = await resolveMarket({ marketId: market._id, resolvedOptionId: resolveOption });
      const r = result as { settledBets: number; totalPaid: number };
      toast.success(`Market resolved — ${r.settledBets} bets settled, ${r.totalPaid} coins paid out.`);
      setResolveOpen(false);
    } catch (e: unknown) {
      toast.error((e as Error).message ?? "Failed to resolve");
    }
  };

  if (market.status === "cancelled") return null;

  const myOption = myBet ? market.options.find((o) => o.id === myBet.optionId) : undefined;

  return (
    <>
      <div className={`rounded-2xl border bg-card transition-all duration-200 overflow-hidden ${
        market.status === "resolved" ? "border-border/50 opacity-80" :
        myBet ? "border-amber-400/40" :
        "border-border hover:border-primary/30 hover:shadow-lg hover:shadow-primary/5"
      }`}>
        {/* Card header */}
        <button
          className="w-full text-left p-4 flex items-start gap-3"
          onClick={() => setExpanded((e) => !e)}
        >
          <div className="h-9 w-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
            <Swords className="h-4 w-4 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-sm leading-tight">{market.title}</span>
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${sc.color}`}>
                <StatusIcon className="h-2.5 w-2.5" />
                {sc.label}
              </span>
              {myBet && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border border-amber-400/40 bg-amber-400/10 text-amber-400">
                  <Lock className="h-2.5 w-2.5" />
                  Bet placed
                </span>
              )}
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
              {market.matchNumber !== undefined && <span>Match #{market.matchNumber}</span>}
              {myBet && myOption && (
                <span className="text-amber-400 font-semibold">
                  You: {formatCoins(myBet.amount)} on {stripEmojis(myOption.label)}
                </span>
              )}
            </div>
          </div>
          <div className="shrink-0 mt-1">
            {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </div>
        </button>

        {/* Collapsed odds preview */}
        {!expanded && (
          <div className="px-4 pb-3">
            <ProbBar options={market.options} resolvedOptionId={market.resolvedOptionId} />
          </div>
        )}

        {/* Expanded content */}
        {expanded && (
          <div className="px-4 pb-4 space-y-4 border-t border-border/40 pt-4">
            <ProbBar options={market.options} resolvedOptionId={market.resolvedOptionId} />

            {/* Fixed odds per side. These never move, so this is a fact about the
                market rather than a live pool readout. */}
            <div className="grid grid-cols-2 gap-2">
              {market.options.map((opt) => (
                <div key={opt.id} className="rounded-xl bg-muted/60 p-3 space-y-1">
                  <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">
                    <AllianceLabel label={opt.label} />
                  </p>
                  <p className="text-sm font-mono font-bold text-amber-400">
                    {multiplierFor(opt).toFixed(2)}x
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {winProbPct(opt).toFixed(0)}% to win &middot; {formatCoins(realBets[opt.id] ?? 0)} wagered
                  </p>
                </div>
              ))}
            </div>

            {/* Bet panel — read-only once the scout has a bet on this match */}
            {market.status === "open" && (
              <BetPanel market={market} myBalance={myBalance} myBet={myBet} />
            )}

            {market.status === "locked" && !myBet && (
              <p className="text-xs text-muted-foreground text-center py-2">
                Betting is closed for this match.
              </p>
            )}
            {market.status === "locked" && myBet && (
              <BetPanel market={market} myBalance={myBalance} myBet={myBet} />
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
            <DialogTitle>Which alliance won?</DialogTitle>
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

// -- Markets Tab ---------------------------------------------------------------

function MarketsTab({
  eventKey,
  myBalance,
  isAdmin,
}: {
  eventKey: string;
  myBalance: number;
  isAdmin: boolean;
}) {
  const [statusFilter, setStatusFilter] = useState<"all" | MarketStatus>("all");
  const [tbaMatches, setTbaMatches] = useState<TBAMatch[]>([]);
  const [generating, setGenerating] = useState(false);
  // A ref, not state: this only latches the auto-generate effect so it fires
  // once, and flipping state inside that effect would cascade a re-render.
  const didAutoGenerate = useRef(false);
  const [wiping, setWiping] = useState(false);

  const marketsQuery = useQuery(api.betting.listMarkets, { eventKey });
  const marketsLive = useCached(marketsQuery, `betting_markets_${eventKey}`);
  const createMarkets = useAdminMutation(api.betting.batchCreateMatchWinnerMarkets);
  const clearAll = useAdminMutation(api.betting.clearAllMarkets);

  useEffect(() => {
    fetchTBAEventMatches(eventKey).then((m) => {
      if (m) setTbaMatches(m);
    }).catch(() => {});
  }, [eventKey]);

  /**
   * Turn TBA matches into market seeds using Statbotics' own match predictions
   * (`pred.red_win_prob`), which is what fixes the payout multipliers. A match
   * Statbotics has no prediction for falls back to red's share of the summed
   * team EPA, and a team missing from Statbotics counts as 30 (roughly a
   * rookie's EPA) so one unknown team can't skew a match to a false certainty.
   * Returns null when Statbotics gave us nothing at all: writing 50/50 markets
   * from that would look fine and stay wrong.
   */
  async function buildMatchSeeds(matches: TBAMatch[]) {
    type SBTeamEvent = { team: number; epa?: unknown };
    let sbTeams: SBTeamEvent[] = [];
    let sbMatches: StatboticsMatch[] = [];
    // Offline or Statbotics down: every value falls back below.
    const [teamsRaw, matchesRaw] = await Promise.all([
      fetchStatboticsEventTeams(eventKey).catch(() => null),
      fetchStatboticsEventMatches(eventKey).catch(() => null),
    ]);
    if (Array.isArray(teamsRaw)) sbTeams = teamsRaw as SBTeamEvent[];
    if (Array.isArray(matchesRaw)) sbMatches = matchesRaw;

    const predByKey = new Map<string, number>();
    for (const sm of sbMatches) {
      const p = sm.pred?.red_win_prob;
      if (typeof p === "number" && Number.isFinite(p)) predByKey.set(sm.key, p);
    }

    const epaMap: Record<number, number> = {};
    for (const t of sbTeams) {
      // Same parser the Dashboard uses; the payload's total is `total_points`.
      const mean = totalEpa(t.epa);
      if (mean !== null) epaMap[t.team] = mean;
    }
    if (predByKey.size === 0 && Object.keys(epaMap).length === 0) return null;

    return matches.map((m) => {
      let redShare = predByKey.get(m.key);
      if (redShare === undefined) {
        const nums = (keys: string[]) => keys.map((k) => parseInt(k.replace("frc", ""), 10));
        const redEpa  = nums(m.alliances.red.team_keys).reduce((s, t) => s + (epaMap[t] ?? 30), 0);
        const blueEpa = nums(m.alliances.blue.team_keys).reduce((s, t) => s + (epaMap[t] ?? 30), 0);
        redShare = redEpa / (redEpa + blueEpa || 1);
      }
      const winRed = Math.max(1, Math.min(99, Math.round(redShare * 100)));
      return {
        matchNumber: m.match_number,
        matchLabel:  matchLabel(m),
        winRed,
        winBlue: 100 - winRed,
      };
    });
  }

  async function generate(matches: TBAMatch[], label: string) {
    setGenerating(true);
    try {
      if (matches.length === 0) {
        toast.info("No matches to generate markets for");
        return;
      }
      const seeds = await buildMatchSeeds(matches);
      if (!seeds) {
        toast.error("Couldn't get predictions from Statbotics, so no odds were set. Try again in a minute.");
        return;
      }
      const { created, refreshed } = await createMarkets({ eventKey, matches: seeds }) as { created: number; refreshed: number };
      if (created > 0 || refreshed > 0) {
        toast.success(
          [created > 0 && `Created ${created} ${label}`, refreshed > 0 && `updated odds on ${refreshed} with no bets`]
            .filter(Boolean).join("; ") + ".",
        );
      } else toast.info("Every match already has a market.");
    } catch (e: unknown) {
      toast.error((e as Error).message ?? "Market generation failed");
    } finally {
      setGenerating(false);
    }
  }

  // First load at an event with no markets yet: seed them so scouts aren't
  // staring at an empty page waiting for an admin to press a button.
  useEffect(() => {
    if (!isAdmin || didAutoGenerate.current || generating || marketsLive === undefined) return;
    if (marketsLive.length > 0 || tbaMatches.length === 0) return;
    didAutoGenerate.current = true;
    // Queued rather than called inline: generate() flips the `generating` flag
    // as its first act, and doing that inside an effect body cascades a render.
    // The ref above means this still runs exactly once.
    const id = setTimeout(() => generate(tbaMatches, "markets"), 0);
    return () => clearTimeout(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketsLive, tbaMatches, isAdmin]);

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
      didAutoGenerate.current = false; // allow auto-generate to re-trigger
    } catch (e: unknown) {
      toast.error((e as Error).message ?? "Wipe failed");
    } finally {
      setWiping(false);
    }
  }

  const markets = (marketsLive ?? []) as Market[];
  const myBetsQuery = useQuery(api.betting.listMyBets, { eventKey });
  const myBetsLive = useCached(myBetsQuery, `betting_my_bets_${eventKey}`);

  // marketId -> my bet on it. One bet per market, so a plain map is enough.
  const myBetByMarket = useMemo(() => {
    const map = new Map<string, MyBet>();
    for (const b of (myBetsLive ?? []) as MyBet[]) map.set(b.marketId, b);
    return map;
  }, [myBetsLive]);

  const filtered = useMemo(() => {
    return markets
      .filter((m) => statusFilter === "all" || m.status === statusFilter)
      .sort((a, b) => {
        const statusOrder = { open: 0, locked: 1, resolved: 2, cancelled: 3 };
        if (a.status !== b.status) return statusOrder[a.status] - statusOrder[b.status];
        return (a.matchNumber ?? 9999) - (b.matchNumber ?? 9999);
      });
  }, [markets, statusFilter]);

  const unplayed = tbaMatches.filter((m) => !isPlayed(m));

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
              onClick={() => generate(unplayed, "markets")}
              disabled={generating || unplayed.length === 0}
            >
              {generating
                ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                : <Zap className="h-3.5 w-3.5" />}
              {generating ? "Generating..." : "Generate Upcoming"}
            </Button>

            {/* Includes played matches, so markets can be created after an event
                to test resolution and payouts. */}
            <Button
              size="sm"
              variant="outline"
              className="gap-2 border-amber-400/40 text-amber-400 hover:bg-amber-400/10"
              onClick={() => generate(tbaMatches, "markets (all matches)")}
              disabled={generating || tbaMatches.length === 0}
            >
              <Target className="h-3.5 w-3.5" />
              All Matches
            </Button>

            <Button
              size="sm"
              variant="outline"
              className="gap-2 border-red-500/40 text-red-500 hover:bg-red-500/10"
              onClick={handleWipeAll}
              disabled={wiping || generating}
            >
              {wiping
                ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                : <XCircle className="h-3.5 w-3.5" />}
              Wipe All
            </Button>
          </div>
        </div>
      )}

      {/* How it works — the rules are short enough to state outright */}
      <div className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5 text-[11px] text-muted-foreground leading-relaxed">
        Pick the alliance you think wins. Odds come from Statbotics and are
        locked in when you bet, so an underdog pays more.{" "}
        <span className="text-foreground font-medium">One bet per match, and it&apos;s final.</span>
      </div>

      <div className="flex gap-1.5">
        {(["all", "open", "locked", "resolved"] as const).map((st) => (
          <button
            key={st}
            onClick={() => setStatusFilter(st)}
            className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium transition-colors border ${
              statusFilter === st
                ? "bg-primary/20 text-primary border-primary/40"
                : "border-border/50 text-muted-foreground hover:border-primary/30"
            }`}
          >
            {st === "all" ? "All Status" : STATUS_CONFIG[st].label}
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
            {isAdmin
              ? "Hit \"Generate Upcoming\" to create a match-winner market for every unplayed match."
              : "An admin needs to generate markets from the match schedule."}
          </p>
        </div>
      )}

      <div className="space-y-3">
        {filtered.map((m) => (
          <MarketCard
            key={m._id}
            market={m}
            myBalance={myBalance}
            myBet={myBetByMarket.get(m._id)}
            isAdmin={isAdmin}
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
  const wonBets = settledBets.filter((b) => (b.payout ?? 0) > 0).length;
  const winRate = settledBets.length > 0 ? Math.round((wonBets / settledBets.length) * 100) : null;

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
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
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
        <div className="rounded-xl bg-card border border-border p-4 text-center">
          <p className="text-2xl font-bold font-mono text-amber-400">{winRate !== null ? `${winRate}%` : "—"}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Win Rate</p>
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
            const opt = market?.options.find((o) => o.id === bet.optionId);
            const optLabel = opt?.label ?? bet.optionId;
            // Prefer the multiplier stored on the bet: it is what this bet will
            // actually be paid, even if the market row were ever re-seeded.
            const mult = bet.multiplier ?? (opt ? multiplierFor(opt) : 2);
            const toWin = Math.floor(bet.amount * mult);
            return (
              <div key={bet._id} className="rounded-xl bg-card border border-amber-500/20 p-4 flex items-center gap-3">
                <div className="h-8 w-8 rounded-lg bg-amber-500/10 flex items-center justify-center shrink-0">
                  <Coins className="h-4 w-4 text-amber-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{market?.title ?? "Unknown Market"}</p>
                  <p className="text-xs text-muted-foreground">
                    Bet on: <span className="text-foreground">{optLabel}</span>
                    {" "}at <span className="font-mono text-amber-400">{mult.toFixed(2)}x</span>
                  </p>
                  <p className="text-[10px] text-muted-foreground/70">
                    Pays <span className="font-mono text-amber-400">{toWin}</span> if it wins
                  </p>
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
                  <p className="text-xs text-muted-foreground">
                    Bet on: <span className="text-foreground">{optLabel}</span>
                    {bet.multiplier !== undefined && (
                      <> at <span className="font-mono">{bet.multiplier.toFixed(2)}x</span></>
                    )}
                  </p>
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

// -- Transaction Log Tab --------------------------------------------------------

type TransactionType =
  | "scouting_reward"
  | "pit_duty_reward"
  | "pit_duty_revoked"
  | "admin_award"
  | "beg"
  | "bet_placed"
  | "bet_won"
  | "bet_refunded";

interface CoinTransaction {
  _id: string;
  type: TransactionType;
  amount: number;
  balanceAfter: number;
  note?: string;
  createdAt: number;
}

const TXN_CONFIG: Record<TransactionType, { label: string; icon: React.ElementType }> = {
  scouting_reward: { label: "Scouting reward",  icon: BadgeCheck },
  pit_duty_reward: { label: "Pit duty",         icon: CheckCircle2 },
  pit_duty_revoked: { label: "Pit duty undone", icon: XCircle },
  admin_award:      { label: "Admin award",     icon: Gift },
  beg:             { label: "Begged",          icon: HandCoins },
  bet_placed:       { label: "Bet placed",      icon: Coins },
  bet_won:          { label: "Bet won",         icon: TrendingUp },
  bet_refunded:     { label: "Bet refunded",    icon: RefreshCw },
};

function TransactionLogTab({ eventKey }: { eventKey: string }) {
  const txnsQuery = useQuery(api.betting.listMyTransactions, { eventKey });
  const txns = useCached(txnsQuery, `betting_txns_${eventKey}`) as CoinTransaction[] | undefined;

  if (!txns) {
    return (
      <div className="flex items-center justify-center py-16">
        <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (txns.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
        <div className="h-16 w-16 rounded-2xl bg-amber-500/10 flex items-center justify-center">
          <ListFilter className="h-8 w-8 text-amber-400/60" />
        </div>
        <p className="font-semibold text-lg">No transactions yet</p>
        <p className="text-sm text-muted-foreground max-w-xs">
          Every coin you earn or spend — scouting, pit duty, begging, bets — shows up here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {txns.map((tx) => {
        const cfg = TXN_CONFIG[tx.type];
        const Icon = cfg.icon;
        const gained = tx.amount >= 0;
        return (
          <div key={tx._id} className="rounded-xl bg-card border border-border p-3 flex items-center gap-3">
            <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${gained ? "bg-amber-500/10" : "bg-red-500/10"}`}>
              <Icon className={`h-4 w-4 ${gained ? "text-amber-400" : "text-red-400"}`} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{cfg.label}</p>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {tx.note && <span className="truncate">{tx.note}</span>}
                <span className="shrink-0">{new Date(tx.createdAt).toLocaleString(undefined, {
                  month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                })}</span>
              </div>
            </div>
            <div className="text-right shrink-0">
              <p className={`font-mono font-bold text-sm ${gained ? "text-amber-400" : "text-red-400"}`}>
                {gained ? "+" : ""}{formatCoins(tx.amount)}
              </p>
              <p className="text-[10px] text-muted-foreground">bal: {formatCoins(tx.balanceAfter)}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// -- Admin: award coins ---------------------------------------------------------

function AwardCoinsDialog({ eventKey }: { eventKey: string }) {
  const [open, setOpen] = useState(false);
  const [scoutId, setScoutId] = useState("");
  const [amount, setAmount] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const users = useQuery(api.users.listUsers);
  const award = useAdminMutation(api.betting.adminAwardCoins);

  const amt = Number(amount);
  const valid = scoutId !== "" && Number.isInteger(amt) && amt > 0 && message.trim() !== "";

  const submit = async () => {
    setBusy(true);
    try {
      await award({ eventKey, scoutId: scoutId as Id<"users">, amount: amt, message });
      toast.success(`Awarded ${amt} coins`);
      setOpen(false);
      setScoutId(""); setAmount(""); setMessage("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not award coins");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} className="gap-2">
        <Gift className="h-4 w-4" /> Award coins
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Award coins</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Scout</Label>
              <Select value={scoutId} onValueChange={(v) => setScoutId(v ?? "")}>
                <SelectTrigger><SelectValue placeholder="Choose a scout" /></SelectTrigger>
                <SelectContent>
                  {[...(users ?? [])]
                    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))
                    .map((u) => (
                      <SelectItem key={u._id} value={u._id}>{u.name ?? u.email ?? "Unnamed"}</SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Coins</Label>
              <Input type="number" inputMode="numeric" min={1} step={1} value={amount}
                onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Reason (shown to the scout)</Label>
              <Input maxLength={200} value={message} placeholder="e.g. Covered an extra shift"
                onChange={(e) => setMessage(e.target.value)} />
            </div>
            <Button className="w-full" disabled={!valid || busy} onClick={submit}>
              {busy ? "Awarding…" : "Award"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

type Tab = "markets" | "my-bets" | "log" | "leaderboard";

export default function BettingPage() {
  const [activeTab, setActiveTab] = useState<Tab>("markets");

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
    { id: "log",         label: "Log",         icon: ListFilter },
    { id: "leaderboard", label: "Leaderboard", icon: Trophy },
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
            <span className="text-yellow-400 font-black font-mono text-lg">{formatCoins(myBalance)}</span>
            <Coins className="h-5 w-5 text-yellow-400" />
          </div>
        )}
      </div>

      {isAdminMode && <AwardCoinsDialog eventKey={eventKey} />}

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
      {activeTab === "log" && <TransactionLogTab eventKey={eventKey} />}
      {activeTab === "leaderboard" && <LeaderboardTab eventKey={eventKey} />}
    </div>
  );
}
