import { httpRouter } from "convex/server";
import { auth } from "./auth";

const http = httpRouter();

// Mount the Convex Auth routes — handles /api/auth/callback/google etc.
auth.addHttpRoutes(http);

export default http;
