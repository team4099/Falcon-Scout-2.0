// useAdminMutation — useMutation, but with the admin credential attached.
//
// Privileged Convex mutations require an `adminKey` (see convex/adminAuth.ts).
// Rather than thread it through every call site, swap `useMutation` for this
// hook at the declaration and the key is injected on every call:
//
//   const deleteTemplate = useAdminMutation(api.forms.deleteTemplate);
//   await deleteTemplate({ id });          // adminKey added automatically
//
// The key is read at call time, not at render time, so enabling admin mode
// takes effect immediately without remounting.

import { useCallback } from "react";
import { useMutation } from "convex/react";
import type {
  FunctionReference,
  FunctionArgs,
  FunctionReturnType,
} from "convex/server";
import { getAdminKey } from "@/lib/adminAuth";

export function useAdminMutation<M extends FunctionReference<"mutation">>(
  mutation: M,
): (args: Omit<FunctionArgs<M>, "adminKey">) => Promise<FunctionReturnType<M>> {
  const run = useMutation(mutation);
  return useCallback(
    (args: Omit<FunctionArgs<M>, "adminKey">) =>
      run({ ...args, adminKey: getAdminKey() } as FunctionArgs<M>),
    [run],
  );
}
