import { create } from "zustand";
import { persist } from "zustand/middleware";

interface UIState {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  isSidebarOpen: boolean;
  setSidebarOpen: (isOpen: boolean) => void;
  // Admin mode — persisted to localStorage so it survives page reloads
  isAdminMode: boolean;
  setAdminMode: (enabled: boolean) => void;
  // Dashboard rankings column visibility: explicit per-device overrides only,
  // so columns keep their defaults (built-ins on, tagged form fields off).
  rankingColumns: Record<string, boolean>;
  setRankingColumn: (id: string, visible: boolean) => void;
  resetRankingColumns: () => void;
  // Picklist card/list stats: same options as the rankings columns, own prefs.
  picklistColumns: Record<string, boolean>;
  setPicklistColumns: (prefs: Record<string, boolean>) => void;
  // Dashboard teams hidden from the rankings list, per event key, per device.
  hiddenTeams: Record<string, number[]>;
  setTeamHidden: (eventKey: string, team: number, hidden: boolean) => void;
  unhideAllTeams: (eventKey: string) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      activeTab: "dashboard",
      setActiveTab: (tab) => set({ activeTab: tab }),
      isSidebarOpen: true,
      setSidebarOpen: (isOpen) => set({ isSidebarOpen: isOpen }),
      isAdminMode: false,
      setAdminMode: (enabled) => set({ isAdminMode: enabled }),
      rankingColumns: {},
      setRankingColumn: (id, visible) =>
        set((s) => ({ rankingColumns: { ...s.rankingColumns, [id]: visible } })),
      resetRankingColumns: () => set({ rankingColumns: {} }),
      picklistColumns: {},
      setPicklistColumns: (prefs) => set({ picklistColumns: prefs }),
      hiddenTeams: {},
      setTeamHidden: (eventKey, team, hidden) =>
        set((s) => {
          const rest = (s.hiddenTeams[eventKey] ?? []).filter((t) => t !== team);
          return { hiddenTeams: { ...s.hiddenTeams, [eventKey]: hidden ? [...rest, team] : rest } };
        }),
      unhideAllTeams: (eventKey) =>
        set((s) => {
          const next = { ...s.hiddenTeams };
          delete next[eventKey];
          return { hiddenTeams: next };
        }),
    }),
    {
      name: "falconscout_ui",
      // Persist admin mode + dashboard prefs — tab and sidebar should reset naturally
      partialize: (state) => ({
        isAdminMode: state.isAdminMode,
        rankingColumns: state.rankingColumns,
        picklistColumns: state.picklistColumns,
        hiddenTeams: state.hiddenTeams,
      }),
    }
  )
);
