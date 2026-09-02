/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as adminAuth from "../adminAuth.js";
import type * as auth from "../auth.js";
import type * as betting from "../betting.js";
import type * as checklists from "../checklists.js";
import type * as events from "../events.js";
import type * as forms from "../forms.js";
import type * as http from "../http.js";
import type * as kanban from "../kanban.js";
import type * as pitScouting from "../pitScouting.js";
import type * as retention from "../retention.js";
import type * as schedules from "../schedules.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  adminAuth: typeof adminAuth;
  auth: typeof auth;
  betting: typeof betting;
  checklists: typeof checklists;
  events: typeof events;
  forms: typeof forms;
  http: typeof http;
  kanban: typeof kanban;
  pitScouting: typeof pitScouting;
  retention: typeof retention;
  schedules: typeof schedules;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
