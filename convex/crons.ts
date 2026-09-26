import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Close betting 5 minutes before a match starts. Cheap when nothing is open: it
// returns before calling TBA.
crons.interval("lock played betting markets", { minutes: 1 }, internal.bettingSync.lockPlayedForCurrentEvent);

// Keep Statbotics' predictions current on markets nobody has bet on yet.
crons.interval("refresh betting odds", { minutes: 10 }, internal.bettingSync.refreshOddsForCurrentEvent);

export default crons;
