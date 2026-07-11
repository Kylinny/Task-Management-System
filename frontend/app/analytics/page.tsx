"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, BarChart3, RefreshCcw } from "lucide-react";
import { ProjectProgressDashboard, getProjectMetrics } from "@/lib/api";

export default function AnalyticsPage() {
  const [dashboard, setDashboard] = useState<ProjectProgressDashboard | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void loadMetrics();
  }, []);

  async function loadMetrics() {
    try {
      setError("");
      setIsLoading(true);
      setDashboard(await getProjectMetrics());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load analytics");
    } finally {
      setIsLoading(false);
    }
  }

  const projects = dashboard?.projects ?? [];
  const completionPercent = overallCompletionPercent(dashboard);

  return (
    <main className="app-shell analytics-shell">
      <aside className="sidebar">
        <div className="brand">
          <h1>HappyRobot Task Management</h1>
          <p>Collaborative project boards for tracking work, blockers, and team discussion.</p>
        </div>

        <Link className="analytics-card-link active" href="/analytics">
          <span>
            <BarChart3 size={16} />
            Monitoring analytics
          </span>
          <small>Project health, blockers, and progress overview</small>
        </Link>

        <Link className="workspace-link" href="/">
          <ArrowLeft size={15} />
          Back to task board
        </Link>
      </aside>

      <section className="analytics-main">
        <header className="analytics-hero">
          <div>
            <p className="eyebrow">Monitoring analytics</p>
            <h2>Project progress dashboard</h2>
            <p>High-level operational view across active projects, computed from backend aggregate metrics.</p>
          </div>
          <button className="button secondary" type="button" onClick={() => void loadMetrics()} disabled={isLoading}>
            <RefreshCcw size={16} />
            {isLoading ? "Refreshing..." : "Refresh"}
          </button>
        </header>

        {error ? <p className="error">{error}</p> : null}

        <section className="metrics-panel analytics-overview">
          <div className="metric-grid">
            <article className="metric-card">
              <span>Active projects</span>
              <strong>{dashboard?.totalProjects ?? 0}</strong>
              <small>{dashboard?.archivedProjects ?? 0} archived</small>
            </article>
            <article className="metric-card">
              <span>Total tasks</span>
              <strong>{dashboard?.totalTasks ?? 0}</strong>
              <small>{dashboard?.statusCounts.inProgress ?? 0} in progress</small>
            </article>
            <article className="metric-card">
              <span>Done rate</span>
              <strong>{formatPercent(completionPercent)}</strong>
              <small>{dashboard?.statusCounts.done ?? 0} done</small>
            </article>
            <article className="metric-card">
              <span>Blocked</span>
              <strong>{dashboard?.statusCounts.blocked ?? 0}</strong>
              <small>{formatPercent(dashboard?.totalTasks ? (dashboard.statusCounts.blocked / dashboard.totalTasks) * 100 : 0)} of tasks</small>
            </article>
            <article className="metric-card">
              <span>Comments</span>
              <strong>{dashboard?.totalComments ?? 0}</strong>
              <small>Across active projects</small>
            </article>
          </div>
        </section>

        <section className="analytics-grid">
          <article className="analytics-panel">
            <div>
              <p className="eyebrow">Status distribution</p>
              <h3>Where work sits now</h3>
            </div>
            <div className="status-bars">
              <StatusBar label="Todo" count={dashboard?.statusCounts.todo ?? 0} total={dashboard?.totalTasks ?? 0} />
              <StatusBar label="In progress" count={dashboard?.statusCounts.inProgress ?? 0} total={dashboard?.totalTasks ?? 0} />
              <StatusBar label="Blocked" count={dashboard?.statusCounts.blocked ?? 0} total={dashboard?.totalTasks ?? 0} />
              <StatusBar label="Done" count={dashboard?.statusCounts.done ?? 0} total={dashboard?.totalTasks ?? 0} />
            </div>
          </article>

          <article className="analytics-panel wide">
            <div>
              <p className="eyebrow">Project health</p>
              <h3>Active projects</h3>
            </div>
            <div className="project-progress-list">
              {projects.map((item) => (
                <div className="project-progress-row analytics-row" key={item.projectId}>
                  <div className="progress-copy">
                    <strong>{item.name}</strong>
                    <span>{item.description || "No description"}</span>
                  </div>
                  <div className="progress-track" aria-label={`${item.name} completion ${formatPercent(item.completionPercent)}`}>
                    <span style={{ width: `${clampPercent(item.completionPercent)}%` }} />
                  </div>
                  <div className="progress-meta">
                    <span>{formatPercent(item.completionPercent)} done</span>
                    <span>{item.statusCounts.blocked} blocked</span>
                    <span>{item.commentCount} comments</span>
                  </div>
                </div>
              ))}
              {projects.length === 0 ? <div className="empty compact">No active projects to summarize yet.</div> : null}
            </div>
          </article>
        </section>
      </section>
    </main>
  );
}

function StatusBar({ count, label, total }: { count: number; label: string; total: number }) {
  const percent = total === 0 ? 0 : (count / total) * 100;
  return (
    <div className="status-bar">
      <div>
        <strong>{label}</strong>
        <span>
          {count} task{count === 1 ? "" : "s"}
        </span>
      </div>
      <div className="progress-track">
        <span style={{ width: `${clampPercent(percent)}%` }} />
      </div>
      <small>{formatPercent(percent)}</small>
    </div>
  );
}

function formatPercent(value: number) {
  return `${Math.round(value)}%`;
}

function clampPercent(value: number) {
  return Math.min(100, Math.max(0, value));
}

function overallCompletionPercent(dashboard: ProjectProgressDashboard | null) {
  if (!dashboard || dashboard.totalTasks === 0) {
    return 0;
  }
  return (dashboard.statusCounts.done / dashboard.totalTasks) * 100;
}
