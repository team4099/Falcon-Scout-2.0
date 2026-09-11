// useAdminMutation — useMutation for privileged Convex mutations.
//
// Admin access is enforced server-side by the caller's signed-in email (see
// convex/adminAuth.ts), not by a client-sent credential. This hook is now a
// thin wrapper kept for its `Omit<..., "adminKey">` typing, so call sites
// don't need to know that some mutations still declare a retired (optional,
// server-ignored) `adminKey` argument for backward compatibility:
//
//   const deleteTemplate = useAdminMutation(api.forms.deleteTemplate);
//   await deleteTemplate({ id });

import { useMutation } from "convex/react";
import type {
  FunctionReference,
  FunctionArgs,
  FunctionReturnType,
} from "convex/server";

export function useAdminMutation<M extends FunctionReference<"mutation">>(
  mutation: M,
): (args: Omit<FunctionArgs<M>, "adminKey">) => Promise<FunctionReturnType<M>> {
  const run = useMutation(mutation);
  return (args: Omit<FunctionArgs<M>, "adminKey">) => run(args as FunctionArgs<M>);
}
