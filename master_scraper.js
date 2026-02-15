/**
 * MASTER SCRAPER - Sarkari Result
 * Single unified scraper that:
 * - Discovers ALL links and sub-links comprehensively
 * - Preserves original format (bullet points → arrays, tables → structured)
 * - Extracts every detail: dates, fee, age, salary, selection process, how to apply, FAQs, etc.
 * - Outputs data in same structure as source (bullets stay bullets, tables stay tables)
 */

const puppeteer = require("puppeteer");
const fs = require("fs-extra");
const path = require("path");

const CONFIG = {
  baseUrl: "https://sarkariresult.com.im/",
  baseHost: "sarkariresult.com.im",
  jobsFile: path.join(__dirname, "jobs.json"),
  concurrency: 3,
  timeout: 60000,
  scrapeInterval: 60 * 60 * 1000,
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  maxQueueSize: 15000,
  maxJsonLines: 90000,
};

// URLs that are category/listing pages - NOT job detail pages
const CATEGORY_PATTERNS = [
  /^https:\/\/sarkariresult\.com\.im\/?$/,
  /^https:\/\/sarkariresult\.com\.im\/(admission|admit-card|sarkari-result|answer-key|sarkari-naukri|syllabus)(\/)?$/,
];

function isCategoryPage(url) {
  const normalized = url.replace(/\/$/, "");
  return CATEGORY_PATTERNS.some((p) => p.test(normalized));
}

class MasterScraper {
  constructor() {
    this.browser = null;
    this.queue = new Set([CONFIG.baseUrl]);
    this.visited = new Set();
    this.jobsData = new Map();
    this.isRunning = false;
  }

