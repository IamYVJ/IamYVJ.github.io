// Refreshes the GitHub numbers in the "projects" block of data.json, and the
// "70+ Projects" readout in the hero of index.html.
//
// Runs weekly from .github/workflows/update-github-stats.yml. To run it locally:
//   GH_STATS_TOKEN=<token> node scripts/update-github-stats.mjs
//
// Counting matches gitfolio (iamyvj.github.io/gitfolio), where the original
// numbers came from: repos you own that aren't forks or empty; lines added and
// removed are your own, from GitHub's contributor statistics; languages are
// bytes summed across those repos.
//
// Only values are rewritten — labels, icons, colours and layout in data.json
// are left as they are. Nothing is written if any repo can't be counted, so a
// bad run never publishes partial numbers.

import { readFile, writeFile } from "node:fs/promises";

const LOGIN = process.env.GH_LOGIN || "IamYVJ";
const TOKEN = process.env.GH_STATS_TOKEN;
const DATA_FILE = new URL("../data.json", import.meta.url);
const INDEX_FILE = new URL("../index.html", import.meta.url);
const API = "https://api.github.com";
const TOP_LANGUAGES = 5;
const OTHER_COLOR = "#7a8783";
// Colours for a language entering the top five that has none in data.json yet,
// taken in this order (the colour-blind-checked palette used on the site).
const SPARE_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300"];
// Repos and all-time contributions only go down if repos are deleted or the
// token can't see private ones, so a drop stops the run unless this is set
// (the workflow's "allow_decrease" option on a manual run).
const ALLOW_DECREASE = process.env.ALLOW_DECREASE === "true";

if (!TOKEN) {
  fail("GH_STATS_TOKEN is not set. Add a read-only personal access token as a repository secret — see the workflow file.");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fmt = (n) => n.toLocaleString("en-US");

function fail(message) {
  console.error("✖ " + message);
  process.exit(1);
}

async function gh(path, { raw = false, method = "GET", body } = {}) {
  const res = await fetch(API + path, {
    method,
    body: body && JSON.stringify(body),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": `${LOGIN}-portfolio-stats`
    }
  });
  if (raw) return res;
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Runs fn over items with a small concurrency limit
async function pool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }));
  return results;
}

async function listOwnedRepos() {
  const repos = [];
  for (let page = 1; ; page++) {
    const batch = await gh(`/user/repos?affiliation=owner&visibility=all&per_page=100&page=${page}`);
    repos.push(...batch);
    if (batch.length < 100) return repos;
  }
}

// GitHub computes contributor stats on demand: a cold repo answers 202 and is
// ready a few seconds later, so keep asking for a while.
async function contributorStats(repo) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const res = await gh(`/repos/${repo.full_name}/stats/contributors`, { raw: true });
    if (res.status === 202) {
      await sleep(3000 + attempt * 2000);
      continue;
    }
    if (res.status === 204) return { added: 0, deleted: 0 };
    if (!res.ok) throw new Error(`stats for ${repo.full_name} → HTTP ${res.status}`);

    let added = 0, deleted = 0;
    for (const c of await res.json()) {
      if (c.author?.login?.toLowerCase() !== LOGIN.toLowerCase()) continue;
      for (const w of c.weeks) {
        added += w.a;
        deleted += w.d;
      }
    }
    return { added, deleted };
  }
  return null; // still computing
}

async function allTimeContributions() {
  const yearsQuery = `query($login:String!){user(login:$login){contributionsCollection{contributionYears}}}`;
  const years = (await gh("/graphql", { method: "POST", body: { query: yearsQuery, variables: { login: LOGIN } } }))
    .data.user.contributionsCollection.contributionYears;
  const parts = years.map((y) =>
    `y${y}:contributionsCollection(from:"${y}-01-01T00:00:00Z",to:"${y}-12-31T23:59:59Z"){contributionCalendar{totalContributions}}`);
  const res = await gh("/graphql", {
    method: "POST",
    body: { query: `query($login:String!){user(login:$login){${parts.join(" ")}}}`, variables: { login: LOGIN } }
  });
  if (res.errors) throw new Error("GraphQL: " + JSON.stringify(res.errors).slice(0, 200));
  return Object.values(res.data.user).reduce((sum, y) => sum + y.contributionCalendar.totalContributions, 0);
}

