/**
 * api/routes/dashboard.ts
 *
 * Serves the live status dashboard HTML.
 * Available at http://127.0.0.1:3747/dashboard
 *
 * Auto-refreshes every 5 seconds via Server-Sent Events.
 * Shows agent health, task pipeline, event log tail, efficiency metrics.
 */

import { Router, type Request, type Response } from "express";
import type { Orchestrator } from "../../core/orchestrator.js";
import type { EfficiencyTracker } from "../../core/efficiency-tracker.js";

export function dashboardRouter(
  orchestrator: Orchestrator,
  efficiency?: EfficiencyTracker
): Router {
  const router = Router();

  // ─── SSE stream ────────────────────────────────────────────────────────────

  router.get("/stream", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    const send = async () => {
      try {
        const store = orchestrator.getStore();
        const snapshots = orchestrator.getSnapshots();

        const [tasks, agents, project] = await Promise.all([
          snapshots.readTasksSnapshot(),
          snapshots.readAgentsSnapshot(),
          snapshots.readProjectSnapshot(),
        ]);

        const recentEvents = await store.readLastEvents(10);

        const payload = JSON.stringify({
          eventLogVersion: store.version,
          tasks: tasks?.byStatus ?? {},
          criticalPath: tasks?.criticalPath?.slice(0, 5) ?? [],
          agents: agents?.agents ?? {},
          project: project
            ? {
                goal: project.goal,
                currentMilestone: project.currentMilestone,
                openTaskCount: project.openTaskCount,
                completedTaskCount: project.completedTaskCount,
                blockedTaskCount: project.blockedTaskCount,
                lastCheckpointAt: project.lastCheckpointAt,
              }
            : null,
          recentEvents: recentEvents.slice(-5).map((e) => ({
            eventId: e.eventId.slice(0, 8),
            eventType: e.eventType,
            actor: e.actor,
            taskId: e.taskId,
            timestamp: e.timestamp,
          })),
          timestamp: new Date().toISOString(),
        });

        res.write(`data: ${payload}\n\n`);
      } catch {
        // Ignore errors — client will reconnect
      }
    };

    // Send immediately then poll
    void send();
    const interval = setInterval(() => void send(), 5000);

    req.on("close", () => {
      clearInterval(interval);
    });
  });

  // ─── Dashboard HTML ────────────────────────────────────────────────────────

  router.get("/", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(DASHBOARD_HTML);
  });

  return router;
}

