import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { initCliSentry } from "./lib/sentry";
import { RootLayout } from "./layouts/root-layout";
import { Home } from "./screens/home";
import { NewSession } from "./screens/new-session";
import { Session } from "./screens/session";

/**
 * Boot the interactive TUI. Kept separate from `index.tsx` so the entrypoint
 * can handle `--help`/`--version` without importing `@opentui/core` — that
 * import loads the native render library, which we don't want to touch for a
 * one-line flag.
 */
export async function boot() {
  initCliSentry();

  const router = createMemoryRouter([
    {
      path: "/",
      element: <RootLayout />,
      children: [
        { index: true, element: <Home /> },
        { path: "sessions/new", element: <NewSession /> },
        { path: "sessions/:id", element: <Session /> },
      ],
    },
  ]);

  function App() {
    return <RouterProvider router={router} />;
  }

  const renderer = await createCliRenderer({
    targetFps: 60,
    exitOnCtrlC: false,
  });
  createRoot(renderer).render(<App />);
}
