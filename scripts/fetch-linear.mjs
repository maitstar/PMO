#!/usr/bin/env node
// fetch-linear.mjs — pulls issues, projects, teams from Linear → data/linear-data.json

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = resolve(__dir, '..');

// ── Load API key from .env ──────────────────────────────────────────────────
function loadEnv() {
  try {
    const raw = readFileSync(resolve(ROOT, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const [k, ...v] = line.trim().split('=');
      if (k && v.length) process.env[k] = v.join('=');
    }
  } catch {}
}
loadEnv();

const API_KEY = process.env.LINEAR_API_KEY;
if (!API_KEY) { console.error('❌  LINEAR_API_KEY not set in .env'); process.exit(1); }

// ── GraphQL helper ──────────────────────────────────────────────────────────
async function gql(query, variables = {}) {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': API_KEY,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    console.error('GraphQL errors:', JSON.stringify(json.errors, null, 2));
    throw new Error(json.errors[0].message);
  }
  return json.data;
}

// ── Queries ─────────────────────────────────────────────────────────────────
const ISSUES_QUERY = `
  query Issues($after: String) {
    issues(
      first: 250
      after: $after
      orderBy: updatedAt
      filter: { state: { type: { nin: ["cancelled"] } } }
    ) {
      nodes {
        id
        title
        priority
        priorityLabel
        state { name type }
        assignee { name displayName }
        dueDate
        completedAt
        createdAt
        startedAt
        project {
          id
          name
          targetDate
          startDate
          progress
        }
        labels { nodes { name color } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const PROJECTS_QUERY = `
  query {
    projects(first: 50, orderBy: updatedAt) {
      nodes {
        id
        name
        description
        progress
        targetDate
        startDate
        status { type name }
        completedIssueCountHistory
        issueCountHistory
        members { nodes { name displayName } }
        lead { name displayName }
      }
    }
  }
`;

const TEAMS_QUERY = `
  query {
    teams(first: 20) {
      nodes {
        id
        name
        members { nodes { id name displayName } }
      }
    }
  }
`;

const VIEWER_QUERY = `
  query {
    viewer { id name displayName organization { name } }
  }