async function main() {
  const viewer = await gh("/user");
  if (viewer.login.toLowerCase() !== LOGIN.toLowerCase()) {
    fail(`The token belongs to ${viewer.login}, not ${LOGIN}.`);
  }

  const repos = (await listOwnedRepos()).filter((r) => !r.fork && r.size > 0);
  console.log(`Counting ${repos.length} repos…`);

  const stats = await pool(repos, 4, contributorStats);
  const pending = repos.filter((_, i) => stats[i] === null).map((r) => r.name);
  if (pending.length) fail(`GitHub was still computing stats for: ${pending.join(", ")}. Nothing written; the next run will retry.`);

  const added = stats.reduce((s, x) => s + x.added, 0);
  const deleted = stats.reduce((s, x) => s + x.deleted, 0);

  const languageBytes = {};
  for (const langs of await pool(repos, 4, (r) => gh(`/repos/${r.full_name}/languages`))) {
    for (const [name, bytes] of Object.entries(langs)) languageBytes[name] = (languageBytes[name] || 0) + bytes;
  }

  const commits = (await gh(`/search/commits?q=${encodeURIComponent("author:" + LOGIN)}&per_page=1`)).total_count;
  const contributions = await allTimeContributions();

  // ── Write into data.json ──────────────────────────────────────────────
  const raw = await readFile(DATA_FILE, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const data = JSON.parse(raw);
  const p = data.projects;
  if (!p) fail("data.json has no projects block.");

  const cards = p.sections.flatMap((s) => s.rows.flatMap((r) => r.cards));
  const card = (key) => cards.find((c) => c.stat === key);

  const current = (key) => Number(String(card(key)?.value || "0").replace(/,/g, ""));
  const drops = [["repos", repos.length], ["contributions", contributions]]
    .filter(([key, next]) => next < current(key))
    .map(([key, next]) => `${key} ${fmt(current(key))} → ${fmt(next)}`);
  if (drops.length && !ALLOW_DECREASE) {
    fail(`Counts went down (${drops.join(", ")}). The token probably can't see your private repos — ` +
      `give it access to all repositories. If the drop is real (e.g. you deleted repos), run the workflow manually with "allow_decrease" ticked.`);
  }

  p.highlight.value = fmt(added);
  p.highlight.detail = `<strong>${fmt(deleted)} removed</strong> • <strong>${fmt(added - deleted)} net</strong> across ${repos.length} repositories`;

  const values = { repos: repos.length, commits, contributions, languages: Object.keys(languageBytes).length };
  for (const [key, value] of Object.entries(values)) {
    if (card(key)) card(key).value = fmt(value);
  }

  // Language split: top five by size, the rest folded into "Other". A
  // language keeps the colour it already has so it doesn't change on re-rank.
  const totalBytes = Object.values(languageBytes).reduce((a, b) => a + b, 0);
  const ranked = Object.entries(languageBytes).sort((a, b) => b[1] - a[1]);
  const colorOf = Object.fromEntries((p.languages.items || []).map((it) => [it.name, it.color]));
  const top = ranked.slice(0, TOP_LANGUAGES).map(([name, bytes]) => ({
    name,
    percent: Math.round((bytes / totalBytes) * 1000) / 10
  }));
  const taken = new Set(top.map((it) => colorOf[it.name]).filter(Boolean));
  for (const it of top) {
    it.color = colorOf[it.name] || SPARE_COLORS.find((c) => !taken.has(c)) || OTHER_COLOR;
    taken.add(it.color);
  }
  const other = Math.round((100 - top.reduce((s, it) => s + it.percent, 0)) * 10) / 10;
  if (other > 0) top.push({ name: "Other", percent: other, color: OTHER_COLOR });
  p.languages.items = top;
  p.languages.note = `Share of code by size across ${repos.length} repositories`;

  const out = JSON.stringify(data, null, 2).replace(/\n/g, eol) + (raw.endsWith(eol) ? eol : "");
  if (out !== raw) {
    await writeFile(DATA_FILE, out);
    console.log(`data.json: ${fmt(added)} added, ${fmt(deleted)} removed, ${repos.length} repos, ` +
      `${fmt(commits)} commits, ${fmt(contributions)} contributions, ${values.languages} languages.`);
  } else {
    console.log("data.json: no changes.");
  }

  // Hero "Projects" readout: the repo count rounded down to a multiple of 5
  // (71 → "70+", 75 → "75+").
  const html = await readFile(INDEX_FILE, "utf8");
  const heroValue = Math.floor(repos.length / 5) * 5;
  const heroPattern = /(<span data-count id="heroProjects">)\d+(<\/span>)/;
  if (!heroPattern.test(html)) fail('index.html has no <span data-count id="heroProjects"> to update.');
  const nextHtml = html.replace(heroPattern, `$1${heroValue}$2`);
  if (nextHtml !== html) {
    await writeFile(INDEX_FILE, nextHtml);
    console.log(`index.html: hero projects → ${heroValue}+`);
  } else {
    console.log("index.html: no changes.");
  }
}

main().catch((err) => fail(err.message));
