// Evaluated once a minute by the System Durable Object (one "* * * * *" Cron Trigger per Worker), in each
// cron's time zone (default UTC). Every cron names the shard ("<kind>:<key>") it runs on.
import { cronJobs } from "@freecorps/ember-server";

const crons = cronJobs({ shard: "global:main" });

crons.hourly("trim-general", { minute: 0 }, "messages:trim", { channel: "general", keep: 1000 });

export default crons;
