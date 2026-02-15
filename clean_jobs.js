const fs = require('fs-extra');
const path = require('path');

const JOBS_FILE = path.join(__dirname, 'jobs.json');

(async () => {
  try {
    if (!fs.existsSync(JOBS_FILE)) {
      console.error('jobs.json file not found.');
      return;
    }

    const jobs = await fs.readJson(JOBS_FILE);
    console.log(`Scanning ${jobs.length} jobs for redundant Notification/Date fields...`);

    let updatedCount = 0;

    jobs.forEach(job => {
      let isModified = false;

      // 1. Clean Application Fee
      if (job.applicationFee) {
        Object.keys(job.applicationFee).forEach(key => {
          const lowerKey = key.toLowerCase();
          // Remove keys containing 'notification' or 'date' from Fee section
          if (lowerKey.includes('notification') || lowerKey.includes('date') || lowerKey.includes('application start')) {
            delete job.applicationFee[key];
            isModified = true;
          }
        });
      }

      // 2. Clean Age Limit
      if (job.ageLimit) {
        Object.keys(job.ageLimit).forEach(key => {
          const lowerKey = key.toLowerCase();
          // Remove keys containing 'notification' or 'date' or 'fee' from Age section
          if (lowerKey.includes('notification') || lowerKey.includes('date') || lowerKey.includes('application start') || lowerKey.includes('fee')) {
            delete job.ageLimit[key];
            isModified = true;
          }
        });
      }

      if (isModified) {
        updatedCount++;
      }
    });

    if (updatedCount > 0) {
      await fs.writeJson(JOBS_FILE, jobs, { spaces: 2 });
      console.log(`Successfully cleaned ${updatedCount} jobs.`);
    } else {
      console.log('No redundant fields found.');
    }

  } catch (error) {
    console.error('Error cleaning jobs.json:', error);
  }
})();