`;

// ── Fetch all issues (paginated) ────────────────────────────────────────────
async function fetchAllIssues() {
  const all = [];
  let after = null;
  let page  = 1;

  while (true) {
    console.log(`  Fetching issues page ${page}…`);
    const data = await gql(ISSUES_QUERY, after ? { after } : {});
    const { nodes, pageInfo } = data.issues;
    all.push(...nodes);
    if (!pageInfo.hasNextPage) break;
    after = pageInfo.endCursor;
    page++;
  }

  console.log(`  ✓ ${all.length} issues fetched`);
  return all;
}

// ── Derive metrics from raw data ────────────────────────────────────────────
function deriveMetrics(issues, projects) {
  const today = new Date();
  const year  = today.getFullYear();

  // ── Completion % by month (year-to-date + forward using project.progress) ──
  const totalIssues = issues.length;
  const completionByMonth = Array.from({ length: 12 }, (_, i) => {
    const monthEnd = new Date(year, i + 1, 0, 23, 59, 59);
    const completed = issues.filter(iss => {
      if (!iss.completedAt) return false;
      return new Date(iss.completedAt) <= monthEnd;
    }).length;
    const created = issues.filter(iss => new Date(iss.createdAt) <= monthEnd).length;
    return {
      planned: null,  // filled below from project target dates
      actual:  created > 0 ? Math.round((completed / created) * 100) : null,
    };
  });

  // Planned: linear ramp from 0 → 100% between earliest start and latest target
  const starts  = projects.map(p => p.startDate).filter(Boolean).map(d => new Date(d));
  const targets = projects.map(p => p.targetDate).filter(Boolean).map(d => new Date(d));
  const planStart  = starts.length  ? new Date(Math.min(...starts))  : new Date(year, 0, 1);
  const planEnd    = targets.length ? new Date(Math.max(...targets))  : new Date(year, 11, 31);
  const planRange  = planEnd - planStart;

  for (let i = 0; i < 12; i++) {
    const monthMid = new Date(year, i, 15);
    if (monthMid < planStart) {
      completionByMonth[i].planned = 0;
    } else if (monthMid > planEnd) {
      completionByMonth[i].planned = 100;
    } else {
      completionByMonth[i].planned = Math.round(((monthMid - planStart) / planRange) * 100);
    }
  }

  // Predicted: current velocity projected forward
  // velocity = issues completed in last 30 days / 30 * 30
  const last30 = new Date(today - 30 * 86400000);
  const recentCompleted = issues.filter(i => i.completedAt && new Date(i.completedAt) >= last30).length;
  const velocity = recentCompleted / 30; // issues per day

  const completedSoFar = issues.filter(i => i.completedAt).length;
  for (let i = 0; i < 12; i++) {
    const monthMid  = new Date(year, i, 15);
    const daysAhead = (monthMid - today) / 86400000;
    if (monthMid <= today) {
      completionByMonth[i].predicted = completionByMonth[i].actual;
    } else {
      const projected = completedSoFar + (velocity * daysAhead);
      completionByMonth[i].predicted = Math.min(100, Math.round((projected / totalIssues) * 100));
    }
  }

  // Null out future actuals (months not yet complete)
  for (let i = 0; i < 12; i++) {
    const monthEnd = new Date(year, i + 1, 0);
    if (monthEnd > today) completionByMonth[i].actual = null;
  }

  // ── Resource allocation: active issues per project (current snapshot) ──────
  const activeIssues = issues.filter(i => i.state.type === 'started');
  const projectCounts = {};
  activeIssues.forEach(iss => {
    const key = iss.project?.name || 'Unassigned';
    projectCounts[key] = (projectCounts[key] || 0) + 1;
  });
  const totalActive = activeIssues.length || 1;
  const resourceAllocation = Object.entries(projectCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, count]) => ({ name, count, pct: Math.round((count / totalActive) * 100) }));

  // ── Risk snapshot ──────────────────────────────────────────────────────────
  const openIssues = issues.filter(i => i.state.type !== 'completed' && i.state.type !== 'cancelled');

  const highRisk = openIssues.filter(iss =>
    iss.priority <= 1 ||  // Urgent
    (iss.priority === 2 && iss.dueDate && new Date(iss.dueDate) < today)  // High + overdue
  );
  const mediumRisk = openIssues.filter(iss =>
    !highRisk.includes(iss) && (
      (iss.priority === 2 && !iss.assignee) ||
      (iss.priority === 3 && iss.dueDate && new Date(iss.dueDate) < today)
    )
  );
  const lowRisk = openIssues.filter(iss =>
    !highRisk.includes(iss) && !mediumRisk.includes(iss) &&
    iss.dueDate &&
    new Date(iss.dueDate) > today &&
    (new Date(iss.dueDate) - today) < 21 * 86400000 &&
    iss.state.type !== 'started'
  );

  // ── Load balance per assignee ──────────────────────────────────────────────
  const assigneeMap = {};
  openIssues.forEach(iss => {
    const name = iss.assignee?.name || iss.assignee?.displayName || 'Unassigned';
    if (!assigneeMap[name]) assigneeMap[name] = { active: 0, p1: 0, total: 0 };
    assigneeMap[name].total++;
    if (iss.state.type === 'started') assigneeMap[name].active++;
    if (iss.priority <= 2) assigneeMap[name].p1++;
  });

  const loadBalance = Object.entries(assigneeMap)
    .sort((a, b) => b[1].active - a[1].active)
    .map(([name, stats]) => ({ name, ...stats }));

  // ── Milestone-style: projects summary ─────────────────────────────────────
  const projectSummary = projects
    .filter(p => p.targetDate)
    .sort((a, b) => new Date(a.targetDate) - new Date(b.targetDate))
    .map(p => {
      const daysLeft = Math.ceil((new Date(p.targetDate) - today) / 86400000);
      const projIssues = issues.filter(i => i.project?.id === p.id);
      const open   = projIssues.filter(i => i.state.type !== 'completed').length;
      const total  = projIssues.length;
      const p1Open = projIssues.filter(i => i.priority <= 2 && i.state.type !== 'completed').length;
      return {
        id: p.id,
        name: p.name,
        progress: Math.round(p.progress * 100),
        targetDate: p.targetDate,
        startDate: p.startDate,
        lead: p.lead?.name || p.lead?.displayName || '—',
        status: p.status?.name || '—',
        daysLeft,
        openIssues: open,
        totalIssues: total,
        p1Open,
      };
    });

  return {
    completionByMonth,
    resourceAllocation,
    risk: {
      high:   highRisk.length,
      medium: mediumRisk.length,
      low:    lowRisk.length,
      highItems:   highRisk.slice(0, 5).map(i => ({ title: i.title, due: i.dueDate, assignee: i.assignee?.name })),
      mediumItems: mediumRisk.slice(0, 5).map(i => ({ title: i.title, due: i.dueDate, assignee: i.assignee?.name })),
    },
    loadBalance,
    projectSummary,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🌿 Moss PMO — fetching Linear data…\n');

  const [viewer, issuesRaw, projectsRaw, teamsRaw] = await Promise.all([
    gql(VIEWER_QUERY).then(d => d.viewer),
    fetchAllIssues(),
    gql(PROJECTS_QUERY).then(d => d.projects.nodes),
    gql(TEAMS_QUERY).then(d => d.teams.nodes),
  ]);

  console.log(`\n  Org: ${viewer.organization.name}  (${viewer.name})`);
  console.log(`  Projects: ${projectsRaw.length}  |  Teams: ${teamsRaw.length}`);

  const metrics = deriveMetrics(issuesRaw, projectsRaw);

  const output = {
    fetchedAt: new Date().toISOString(),
    org: viewer.organization.name,
    issues: issuesRaw,
    projects: projectsRaw,
    teams: teamsRaw,
    metrics,
  };

  mkdirSync(resolve(ROOT, 'data'), { recursive: true });
  writeFileSync(resolve(ROOT, 'data', 'linear-data.json'), JSON.stringify(output, null, 2));

  console.log('\n✅  Saved → data/linear-data.json');
  console.log(`    Issues: ${issuesRaw.length}  Projects: ${projectsRaw.length}`);
  console.log(`    Risk — High: ${metrics.risk.high}  Medium: ${metrics.risk.medium}  Low: ${metrics.risk.low}`);
  console.log(`    Active work across ${metrics.resourceAllocation.length} projects`);
  console.log('\nRun: npm run inject  →  dashboard.html ready to open\n');
}

main().catch(err => { console.error('❌ ', err.message); process.exit(1); });
