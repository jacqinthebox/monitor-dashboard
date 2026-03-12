const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// In-memory cache: { key: { data, ts } }
const cache = {};
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function cachedFetch(key, fn) {
  if (cache[key] && Date.now() - cache[key].ts < CACHE_TTL) return cache[key].data;
  const data = await fn();
  cache[key] = { data, ts: Date.now() };
  return data;
}

// Fetch USD→EUR rate from Yahoo
async function getUsdEurRate() {
  return cachedFetch('USDEUR', async () => {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X?range=1d&interval=1d';
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MonitorDashboard/1.0)' } });
    const raw = await resp.json();
    const rate = raw.chart.result[0].meta.regularMarketPrice;
    return 1 / rate; // USD→EUR
  });
}

// Serve static files from current directory
app.use(express.static(path.join(__dirname), { index: 'dashboard.html' }));

// Single quote endpoint
app.get('/api/quote/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  try {
    const data = await cachedFetch(ticker, async () => {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=2d&interval=1d`;
      const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MonitorDashboard/1.0)' } });
      if (!resp.ok) throw new Error(`Yahoo returned ${resp.status}`);
      const raw = await resp.json();
      const result = raw.chart.result[0], meta = result.meta;
      const closes = result.indicators.quote[0].close.filter(v => v != null);
      const prev = closes.length > 1 ? closes[closes.length - 2] : meta.chartPreviousClose;
      const price = meta.regularMarketPrice;
      const chg = prev ? ((price - prev) / prev) * 100 : 0;

      let priceEur = null;
      if (meta.currency === 'USD') {
        const rate = await getUsdEurRate();
        priceEur = Math.round(price * rate * 100) / 100;
      }

      return {
        ticker: meta.symbol, price, currency: meta.currency,
        chg: Math.round(chg * 100) / 100,
        priceEur
      };
    });
    res.json(data);
  } catch (e) {
    console.error(`[quote] ${ticker}: ${e.message}`);
    res.status(502).json({ error: 'Failed to fetch quote', detail: e.message });
  }
});

// Batch quotes endpoint
app.get('/api/quotes', async (req, res) => {
  const tickers = (req.query.symbols || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!tickers.length) return res.status(400).json({ error: 'No symbols provided' });

  const results = await Promise.allSettled(
    tickers.map(async ticker => {
      const r = await fetch(`http://localhost:${PORT}/api/quote/${encodeURIComponent(ticker)}`);
      if (!r.ok) throw new Error('failed');
      return r.json();
    })
  );

  const data = {};
  results.forEach((r, i) => {
    data[tickers[i]] = r.status === 'fulfilled' ? r.value : { error: true };
  });
  res.json(data);
});

// GitHub repos endpoint — fetches latest commit + open issues/PRs
const GITHUB_REPOS = [
  'HKUDS/LightRAG',
  'fluxcd/flux2',
  'external-secrets/external-secrets',
  'kubernetes/kubernetes',
  'ollama/ollama'
];

app.get('/api/github', async (req, res) => {
  try {
    const data = await cachedFetch('github-repos', async () => {
      const headers = { 'User-Agent': 'MonitorDashboard/1.0', 'Accept': 'application/vnd.github+json' };
      // Add token if available (raises rate limit from 60 to 5000/hr)
      if (process.env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;

      const results = await Promise.allSettled(GITHUB_REPOS.map(async repo => {
        const [repoData, commits] = await Promise.all([
          fetch(`https://api.github.com/repos/${repo}`, { headers }).then(r => r.json()),
          fetch(`https://api.github.com/repos/${repo}/commits?per_page=1`, { headers }).then(r => r.json())
        ]);
        const lastCommit = commits[0];
        return {
          repo,
          name: repoData.name,
          stars: repoData.stargazers_count,
          openIssues: repoData.open_issues_count,
          lastCommitMsg: lastCommit?.commit?.message?.split('\n')[0] || 'N/A',
          lastCommitDate: lastCommit?.commit?.committer?.date || null,
          lastCommitAuthor: lastCommit?.commit?.author?.name || 'N/A',
          defaultBranch: repoData.default_branch
        };
      }));

      return results
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value);
    });
    res.json(data);
  } catch (e) {
    console.error('[github]', e.message);
    res.status(502).json({ error: 'GitHub fetch failed' });
  }
});

app.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║  MONITOR DASHBOARD                   ║`);
  console.log(`  ║  http://localhost:${PORT}                ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
});
