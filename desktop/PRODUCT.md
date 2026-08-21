# DarkCode Desktop

## What it is

A native Windows client for the DarkCode coding agent. Same API, same
credentials and the same client-side tool model as the terminal CLI — a window
instead of a terminal.

**Register: product.** Design serves the task. The user is here to get a change
made in their codebase, not to look at the app.

## Who uses it, where

A developer at a desk, on a second monitor, alongside their editor. Often for a
long session: they ask for a change, watch tools run against their real
filesystem, approve or refuse the ones that touch things. The window is open for
hours and frequently in peripheral vision.

That scene forces two decisions. It is **dark** — it sits next to a dark editor
in a dim room, and a bright panel in that arrangement is a lamp pointed at the
user. And it is **quiet** — anything that moves or flashes competes with the
editor for attention it has not earned.

## What the user needs to see at a glance

1. Is it working right now, or waiting for me?
2. What did the agent just do to my files?
3. Which of those needs my permission before it happens?

Everything else — model, mode, credits, project directory — is reference
material and should sit still.

## Non-goals

- Not a terminal emulator. It does not try to look like one.
- Not a general IDE. There is no file tree, no editor, no debugger.
- No onboarding tour, no marketing surface, no empty-state illustration.

## Constraints

- Dear ImGui (immediate mode) on Win32 + Direct3D 11, C++20.
- Single window, no docking, no user-arrangeable panels.
- Everything ships in one executable; assets sit beside it and are optional.
