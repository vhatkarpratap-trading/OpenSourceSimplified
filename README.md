# Open Source Simplified

Open Source Simplified is a desktop application for understanding a codebase visually. Open a local repository and the app builds an interactive canvas that explains user flows, architecture, code paths, changes, and relationships in plain language.

It is designed for developers who need to orient themselves in an unfamiliar project, explain a system to others, investigate a change, or keep a visual map of repositories they work with.

## What you can do

Open Source Simplified lets you:

- Open a local repository and generate a source-backed visual map.
- Reopen previously cached projects from the home screen.
- Explore the primary user flow and supporting flows on a canvas.
- Select a component to inspect its detail, source evidence, code story, and implementation path.
- Generate a project-level technical architecture map.
- Generate a plain-English code walkthrough for a project or component.
- Ask a question about the whole project or selected components and receive a focused diagram.
- Explore local Git commits, commit diffs, branches, and pull requests when available.
- Highlight what changed and what may be affected after local file changes.
- Adjust analysis depth: Overview, Balanced, or Deep.
- Focus analysis on data flow, APIs, authentication, error handling, caching, observability, testing, and design patterns.

## Open a project

1. Start the application.
2. If shown, read the Terms & Conditions and select **I agree**. Selecting **Decline & exit** closes the application.
3. Select **Open Project**.
4. Choose the root folder of a repository.
5. Open Source Simplified prepares a local code graph and starts the analysis.

The first analysis may take longer for a large repository. Once completed, the project is cached locally so it can be reopened from **Cached repositories** on the home screen.

## Analysis views

### User flow

The main canvas explains what a person can do with the project: entry points, major decisions, data boundaries, integrations, and outcomes. It favors plain-language labels over file names and framework internals.

### Component detail

Select a node on the canvas to investigate a particular feature, module, service, screen, or other component. Depending on the selection, you can inspect a concise explanation, source files and evidence, a detailed drilldown, a code story, and an implementation walkthrough.

### Technical architecture

Use **Technical Architecture** to see how the project is organized: runtime boundaries, state, storage, APIs, external integrations, error paths, and important connections.

### Project code story and walkthrough

Use **Project Code Story** for a plain-English explanation of how the repository works. Use a walkthrough when you need a more implementation-oriented trace of the project or a selected component.

### Questions

Use **Ask project** or **Ask selected** to ask a focused question. The answer is rendered as a canvas diagram, so it remains connected to the visual context you are exploring.

### Git and pull requests

When the opened folder is a Git repository, you can inspect commits and diffs. If pull-request information is available, you can review a pull request as a feature-level story or code-oriented view.

## Analysis depth and focus

The **Depth** control affects new analysis, code stories, implementation maps, and answers:

- **Overview** — the smallest complete explanation of the most important path.
- **Balanced** — the main path plus meaningful decisions, boundaries, and alternatives.
- **Deep** — a more detailed map of consequential paths, errors, and contracts.

Use the **Walkthrough Focus** menu to ask for extra attention to API contracts, data and state, safety, reliability, database use, authentication, validation, errors, events, logging, tests, and architecture patterns.

## Cached projects

Open Source Simplified keeps a local cache of analyses and canvases. The home screen lists repositories that already have a saved cache. Choose **Open** on any card to restore its saved project canvas.

Use **Back to home** from the canvas to return to the repository library. You can clear a project cache from the canvas when you no longer want its local analysis, drilldowns, prepared walkthroughs, and saved canvas state.

## Privacy and Supabase synchronization

Repository handling is based on a conservative classification:

- **Open-source repositories** — when a repository is verified as publicly accessible on GitHub or GitLab, or has a recognised open-source licence, Open Source Simplified may upload generated analysis artifacts, cached diagrams, prepared walkthrough artifacts, public remote metadata, and related analysis metadata to Supabase. This allows the cached analysis to be reused.
- **Private, closed-source, and unverified repositories** — analysis remains local-only. The application does not upload their analysis to Supabase, retrieve a Supabase analysis for them, or send a Supabase deletion request for them.

If visibility cannot be verified, the repository is treated as private. The Terms & Conditions dialog is shown once per device and version. Accepting it records local consent; declining it exits the application.

## Requirements

- **Operating System**: macOS, Windows, or Linux with a supported Electron runtime.
- **Node.js**: Node.js 20 or newer (tested on Node 22/23).
- **Git**: Installed and available in PATH (for repository history, commit diffs, and branch features).

## Getting Started

### 1. Install dependencies

~~~bash
npm install
~~~

### 2. Rebuild native modules

The project uses `node-pty` for terminal and command interactions, which compiles native bindings against Electron's internal ABI:

~~~bash
npm run rebuild-native
~~~

> **Tip**: Always run this step after `npm install`, updating Node.js, or switching Electron versions.

### 3. Build the application

Compile both the Electron main process (TypeScript) and the renderer bundle (React & Webpack):

~~~bash
npm run build
~~~

### 4. Run the application

Launch the built desktop application:

~~~bash
npm start
~~~

---

## Development Mode

For active development with live recompilation of renderer assets:

~~~bash
npm run dev
~~~

This command concurrently watches and bundles changes in `src/renderer/` and boots the Electron window once the bundle is ready.

## Useful commands

| Command | What it does |
| --- | --- |
| `npm run build` | Builds both the main Electron process and Webpack renderer bundle. |
| `npm start` | Launches the built Electron desktop application. |
| `npm run dev` | Watches renderer source changes and launches Electron with live reloads. |
| `npm run build:main` | Compiles the Electron main process via `tsc`. |
| `npm run build:renderer` | Bundles the React renderer via Webpack. |
| `npm run rebuild-native` | Rebuilds native C++ modules (`node-pty`) for the Electron ABI. |

## Troubleshooting

- **Native module mismatch (`NODE_MODULE_VERSION`)**: If Electron errors with `was compiled against a different Node.js version`, run `npm run rebuild-native`.
- **Clean rebuild**: If assets fail to load or build state is stale, run:
  ~~~bash
  npm run rebuild-native && npm run build && npm start
  ~~~

## Notes

- Analysis is intended to help people understand source code; it is not legal, security, compliance, or professional advice.
- Verify generated diagrams and explanations against the source before making important decisions.
- Do not process secrets, credentials, regulated data, or other sensitive information unless doing so is permitted and appropriate for your environment.
