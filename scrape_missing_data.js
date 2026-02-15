const puppeteer = require('puppeteer');
const fs = require('fs-extra');
const path = require('path');

const JOBS_FILE = path.join(__dirname, 'jobs.json');

(async () => {
  console.log('Starting missing data scraper (v3)...');
  const browser = await puppeteer.launch({
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  try {
    if (!fs.existsSync(JOBS_FILE)) {
      console.error('jobs.json file not found.');
      return;
    }

    const jobs = await fs.readJson(JOBS_FILE);
    console.log(`Loaded ${jobs.length} jobs. Scanning for missing details...`);

    let updatedCount = 0;

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      
      // Check if critical fields are missing
      const needsUpdate = !job.postDate || !job.shortInfo || 
                          Object.keys(job.importantDates || {}).length === 0 || 
                          Object.keys(job.applicationFee || {}).length === 0;

      if (needsUpdate && job.officialLink) {
        console.log(`Processing [${i + 1}/${jobs.length}]: ${job.title.substring(0, 40)}...`);
        
        try {
          await page.goto(job.officialLink, { waitUntil: 'domcontentloaded', timeout: 45000 });

          const scrapedData = await page.evaluate(() => {
            const data = {
                postDate: "",
                shortInfo: "",
                importantDates: {},
                applicationFee: {},
                ageLimit: {}
            };
            
            const clean = (text) => text ? text.replace(/\s+/g, ' ').trim() : '';

            // 1. Scrape Post Date
            const bodyText = document.body.innerText;
            const dateMatch = bodyText.match(/(?:Post Date|Updated on|Notification Date)\s*[:/-]?\s*([0-9]{1,2}\s+[A-Za-z]+\s+[0-9]{4})/i);
            if (dateMatch) {
                data.postDate = clean(dateMatch[1]);
            }

            // 2. Scrape Short Information
            const headers = Array.from(document.querySelectorAll('h2, h3, h4, strong, b, span'));
            const shortInfoHeader = headers.find(el => el.innerText.toLowerCase().includes('short information'));
            
            if (shortInfoHeader) {
                let content = shortInfoHeader.nextSibling;
                let attempts = 0;
                while(attempts < 5 && content) {
                    if (content.nodeType === 3 && content.textContent.trim().length > 10) {
                        data.shortInfo = clean(content.textContent);
                        break;
                    }
                    if (content.nodeType === 1 && content.innerText.trim().length > 10) {
                        data.shortInfo = clean(content.innerText);
                        break;
                    }
                    content = content.nextSibling;
                    attempts++;
                }
            }

            // 3. Scrape Sections with Exclusion Logic
            const extractSection = (keywords, excludeKeywords = []) => {
                const result = {};
                const elements = Array.from(document.querySelectorAll('td, li, p, div'));
                
                const container = elements.find(el => {
                    const text = el.innerText.toLowerCase();
                    return keywords.some(k => text.includes(k)) && text.length < 100;
                });

                if (container) {
                    const table = container.closest('table');
                    if (table) {
                        const rows = Array.from(table.querySelectorAll('tr'));
                        rows.forEach(row => {
                            const text = row.innerText.trim();
                            if (text.includes(':')) {
                                const parts = text.split(':');
                                const key = clean(parts[0]);
                                const val = clean(parts.slice(1).join(':'));
                                
                                // Logic to exclude unwanted keys
                                const isExcluded = excludeKeywords.some(ex => key.toLowerCase().includes(ex));
                                const isHeader = keywords.some(k => key.toLowerCase().includes(k));

                                if (!isHeader && !isExcluded && key.length < 50 && val.length > 1) {
                                    result[key] = val;
                                }
                            }
                        });
                    } else {
                        let sibling = container.nextElementSibling;
                        let limit = 0;
                        while(sibling && limit < 10) {
                            const text = sibling.innerText.trim();
                            if (text.includes(':')) {
                                const parts = text.split(':');
                                const key = clean(parts[0]);
                                const val = clean(parts.slice(1).join(':'));
                                
                                const isExcluded = excludeKeywords.some(ex => key.toLowerCase().includes(ex));
                                
                                if (!isExcluded && key.length < 50 && val.length > 1) {
                                    result[key] = val;
                                }
                            }
                            sibling = sibling.nextElementSibling;
                            limit++;
                        }
                    }
                }
                return result;
            };

            // Updated Exclusion Logic:
            // Dates: Exclude 'age' and 'fee'
            data.importantDates = extractSection(['important dates', 'application dates'], ['age', 'fee']);
            
            // Fee: Exclude 'age', 'notification', 'date'
            data.applicationFee = extractSection(['application fee', 'exam fee'], ['age', 'notification', 'date', 'important']);
            
            // Age: Exclude 'fee', 'notification', 'date'
            data.ageLimit = extractSection(['age limit'], ['fee', 'notification', 'date', 'important']);

            return data;
          });

          let modified = false;
          if (scrapedData.postDate && !job.postDate) { job.postDate = scrapedData.postDate; modified = true; }
          if (scrapedData.shortInfo && !job.shortInfo) { job.shortInfo = scrapedData.shortInfo; modified = true; }
          
          if (Object.keys(scrapedData.importantDates).length > 0) { 
              job.importantDates = { ...job.importantDates, ...scrapedData.importantDates }; 
              modified = true; 
          }
          if (Object.keys(scrapedData.applicationFee).length > 0) { 
              job.applicationFee = { ...job.applicationFee, ...scrapedData.applicationFee }; 
              modified = true; 
          }
          if (Object.keys(scrapedData.ageLimit).length > 0) { 
              job.ageLimit = { ...job.ageLimit, ...scrapedData.ageLimit }; 
              modified = true; 
          }

          if (modified) {
              updatedCount++;
              console.log(`   -> Updated details for ${job.title.substring(0, 20)}...`);
          }

        } catch (err) {
          console.error(`   -> Failed to scrape: ${err.message}`);
        }
      }

      if (i % 5 === 0 || i === jobs.length - 1) {
          await fs.writeJson(JOBS_FILE, jobs, { spaces: 2 });
      }
    }

    console.log(`Scraping completed. Updated ${updatedCount} jobs.`);

  } catch (error) {
    console.error('Fatal error:', error);
  } finally {
    await browser.close();
  }
})();