// ─── Dashboard HTML ────────────────────────────────────────────────────────────

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Duostack</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@300;400;500&display=swap');

  :root {
    --bg: #0a0a0f;
    --surface: #12121a;
    --border: #1e1e2e;
    --border-bright: #2d2d42;
    --text: #e2e0f0;
    --text-muted: #6e6a8a;
    --text-dim: #3d3a55;
    --claude: #7c6af7;
    --claude-dim: #2d2860;
    --ag: #f7b46a;
    --ag-dim: #3d2a0a;
    --green: #5af7a4;
    --green-dim: #0a2d1e;
    --red: #f75a6a;
    --red-dim: #2d0a10;
    --amber: #f7d86a;
    --mono: 'IBM Plex Mono', monospace;
    --sans: 'IBM Plex Sans', sans-serif;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--sans);
    font-size: 13px;
    line-height: 1.5;
    min-height: 100vh;
    padding: 24px;
  }

  .header {
    display: flex;
    align-items: baseline;
    gap: 16px;
    margin-bottom: 24px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border);
  }

  .logo {
    font-family: var(--mono);
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.5px;
    color: var(--text);
  }

  .logo span { color: var(--claude); }

  .status-dot {
    width: 7px; height: 7px;
    border-radius: 50%;
    background: var(--green);
    display: inline-block;
    animation: pulse 2s ease-in-out infinite;
  }

  .status-dot.offline { background: var(--red); animation: none; }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .meta {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-muted);
    margin-left: auto;
  }

  .grid {
    display: grid;
    grid-template-columns: 280px 1fr;
    grid-template-rows: auto auto;
    gap: 16px;
  }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
  }

  .card-title {
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin-bottom: 14px;
  }

  /* Agent cards */
  .agent {
    padding: 12px;
    border-radius: 6px;
    border: 1px solid var(--border);
    margin-bottom: 10px;
  }

  .agent:last-child { margin-bottom: 0; }

  .agent.claude { border-color: var(--claude-dim); background: rgba(124,106,247,0.05); }
  .agent.antigravity { border-color: var(--ag-dim); background: rgba(247,180,106,0.05); }
  .agent.unavailable { opacity: 0.5; }

  .agent-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }

  .agent-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
  }

  .claude .agent-dot { background: var(--claude); }
  .antigravity .agent-dot { background: var(--ag); }
  .unavailable .agent-dot { background: var(--text-dim); }

  .agent-name {
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 500;
  }

  .agent-role {
    font-size: 11px;
    color: var(--text-muted);
    margin-left: auto;
  }

  .health-bar {
    height: 3px;
    border-radius: 2px;
    background: var(--border);
    overflow: hidden;
  }

  .health-fill {
    height: 100%;
    border-radius: 2px;
    transition: width 0.5s ease;
  }

  .health-fill.normal { background: var(--green); width: 100%; }
  .health-fill.batching { background: var(--amber); width: 70%; }
  .health-fill.triage { background: var(--amber); width: 40%; }
  .health-fill.final_flush { background: var(--red); width: 15%; }
  .health-fill.exhausted { background: var(--red); width: 5%; }
  .health-fill.unknown { background: var(--text-dim); width: 30%; }

  .health-label {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--text-muted);
    margin-top: 5px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .lease-info {
    margin-top: 8px;
    font-family: var(--mono);
    font-size: 10px;
    color: var(--text-muted);
  }

  /* Task pipeline */
  .pipeline {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 8px;
  }

  .pipeline-col {
    background: rgba(255,255,255,0.02);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px;
    min-height: 80px;
  }

  .pipeline-label {
    font-family: var(--mono);
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-dim);
    margin-bottom: 8px;
  }

  .pipeline-count {
    font-family: var(--mono);
    font-size: 28px;
    font-weight: 600;
    line-height: 1;
    margin-bottom: 4px;
  }

  .pipeline-count.pending { color: var(--text-muted); }
  .pipeline-count.claimed { color: var(--claude); }
  .pipeline-count.in_progress { color: var(--ag); }
  .pipeline-count.blocked { color: var(--red); }
  .pipeline-count.handoff { color: var(--amber); }
  .pipeline-count.completed { color: var(--green); }

  /* Project info */
  .project-goal {
    font-size: 14px;
    font-weight: 400;
    color: var(--text);
    margin-bottom: 8px;
    line-height: 1.4;
  }

  .milestone {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--claude);
    margin-bottom: 12px;
  }

  .stats-row {
    display: flex;
    gap: 20px;
    margin-top: 12px;
  }

  .stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .stat-value {
    font-family: var(--mono);
    font-size: 20px;
    font-weight: 600;
    color: var(--text);
  }

  .stat-label {
    font-size: 10px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  /* Event log */
  .event-log {
    grid-column: 1 / -1;
  }

  .event-row {
    display: grid;
    grid-template-columns: 80px 200px 80px 1fr;
    gap: 12px;
    padding: 7px 0;
    border-bottom: 1px solid var(--border);
    font-family: var(--mono);
    font-size: 11px;
    align-items: center;
    animation: fadeIn 0.3s ease;
  }

  .event-row:last-child { border-bottom: none; }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .event-id { color: var(--text-dim); }

  .event-type { color: var(--text); font-weight: 500; }
  .event-type.task { color: var(--ag); }
  .event-type.agent { color: var(--claude); }
  .event-type.project { color: var(--green); }
  .event-type.step { color: var(--amber); }

  .event-actor { color: var(--text-muted); }
  .event-actor.claude { color: var(--claude); }
  .event-actor.antigravity { color: var(--ag); }

  .event-taskid { color: var(--text-dim); }

  .version-badge {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--text-dim);
    padding: 2px 6px;
    border: 1px solid var(--border);
    border-radius: 3px;
  }

  .checkpoint-row {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--text-muted);
    padding: 5px 0;
    font-style: italic;
  }

  /* Full width project + pipeline */
  .top-row {
    grid-column: 2;
  }

  .agents-col {
    grid-row: 1 / 3;
  }
