const degrees = [
  "b.tech",
  "b.e",
  "b.sc",
  "b.a",
  "b.com",
  "m.tech",
  "m.sc",
  "mba",
  "mbbs",
  "llb",
  "diploma",
  "10th",
  "12th"
];

function detectDegrees(text) {
  const found = [];

  const lower = text.toLowerCase();

  degrees.forEach(deg => {
    if (lower.includes(deg)) {
      found.push(deg.toUpperCase());
    }
  });

  return found;
}

module.exports = detectDegrees;
