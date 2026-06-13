# crew-of-pi: Async Non-Blocking Subagent Orchestration Extension

## Rencana Kerja (Work Plan)

---

## 0. Ringkasan & Jawaban "Apakah Bisa?"

**BISA.** Semua 5 kebutuhan teknis bisa diimplementasikan di atas extension API pi. Berikut mapping:

| # | Requirement | Status | Approach |
|---|-------------|--------|----------|
| 1 | Main context bersih | ✅ Bisa | Subagent spawn isolated `pi` process (isolated context window) |
| 2 | Main tidak bisa tulis langsung | ✅ Bisa | Block `write`/`edit` di main agent via `tool_call` event; delegasikan ke subagent |
| 3 | Async non-blocking | ✅ Bisa | Subagent spawn via `spawn()` dengan `detached: true`; hasil dikirim via `sendMessage({ deliverAs: "steer" })` |
| 4 | Subagent saling bicara, main agent aware | ✅ Bisa | Message bus berbasis session entries; main agent di-notify via steering messages |
| 5 | Delegasi otomatis | ✅ Bisa | System prompt injection via `before_agent_start` + agent registry di `session_start` |

---

## 1. Arsitektur Umum

```
┌──────────────────────────────────────────────────────────────┐
│                    MAIN PI SESSION                           │
│                                                              │
│  ┌─────────────┐     ┌──────────────────────────────────┐   │
│  │  Main Agent  │────▶│  crew-of-pi Extension            │   │
│  │  (orchestrator)│   │                                  │   │
│  │  NO write/edit│   │  ┌─────────────────────────────┐  │   │
│  │  read-only    │   │  │ Subagent Manager            │  │   │
│  └─────────────┘   │  │  - spawn()                   │  │   │
│        ▲           │  │  - abort()                    │  │   │
│        │           │  │  - list()                     │  │   │
│   steering         │  │  - respond()                  │  │   │
│   messages         │  └─────────────────────────────┘  │   │
│   (results)        │              │                      │   │
│                    │              │ spawn()              │   │
│                    │              ▼                      │   │
│                    │  ┌─────────────────────────────┐   │   │
│                    │  │ Isolated PI Processes        │   │   │
│                    │  │                              │   │   │
│                    │  │  ┌────────┐  ┌────────────┐  │   │
│                    │  │  │ Worker │  │ Researcher │  │   │
│                    │  │  │ (edit) │  │ (research) │  │   │
│                    │  │  └────────┘  └────────────┘  │   │
│                    │  │  ┌────────┐  ┌────────────┐  │   │
│                    │  │  │ Scout  │  │  Reviewer  │  │   │
│                    │  │  │(search)│  │ (review)   │  │   │
│                    │  │  └────────┘  └────────────┘  │   │
│                    │  └─────────────────────────────┘   │   │
│                    └──────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Struktur File Extension

```
~/.pi/agent/extensions/crew-of-pi/
├── index.ts                 # Entry point, registers all tools & events
├── manager.ts               # Subagent lifecycle manager (spawn, abort, monitor)
├── agents.ts                # Agent discovery (from project, user, bundled)
├── bus.ts                   # Inter-subagent message bus
├── blockers.ts              # Blocks main agent write/edit/delete tools
├── prompts.ts               # System prompt injection for main agent awareness
├── widget.ts                # TUI status widget
├── types.ts                 # Type definitions
├── docs/
│   └── plan.md              # This file
├── agents/                  # Bundled subagent definitions
│   ├── worker.md            # General-purpose (full tools, cheap model)
│   ├── scout.md             # Fast codebase recon (read-only, cheap model)
│   ├── researcher.md        # Deep research (read + grep + find, medium model)
│   ├── reviewer.md          # Code review (read-only, medium model)
│   └── planner.md           # Implementation planning (read-only)
└── prompts/                 # Prompt templates
    ├── implement.md         # scout → planner → worker chain
    └── research.md          # researcher standalone
