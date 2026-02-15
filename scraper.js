const puppeteer = require("puppeteer");
const fs = require("fs-extra");
const parseJob = require("./parser");
const detectDegrees = require("./degreeDetector");
const config = require("./config");

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox"]
  });

  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

  await page.goto(config.BASE_URL, {
    waitUntil: "networkidle2",
    timeout: 0
  });

  const links = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll("a"));
    const jobs = [];
    const seen = new Set();

    anchors.forEach(a => {
      const title = a.innerText.trim();
      const link = a.href;

      if (
        title.toLowerCase().includes("recruitment") ||
        title.toLowerCase().includes("vacancy") ||
        title.toLowerCase().includes("apply online")
      ) {
        if (!seen.has(link)) {
          seen.add(link);
          jobs.push(link);
        }
      }
    });

    return jobs;
  });

  console.log("Found links:", links.length);

  const jobsData = [];

  for (const link of links.slice(0, config.MAX_JOBS)) {
    try {
      console.log("Scraping:", link);

      await page.goto(link, { waitUntil: "networkidle2", timeout: 0 });

      const job = await parseJob(page, link);

      if (job.title) {
        job.degrees = detectDegrees(job.eligibilityText);
        delete job.eligibilityText;

        jobsData.push(job);
      }

      await delay(config.DELAY);

    } catch (err) {
      console.log("Failed:", link);
    }
  }

  await fs.writeJson("./data/jobs.json", jobsData, { spaces: 2 });

  console.log("Saved 100+ jobs successfully ✅");

  await browser.close();
}

run();