  async init() {
    console.log("Initializing Master Scraper...");

    try {
      if (await fs.pathExists(CONFIG.jobsFile)) {
        const existing = await fs.readJson(CONFIG.jobsFile);
        existing.forEach((job) => {
          if (job.officialLink) {
            const norm = job.officialLink.split("#")[0].replace(/\/$/, "") || job.officialLink;
            this.jobsData.set(norm, job);
            this.visited.add(norm);
          }
        });
        console.log(`Loaded ${this.jobsData.size} existing jobs. Only new links will be scraped (incremental).`);
      }
    } catch (e) {
      console.log("Starting fresh.");
    }

    this.browser = await puppeteer.launch({
      headless: false,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu",
        "--window-size=1920,1080",
      ],
      defaultViewport: null,
    });
  }

  async start() {
    await this.init();
    this.isRunning = true;
    console.log("Starting comprehensive crawl...\n");

    while (this.queue.size > 0 && this.isRunning) {
      const batch = Array.from(this.queue).slice(0, CONFIG.concurrency);
      batch.forEach((url) => {
        this.queue.delete(url);
        this.visited.add(url);
      });

      if (batch.length === 0) break;

      console.log(`Batch: ${batch.length} | Queue: ${this.queue.size} | Visited: ${this.visited.size}`);

      await Promise.all(batch.map((url) => this.processUrl(url)));
      await this.saveData();
    }

    console.log("\nCrawl complete.");
    await this.saveData();
    await this.browser.close();

    const runOnce = process.argv.includes("--once");
    if (!runOnce) {
      console.log(`Next run in ${CONFIG.scrapeInterval / 60000} minutes...`);
      setTimeout(() => new MasterScraper().start(), CONFIG.scrapeInterval);
    }
  }

  async processUrl(url) {
    let page = null;
    try {
      page = await this.browser.newPage();

      await page.setRequestInterception(true);
      page.on("request", (req) => {
        if (["image", "stylesheet", "font", "media"].includes(req.resourceType())) {
          req.abort();
        } else {
          req.continue();
        }
      });

      await page.setUserAgent(CONFIG.userAgent);
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
      });

      await page.goto(url, { waitUntil: "networkidle2", timeout: CONFIG.timeout });

      // 1. COMPREHENSIVE LINK DISCOVERY - only queue links not already scraped (incremental)
      const newLinks = await page.evaluate((baseUrl, baseHost) => {
        const links = new Set();
        document.querySelectorAll("a[href]").forEach((a) => {
          try {
            let href = a.href;
            if (!href || href === "#" || href.startsWith("javascript:") || href.startsWith("mailto:")) return;
            if (!href.startsWith(baseUrl) && !href.includes(baseHost)) return;
            href = href.split("#")[0].replace(/\/$/, "") || href.split("#")[0];
            if (href.length > 5) links.add(href);
          } catch (_) {}
        });
        return Array.from(links);
      }, CONFIG.baseUrl, CONFIG.baseHost);

      newLinks.forEach((link) => {
        const norm = link.split("#")[0].replace(/\/$/, "") || link;
        if (!this.visited.has(norm) && !this.queue.has(norm) && this.queue.size < CONFIG.maxQueueSize) {
          this.queue.add(norm);
        }
      });

      // 2. JOB PAGE DETECTION - Skip category pages
      if (isCategoryPage(url)) return;

      const isJob = await this.isJobPage(page);
      if (isJob && !this.jobsData.has(url)) {
        const scrapedAt = new Date().toISOString();
        const jobData = await this.scrapeJobDetails(page, url, scrapedAt);
        if (jobData && jobData.title) {
          this.jobsData.set(url, jobData);
          console.log(`  [OK] ${jobData.title.substring(0, 55)}...`);
        }
      }
    } catch (err) {
      // Silent fail for individual URLs
    } finally {
      if (page) await page.close();
    }
  }

  async isJobPage(page) {
    return await page.evaluate(() => {
      const h1 = document.querySelector("h1");
      if (!h1) return false;

      // Must have job-like content: Important Links table, vacancy table, or Apply link
      const bodyText = document.body.innerText.toLowerCase();
      const hasImportantLinks = bodyText.includes("important link") || bodyText.includes("apply online");
      const hasVacancy = bodyText.includes("vacancy") || bodyText.includes("post name") || bodyText.includes("eligibility");
      const hasApplyLink = !!document.querySelector('a[href*="apply"], a[href*="login"], a[href*="registration"]');

      return hasImportantLinks || hasVacancy || hasApplyLink;
    });
  }

  async scrapeJobDetails(page, url, scrapedAt) {
    return await page.evaluate((currentUrl, scrapedAtDate, baseUrl) => {
      const clean = (t) => (t ? String(t).replace(/\s+/g, " ").trim() : "");
      const $ = (sel, ctx = document) => ctx.querySelector(sel);
      const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

      const title = clean($("h1")?.innerText) || "";

      let category = "Latest Jobs";
      const lower = title.toLowerCase();
      if (lower.includes("result")) category = "Result";
      else if (lower.includes("admit card")) category = "Admit Card";
      else if (lower.includes("answer key")) category = "Answer Key";
      else if (lower.includes("syllabus")) category = "Syllabus";
      else if (lower.includes("admission")) category = "Admission";

      const job = {
        title,
        scrapedAt: scrapedAtDate || "",
        category,
        postDate: "",
        shortInfo: "",
        importantDates: {},
        applicationFee: {},
        applicationFeeBullets: [],
        ageLimit: {},
        ageLimitBullets: [],
        vacancyDetails: [],
        salary: [],
        selectionProcess: [],
        howToApply: [],
        importantLinks: [],
        faqs: [],
        educationalQualification: "",
        applyOnline: "",
        downloadNotification: "",
        officialWebsite: "",
        officialLink: currentUrl,
        allTables: [],
        rawBulletSections: {},
      };

      // --- POST DATE ---
      const bodyText = document.body.innerText;
      const dateMatch = bodyText.match(/(?:Post Date|Updated on|Notification Date|Published)\s*[:\/]\s*([^\n]+)/i);
      if (dateMatch) job.postDate = clean(dateMatch[1]);

      // --- SHORT INFO (first meaningful paragraph after intro) ---
      const shortEl = $$("p").find((p) => {
        const t = p.innerText.trim();
        return t.length > 80 && t.length < 800 && !t.toLowerCase().includes("join our");
      });
      if (shortEl) job.shortInfo = clean(shortEl.innerText);

      // --- EXTRACT ALL BULLET LISTS (preserve format) ---
      const extractBulletList = (ulOrOl) => {
        if (!ulOrOl || !(ulOrOl.tagName === "UL" || ulOrOl.tagName === "OL")) return [];
        return $$("li", ulOrOl).map((li) => clean(li.innerText)).filter((t) => t.length > 1);
      };

      // Find sections by header proximity - scan all h2, h3, h4, strong, and associated content
      const sectionHeaders = ["important dates", "application fee", "exam fee", "age limit", "selection process", "how to apply", "how to"];

      const allSections = [];
      $$("h2, h3, h4, strong, b").forEach((el) => {
        const text = el.innerText?.trim().toLowerCase() || "";
        const match = sectionHeaders.find((h) => text.includes(h));
        if (match && text.length < 80) {
          let container = el.closest("td") || el.closest("div") || el.parentElement;
          if (!container) container = el;
          let next = el.nextElementSibling;
          if (!next) next = container.nextElementSibling;

          const bullets = [];
          [next, next?.nextElementSibling, next?.nextElementSibling?.nextElementSibling].forEach((n) => {
            if (n && (n.tagName === "UL" || n.tagName === "OL")) {
              extractBulletList(n).forEach((b) => bullets.push(b));
            } else if (n && n.tagName === "TABLE") {
              $$("tr", n).forEach((row) => {
                const cells = $$("td, th", row);
                cells.forEach((c) => {
                  const t = clean(c.innerText);
                  if (t && t.length > 2) bullets.push(t);
                });
              });
            }
          });

          allSections.push({ name: match, bullets });
        }
      });

      // Also scan tables that have section headers in first row
      $$("table").forEach((table) => {
        const firstRow = $("tr", table);
        if (!firstRow) return;
        const headerText = firstRow.innerText.toLowerCase();

        if (headerText.includes("important date") && headerText.includes("application fee")) {
          const rows = $$("tr", table);
          rows.slice(1).forEach((row) => {
            const cells = $$("td", row);
            cells.forEach((c) => {
              const list = $("ul, ol", c);
              if (list) {
                const items = extractBulletList(list);
                if (headerText.includes("important date") && items.some((i) => /date|start|last|exam|admit|result|notification/i.test(i))) {
                  items.forEach((i) => {
                    if (/^[a-z\s]+:\s*.+/i.test(i)) {
                      const [k, v] = i.split(/:\s*(.+)/);
                      job.importantDates[clean(k)] = clean(v);
                    }
                  });
                }
                if (headerText.includes("application fee") && items.some((i) => /₹|rs\.|fee|gen|obc|sc|st|pay/i.test(i))) {
                  items.forEach((i) => {
                    if (/^[a-z\s\/]+:\s*.+/i.test(i)) {
                      const [k, v] = i.split(/:\s*(.+)/);
                      job.applicationFee[clean(k)] = clean(v);
                    }
                    job.applicationFeeBullets.push(i);
                  });
                }
              }
            });
          });
        }
        if (headerText.includes("age limit")) {
          const list = $("ul, ol", table);
          if (list) {
            extractBulletList(list).forEach((i) => {
              if (/^[a-z\s]+:\s*.+/i.test(i)) {
                const [k, v] = i.split(/:\s*(.+)/);
                job.ageLimit[clean(k)] = clean(v);
              }
              job.ageLimitBullets.push(i);
            });
          }
        }
      });

      // Fallback: scan all ul/ol and associate by content
      const hasImportantDates = Object.keys(job.importantDates).length > 0;
      if (!hasImportantDates || job.applicationFeeBullets.length === 0 || job.ageLimitBullets.length === 0) {
        $$("ul, ol").forEach((list) => {
          const items = extractBulletList(list);
          if (items.length === 0) return;

          const text = items.join(" ").toLowerCase();
          if (/notification|application start|last date|exam date|admit card|result date/i.test(text) && !/₹|fee|age|year/i.test(text)) {
            items.forEach((i) => {
              const m = i.match(/^([^:]+):\s*(.+)$/);
              if (m) job.importantDates[clean(m[1])] = clean(m[2]);
            });
          } else if (/₹|gen\/|obc|sc\/st|fee|pay the examination/i.test(text) && !/age|year/i.test(text)) {
            items.forEach((i) => {
              const m = i.match(/^([^:]+):\s*(.+)$/);
              if (m) job.applicationFee[clean(m[1])] = clean(m[2]);
              job.applicationFeeBullets.push(i);
            });
          } else if (/age|year|minimum|maximum/i.test(text) && items.some((i) => /year/i.test(i))) {
            items.forEach((i) => {
              const m = i.match(/^([^:]+):\s*(.+)$/);
              if (m) job.ageLimit[clean(m[1])] = clean(m[2]);
              job.ageLimitBullets.push(i);
            });
          } else if (/merit|written|document|interview|selection/i.test(text) && items.length >= 2) {
            job.selectionProcess = items;
          } else if (/click on|apply|fill|upload|print|visit the official/i.test(text) && items.length >= 3) {
            job.howToApply = items;
          }
        });
      }

      // Apply section results from allSections
      allSections.forEach((s) => {
        if (s.name.includes("selection") && s.bullets.length > 0) job.selectionProcess = s.bullets;
        if (s.name.includes("how to") && s.bullets.length > 0) job.howToApply = s.bullets;
        if (s.name.includes("important date") && s.bullets.length > 0 && Object.keys(job.importantDates).length === 0) {
          s.bullets.forEach((i) => {
            const m = i.match(/^([^:]+):\s*(.+)$/);
            if (m) job.importantDates[clean(m[1])] = clean(m[2]);
          });
        }
        if ((s.name.includes("fee") || s.name.includes("exam fee")) && s.bullets.length > 0 && job.applicationFeeBullets.length === 0) {
          job.applicationFeeBullets = s.bullets;
          s.bullets.forEach((i) => {
            const m = i.match(/^([^:]+):\s*(.+)$/);
            if (m) job.applicationFee[clean(m[1])] = clean(m[2]);
          });
        }
        if (s.name.includes("age") && s.bullets.length > 0 && job.ageLimitBullets.length === 0) {
          job.ageLimitBullets = s.bullets;
          s.bullets.forEach((i) => {
            const m = i.match(/^([^:]+):\s*(.+)$/);
            if (m) job.ageLimit[clean(m[1])] = clean(m[2]);
          });
        }
      });

      // --- VACANCY TABLES ---
      $$("table").forEach((table) => {
        const headers = $$("th, td", $("tr", table)).map((c) => c.innerText.trim().toLowerCase());
        const hasPost = headers.some((h) => h.includes("post") || h.includes("post name"));
        const hasTotal = headers.some((h) => h.includes("total") || h.includes("vacancy"));
        const hasEligibility = headers.some((h) => h.includes("eligibility") || h.includes("qualification"));

        const isMetaTable = headers.some((h) => h.includes("important link") || h.includes("important date") || h.includes("application fee") || h.includes("age limit"));
        if ((hasPost || hasEligibility) && !isMetaTable) {
          const rows = $$("tr", table).slice(1);
          rows.forEach((row) => {
            const cols = $$("td", row);
            if (cols.length < 2) return;
            const rowData = {};
            headers.forEach((h, i) => {
              if (cols[i]) rowData[h || "col" + i] = clean(cols[i].innerText);
            });
            if (Object.keys(rowData).length > 0) job.vacancyDetails.push(rowData);
          });
        }

        // Salary table
        if (headers.some((h) => h.includes("salary") || h.includes("amount") || h.includes("allowance"))) {
          const rows = $$("tr", table).slice(1);
          rows.forEach((row) => {
            const cols = $$("td", row);
            if (cols.length >= 2) {
              job.salary.push({ key: clean(cols[0].innerText), value: clean(cols[1].innerText) });
            }
          });
        }
      });

      // Educational qualification from vacancy or dedicated section
      const qualKeys = ["eligibility", "qualification", "educational"];
      job.vacancyDetails.forEach((row) => {
        Object.keys(row).forEach((k) => {
          if (qualKeys.some((q) => k.toLowerCase().includes(q)) && row[k]?.length > 10) {
            const post = row["post name"] || row["post"] || "";
            job.educationalQualification += (post ? post + ": " : "") + row[k] + "\n";
          }
        });
      });
      job.educationalQualification = job.educationalQualification.trim();

      // --- IMPORTANT LINKS TABLE: scrape all rows (Download Admit Card, Apply Online, Download Notification, Official Website, etc.) except Homepage ---
      let linksTable = null;
      
      // Strategy 1: Look for a heading "Important Links" and find the next table
      const headings = Array.from(document.querySelectorAll("h2, h3, h4, strong, b, p, div, span, center, font"));
      const importantLinksHeader = headings.find(el => {
          const text = el.innerText.trim().toLowerCase();
          return (text.includes("important link") || text.includes("useful link")) && text.length < 50;
      });

      if (importantLinksHeader) {
          let next = importantLinksHeader.nextElementSibling;
          let attempts = 0;
          while (next && attempts < 5) { // Look ahead a few siblings
              if (next.tagName === 'TABLE') {
                  linksTable = next;
                  break;
              }
              // Sometimes table is inside a div
              const innerTable = next.querySelector('table');
              if (innerTable) {
                  linksTable = innerTable;
                  break;
              }
              next = next.nextElementSibling;
              attempts++;
          }
      }

      // Strategy 2: If not found, look for table containing specific keywords in first column
      if (!linksTable) {
          const tables = Array.from(document.querySelectorAll("table"));
          for (const table of tables) {
              const text = table.innerText.toLowerCase();
              if ((text.includes("apply online") || text.includes("download result")) && text.includes("official website")) {
                  linksTable = table;
                  break;
              }
          }
      }
      
      // Strategy 3: Fallback to last table if not found explicitly (only if it looks like a link table)
      if (!linksTable) {
           const tables = Array.from(document.querySelectorAll("table"));
           if (tables.length > 0) {
               const lastTable = tables[tables.length - 1];
               if (lastTable.querySelectorAll('a').length > 2) {
                   linksTable = lastTable;
               }
           }
      }

      if (linksTable) {
           const rows = Array.from(linksTable.querySelectorAll("tr"));
           rows.forEach(row => {
               const cols = row.querySelectorAll("td");
               if (cols.length >= 2) {
                   let label = cols[0].innerText.trim();
                   // Clean up label (remove trailing colons, etc.)
                   label = label.replace(/[:\-\s]+$/, "");
                   
                   const anchor = cols[1].querySelector("a");
                   if (anchor) {
                       const linkUrl = anchor.href;
                       
                       // Filter invalid links
                       if (!linkUrl || linkUrl === "" || linkUrl === "#" || linkUrl.includes("javascript:")) return;
                       if (linkUrl === window.location.href) return;
                       if (baseUrl && (linkUrl === baseUrl || linkUrl === baseUrl + "/")) return;

                       job.importantLinks.push({
                           label: label,
                           url: linkUrl
                       });
                       
                       const lowerLabel = label.toLowerCase();
                       if (lowerLabel.includes("apply") && (lowerLabel.includes("online") || lowerLabel.includes("registration") || lowerLabel.includes("login"))) {
                           if (!job.applyOnline) job.applyOnline = linkUrl;
                       }
                       else if (lowerLabel.includes("notification") || lowerLabel.includes("advertisement") || lowerLabel.includes("brochure")) {
                           if (!job.downloadNotification) job.downloadNotification = linkUrl;
                       }
                       else if (lowerLabel.includes("official") && (lowerLabel.includes("website") || lowerLabel.includes("site"))) {
                           if (!job.officialWebsite) job.officialWebsite = linkUrl;
                       }
                   }
               }
           });
      }

      // --- FAQs ---
      const faqHeader = $$("h2, h3, h4").find((el) => el.innerText.toLowerCase().includes("faq") || el.innerText.toLowerCase().includes("frequently"));
      if (faqHeader) {
        let next = faqHeader.nextElementSibling;
        let limit = 20;
        while (next && limit--) {
          const text = next.innerText.trim();
          if (text.length > 20 && text.includes("?")) {
            const parts = text.split(/\?/);
            if (parts.length >= 2) {
              job.faqs.push({ question: clean(parts[0]) + "?", answer: clean(parts.slice(1).join("?")) });
            }
          }
          next = next.nextElementSibling;
        }
      }

      // Clean redundant empty arrays
      if (job.applicationFeeBullets.length === 0) delete job.applicationFeeBullets;
      if (job.ageLimitBullets.length === 0) delete job.ageLimitBullets;
      if (job.selectionProcess.length === 0) delete job.selectionProcess;
      if (job.howToApply.length === 0) delete job.howToApply;
      if (job.salary.length === 0) delete job.salary;
      if (job.faqs.length === 0) delete job.faqs;
      if (job.rawBulletSections && Object.keys(job.rawBulletSections).length === 0) delete job.rawBulletSections;

      return job;
    }, url, scrapedAt, CONFIG.baseUrl);
  }

  async saveData() {
    let data = Array.from(this.jobsData.values());
    // Sort by scrapedAt (oldest first); jobs without scrapedAt are treated as oldest
    data.sort((a, b) => {
      const da = a.scrapedAt || "";
      const db = b.scrapedAt || "";
      return da.localeCompare(db);
    });
    // Trim to max lines by removing oldest jobs first
    while (data.length > 0) {
      const str = JSON.stringify(data, null, 2);
      const lineCount = str.split("\n").length;
      if (lineCount <= CONFIG.maxJsonLines) break;
      const removed = data.shift();
      if (removed && removed.officialLink) this.jobsData.delete(removed.officialLink);
    }
    await fs.writeJson(CONFIG.jobsFile, data, { spaces: 2 });
  }
}

new MasterScraper().start();
