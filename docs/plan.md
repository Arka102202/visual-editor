# Visual Editor: the plan (shell + React first)

We build the **shell and the React plugin completely first**, then the other plugins (Node.js + Express, SQL,
MongoDB, later Next.js and the rest).

Every step ends the same way: the tests pass, it's tried in a test VS Code, you try it, and it's committed after
your OK. **Claude changes code only when you ask, and only as proposals in Review.**

---

## The rules everything follows

### Two parts for every previewable component or page

- **Dynamic:** the real data (hooks, API, stores), used in the app.
- **Static:** a **working prototype** with no network:
  - it starts from fixed data;
  - clicks, typing, menus and modals work, and actions change the data **in memory** ("New project" adds a card,
    "Delete" removes it);
  - reloading starts again from the fixed data;
  - **one page only:** a link or navigation to another page doesn't go anywhere, it shows a small note instead
    ("Would open /editor/abc").

### The folder

```
ProjectList/
  index.tsx                  chooser: the app → dynamic part; Preview and Playground → static part
  ProjectList.types.ts       Props (what a parent passes), View (what every design gets), situations if any
  ProjectList.data.tsx       dynamic: hooks, API, stores → View
  ProjectList.static.tsx     static: starting data + clicks that change it in memory → View
  ProjectList.mock.ts        the starting data, as named states (default, empty, many…), committed
  ProjectList.switcher.tsx   which design is in use (one line per situation)
  ProjectList.variant.tsx, ProjectList.<name>.variant.tsx   designs: looks only
```

### Children get their parent's data

On a page, each ProjectCard receives the project the page gives it. Its static part shapes that, so every card is
different, just like in the app. On its own (in its own Playground), a child starts from its own starting data.

### Situations (Button, Toast…)

- A component can have situations, for example Button: primary, secondary, danger; Toast: success, error, info.
- The parent picks the situation (`<Button kind="danger">`).
- **Each situation has its own design in use.** The switcher has one line per situation, and one design can serve
  several situations.
- Components without situations have just one "in use".

### Legacy projects

Children that aren't previewable just show as they are. Nothing is noted or changed.

### Three views

- **Webview:** the whole running app inside VS Code (map toolbar), for trying finished pages.
- **Preview:** one design on its own, in one state, at a screen size (Phone, Tablet, Laptop, Desktop).
- **Playground:** every design in every state, side by side.

### Agents

- Every agent is a **worker plus a checker**. The checker proves the work with its own evidence (pictures, numbers,
  test results) before it reaches Review, at most 3 rounds, with time and cost limits.
- Three layers: **tools** (code that does things) → **skills** (know-how) → **agents** (worker + checker).
- Every agent runs **three ways**:
  1. asking Claude in your chat (a skill hands the job to the agent);
  2. a button, in the background (progress line, Stop);
  3. a button, in a terminal you can watch and talk to.
- Visual Editor's skills and agents are installed in Claude Code for the project (public), when you press Connect.

---

## Phase 1: Finish Preview and Playground

### 1.1 Webview ✅ done
The whole running app inside VS Code, with Console, CSS, Network and fakes.

### 1.2 Preview and Playground ✅ done
Preview shows one design at screen sizes. The Playground shows every design in every state, with Compare and
Details.

### 1.3 "Use this design" ✅ done
A one-line proposal, with the before and after shown live in Review, and Undo.

### 1.4 The new rules, written down ✅ done
- **You get:** `docs/variants.md` rewritten in simple words:
  - the two parts (dynamic and static);
  - the static part as a prototype;
  - starting data;
  - children getting their parent's data;
  - one page only;
  - situations;
  - a full worked example.
- **Done when:** you read it and agree. Everything after is built from it.

### 1.5 Helper version 2 ✅ done
- **You get:** the project's helper file (`src/visual-editor.tsx`) learns:
  - the static part's memory (each tile keeps its own changes);
  - **Reset** back to the starting data;
  - navigation that shows a note instead of leaving the page;
  - a version number.
- When a project's helper is older, Preview says so and offers **"Update the helper"** as a proposal.
- **Done when:** old and new helpers both work, and the update proposal is a clean diff.

### 1.6 The static part: read and checked ✅ done
- **You get:** Visual Editor reads `Name.static.tsx`. New checks, each explained in words:
  - the static part calls no API, database or store;
  - it gives the same `View` as the dynamic part;
  - the starting data has a "default" state;
  - a child's static part uses what its parent passes.
- **Done when:** every broken rule shows on the card with what to do.

### 1.7 The prototype in Preview and the Playground ✅ done (with 1.5)
- **You get:**
  - clicks work and change the data **in memory** (Delete removes a card, New adds one);
  - each tile keeps its own changes;
  - a **Reset** button;
  - a note when something tries to go to another page ("Would open /editor/abc");
  - the network stays blocked.
- **Done when:** you can use a page in Preview like the real thing, and Reset brings it back.

### 1.8 ProjectCard in the new shape ✅ done
- **You get:** the worked example and the test fixtures moved to the new shape. Your archFlow too, **only if you
  ask**.
