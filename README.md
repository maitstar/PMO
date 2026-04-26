# PMO Dashboard

A real-time project management dashboard that pulls live data from Linear and visualizes it as charts, risk metrics, and workload distribution.

## What It Does

Instead of digging through Linear's UI to answer "how close are we to shipping?", this dashboard answers:
- **Completion %** — planned vs. predicted vs. actual, month by month
- **Resource allocation** — which projects are consuming team effort right now
- **Risk distribution** — how many high/medium/low severity issues are open
- **Load balance** — who has the most work, who's blocked by P1s
- **Project summary** — all projects with progress, lead, days to deadline

All data is **live from Linear** — no manual spreadsheets.

## How It Works

```
Linear Workspace
       ↓ (GraphQL API)
fetch-linear.mjs  ← pulls issues, projects, teams
       ↓ (derives metrics from raw data)
data/linear-data.json  ← structured JSON snapshot
       ↓ (injects into template)
dashboard.html  ← Chart.js dashboard, ready to open
```

Three commands:
- `npm run fetch` — query Linear API, save data
- `npm run inject` — inject data into HTML template
- `npm run update` — fetch + inject (do this one)

## Setup

### 1. Get a Linear API Key
Go to [Linear settings → API](https://linear.app/settings/api) and create a new personal API key.

### 2. Clone & Configure
```bash
git clone https://github.com/maitstar/PMO.git
cd pmo-dashboard
echo "LINEAR_API_KEY=lin_api_..." > .env
```

Paste your API key in place of `lin_api_...`.

### 3. Run
```bash
npm run update   # fetch from Linear + build dashboard
npm run open     # open in your browser
```

That's it. Dashboard is now live with your team's data.

## What Each Chart Shows

### Completion Progress (Line Chart)
- **Planned** — linear ramp from project start dates to target dates (100% by deadline)
- **Predicted** — your current issue completion velocity extrapolated forward
- **Actual** — `(completed issues) / (total issues) * 100%` through end of current month

If "Actual" is lagging "Planned", you're at risk of missing deadlines.

### Resource Allocation (Bar Chart)
Counts in-progress (started) issues per project. Shows which projects are actively consuming effort right now.

### Risk Distribution (Doughnut)
- **High** — Urgent priority issues OR High priority + overdue
- **Medium** — High priority with no assignee, OR Medium priority + overdue
- **Low** — Upcoming issues (due within 14 days, not started yet)

### Projects Table
All projects with target dates, sorted by deadline. Shows:
- Progress % (from Linear)
- Open vs. total issues
- Number of P1/P2 blockers
- Days left to target date

### Load Balance
Per team member:
- Total open issues assigned
- How many are in progress
- How many are P1/P2 (blockers)
- Visual workload bar

## The Data Logic

All metrics are **derived from raw Linear data**, not hardcoded:

**Completion %:**
- Planned: linear interpolation between earliest project start date and latest target date
- Actual: issues with `completedAt` timestamp / total issues created, per month
- Predicted: `(completed so far) + (velocity × days ahead)`, where velocity = issues/day over last 30 days

**Risk:**
- Queries open issues (not completed, not cancelled)
- Filters by priority + dueDate + assignee status
- Generates risk list and count

**Resource allocation:**
- Counts issues where `state.type === 'started'`
- Groups by project
- Expresses as % of total active work

**Load balance:**
- Groups open issues by assignee
- Counts active (started) per person
- Counts P1/P2 blockers per person

## Customization

### Change Risk Logic
Edit `fetch-linear.mjs`, function `deriveMetrics()`:
```javascript
const highRisk = openIssues.filter(iss =>
  iss.priority <= 1 ||  // Urgent
  (iss.priority === 2 && iss.dueDate && new Date(iss.dueDate) < today)
);
```

### Add More Queries
In `PROJECTS_QUERY`, add fields like:
```graphql
completedIssueCountHistory
issueCountHistory
scopeHistory
```

Then process them in `deriveMetrics()`.

### Change Chart Types
In `dashboard-template.html`, replace `new Chart(...)` with different chart types (see [Chart.js docs](https://www.chartjs.org/docs/latest/)).

## How to Use It

### Daily
```bash
cd pmo-dashboard && npm run update
```
Opens browser with latest data from Linear.

### Weekly
Same as above, use for standup/planning.

### Before deadlines
Check the "Actual" line in Completion chart — if it's below "Planned", escalate.

## What's NOT Included

- **Burndown charts** — Linear doesn't expose historical state changes easily
- **Cycle velocity** — would need cycle data; currently just uses global velocity
- **Cost tracking** — no financial data in Linear
- **Forecast confidence** — velocity assumes constant pace (in reality: varies)

These could be added if you want to extend it.

## Troubleshooting

**"LINEAR_API_KEY not set"**
```bash
echo "LINEAR_API_KEY=lin_api_..." > .env
```

**"Cannot find module fetch"**
You need Node 18+. Check: `node --version`

**No data shows up**
1. Check `.env` has your API key
2. Run `npm run fetch` to see if it errors
3. Make sure your Linear workspace has issues/projects

**Dashboard looks empty**
Run `npm run update` again — maybe data is stale.

## On GitHub

This is a template. Fork it, customize the risk logic, deploy it for your team.

---

Built with Node.js + Chart.js + Linear GraphQL API.
