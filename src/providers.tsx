import { ThemeProvider } from "@/components/theme-provider";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import { TooltipProvider } from "@/components/ui/tooltip";

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <ConvexAuthProvider client={convex}>
        <TooltipProvider>
          {children}
        </TooltipProvider>
      </ConvexAuthProvider>
    </ThemeProvider>
  );
}
