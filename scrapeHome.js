process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const axios = require("axios");
const cheerio = require("cheerio");

const URL = "https://sarkariresult.com.im/";

async function scrapeHome() {
  const { data } = await axios.get(URL);
  const $ = cheerio.load(data);

  const links = [];
  const seen = new Set();

  $("a").each((i, el) => {
    const title = $(el).text().trim();
    const link = $(el).attr("href");

    if (!title || !link) return;

    if (
      title.toLowerCase().includes("recruitment") ||
      title.toLowerCase().includes("vacancy") ||
      title.toLowerCase().includes("apply")
    ) {
      if (!seen.has(link)) {
        seen.add(link);
        links.push({ title, link });
      }
    }
  });

  return links;
}

module.exports = scrapeHome;
