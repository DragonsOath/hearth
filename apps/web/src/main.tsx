import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyTheme, cachedTheme } from "./lib/theme";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider, Navigate, useLocation } from "react-router";
import { AppShell } from "./components/AppShell";
import { EmptyState } from "./components/ui";
import { AgentPage } from "./pages/Agent";
import { JobsPage } from "./pages/Jobs";
import { TodoPage } from "./pages/Todo";
import { ReleasesPage } from "./pages/Releases";
import { PlanPage } from "./pages/Plan";
import { SavedWorkPage } from "./pages/SavedWork";
import { ProjectsPage } from "./pages/Projects";
import { BackupsPage, DockerPage, LogsPage, NetworkPage } from "./pages/Infrastructure";
import { JobDetailPage } from "./pages/JobDetail";
import { AutonomyPage } from "./pages/Autonomy";
import { DiscoverPage } from "./pages/Discover";
import { HomePage } from "./pages/Home";
import { IncidentDetailPage } from "./pages/IncidentDetail";
import { IncidentsPage } from "./pages/Incidents";
import { FindingDetailPage, FindingsPage } from "./pages/Findings";
import { IntegrationsPage } from "./pages/Integrations";
import { NotificationsPage } from "./pages/Notifications";
import { ServiceDetailPage, BackLink } from "./pages/ServiceDetail";
import { ServicesPage } from "./pages/Services";
import { SettingsPage } from "./pages/Settings";
import { StorageBrowserPage } from "./pages/StorageBrowser";
import { SystemsPage } from "./pages/Systems";
import { AuthGate } from "./pages/auth/AuthFrame";
import { PairPage } from "./pages/auth/Pair";
import { JoinInfoPage } from "./pages/auth/JoinInfo";
import { DevicesPage } from "./pages/Devices";
import { LoginPage } from "./pages/auth/Login";
import { SetupPage } from "./pages/auth/Setup";
import { VaultPage } from "./pages/Vault";
import { MemoryPage } from "./pages/Memory";
import { AskPage } from "./pages/Ask";
import { ImportReviewPage } from "./pages/ImportReview";
import { WelcomePage } from "./pages/Welcome";
import { WarRoomPage } from "./pages/WarRoom";
import { HomeScreenPage } from "./pages/HomeScreen";
import "./index.css";
import { captureViewingPc } from "./lib/viewingPc";

function NotFound() {
  return (
    <>
      <BackLink to="/">Home</BackLink>
      <EmptyState title="Nothing here">This page does not exist.</EmptyState>
    </>
  );
}

/** /saved (the Forge Library's old address) keeps its tab. */
function ToForge() {
  const { search } = useLocation();
  return <Navigate to={`/forge${search}`} replace />;
}

const router = createBrowserRouter([
  { path: "setup", element: <SetupPage /> },
  { path: "login", element: <LoginPage /> },
  { path: "pair", element: <PairPage /> },
  { path: "join", element: <JoinInfoPage /> },
  {
    path: "war-room",
    element: (
      <AuthGate>
        <WarRoomPage />
      </AuthGate>
    ),
  },
  {
    path: "home-screen",
    element: (
      <AuthGate>
        <HomeScreenPage />
      </AuthGate>
    ),
  },
  {
    path: "welcome",
    element: (
      <AuthGate>
        <WelcomePage />
      </AuthGate>
    ),
  },
  {
    element: (
      <AuthGate>
        <AppShell />
      </AuthGate>
    ),
    children: [
      { index: true, element: <HomePage /> },
      { path: "systems", element: <SystemsPage /> },
      { path: "services", element: <ServicesPage /> },
      { path: "services/:id", element: <ServiceDetailPage /> },
      { path: "findings", element: <FindingsPage /> },
      { path: "findings/:id", element: <FindingDetailPage /> },
      { path: "incidents", element: <IncidentsPage /> },
      { path: "incidents/:id", element: <IncidentDetailPage /> },
      // Storage & Files is a panel now; the old page address opens it.
      {
        path: "storage",
        element: <Navigate to="/?panels=tool%3Astorage&focus=tool%3Astorage" replace />,
      },
      { path: "storage/:id", element: <StorageBrowserPage /> },
      { path: "projects", element: <ProjectsPage /> },
      { path: "docker", element: <DockerPage /> },
      { path: "network", element: <NetworkPage /> },
      { path: "logs", element: <LogsPage /> },
      { path: "backups", element: <BackupsPage /> },
      { path: "todo", element: <TodoPage /> },
      { path: "releases", element: <ReleasesPage /> },
      { path: "plan", element: <PlanPage /> },
      { path: "forge", element: <SavedWorkPage /> },
      // The Forge Library was called Saved work: old links still arrive.
      { path: "saved", element: <ToForge /> },
      { path: "jobs", element: <JobsPage /> },
      { path: "jobs/:id", element: <JobDetailPage /> },
      { path: "agent", element: <AgentPage /> },
      { path: "autonomy", element: <AutonomyPage /> },
      { path: "vault", element: <VaultPage /> },
      { path: "memory", element: <MemoryPage /> },
      { path: "ask", element: <AskPage /> },
      { path: "ask/:id", element: <AskPage /> },
      { path: "memory/import", element: <ImportReviewPage /> },
      { path: "notifications", element: <NotificationsPage /> },
      { path: "integrations", element: <IntegrationsPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "devices", element: <DevicesPage /> },
      { path: "discover", element: <DiscoverPage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

// A linked PC opened this window: remember which, so it is named after that PC.
captureViewingPc();

// The theme this device used last, before the first paint (your settings follow once loaded).
applyTheme(cachedTheme());

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing from index.html");

/**
 * After an update, an open page can ask for a file the new version replaced ("Failed to fetch
 * dynamically imported module"). Reload once to get the new version instead of showing the error;
 * a second failure within a minute is a real problem, so it is shown.
 */
window.addEventListener("vite:preloadError", (event) => {
  const KEY = "hearth-reloaded-for-update";
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(KEY) ?? 0);
  } catch {
    /* no storage: still reload once */
  }
  if (Date.now() - last < 60_000) return;
  try {
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* fine */
  }
  event.preventDefault();
  window.location.reload();
});

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);

// Installable on a phone or desktop, and opens without a connection (production builds only).
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Not available (for example plain http on a LAN address): the app works the same without it.
    });
  });
}