```

---

## 3. Detail Implementasi Per Kebutuhan

### 3.1 Main Context Windows Tetap Bersih

**Strategy:** Setiap subagent dijalankan sebagai isolated `pi` process dengan `--no-session --mode json -p`.

**Implementasi:**
- `manager.ts`: `spawnSubagent(agentName, task)` menggunakan `child_process.spawn()`
- Setiap spawn membuat process pi baru dengan konteks terisolasi
- Main agent hanya menerima hasil akhir sebagai steering message (bukan seluruh conversation history subagent)
- Subagent results disimpan di session entries (custom entry type `crew-subagent-result`) untuk persistence

```typescript
// manager.ts - spawn logic
const proc = spawn("pi", [
  "--mode", "json",
  "-p",
  "--no-session",
  "--model", agentConfig.model,
  "--tools", agentConfig.tools.join(","),
  // system prompt custom
], {
  cwd: ctx.cwd,
  stdio: ["ignore", "pipe", "pipe"],
});
```

**Isolasi konteks:**
- Tidak ada session sharing antara main agent dan subagent
- Subagent tidak menerima conversation history main agent
- Task diberikan sebagai prompt awal yang self-contained
- Hasil kembali sebagai text block pendek (bukan raw messages)

---

### 3.2 Main Agent Tidak Bisa Tulis Langsung

**Strategy:** Block semua write/edit/delete tool di main agent via `tool_call` event interceptor. Subagent workers menggunakan model lebih murah.

**Implementasi:**
- `blockers.ts`: Intercept `tool_call` event untuk built-in tools yang memodifikasi filesystem:

```typescript
// blockers.ts
const BLOCKED_MAIN_TOOLS = ["write", "edit"]; // bash? perlu dipikirkan

