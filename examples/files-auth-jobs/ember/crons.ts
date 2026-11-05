// The System Durable Object evaluates these once a minute and runs each due one on its shard.
import { cronJobs } from "@freecorps/ember-server";
import { internal } from "./_generated/api";

const crons = cronJobs({ shard: "global:main" });

crons.interval("retry-stuck-uploads", { minutes: 5 }, internal.files.sweep);

export default crons;
