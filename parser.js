const slugify = require("slugify");
const detectDegrees = require("./degreeDetector");

async function parseJob(page, url) {
  return await page.evaluate((url) => {
    const title = document.querySelector("h1")?.innerText || "";

    const job = {
      slug: title.toLowerCase().replace(/\s+/g, "-"),
      title,
      importantDates: {},
      applicationFee: {},
      ageLimit: {},
      vacancyDetails: [],
      eligibilityText: "",
      officialLink: url
    };

    const fullText = document.body.innerText;

    job.eligibilityText = fullText;

    const tables = document.querySelectorAll("table");

    tables.forEach(table => {
      const rows = table.querySelectorAll("tr");

      rows.forEach(row => {
        const cols = row.querySelectorAll("td");
        if (cols.length >= 3) {
          job.vacancyDetails.push({
            postName: cols[0].innerText.trim(),
            totalPosts: cols[1].innerText.trim(),
            qualification: cols[2].innerText.trim()
          });
        }
      });
    });

    return job;
  }, url);
}

module.exports = parseJob;
