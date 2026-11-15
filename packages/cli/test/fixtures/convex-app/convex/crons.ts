import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.daily("cleanup", { hourUTC: 3, minuteUTC: 30 }, internal.maintenance.cleanup);
crons.weekly("weekly cleanup", { dayOfWeek: "monday", hourUTC: 9, minuteUTC: 0 }, internal.maintenance.cleanup);
crons.interval("tick", { seconds: 300 }, internal.maintenance.cleanup);

export default crons;
