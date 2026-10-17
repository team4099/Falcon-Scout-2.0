/**
 * The label a scout is shown by: the admin-set nickname when there is one (so
 * two scouts named "Charlie" can be told apart), otherwise their name, then
 * their email. Callers pass their own fallback for a user with none of these.
 */
export function scoutLabel(
  u: { nickname?: string; name?: string; email?: string },
  fallback = "Scout",
): string {
  return u.nickname || u.name || u.email || fallback;
}
