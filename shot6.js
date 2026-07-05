const { chromium } = require('/opt/node22/lib/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 2 });
  await page.goto('http://127.0.0.1:8143/?replay=turn-demo.jsonl', { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const res = await page.evaluate(async () => {
    const d = await (await fetch('/api/replay?file=turn-demo.jsonl')).json();
    const u = d.frames[0].u; // A at 0, B at 9, building at 18
    const out = {};
    for (const frac of [0, 0.2, 0.33, 0.5, 0.999999]) {
      window.setPlayhead(frac, false);
      out[frac.toFixed(2)] = { A: window.interpPos(u, 0), B: window.interpPos(u, 9), Bld: window.interpPos(u, 18) };
    }
    return out;
  });
  console.log(JSON.stringify(res));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
