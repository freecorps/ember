import { cronJobs } from "@freecorps/ember-server";
import { internal } from "./_generated/api";

const crons = cronJobs({ shard: "global:main" });

crons.daily("cleanup", { hour: 3, minute: 30 }, internal.maintenance.cleanup);
crons.weekly("weekly cleanup", { dayOfWeek: 1, hour: 9, minute: 0 }, internal.maintenance.cleanup);
crons.interval("tick", { minutes: 5 }, internal.maintenance.cleanup);

export default crons;