pi.on("tool_call", async (event, ctx) => {
  if (BLOCKED_MAIN_TOOLS.includes(event.toolName)) {
    return {
      block: true,
      reason: `Main agent is read-only. Delegate to a "worker" subagent via crew_spawn.`,
    };
  }
});
```

**Subagent pakai model murah:**
- `worker.md`: model `openai/gpt-4o-mini` atau `anthropic/claude-haiku-4-5` (murah)
- `scout.md`: model haiku (paling murah)
- Main agent tetap pakai model utama (mahal) untuk orchestration/thinking

**Cost comparison:**
| Role | Model | Est. Cost/token |
|------|-------|-----------------|
| Main Agent | claude-sonnet-4-5 | $$$ |
| Worker | claude-haiku-4-5 | $ |
| Scout | claude-haiku-4-5 | $ |
| Researcher | gpt-4o-mini | $ |

---

### 3.3 Async Non-Blocking

**Strategy:** Subagent di-spawn sebagai process detached. Hasil dikirim balik via `pi.sendMessage({ deliverAs: "steer" })`. Main agent bisa lanjut kerja sementara subagent berjalan.

**Implementasi:**

```typescript
// manager.ts
async spawnSubagent(agentName: string, task: string, ctx: ExtensionContext): Promise<string> {
  const id = generateId(); // crew-<agent>-<random>
  
  // 1. Simpan state ke session entry
  pi.appendEntry("crew-subagent-spawn", {
    id,
    agentName,
    task,
    status: "running",
    spawnedAt: Date.now(),
    ownerSession: ctx.sessionManager.getSessionFile(),
  });
  
  // 2. Spawn process (non-blocking)
  const proc = spawn("pi", [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  
  // 3. Stream processing in background (via async IIFE, tidak await)
  (async () => {
    // Parse JSON lines dari stdout
    // Kumpulkan messages
    // Ketika process close:
    const result = { id, agentName, output, usage, exitCode, ... };
    
    // 4. Kirim hasil sebagai steering message ke main session
    pi.sendMessage({
      customType: "crew-subagent-result",
      content: `Subagent **${agentName}** (${id}) completed:\n\n${output}`,
      display: true,
      details: result,
    }, {
      deliverAs: "steer",     // Kirim setelah current turn selesai
      triggerTurn: true,       // Trigger LLM response
    });
    
    // Update session entry
    pi.appendEntry("crew-subagent-result", result);
  })();
  
  return id; // Return immediately, tidak menunggu
}
```

**Key points:**
- Spawn adalah fire-and-forget dari perspektif main agent
- Main agent bisa menerima hasil di tengah pekerjaan lain via steering
- Multiple subagent bisa berjalan paralel
- Abort signal propagation via `ctx.signal`

---

### 3.4 Subagent Bisa Saling Berbicara & Main Agent Tetap Tahu

**Strategy:** Inter-subagent communication melalui message bus yang dipersist ke session entries. Semua komunikasi relay ke main agent sebagai notification.

**Implementasi:**

```typescript
// bus.ts
interface SubagentMessage {
  id: string;
  from: string;      // subagent id
  to: string;        // subagent id atau "main"
  type: "request" | "response" | "handoff" | "report";
  content: string;
  timestamp: number;
}

// Komunikasi antar subagent:
// 1. Subagent A selesai, hasil disimpan di bus
// 2. Subagent B membaca hasil A dari bus (via {previous} placeholder di chain)
// 3. Atau: Subagent A explicit call "respond to B" via tool

// Main agent awareness:
// Setiap kali subagent selesai atau komunikasi terjadi:
pi.sendMessage({
  customType: "crew-status",
  content: `📢 Subagent **${agentName}** (${id}) -> ${target}: "${summary}"`,
  display: true,
}, { deliverAs: "steer", triggerTurn: false });
```

**Pattern komunikasi:**

1. **Chain (sequential):** Subagent B menerima output A via `{previous}` placeholder
   ```
   scout -> planner -> worker
   ```
   Setiap step, output previous agent di-inject ke prompt next agent.

2. **Direct message:** Subagent bisa "call back" ke main atau subagent lain
   ```
   worker -> main: "Need clarification on design decision X"
   main -> worker: "Use pattern Y"
   ```

3. **Broadcast:** Main agent bisa broadcast ke semua running subagent
   ```
   main -> all: "Project convention: use tabs, not spaces"
   ```

**Session persistence:**
- Semua komunikasi dicatat sebagai custom entries di session
- Saat session reload/resume, state subagent direstore
- Widget menampilkan semua running subagent

---

### 3.5 Pendelegasian Otomatis oleh Main Agent

**Strategy:** Main agent secara otomatis tahu subagent apa yang tersedia dan role masing-masing melalui system prompt injection. Main agent memutuskan delegasi tanpa user intervention.

**Implementasi:**

```typescript
// prompts.ts
pi.on("before_agent_start", async (event, ctx) => {
  const discovery = discoverAgents(ctx.cwd, "both");
  const agents = discovery.agents;
  
  const agentList = agents.map(a => 
    `- **${a.name}**: ${a.description} (model: ${a.model}, tools: ${a.tools?.join(", ") || "all"})`
  ).join("\n");
  
  const systemPromptAddition = `
## Your Subagent Crew

You are a MAIN ORCHESTRATOR agent. You do NOT write or edit files directly.
Instead, you delegate implementation to your crew of specialized subagents.

### Available Subagents
${agentList}

### Rules
1. You CAN read, grep, find, ls, and bash (read-only) to understand the codebase.
2. You CANNOT write, edit, or modify files. Delegate to "worker" subagent instead.
3. For codebase investigation, delegate to "scout" (fast, cheap).
4. For deep research/analysis, delegate to "researcher".
5. For implementation planning, delegate to "planner".
6. For code review after changes, delegate to "reviewer".
7. Subagents run ASYNC in the background. You will be notified when they finish.
8. Use \`crew_spawn\` tool to spawn a subagent. Use \`crew_list\` to check status.
9. Use \`crew_abort\` to cancel a running subagent.
10. Chain subagents with \`crew_chain\` for sequential workflows.
`;

  return {
    systemPrompt: event.systemPrompt + systemPromptAddition,
  };
});
```

**Auto-delegation flow:**
```
User: "Buat fitur login dengan JWT"
  ↓
Main Agent (reads codebase struktur, tidak bisa write):
  1. crew_spawn("scout", "find all auth-related code") → async
  2. (menunggu scout selesai via steering, sambil bisa jawab pertanyaan lain)
  3. crew_spawn("planner", "plan JWT login implementation based on: {previous}") → async  
  4. crew_spawn("worker", "implement: {previous}") → async
  5. crew_spawn("reviewer", "review the implementation") → async
  6. Hasil akhir dikembalikan ke user
```

---

## 4. Tools yang Didaftarkan

### 4.1 `crew_spawn`
Spawn subagent tunggal, async non-blocking.

```typescript
parameters: {
  agent: string,        // Nama agent (worker, scout, researcher, dll)
  task: string,         // Task description
  model?: string,       // Override model
  interactive?: boolean, // Multi-turn mode
}
```

Return: `{ subagent_id: string, status: "spawned" }`

### 4.2 `crew_chain`
Chain sequential subagents. Output previous di-inject ke next via `{previous}`.

```typescript
parameters: {
  chain: Array<{ agent: string; task: string }>,
  stopOnError?: boolean,
}
```

Return: `{ chain_id: string, steps: number, status: "running" }`
Proses async; hasil tiap step dilaporkan via steering.

### 4.3 `crew_list`
List semua subagent definitions dan running subagents.

```typescript
parameters: {} // no params
```

Return: daftar available agents + running subagents dengan status.

### 4.4 `crew_abort`
Abort satu atau semua running subagents.

```typescript
parameters: {
  subagent_id?: string,
  all?: boolean,
}
```

### 4.5 `crew_respond`
Kirim follow-up ke interactive subagent.

```typescript
parameters: {
  subagent_id: string,
  message: string,
}
```

### 4.6 `crew_done`
Tutup interactive subagent session.

```typescript
parameters: {
  subagent_id: string,
}
```

---

## 5. Subagent Definitions (Bundled)

### 5.1 `worker.md`
```markdown
---
name: worker
description: General-purpose subagent with full write capabilities. Use for implementing code changes.
tools: read, write, edit, grep, find, ls, bash
model: anthropic/claude-haiku-4-5
interactive: false
---

You are a worker agent. Execute the assigned implementation task.
Use write/edit to make changes. Verify with read/bash.
Output format:
## Completed - what was done
## Files Changed - list with descriptions
## Notes - anything the orchestrator should know
```

### 5.2 `scout.md`
```markdown
---
name: scout
description: Fast codebase recon. Read-only. Returns structured findings.
tools: read, grep, find, ls, bash
model: anthropic/claude-haiku-4-5
interactive: false
---

[Sama dengan existing scout di pi subagent example]
```

### 5.3 `researcher.md`
```markdown
---
name: researcher
description: Deep codebase research and analysis. Read-only. For understanding architecture, patterns, and dependencies.
tools: read, grep, find, ls, bash
model: anthropic/claude-haiku-4-5
interactive: false
---

You are a researcher. Deep-dive into the codebase.
Output structured analysis: architecture, patterns, dependencies, data flow.
Use grep/find extensively, read key sections.
```

### 5.4 `reviewer.md`
```markdown
---
name: reviewer
description: Code review specialist. Read-only. Analyzes quality, security, and maintainability.
tools: read, grep, find, ls, bash
model: anthropic/claude-haiku-4-5
interactive: false
---

[Sama dengan existing reviewer]
```

### 5.5 `planner.md`
```markdown
---
name: planner
description: Implementation planner. Read-only. Creates step-by-step plans from context.
tools: read, grep, find, ls
model: anthropic/claude-haiku-4-5
interactive: false
---

[Sama dengan existing planner]
```

---

## 6. TUI Widget

Status widget menampilkan running subagents:

```
┌─ Crew ──────────────────────────────────────────────┐
│ 🟢 scout-abc123   [running]  2 turns  ctx:4.2k      │
│ 🟢 worker-def456  [running]  5 turns  ctx:12.1k     │
│ ✅ planner-ghi789 [done]     3 turns  $0.042        │
│ ❌ reviewer-jkl0  [error]    Aborted                │
└─────────────────────────────────────────────────────┘
```

Implementasi via `pi.ui.setWidget("crew-status", lines)` atau custom TUI component.

Update widget di:
- `crew_spawn` → add entry
- steering message (subagent complete) → update status
- `crew_abort` → update status
- `session_start` → restore widget dari session entries

---

## 7. Event Handling Flow

```
session_start
  ├── discover agents (user + project + bundled)
  ├── resolve extension paths & pi packages
  ├── restore running subagents dari session entries
  ├── pasang widget
  └── daftarkan tools

before_agent_start
  └── inject agent list + extensions info + instructions ke system prompt

tool_call (write/edit)
  └── BLOCK → "Delegate ke worker"

tool_call (crew_spawn)
  └── baca agentConfig.extensions
  └── build spawn args: --no-extensions + (--extension per ext)
  └── spawn subagent process (async, non-blocking)
  └── save ke session entries
  └── update widget
  └── return { subagent_id, status: "spawned" }

[BACKGROUND - subagent process events]
  ├── stdout JSON lines → kumpulkan messages, usage
  ├── process close →
  │   ├── simpan result ke session entries
  │   ├── pi.sendMessage({ deliverAs: "steer", triggerTurn: true })
  │   └── update widget
  └── process error → kirim error sebagai steering message

turn_end
  └── cek apakah ada pending steering messages dari subagent
  └── jika ya, LLM akan merespons di turn berikutnya

session_shutdown
  └── abort semua running subagents
  └── cleanup resources
```

---

## 8. Inter-Subagent Communication Detail

### Chain Mode (Sequential)
```
Main: crew_chain([
  { agent: "scout", task: "find auth code" },
  { agent: "planner", task: "plan based on: {previous}" },
  { agent: "worker", task: "implement: {previous}" },
])
```

Setiap step:
1. Step N spawn subagent dengan task + output step N-1
2. Step N selesai → output disimpan di bus
3. Step N+1 di-spawn dengan `{previous}` di-replace output step N
4. Setiap step completion di-notifikasi ke main via steering
5. Jika step gagal dan `stopOnError: true`, chain berhenti

### Direct Communication
```
worker-abc: "I need to know the database schema"
  → crew_respond_main("worker-abc", "Need DB schema")
  → Main agent sees steering message
  → Main: crew_respond("worker-abc", "Schema is in db/schema.ts")
  → worker-abc receives response, continues
```

### Broadcast
```
Main: crew_broadcast("All workers: use camelCase for variables")
  → Semua running workers receive message
  → Disimpan di bus
  → Worker berikutnya aware
```

---

## 9. Session Persistence

Semua state disimpan via `pi.appendEntry()`:

| Entry Type | Data | Purpose |
|------------|------|---------|
| `crew-subagent-spawn` | { id, agentName, task, status, spawnedAt, pid } | Track running subagent |
| `crew-subagent-result` | { id, output, usage, exitCode, completedAt } | Persist results |
| `crew-bus-message` | { id, from, to, type, content, timestamp } | Inter-subagent messages |

Saat `session_start`:
- Scan semua entries
- Subagent dengan status "running" → cek apakah process masih hidup
- Jika process mati tanpa result → tandai sebagai "orphaned"
- Restore widget state

---

## 10. Security Considerations

1. **Project-local agents** (`.pi/agents/*.md`) hanya load untuk trusted projects
2. **Konfirmasi interaktif** sebelum menjalankan project agents pertama kali
3. **Subagent process** inherit cwd dari main session
4. **No network isolation** - subagent bisa akses network sama seperti main
5. **File write** hanya oleh worker subagent, tapi tetap bisa write apa saja di filesystem

---

## 11. Timeline Implementasi

| Fase | Durasi | Tasks |
|------|--------|-------|
| **Phase 0: Scaffold** | Hari 1 | Setup vertical slice structure, `shared/types.ts`, `index.ts` assembly skeleton |
| **Phase 1: Agents** | Hari 1-2 | `slices/agents/` — discovery, frontmatter parsing, extension resolver, registry |
| **Phase 2: Spawn** | Hari 2-3 | `slices/spawn/` — `crew_spawn` tool, `--no-extensions` flag, extension injection, async manager |
| **Phase 3: Blockers + Prompt** | Hari 3-4 | `slices/blockers/` — write/edit intercept, `slices/prompt/` — system prompt injection with agent awareness |
| **Phase 4: Chain + Comms** | Hari 4-5 | `slices/chain/` — sequential workflow, `{previous}`, `slices/comms/` — message bus & relay |
| **Phase 5: Lifecycle** | Hari 5-6 | `slices/lifecycle/` — `crew_abort`, `crew_respond`, `crew_done` |
| **Phase 6: Widget + Polish** | Hari 6-7 | `slices/widget/` — TUI widget, session persistence, error handling, testing |

---

## 12. File Dependencies (Vertical Slice)

```
index.ts  (hanya assembly)
  ├── shared/types.ts          ← semua slice import dari sini
  │
  ├── slices/agents/           ← agent discovery + extension resolver
  │   └── dipakai oleh: spawn, chain, prompt
  │
  ├── slices/spawn/            ← crew_spawn tool + process manager
  │   └── dependensi: agents (baca config), comms (kirim hasil)
  │
  ├── slices/chain/            ← crew_chain tool
  │   └── dependensi: spawn (spawn per step), comms (relay progress)
  │
  ├── slices/blockers/         ← tool_call intercept (write/edit block)
  │   └── no dependensi internal
  │
  ├── slices/prompt/           ← system prompt injection
  │   └── dependensi: agents (baca agent list)
  │
  ├── slices/comms/            ← message bus antar agent + relay ke main
  │   └── no dependensi internal
  │
  ├── slices/lifecycle/        ← abort, respond, done tools
  │   └── dependensi: spawn (abort process), comms (relay messages)
  │
  └── slices/widget/           ← TUI status display
      └── dependensi: spawn (baca running agents), comms (status updates)
```

**Aturan import:**
- ✅ `import { SubagentHandle } from "../../shared/types"`
- ✅ `import { AgentConfig } from "../agents/agents.types"` (specific type import)
- ❌ `import { spawnSubagent } from "../spawn/spawn.manager"` (cross-slice runtime import)
- ✅ Cross-slice runtime communication via shared event bus di `shared/types`

---

## 13. Next Steps

1. ✅ **Plan written** (this file)
2. ⬜ **Phase 0**: Scaffold vertical slice folder structure + shared types
3. ⬜ **Phase 1**: Agent discovery + frontmatter parser + extension resolver (`--no-extensions` + per-agent extensions)
4. ⬜ **Phase 2**: Spawn slice — async non-blocking, steering results, `--no-extensions` default
5. ⬜ **Phase 3**: Blockers (write/edit intercept) + Prompt (system injection with agent awareness)
6. ⬜ **Phase 4**: Chain + Comms — sequential workflow + inter-agent message bus
7. ⬜ **Phase 5**: Lifecycle tools (abort/respond/done)
8. ⬜ **Phase 6**: Widget + session persistence + polish + testing

---

## 14. Key Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Vertical slice architecture | Setiap fitur self-contained, mudah di-test, mudah dihapus/diganti. Cocok untuk iterasi cepat. |
| 2 | `--no-extensions` default di subagent | Mencegah endless spawning + subagent tidak mewarisi blockers (agar bisa write/edit). Extension hanya di-load jika explicit diminta. |
| 3 | Extension per-agent via frontmatter | Berbeda agent bisa punya kapabilitas berbeda. Scout tidak perlu git-checkpoint, worker perlu. Support path-based & pi-package. |
| 4 | Steering messages (`deliverAs: "steer"`) | Main agent tetap aware tanpa blocking. Hasil subagent muncul sebagai "interrupt" yang triggering LLM response baru. |
| 5 | Session entry persistence | Semua state subagent disimpan. Session bisa di-resume tanpa kehilangan running subagents. |
| 6 | Shared types sebagai kontrak antar slice | Mencegah tight coupling. Setiap slice hanya import types dari slice lain, bukan runtime code. |
