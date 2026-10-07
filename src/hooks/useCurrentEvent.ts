// Which event a screen should show.
//
// The admin-set current event is the one everybody works in: scouting forms,
// assignments, scheduling and FalconBet always use it (useAdminEvent). Screens
// that only *read* an event's data — Dashboard, Matches, Data Viewer, Picklist,
// Submissions — use useCurrentEvent, which returns the event this device chose
// to look at in Settings instead, when there is one. That choice is local: it
// never changes the current event for anyone else.

import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useCached } from "@/hooks/useCached";
import { useUIStore } from "@/store/uiStore";

/** The event an admin set as current. */
export function useAdminEvent() {
  return useCached(useQuery(api.events.getCurrentEvent), "current_event");
}

/** The event this device is viewing: the local pick if any, else the current one. */
export function useCurrentEvent(): { eventKey: string; eventName: string } | null | undefined {
  const adminEvent = useAdminEvent();
  const viewEvent = useUIStore((s) => s.viewEvent);
  return viewEvent && viewEvent.eventKey !== adminEvent?.eventKey ? viewEvent : adminEvent;
}
