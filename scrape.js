// TEMP SSL FIX (only for testing)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");

async function scrape() {
  try {
    console.log("Scraper started...");

    const { data } = await axios.get("https://sarkariresult.com.im/", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });

    const $ = cheerio.load(data);

    const jobs = [];

    $("a").each((i, el) => {
      const title = $(el).text().trim();
      const link = $(el).attr("href");

      if (title && link) {
        jobs.push({
          title,
          link
        });
      }
    });

    // Save to JSON file
    fs.writeFileSync("jobs.json", JSON.stringify(jobs, null, 2));

    console.log("Scraping completed ✅");
    console.log("Data saved to jobs.json");
    console.log("Total items scraped:", jobs.length);

  } catch (error) {
    console.error("Error occurred ❌");
    console.error(error.message);
  }
}

scrape();