- **Done when:** ProjectCard looks and works exactly as before in the app, and in the Playground.

### 1.9 Situations ✅ done
- **You get:**
  - `types` declares the situations (Button: primary, secondary, danger);
  - the switcher has one line per situation, and a design says which situations it serves;
  - the Playground groups by situation;
  - Preview lets you pick a situation;
  - "Use this design" asks **for which situation**;
  - check: every situation has a design in use.
- **Done when:** a test Button uses design A for primary and design B for danger, and switching one doesn't touch
  the other.

### 1.10 Pages ✅ done
- **You get:** ProjectList converted in the test copy. The whole page in Preview at Phone, Tablet or Desktop size:
  - each card shows its own project;
  - "New project" opens the modal and adds a card;
  - Delete removes one;
  - the "empty" state shows the empty page;
  - opening a project shows the note.
- **Done when:** the page in Preview feels like the real page, with no network.

### 1.11 Providers file ✅ done
- **You get:** an optional `src/visual-editor.providers.tsx` that wraps every preview (a router in memory, a
  theme…). When a page's design needs it (links, for example) and it's missing, Visual Editor offers it as a
  proposal.
- **Done when:** a page with links draws and its links show the note.

### 1.12 Tie it together ✅ done
- **You get:**
  - card badges ("3 designs · 2 situations · 4 states");
  - a **Variants** tab in Focus;
  - the Webview picker says "ProjectCard · Compact (in use)";
  - Preview, Playground and Webview open each other.
- **Done when:** from any card you reach every view in one click.

### 1.13 Clean-ups ✅ done
- **You get:**
  - temporary files from tools like `sed` no longer counted as changes;
  - the Playground smooth with many tiles on 8 GB (tiles drawn only when on screen);
  - a full test run.
- **Done when:** a component with 6 designs × 8 states scrolls smoothly.

---

## Phase 2: The agent foundation, and the first agents

### 2.1 Plugin slots for tools, skills and agents ✅ done
- **You get:** plugins can hand the shell their tools (code Claude calls), skills (know-how) and agents (worker plus
  checker). The shell collects them.
- **Done when:** the React plugin's first tool shows up in Claude Code.

### 2.2 Visual Editor's Claude Code plugin ✅ done
- **You get:** one Claude Code plugin built from every installed plugin's skills and agents.
  - It's installed for the project when you press Connect.
  - Projects that are already connected get "Add Visual Editor's agents".
  - It updates when plugins update.
- **Done when:** in your chat, Claude lists Visual Editor's agents.

### 2.3 Tools for variants ✅ done
- **You get:**
  - `variant_brief` (everything about a card for a job);
  - `check_variant_files` (the rules on proposed files);
  - `save_draft`, `read_draft` and `submit_draft`.
- **Done when:** Claude can make and check a draft without touching your files.

### 2.4 Drafts and evidence ✅ done
- **You get:**
  - drafts are kept apart from proposals;
  - evidence (pictures of the Playground, numbers, test results) is stored with each draft;
  - Review shows the evidence next to the change.
- **Done when:** a proposal in Review carries its proof.

### 2.5 The worker → checker loop ✅ done
- **You get:** the worker makes a draft, and the checker proves it or sends it back with reasons, at most 3 rounds.
  Time and cost limits, and **Stop**.
- **Done when:** a planted mistake is caught by the checker and fixed by the worker.
- **Note:** the cost limit applies to runs Visual Editor starts (2.6: `--max-budget-usd`); in your own chat, Claude
  Code's own limits apply.

### 2.6 The three ways in
- **You get:**
  - **chat:** the skill runs the worker, then the checker;
  - **a button in the background:** with a progress line and Stop;
  - **a button in a terminal:** you watch and can talk to it;
  - a setting for which one the buttons use.
- **Done when:** the same job gives the same proposal all three ways.

### 2.7 Agents panel
- **You get:** every agent with what it does, Run now, what's running, and the last results with their proof.
- **Done when:** you can start, watch, stop and review any agent from one place.

### 2.8 Agent: Make previewable
- **You get:** an existing component or page split into the two parts.
- **The checker proves:**
  - the rules pass;
  - TypeScript passes;
  - **the app looks the same in the Webview before and after**;
  - the prototype works in the Playground.
- **Done when:** a real archFlow component converts with no hand fixes.

### 2.9 Agent: New variant
- **You get:** a new design from your words, for a situation if there are any.
- **The checker proves:** the rules pass, and the Playground pictures match what you asked for.
- **Done when:** "a one-line row with the colour as a dot" gives that design.

### 2.10 Agents: New component / New page, and Set up project
- **You get:**
  - a component or page built **with both parts from the start**, from a description, so new projects grow in this
    shape from day one;
  - setup adds the helper and the providers file.
- **Done when:** a new page made from a sentence works in the app and as a prototype.

### 2.11 Tested all three ways
- **Done when:** each agent runs in chat, in the background and in a terminal on the archFlow copy.

---

## Phase 3: Understand without reading code (React)

