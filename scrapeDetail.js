const axios = require("axios");
const cheerio = require("cheerio");
const slugify = require("slugify");

async function scrapeJob(url) {
  try {
    const { data } = await axios.get(url);
    const $ = cheerio.load(data);

    const title = $("h1").first().text().trim();

    const job = {
      slug: slugify(title, { lower: true }),
      title,
      category: "jobs",
      importantDates: {},
      applicationFee: {},
      ageLimit: {},
      vacancyDetails: [],
      eligibility: [],
      officialLink: url
    };

    // Important Dates
    $("li").each((i, el) => {
      const text = $(el).text();
      if (text.toLowerCase().includes("last date")) {
        job.importantDates.lastDate = text;
      }
    });

    // Age Limit
    $("li").each((i, el) => {
      const text = $(el).text().toLowerCase();
      if (text.includes("minimum")) {
        job.ageLimit.min = text.replace(/[^0-9]/g, "");
      }
      if (text.includes("maximum")) {
        job.ageLimit.max = text.replace(/[^0-9]/g, "");
      }
    });

    // Vacancy Table
    $("table tr").each((i, row) => {
      const cols = $(row).find("td");
      if (cols.length >= 3) {
        job.vacancyDetails.push({
          postName: $(cols[0]).text().trim(),
          totalPosts: $(cols[1]).text().trim(),
          qualification: $(cols[2]).text().trim()
        });
      }
    });

    return job;
  } catch (err) {
    console.log("Error scraping:", url);
    return null;
  }
}

module.exports = scrapeJob;