</style>
</head>
<body>

<div class="header">
  <div class="logo">duo<span>stack</span></div>
  <span class="status-dot" id="dot"></span>
  <span class="meta" id="version">connecting...</span>
</div>

<div class="grid">

  <!-- Agents column -->
  <div class="card agents-col">
    <div class="card-title">Agents</div>
    <div id="agents-container">
      <div class="agent claude">
        <div class="agent-header">
          <div class="agent-dot"></div>
          <div class="agent-name">Claude Desktop</div>
          <div class="agent-role">planner</div>
        </div>
        <div class="health-bar"><div class="health-fill unknown"></div></div>
        <div class="health-label">connecting...</div>
      </div>
      <div class="agent antigravity">
        <div class="agent-header">
          <div class="agent-dot"></div>
          <div class="agent-name">Antigravity</div>
          <div class="agent-role">executor</div>
        </div>
        <div class="health-bar"><div class="health-fill unknown"></div></div>
        <div class="health-label">connecting...</div>
      </div>
    </div>

    <!-- Project info -->
    <div style="margin-top: 20px;">
      <div class="card-title">Project</div>
      <div class="project-goal" id="project-goal">—</div>
      <div class="milestone" id="project-milestone">No milestone set</div>
      <div class="stats-row">
        <div class="stat">
          <div class="stat-value" id="stat-open">—</div>
          <div class="stat-label">Open</div>
        </div>
        <div class="stat">
          <div class="stat-value" id="stat-done">—</div>
          <div class="stat-label">Done</div>
        </div>
        <div class="stat">
          <div class="stat-value" id="stat-blocked">—</div>
          <div class="stat-label">Blocked</div>
        </div>
      </div>
    </div>
  </div>

  <!-- Task pipeline -->
  <div class="card top-row">
    <div class="card-title">Task pipeline</div>
    <div class="pipeline">
      <div class="pipeline-col">
        <div class="pipeline-label">Pending</div>
        <div class="pipeline-count pending" id="count-pending">—</div>
      </div>
      <div class="pipeline-col">
        <div class="pipeline-label">Claimed</div>
        <div class="pipeline-count claimed" id="count-claimed">—</div>
      </div>
      <div class="pipeline-col">
        <div class="pipeline-label">In progress</div>
        <div class="pipeline-count in_progress" id="count-inprogress">—</div>
      </div>
      <div class="pipeline-col">
        <div class="pipeline-label">Blocked</div>
        <div class="pipeline-count blocked" id="count-blocked">—</div>
      </div>
      <div class="pipeline-col">
        <div class="pipeline-label">Handoff</div>
        <div class="pipeline-count handoff" id="count-handoff">—</div>
      </div>
      <div class="pipeline-col">
        <div class="pipeline-label">Completed</div>
        <div class="pipeline-count completed" id="count-completed">—</div>
      </div>
    </div>
  </div>

  <!-- Event log -->
  <div class="card event-log">
    <div class="card-title">Recent events</div>
    <div id="event-log-rows">
      <div class="checkpoint-row">Waiting for events...</div>
    </div>
  </div>

</div>