### 3.1 Summaries
- **You get:** "What does this do?" on every card, in plain words.
  - Written by the Documentation writer and checked by its checker.
  - Marked "read" (straight from code) or "worked out".
  - Refreshed when the code changes.
- **Done when:** summaries stay correct after code changes.

### 3.2 Story view
- **You get:** "What happens when I click?" as steps: click → handler → state → API call. It stops at the API card
  until Express exists.
- **Done when:** ProjectList's "Delete" shows its full story.

### 3.3 Follow a field
- **You get:** pick a value (for example `project.name`) and see where it comes from and every place it's shown.
- **Done when:** the path is highlighted across components on the map.

### 3.4 Impact
- **You get:** "What breaks if I change this?", direct and further away, each with a reason.
- **Done when:** changing a prop lists every parent that passes it.

### 3.5 History and change timeline
- **You get:** per card: approved proposals, notes and outside changes, in words ("changed yesterday by Claude: the
  date shows first").
- **Done when:** a card's history reads like a story.

### 3.6 Problems list
- **You get:** hooks rules, duplicates and look-alikes, missing loading/error states, design tokens, unused
  components. Each comes with a fix ready as a proposal.
- **Done when:** problems are explained in one sentence each, with a working fix.

### 3.7 Run panel and Setup doctor
- **You get:** scripts, port, env variables (missing ones in red), and an agent that fixes setup problems.
- **Done when:** a missing env variable is found and fixed.

### 3.8 Start measuring the 80%
- **You get:** a count of Open code clicks (on your machine only), plus a one-click "What were you looking for?".
- **Done when:** the answers show which questions the editor doesn't answer yet.

---

## Phase 4: Change code visually (React writers)

### 4.1 Writer foundation
- **You get:** the plugin `writers` slot. Edits are made on the code's structure, never by text search, and always
  as proposals.
- **Done when:** a writer's edit keeps the file's own formatting.

### 4.2 Props
- **You get:** add, rename or remove a prop, with every parent updated.
- **Done when:** renaming a prop updates every place that passes it.

### 4.3 Swap, move, wrap
- **You get:** replace a child with another component, move it, or wrap it.
- **Done when:** each is one proposal with a clean diff.

### 4.4 Text from Preview
- **You get:** click text in Preview, edit it, and it becomes a proposal on the design file.
- **Done when:** the edit lands in the right file and line.

### 4.5 Styles
- **You get:** style changes from the Webview's CSS panel or from Preview, written as Tailwind classes or CSS,
  whichever the project uses.
- **Done when:** a colour change becomes the right class.

---

## Phase 5: React's own agents (each with its checker)

### 5.1 Leak hunter
Finds listeners, timers and subscriptions that pile up. **Proof:** the page used 20 times in the Webview, with
listener and memory counts staying flat.

### 5.2 Edge-case tester (UI)
Finds cases a component can't handle; adds them as starting-data states and writes tests. **Proof:** the tests fail
before the fix and pass after.

### 5.3 UI speed
Finds slow and over-rendering components. **Proof:** render counts and times, before and after.

### 5.4 Design system builder
From a description ("calm, rounded, blue") to colours, type, spacing and core components (Button, Toast… with their
situations). **Proof:** rendered tokens, contrast checks, a comparison with your description.

---

## Phase 6: The shell's project-wide agents

1. **6.1 DRY keeper:** finds repeated code and proposes one shared piece.
2. **6.2 Rules keeper:** checks changes against the project's rules; turns repeated decisions into rules.
3. **6.3 Health watcher:** a health line per part of the project; warns when something gets worse.
4. **6.4 Dead code cleaner:** unused files, exports and components, removed as proposals.
5. **6.5 Security guard:** secrets in code, unsafe HTML, risky packages.
6. **6.6 Package advisor / dependency doctor:** outdated, duplicate or broken packages.
7. **6.7 Change impact reviewer:** reviews every proposal for what it might break.
8. **6.8 Feature planner:** turns a feature request into steps on the map.
9. **6.9 Project guide:** answers "how does this project work?" for newcomers.
10. **6.10 Triggers and limits:** after an approval, after a task, or nightly, with runs-per-day limits.
11. **6.11 Conductor:** answers a question by sending several agents.
12. **6.12 Release test planner:** a "ready to deploy?" checklist.

---

## Phase 7: Finish the shell

1. **7.1 Project shapes:** several projects in one folder (switcher), multi-root workspaces, npm/yarn/pnpm
   workspaces (packages map), submodules.
2. **7.2 Plugin manager:** suggests the plugins a project needs and installs them in one click.
3. **7.3 Settings and health page:** everything in one place, errors in plain words.
4. **7.4 Performance:** smooth at about 5,000 files on 8 GB RAM.
5. **7.5 Other assistants:** Copilot and Cursor connect guides.
6. **7.6 First-run help:** a short tour for a new user.
7. **7.7 Publish:** both extensions published, merged to `main`, tagged.

---

## Then: the other plugins

Node.js + Express, SQL (Postgres, MySQL, SQLite, SQL Server), MongoDB; later Next.js, Prisma, Angular, NestJS,
Spring Boot and the rest.
