import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Close betting when a match is scheduled to start, and pay out bets the moment
// TBA posts that match's winner. Cheap when nothing is open/unresolved: it
// returns before calling TBA.
crons.interval("sync betting markets with TBA", { minutes: 1 }, internal.bettingSync.syncPlayedMatchesForCurrentEvent);

// Keep Statbotics' predictions current on markets nobody has bet on yet.
crons.interval("refresh betting odds", { minutes: 10 }, internal.bettingSync.refreshOddsForCurrentEvent);

export default crons;
