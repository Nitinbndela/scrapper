const puppeteer = require("puppeteer");
const fs = require("fs-extra");
const path = require("path");

// Configuration
const CONFIG = {
  baseUrl: "https://sarkariresult.com.im/",
  jobsFile: path.join(__dirname, "jobs.json"),
  concurrency: 5, // Number of parallel tabs
  timeout: 60000, // 60 seconds timeout
  scrapeInterval: 60 * 60 * 1000, // 1 hour
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  maxQueueSize: 10000 // Prevent memory overflow
};

class AdvancedScraper {
  constructor() {
    this.browser = null;
    this.queue = new Set([CONFIG.baseUrl]); // URLs to visit
    this.visited = new Set(); // URLs already visited
    this.jobsData = new Map(); // Store scraped jobs (URL -> Data)
    this.isRunning = false;
  }

  async init() {
    console.log("Initializing Advanced Scraper Engine...");
    
    // Load existing data to prevent re-scraping
    try {
      if (await fs.pathExists(CONFIG.jobsFile)) {
        const existing = await fs.readJson(CONFIG.jobsFile);
        existing.forEach(job => {
          if (job.officialLink) {
            this.jobsData.set(job.officialLink, job);
            this.visited.add(job.officialLink);
          }
        });
        console.log(`Loaded ${this.jobsData.size} existing jobs from database.`);
      }
    } catch (e) {
      console.log("Starting with a fresh database.");
    }

    this.browser = await puppeteer.launch({
      headless: "new",
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
    console.log("Starting Crawl...");

    while (this.queue.size > 0 && this.isRunning) {
      // Process URLs in batches for concurrency
      const batch = Array.from(this.queue).slice(0, CONFIG.concurrency);
      
      // Mark as visited immediately to prevent duplicates in next batch
      batch.forEach(url => {
        this.queue.delete(url);
        this.visited.add(url);
      });

      if (batch.length === 0) break;

      console.log(`Processing batch of ${batch.length} URLs. (Queue: ${this.queue.size}, Visited: ${this.visited.size})`);

      await Promise.all(batch.map(url => this.processUrl(url)));

      // Incremental Save
      await this.saveData();
    }

    console.log("Crawl cycle complete.");
    await this.saveData();
    await this.browser.close();

    console.log(`Sleeping for ${CONFIG.scrapeInterval / 60000} minutes...`);
    setTimeout(() => new AdvancedScraper().start(), CONFIG.scrapeInterval);
  }

  async processUrl(url) {
    let page = null;
    try {
      page = await this.browser.newPage();
      
      // Optimization: Block images, fonts, css to speed up scraping
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
          req.abort();
        } else {
          req.continue();
        }
      });

      await page.setUserAgent(CONFIG.userAgent);
      
      // Stealth: Hide webdriver property
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: CONFIG.timeout });

      // 1. Discovery: Find new links on this page
      const links = await page.evaluate((baseUrl) => {
        return Array.from(document.querySelectorAll("a"))
          .map(a => a.href)
          .filter(href => href.startsWith(baseUrl) && !href.includes("#") && !href.includes("javascript:"));
      }, CONFIG.baseUrl);

      links.forEach(link => {
        if (!this.visited.has(link) && !this.queue.has(link) && this.queue.size < CONFIG.maxQueueSize) {
          this.queue.add(link);
        }
      });

      // 2. Extraction: If it's a job page, scrape details
      const isJob = await this.isJobPage(page);
      if (isJob) {
        const jobData = await this.scrapeJobDetails(page, url);
        if (jobData && jobData.title) {
          this.jobsData.set(url, jobData);
          console.log(`[SCRAPED] ${jobData.title}`);
        }
      }

    } catch (err) {
      // console.error(`Failed to process ${url}: ${err.message}`);
    } finally {
      if (page) await page.close();
    }
  }

  async isJobPage(page) {
    // Heuristic: Check if page has typical job headers
    return await page.evaluate(() => {
      const h1 = document.querySelector("h1");
      if (!h1) return false;
      const text = h1.innerText.toLowerCase();
      const keywords = ["recruitment", "vacancy", "apply", "form", "result", "admit card", "answer key", "syllabus", "admission", "notification"];
      return keywords.some(k => text.includes(k));
    });
  }

  async scrapeJobDetails(page, url) {
    return await page.evaluate((currentUrl) => {
      const title = document.querySelector("h1")?.innerText.trim() || "";
      
      // Auto-Categorization
      let category = "Latest Jobs";
      const lowerTitle = title.toLowerCase();
      if (lowerTitle.includes("result")) category = "Result";
      else if (lowerTitle.includes("admit card")) category = "Admit Card";
      else if (lowerTitle.includes("answer key")) category = "Answer Key";
      else if (lowerTitle.includes("syllabus")) category = "Syllabus";
      else if (lowerTitle.includes("admission")) category = "Admission";

      const jobObj = {
        title,
        category,
        postDate: "",
        shortInfo: "",
        importantDates: {},
        applicationFee: {},
        ageLimit: {},
        educationalQualification: "",
        vacancyDetails: [],
        importantLinks: [],
        applyOnline: "",
        downloadNotification: "",
        officialWebsite: "",
        officialLink: currentUrl
      };

      // Robust Section Extractor
      const extractSection = (headerText, targetObj) => {
        // Find header element (h2, h3, b, strong, etc.)
        const allElements = Array.from(document.querySelectorAll("h2, h3, h4, b, strong, p, span, div, th, td"));
        const header = allElements.find(el => {
            const text = el.innerText?.trim().toLowerCase() || "";
            return text.includes(headerText.toLowerCase()) && text.length < 50;
        });

        if (!header) return;

        // 1. Check for a list (ul/ol) immediately following the header or its parent
        let next = header.nextElementSibling;
        if (!next && header.parentElement) next = header.parentElement.nextElementSibling;
        
        if (next && (next.tagName === 'UL' || next.tagName === 'OL')) {
            Array.from(next.querySelectorAll('li')).forEach(li => {
                const parts = li.innerText.split(/:(.+)/);
                if (parts.length >= 2) {
                    targetObj[parts[0].trim()] = parts[1].trim();
                }
            });
            return;
        }

        // 2. Fallback: Check parent container (div/td) for text lines
        let container = header.closest('td') || header.closest('div') || header.parentElement;
        if (container) {
          const lines = container.innerText.split('\n');
          let capturing = false;
          lines.forEach(line => {
            const clean = line.trim();
            if (clean.toLowerCase().includes(headerText.toLowerCase())) {
                capturing = true;
                return; 
            }
            // Stop capturing if we hit another section header
            if (capturing && (clean.toLowerCase().includes("application fee") || clean.toLowerCase().includes("age limit") || clean.toLowerCase().includes("vacancy"))) {
                if (!clean.toLowerCase().includes(headerText.toLowerCase())) capturing = false;
            }
            
            if (capturing && clean.includes(':')) {
                const parts = clean.split(/:(.+)/);
                if (parts.length >= 2) {
                    targetObj[parts[0].trim()] = parts[1].trim();
                }
            }
          });
        }
      };

      extractSection('Important Dates', jobObj.importantDates);
      extractSection('Application Fee', jobObj.applicationFee);
      extractSection('Age Limit', jobObj.ageLimit);

      // Extract Educational Qualification
      const qualHeader = Array.from(document.querySelectorAll("h2, h3, h4, b, strong, p, span")).find(el => {
          const text = el.innerText?.trim().toLowerCase() || "";
          return (text.includes("eligibility") || text.includes("qualification")) && !text.includes("age") && text.length < 50;
      });
      if (qualHeader) {
          let next = qualHeader.nextElementSibling;
          while(next && next.innerText.trim().length < 5) next = next.nextElementSibling;
          if (next) jobObj.educationalQualification = next.innerText.trim();
      }

      // Extract Post Date
      const dateEl = Array.from(document.querySelectorAll('li, p, div')).find(el => el.innerText.includes('Post Date / Update:'));
      if (dateEl) {
          jobObj.postDate = dateEl.innerText.replace('Post Date / Update:', '').trim();
      }

      // Extract Short Info
      const shortInfoEl = Array.from(document.querySelectorAll('p')).find(el => el.innerText.includes('Short Information :'));
      if (shortInfoEl) {
           jobObj.shortInfo = shortInfoEl.innerText.replace('Short Information :', '').trim();
      }

      // Extract Vacancy Tables
      const tables = Array.from(document.querySelectorAll("table"));
      tables.forEach(table => {
          const rows = Array.from(table.querySelectorAll("tr"));
          if (rows.length < 2) return;

          // Determine headers from first row (th or td)
          const headerCells = Array.from(rows[0].querySelectorAll("th, td"));
          const headers = headerCells.map(c => c.innerText.trim().toLowerCase());

          // Heuristic: Check if this looks like a vacancy table
          if (headers.some(h => h.includes("post") || h.includes("vacancy") || h.includes("eligibility") || h.includes("total") || h.includes("trade"))) {
              rows.slice(1).forEach(row => {
                  const cols = Array.from(row.querySelectorAll("td"));
                  if (cols.length > 0) {
                      const rowData = {};
                      cols.forEach((col, idx) => {
                          const key = headers[idx] || `col${idx}`;
                          rowData[key] = col.innerText.trim();
                      });
                      if (Object.keys(rowData).length > 0) jobObj.vacancyDetails.push(rowData);
                  }
              });
          }
      });

      // Fallback: Extract Educational Qualification from Vacancy Details if missing
      if (!jobObj.educationalQualification && jobObj.vacancyDetails.length > 0) {
          const qualList = [];
          jobObj.vacancyDetails.forEach(row => {
              Object.keys(row).forEach(key => {
                  if (key.toLowerCase().includes('eligibility') || key.toLowerCase().includes('qualification')) {
                      const post = row['post name'] || row['Post Name'] || '';
                      const qual = row[key];
                      if (qual && qual.length > 5) {
                          qualList.push(post ? `${post}: ${qual}` : qual);
                      }
                  }
              });
          });
          if (qualList.length > 0) {
              jobObj.educationalQualification = [...new Set(qualList)].join('\n');
          }
      }

      // Extract Important Links (Smart Search)
      let linksTable = null;
      for (const table of tables) {
          if (table.innerText.toLowerCase().includes("important link") || 
              table.innerText.toLowerCase().includes("useful link")) {
              linksTable = table;
              break;
          }
          // Check previous sibling for header
          let prev = table.previousElementSibling;
          while(prev && prev.tagName !== 'TABLE') {
              if (prev.innerText && prev.innerText.toLowerCase().includes("important link")) {
                  linksTable = table;
                  break;
              }
              prev = prev.previousElementSibling;
          }
          if (linksTable) break;
      }
      
      // Fallback to last table if not found explicitly
      if (!linksTable && tables.length > 0) {
           linksTable = tables[tables.length - 1];
      }

      if (linksTable) {
           const rows = Array.from(linksTable.querySelectorAll("tr"));
           rows.forEach(row => {
               const cols = row.querySelectorAll("td");
               if (cols.length >= 2) {
                   const label = cols[0].innerText.trim();
                   const anchor = cols[1].querySelector("a");
                   if (anchor) {
                       const linkUrl = anchor.href;
                       
                       // Filter invalid links
                       if (!linkUrl || linkUrl === "" || linkUrl === "#" || linkUrl.includes("javascript:")) return;
                       if (linkUrl === window.location.href) return;

                       jobObj.importantLinks.push({
                           label: label,
                           url: linkUrl
                       });
                       
                       const lowerLabel = label.toLowerCase();
                       if (lowerLabel.includes("apply") && (lowerLabel.includes("online") || lowerLabel.includes("click here"))) {
                           if (!jobObj.applyOnline) jobObj.applyOnline = linkUrl;
                       }
                       if (lowerLabel.includes("notification") || lowerLabel.includes("advertisement") || lowerLabel.includes("brochure")) {
                           if (!jobObj.downloadNotification) jobObj.downloadNotification = linkUrl;
                       }
                       if (lowerLabel.includes("official") && (lowerLabel.includes("website") || lowerLabel.includes("site"))) {
                           if (!jobObj.officialWebsite) jobObj.officialWebsite = linkUrl;
                       }
                   }
               }
           });
      }

      return jobObj;
    }, url);
  }

  async saveData() {
    const data = Array.from(this.jobsData.values());
    await fs.writeJson(CONFIG.jobsFile, data, { spaces: 2 });
  }
}

new AdvancedScraper().start();
