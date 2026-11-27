#!/usr/bin/env node
// Generates contribution activity cards (weekly / monthly bars + cumulative line)
// as static SVGs in dark and light themes. No external dependencies.
//
// Usage:
//   GITHUB_TOKEN=... node .github/scripts/generate-activity.mjs <login>
//   node .github/scripts/generate-activity.mjs <login> --input days.json   (offline / test)
//
// days.json format: [{ "date": "2026-01-01", "count": 3 }, ...]

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const OUT_DIR = "assets";
const WEEKS = 26;
const MONTHS = 12;

const THEMES = {
  dark: {
    bg: "#0d1117", border: "#30363d", title: "#e6edf3", text: "#8b949e",
    grid: "#21262d", bar: "#39d353", line: "#58a6ff",
  },
  light: {
    bg: "#ffffff", border: "#d0d7de", title: "#1f2328", text: "#656d76",
    grid: "#eaeef2", bar: "#2da44e", line: "#0969da",
  },
};

function parseArgs(argv) {
  const args = { login: null, input: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--input") args.input = argv[++i];
    else if (!args.login) args.login = argv[i];
  }
  if (!args.login) throw new Error("usage: generate-activity.mjs <login> [--input days.json]");
  return args;
}

async function fetchDays(login) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required (or pass --input)");
  const query = `query($login: String!) {
    user(login: $login) {
      contributionsCollection {
        contributionCalendar {
          weeks { contributionDays { date contributionCount } }
        }
      }
    }
  }`;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { login } }),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  const weeks = json.data?.user?.contributionsCollection?.contributionCalendar?.weeks;
  if (!weeks) throw new Error(`user not found: ${login}`);
  return weeks.flatMap((w) => w.contributionDays.map((d) => ({ date: d.date, count: d.contributionCount })));
}

// --- aggregation ---------------------------------------------------------

function aggregateWeekly(days) {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  // 7-day buckets aligned so the last bucket ends on the most recent day
  const buckets = [];
  for (let end = sorted.length; end > 0 && buckets.length < WEEKS; end -= 7) {
    const chunk = sorted.slice(Math.max(0, end - 7), end);
    buckets.unshift({ label: shortDate(chunk[0].date), value: sum(chunk) });
  }
  return buckets;
}

function aggregateMonthly(days) {
  const map = new Map();
  for (const d of days) {
    const key = d.date.slice(0, 7);
    map.set(key, (map.get(key) ?? 0) + d.count);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-MONTHS)
    .map(([key, value]) => ({ label: `${Number(key.slice(5))}月`, value }));
}

const sum = (arr) => arr.reduce((s, d) => s + d.count, 0);
const shortDate = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// --- rendering -----------------------------------------------------------

function renderChart({ x, y, w, h, title, buckets, theme, labelEvery }) {
  const max = Math.max(1, ...buckets.map((b) => b.value));
  const total = buckets.reduce((s, b) => s + b.value, 0) || 1;
  const plotTop = y + 28;
  const plotH = h - 28 - 20;
  const slot = w / buckets.length;
  const barW = Math.max(2, slot * 0.6);
  let cum = 0;
  const points = [];
  const bars = buckets.map((b, i) => {
    const bh = (b.value / max) * plotH;
    const bx = x + i * slot + (slot - barW) / 2;
    const by = plotTop + plotH - bh;
    cum += b.value;
    points.push([x + i * slot + slot / 2, plotTop + plotH - (cum / total) * plotH]);
    const label = (buckets.length - 1 - i) % labelEvery === 0
      ? `<text x="${(x + i * slot + slot / 2).toFixed(1)}" y="${y + h - 4}" class="axis" text-anchor="middle">${esc(b.label)}</text>`
      : "";
    return `<rect class="bar" style="animation-delay:${(i * 0.02).toFixed(2)}s" x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${theme.bar}"><title>${esc(b.label)}: ${b.value}</title></rect>${label}`;
  });
  const linePath = points.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
  const [lx, ly] = points.at(-1);
  return `
  <g>
    <text x="${x}" y="${y + 14}" class="subtitle">${esc(title)}</text>
    <text x="${x + w}" y="${y + 14}" class="axis" text-anchor="end">期間合計 ${fmt(cum)}</text>
    <line x1="${x}" y1="${plotTop + plotH}" x2="${x + w}" y2="${plotTop + plotH}" stroke="${theme.grid}"/>
    <line x1="${x}" y1="${plotTop}" x2="${x + w}" y2="${plotTop}" stroke="${theme.grid}" stroke-dasharray="3 3"/>
    ${bars.join("\n    ")}
    <path class="line" d="${linePath}" fill="none" stroke="${theme.line}" stroke-width="2" stroke-linejoin="round" pathLength="1"/>
    <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="3" fill="${theme.line}"/>
  </g>`;
}

function renderSvg({ login, weekly, monthly, yearTotal, theme }) {
  const W = 840, H = 420, pad = 24;
  const innerW = W - pad * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(login)} GitHub activity">
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans JP", Helvetica, Arial, sans-serif; }
    .title { font-size: 18px; font-weight: 600; fill: ${theme.title}; }
    .subtitle { font-size: 13px; font-weight: 600; fill: ${theme.title}; }
    .axis, .meta { font-size: 11px; fill: ${theme.text}; }
    .bar { transform-box: fill-box; transform-origin: bottom; animation: grow .6s ease-out backwards; }
    .line { stroke-dasharray: 1; animation: draw 1.2s ease-out .4s backwards; }
    @keyframes grow { from { transform: scaleY(0); } to { transform: scaleY(1); } }
    @keyframes draw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
    @media (prefers-reduced-motion: reduce) { .bar, .line { animation: none; } }
  </style>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="${theme.bg}" stroke="${theme.border}"/>
  <text x="${pad}" y="36" class="title">${esc(login)} · GitHub Activity</text>
  <text x="${W - pad}" y="36" class="meta" text-anchor="end">直近1年 ${yearTotal.toLocaleString("en-US")} contributions</text>
  <text x="${W - pad}" y="52" class="meta" text-anchor="end"><tspan fill="${theme.bar}">▮</tspan> 期間別　<tspan fill="${theme.line}">―</tspan> 累計</text>
  ${renderChart({ x: pad, y: 64, w: innerW, h: 165, title: `Weekly · 直近${WEEKS}週`, buckets: weekly, theme, labelEvery: 4 })}
  ${renderChart({ x: pad, y: 240, w: innerW, h: 165, title: `Monthly · 直近${MONTHS}か月`, buckets: monthly, theme, labelEvery: 1 })}
</svg>
`;
}

// --- main ----------------------------------------------------------------

async function main() {
  const { login, input } = parseArgs(process.argv.slice(2));
  const days = input ? JSON.parse(await readFile(input, "utf8")) : await fetchDays(login);
  if (!days.length) throw new Error("no contribution data");
  const weekly = aggregateWeekly(days);
  const monthly = aggregateMonthly(days);
  const yearTotal = sum(days);
  await mkdir(OUT_DIR, { recursive: true });
  for (const [name, theme] of Object.entries(THEMES)) {
    const file = path.join(OUT_DIR, `activity-${name}.svg`);
    await writeFile(file, renderSvg({ login, weekly, monthly, yearTotal, theme }));
    console.log(`wrote ${file}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
