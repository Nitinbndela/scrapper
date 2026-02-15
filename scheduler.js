const cron = require("node-cron");
const { exec } = require("child_process");

cron.schedule("0 3 * * *", () => {
  console.log("Running daily scraper...");
  exec("node scraper.js");
});
