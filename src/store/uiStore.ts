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
    }),
    {
      name: "falconscout_ui",
      // Only persist admin mode — tab and sidebar should reset naturally
      partialize: (state) => ({ isAdminMode: state.isAdminMode }),
    }
  )
);
