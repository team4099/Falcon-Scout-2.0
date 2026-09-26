import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Close betting on matches that have started. Cheap when nothing is open: it
// returns before calling TBA.
crons.interval("lock played betting markets", { minutes: 1 }, internal.bettingSync.lockPlayedForCurrentEvent);

export default crons;
