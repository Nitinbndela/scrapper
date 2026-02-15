const puppeteer = require('puppeteer');
const fs = require('fs-extra');
const path = require('path');

const JOBS_FILE = path.join(__dirname, 'jobs.json');

(async () => {
  console.log('Starting detail scraper...');
  const browser = await puppeteer.launch({
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  
  // Set a standard user agent
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  try {
    if (!fs.existsSync(JOBS_FILE)) {
      console.error('jobs.json file not found.');
      return;
    }

    const jobs = await fs.readJson(JOBS_FILE);
    console.log(`Loaded ${jobs.length} jobs. Starting update process...`);

    let updatedCount = 0;

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      let isModified = false;

      // Ensure field exists
      if (!job.educationalQualification) {
          job.educationalQualification = "";
      }

      // STRATEGY 1: Extract from existing vacancyDetails (Fastest & Most Reliable)
      // Many jobs in your JSON already have eligibility in the vacancy table
      if ((!job.educationalQualification || job.educationalQualification.length < 10) && job.vacancyDetails && Array.isArray(job.vacancyDetails)) {
          const qualList = [];
          job.vacancyDetails.forEach(row => {
              Object.keys(row).forEach(key => {
                  // Look for keys like "eligibility", "qualification"
                  if (key.toLowerCase().includes('eligibility') || key.toLowerCase().includes('qualification')) {
                      const post = row['post name'] || row['Post Name'] || '';
                      const qual = row[key];
                      if (qual && qual.length > 5) {
                          // Format: "Post Name: Qualification"
                          qualList.push(post ? `${post}: ${qual}` : qual);
                      }
                  }
              });
          });
          
          if (qualList.length > 0) {
              // Join unique qualifications
              job.educationalQualification = [...new Set(qualList)].join('\n');
              console.log(`[JSON Extract] ${job.title.substring(0, 40)}... -> Added Qualification`);
              isModified = true;
          }
      }

      // STRATEGY 2: Scrape from website if still missing
      if ((!job.educationalQualification || job.educationalQualification.length < 5) && job.officialLink) {
          console.log(`[Scraping] ${i + 1}/${jobs.length}: ${job.title.substring(0, 40)}...`);
          
          try {
            await page.goto(job.officialLink, { waitUntil: 'domcontentloaded', timeout: 30000 });

            const scrapedData = await page.evaluate(() => {
              const data = {};
              const clean = (text) => text ? text.replace(/\s+/g, ' ').trim() : '';

              // Helper to find text after a header
              const getTextAfterHeader = (headerRegex) => {
                  const elements = Array.from(document.querySelectorAll('h2, h3, h4, strong, b, span, p, div'));
                  const header = elements.find(el => headerRegex.test(el.innerText));
                  if (header) {
                      // Try next sibling
                      let next = header.nextElementSibling;
                      if (next && next.innerText.trim().length > 5) return clean(next.innerText);
                      
                      // Try parent's next sibling (common in some layouts)
                      if (header.parentElement && header.parentElement.nextElementSibling) {
                          let pNext = header.parentElement.nextElementSibling;
                          if (pNext.innerText.trim().length > 5) return clean(pNext.innerText);
                      }
                  }
                  return null;
              };

              // 1. Post Date
              const bodyText = document.body.innerText;
              const dateMatch = bodyText.match(/(?:Published on|Post Date|Updated on)\s*:\s*([^\n]+)/i);
              if (dateMatch) data.postDate = clean(dateMatch[1]);

              // 2. Short Info
              data.shortInfo = getTextAfterHeader(/Short Information/i);

              // 3. Educational Qualification (Improved Selector)
              let edu = getTextAfterHeader(/(?:Eligibility|Qualification|Education)\s*:/i);
              
              // If header search failed, look for tables with "Eligibility" in them
              if (!edu) {
                  const tables = Array.from(document.querySelectorAll('table'));
                  for (const table of tables) {
                      if (table.innerText.toLowerCase().includes('eligibility')) {
                          // Extract text from table rows
                          const rows = Array.from(table.querySelectorAll('tr'));
                          // Skip header row usually
                          const textRows = rows.slice(1).map(r => r.innerText.trim()).filter(t => t.length > 5);
                          if (textRows.length > 0) {
                              edu = textRows.join('\n');
                              break;
                          }
                      }
                  }
              }
              data.educationalQualification = edu;

              return data;
            });

            if (scrapedData.postDate && !job.postDate) { job.postDate = scrapedData.postDate; isModified = true; }
            if (scrapedData.shortInfo && !job.shortInfo) { job.shortInfo = scrapedData.shortInfo; isModified = true; }
            if (scrapedData.educationalQualification) { job.educationalQualification = scrapedData.educationalQualification; isModified = true; }

          } catch (err) {
            console.error(`   -> Failed to scrape: ${err.message}`);
          }
      }

      if (isModified) updatedCount++;

      // Periodic Save (Every 10 jobs) to prevent data loss on crash
      if (i % 10 === 0 || i === jobs.length - 1) {
          await fs.writeJson(JOBS_FILE, jobs, { spaces: 2 });
          if (i % 10 === 0) console.log(`   [Saved] Progress: ${i}/${jobs.length}`);
      }
    }

    console.log(`Scraping completed. Updated ${updatedCount} jobs.`);

  } catch (error) {
    console.error('Fatal error:', error);
  } finally {
    await browser.close();
  }
})();