<script>
  const es = new EventSource('/dashboard/stream');

  function eventCategory(type) {
    if (type.startsWith('Task')) return 'task';
    if (type.startsWith('Agent')) return 'agent';
    if (type.startsWith('Project')) return 'project';
    if (type.includes('Step')) return 'step';
    return '';
  }

  function agentClass(actor) {
    if (actor === 'claude') return 'claude';
    if (actor === 'antigravity') return 'antigravity';
    return '';
  }

  function renderAgent(id, agent) {
    const health = agent?.health ?? 'unknown';
    const status = agent?.status ?? 'unknown';
    const isUnavailable = status === 'unavailable';
    const role = agent?.isInFallbackMode
      ? (id === 'claude' ? 'fallback exec' : 'fallback planner')
      : (id === 'claude' ? 'planner' : 'executor');

    const lease = agent?.activeLease;
    const leaseHtml = lease
      ? \`<div class="lease-info">lease: \${lease.taskId} · exp \${new Date(lease.expiresAt).toLocaleTimeString()}</div>\`
      : '';

    return \`
      <div class="agent \${id} \${isUnavailable ? 'unavailable' : ''}">
        <div class="agent-header">
          <div class="agent-dot"></div>
          <div class="agent-name">\${id === 'claude' ? 'Claude Desktop' : 'Antigravity'}</div>
          <div class="agent-role">\${role}</div>
        </div>
        <div class="health-bar"><div class="health-fill \${health}"></div></div>
        <div class="health-label">\${health} · \${status}</div>
        \${leaseHtml}
      </div>
    \`;
  }

  function renderEvent(e) {
    const cat = eventCategory(e.eventType);
    const time = new Date(e.timestamp).toLocaleTimeString();
    return \`
      <div class="event-row">
        <span class="event-id">\${e.eventId}</span>
        <span class="event-type \${cat}">\${e.eventType}</span>
        <span class="event-actor \${agentClass(e.actor)}">\${e.actor}</span>
        <span class="event-taskid">\${e.taskId ?? '—'}</span>
      </div>
    \`;
  }

  es.onmessage = (ev) => {
    const data = JSON.parse(ev.data);

    // Header
    document.getElementById('dot').className = 'status-dot';
    document.getElementById('version').textContent = 'v' + data.eventLogVersion + ' events · ' + new Date(data.timestamp).toLocaleTimeString();

    // Agents
    const agHtml = ['claude', 'antigravity']
      .map(id => renderAgent(id, data.agents[id]))
      .join('');
    document.getElementById('agents-container').innerHTML = agHtml;

    // Project
    if (data.project) {
      document.getElementById('project-goal').textContent = data.project.goal || '—';
      document.getElementById('project-milestone').textContent = data.project.currentMilestone || 'No milestone set';
      document.getElementById('stat-open').textContent = data.project.openTaskCount ?? '—';
      document.getElementById('stat-done').textContent = data.project.completedTaskCount ?? '—';
      document.getElementById('stat-blocked').textContent = data.project.blockedTaskCount ?? '—';
    }

    // Pipeline
    const bs = data.tasks;
    document.getElementById('count-pending').textContent = (bs.pending ?? []).length;
    document.getElementById('count-claimed').textContent = (bs.claimed ?? []).length;
    document.getElementById('count-inprogress').textContent = (bs.in_progress ?? []).length;
    document.getElementById('count-blocked').textContent = (bs.blocked ?? []).length;
    document.getElementById('count-handoff').textContent = (bs.handoff_pending ?? []).length;
    document.getElementById('count-completed').textContent = (bs.completed ?? []).length;

    // Events
    if (data.recentEvents?.length) {
      document.getElementById('event-log-rows').innerHTML =
        data.recentEvents.map(renderEvent).join('');
    }
  };

  es.onerror = () => {
    document.getElementById('dot').className = 'status-dot offline';
    document.getElementById('version').textContent = 'disconnected';
  };
</script>
</body>
</html>`;
