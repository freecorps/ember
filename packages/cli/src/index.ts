// Programmatic API of the `ember` CLI.
export { main } from "./main.ts";
export * from "./config.ts";
export { codegen, buildManifest, apiDts, dataModelDts, type EmberManifest, type FunctionManifest, type CodegenResult } from "./codegen/index.ts";
export { AUTH_DO, authModeOf, buildWorker, doClasses, loadProjectCode, workerEntrySource, DO_CLASSES, type AuthMode, type WorkerBuild } from "./build.ts";
export { deploy, fetchCurrentState, workerForm, loadDeployments, noopRegistry, type DeployOptions, type DeployResult, type ProjectRegistry } from "./deploy/index.ts";
export * from "./deploy/plan.ts";
export { CfClient, CloudflareApiError, resolveToken } from "./deploy/cf.ts";
export { dev, type DevOptions } from "./dev.ts";
export { startLocal, miniflareOptions } from "./local.ts";
export { init } from "./init.ts";
export { run, normalizeFnName } from "./run.ts";
export { D1Registry, ensureFingerprint, findDatabase, noopRegistry as noopProjectRegistry, registryName, RegistryConflictError, REGISTRY_DDL, SHARDS_TABLE_DDL, DEFAULT_REGISTRY_NAME } from "./registry.ts";
export { addDomain, checkDomain, findZone, routeMatchesHost, type DomainCheck, type DomainConflict } from "./domains.ts";
export { streamLogs, formatTailEvent, createTail, deleteTail, type TailEvent, type LogFilters } from "./logs.ts";
export { buildDashboard, deployDashboard, projectServices, DEFAULT_DASHBOARD_NAME, type DashboardBuild } from "./dashboard.ts";
export { restoreCommand, parseRestoreTarget, resolveBookmark, resolveDeployPoint, listBookmarks, recordBookmark, restoreShard, isBookmark, PITR_RETENTION_MS, type BookmarkRow, type RestoreTarget, type RestoreResult, type RestoreCommandOptions } from "./restore.ts";
export { parseAuthFrom, resolveAuthFrom, withAuthFrom, type SsoRegistry } from "./sso.ts";
