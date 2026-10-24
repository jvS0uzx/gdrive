import { chromium } from "@playwright/test";

const baseURL = process.env.BASE_URL ?? "http://localhost:8085";
const executablePath = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const runs = Number(process.env.RUNS ?? 3);
const pages = (process.argv[2] ?? "/,/rota").split(",");
const viewport = { width: Number(process.env.W ?? 1440), height: Number(process.env.H ?? 900) };
const scale = Number(process.env.DPR ?? 1);

function stats(intervals, longTasks) {
  const sorted = [...intervals].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const total = intervals.reduce((a, b) => a + b, 0);
  return {
    fps: Math.round((intervals.length / total) * 1000 * 10) / 10,
    p50: Math.round(at(0.5) * 10) / 10,
    p95: Math.round(at(0.95) * 10) / 10,
    p99: Math.round(at(0.99) * 10) / 10,
    slow: Math.round((intervals.filter((v) => v > 50).length / intervals.length) * 1000) / 10,
    longTaskMs: Math.round(longTasks),
  };
}

async function journey(page) {
  const box = await page.getByTestId("mapa").boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const drag = async (dx, dy) => {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + dx, cy + dy, { steps: 24 });
    await page.mouse.up();
  };
  const wheel = async (delta, times) => {
    await page.mouse.move(cx, cy);
    for (let i = 0; i < times; i++) {
      await page.mouse.wheel(0, delta);
      await page.waitForTimeout(90);
    }
  };
  for (const [dx, dy] of [[260, 0], [-260, 120], [0, -160], [180, 80]]) await drag(dx, dy);
  await wheel(-240, 10);
  for (const [dx, dy] of [[300, 0], [-300, 200], [120, -260], [-200, 60]]) await drag(dx, dy);
  await wheel(240, 10);
}

async function measure(browser, path) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: scale });
  await page.goto(`${baseURL}${path}`);
  await page.locator('[data-testid="mapa"][data-ready="true"]').waitFor({ timeout: 60_000 });
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    const w = window;
    w.__bench = { frames: [], longTasks: 0, running: true };
    let last = performance.now();
    const tick = (now) => {
      w.__bench.frames.push(now - last);
      last = now;
      if (w.__bench.running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) w.__bench.longTasks += entry.duration;
    }).observe({ type: "longtask", buffered: false });
  });
  await journey(page);
  await page.waitForTimeout(500);
  const { frames, longTasks } = await page.evaluate(() => {
    const w = window;
    w.__bench.running = false;
    return { frames: w.__bench.frames.slice(1), longTasks: w.__bench.longTasks };
  });
  await page.close();
  return stats(frames, longTasks);
}

const gpu = process.env.GPU !== "0" ? ["--ignore-gpu-blocklist", "--enable-gpu", "--use-gl=angle", "--use-angle=gl-egl"] : [];
const browser = await chromium.launch({ executablePath, args: gpu });
for (const path of pages) {
  const results = [];
  for (let i = 0; i < runs; i++) results.push(await measure(browser, path));
  const median = (key) => [...results.map((r) => r[key])].sort((a, b) => a - b)[Math.floor(results.length / 2)];
  const summary = Object.fromEntries(Object.keys(results[0]).map((k) => [k, median(k)]));
  console.log(`${path.padEnd(8)} fps ${summary.fps}  p50 ${summary.p50} ms  p95 ${summary.p95} ms  p99 ${summary.p99} ms  quadros > 50 ms ${summary.slow}%  long tasks ${summary.longTaskMs} ms`);
}
await browser.close();
