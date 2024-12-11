// Fetch issues from chromium bugganizer.
// We use puppeter to fetch the page.
import fs from 'fs'
import puppeteer from 'puppeteer'
import spawn from 'child_process'

const loadDatabase = () => {
  try {
    const data = JSON.parse(fs.readFileSync('../public/cve/data.json', 'utf8'))
    const values = Object.values(data);
    return values.filter(cve => cve.id).sort((a, b) => a.id - b.id)
  } catch (e) {
    return {}
  }
}

const saveDatabase = (database) => {
  fs.mkdirSync('../data/cve', { recursive: true });
  fs.writeFileSync('../public/cve/data.json', JSON.stringify(database, null, 1))
}

// Execute a command, and log its output.
const exec = async (command, args, options) => {
  console.log(`Running: ${command} ${args.join(' ')}`)
  const child = spawn.spawn(command, args, options)
  child.stdout.on('data', (data) => {
    console.log(`stdout: ${data}`)
  });
  child.stderr.on('data', (data) => {
    console.error(`stderr: ${data}`)
  });
  await new Promise((resolve, error) => {
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        error(new Error(`git process exited with code ${code}`))
      }
    })
  })
  console.log(`Finished: ${command} ${args.join(' ')}`)
}

// Fetch the CVE github repository.
const fetchCveRepository = async () => {
  // If the repository already exists, fetch the latest changes.
  if (fs.existsSync('/tmp/cvelist')) {
    await exec('git', ['pull'], { cwd: '/tmp/cvelist' })

    return
  }

  // Otherwise, clone the repository.
  await exec('git', [
    'clone',
    '--depth=1',
    'https://github.com/CVEProject/cvelistV5',
    '/tmp/cvelist'
  ])
}

// Iterate over the CVEs in the repository.
const iterateCVE = function* () {
  for (const year of fs.readdirSync('/tmp/cvelist/cves')) {
    if (!fs.statSync(`/tmp/cvelist/cves/${year}`).isDirectory()) {
      continue;
    }

    for (const subsection of fs.readdirSync(`/tmp/cvelist/cves/${year}`)) {
      if (!fs.statSync(`/tmp/cvelist/cves/${year}/${subsection}`).isDirectory()) {
        continue;
      }

      for (const file of fs.readdirSync(`/tmp/cvelist/cves/${year}/${subsection}`)) {
        const cve = JSON.parse(fs.readFileSync(`/tmp/cvelist/cves/${year}/${subsection}/${file}`, 'utf8'))
        yield cve;
      }
    }
  }
}

// Check if the CVE is related to Chromium.
const cveIsChromium = (cve) => {
  if (cve.cveMetadata.assignerShortName != "Chrome") {
    return false;
  }

  if (!cve.containers?.cna?.affected) {
    return false;
  }

  for (const affected of cve.containers.cna.affected) {
    const product = affected.product?.toLowerCase() || ''
    const vendor = affected.vendor?.toLowerCase() || ''
    if ((product.includes('chrome') || product.includes('chromium')) &&
      (vendor.includes('google'))) {
      return true;
    }

    // Old CVE from 2018- are not properly tagged. They are using product="n/a"
    // and "vendor"="n/a"
    if (affected.product == "n/a" && affected.vendor == "n/a") {
      return true;
    }
  }

  return false;
}

const cveIsPublished = (cve) => {
  return cve.cveMetadata.state === "PUBLISHED";
}

const urlIsChromiumBugTracker = (url) => {
  return url.includes("issues.chromium.org") ||
    url.includes('crbug.com') ||
    url.includes('bugs.chromium.org') ||
    ( url.includes("code.google.com") && url.includes("chromium") && url.includes("issues") );
}

const urlIsChromiumCodeReview = (url) => {
  return url.includes("chromium.googlesource.com") ||
    url.includes("codereview.chromium.org") ||
    url.includes("src.chromium.org");
}

const normalizeCve = (cve) => {
  // Fill in the fields if they are missing.
  cve.containers.cna ||= {};
  cve.containers.cna.problemTypes ||= [];
  cve.containers.cna.problemTypes[0] ||= {};
  cve.containers.cna.problemTypes[0].descriptions ||= [];
  cve.containers.cna.problemTypes[0].descriptions[0] ||= {};
  cve.containers.cna.problemTypes[0].descriptions[0].description ||= '';
  cve.containers.cna.problemTypes[0].descriptions[0].cweId ||= '';
  cve.containers.cna.references ||= [];
  cve.containers.cna.affected ||= [];
  cve.containers.cna.descriptions ||= [];
  cve.containers.adp ||= [];
  cve.containers.adp[0] ||= {};
  cve.containers.adp[0].problemTypes ||= [];
  cve.containers.adp[0].problemTypes[0] ||= {};
  cve.containers.adp[0].problemTypes[0].descriptions ||= [];
  cve.containers.adp[0].problemTypes[0].descriptions[0] ||= {};
  cve.containers.adp[0].problemTypes[0].descriptions[0].cweId ||= '';
  cve.containers.adp[0].problemTypes[0].descriptions[0].description ||= '';
}

let version_history = null;
const fetchVersionHistory = async () => {
  console.log("Fetching version history")

  // For local dev, load the file from disk, if any.
  if (fs.existsSync('version_history.json')) {
    version_history = JSON.parse(fs.readFileSync('version_history.json', 'utf8'))
    return;
  }

  version_history = {}
  for(const channel of ['extended', 'stable', 'beta', 'dev', 'canary']) {
    console.log(`Fetching version history for ${channel}`)
    const url = `https://versionhistory.googleapis.com/v1/chrome/platforms/all/channels/${channel}/versions/all/releases`;
    const response = await fetch(url);
    const json = await response.json();
    version_history[channel] = json;
  }

  // Write json to file.
  fs.writeFileSync('version_history.json', JSON.stringify(version_history, null, 1))
}

const getChromiumReleaseDate = (version) => {
  const out = {};
  for (const channel in version_history) {
    for (const release of version_history[channel].releases) {
      if (release.version == version) {
        out[channel] = release.serving.startTime;
        break;
      }
    }
  }
  return out;
}

const chromiumSeverity = (description) => {
  const match = description.match(/security severity: (\w+)\)/);
  if (match) {
    return match[1];
  } else {
    return "";
  }
}

// Extract the relevant fields from the CVE.
const transformCve = (cve) => {
  normalizeCve(cve)

  // Extract the Chromium bug URLs.
  let bug = "n/a"
  for(const reference of cve.containers.cna.references) {
    if (urlIsChromiumBugTracker(reference.url)) {
      bug = reference.url;
    }
  }

  let description = "n/a";
  for(const d of cve.containers.cna.descriptions) {
    description = d.value;
  }

  let version_fixed = "n/a";
  for (const affected of cve.containers.cna.affected) {
    if (affected.product?.toLowerCase().includes('chrome')) {
      for (const version of affected.versions) {
        version_fixed = version.version;
      }
    }
  }

  // If the version is not specified, it might be part of the description.
  if (version_fixed == 'unspecified') {
    const match = description.match(/\b\d+\.\d+\.\d+\.\d+/);
    if (match) {
      version_fixed = match[0];
    }
  }

  if (version_fixed.startsWith('prior to ')) {
    version_fixed = version_fixed.replace('prior to ', '');
  }

  //const proposedCweId = cve.containers.adp[0].prolemTypes[0].descriptions[0].cweId;
  const cweId =
    cve.containers.adp[0].problemTypes[0].descriptions[0].cweId.replace('CWE-', '') ||
    cve.containers.cna.problemTypes[0].descriptions[0].cweId.replace('CWE-', '');

  const problem =
    cve.containers.adp[0].problemTypes[0].descriptions[0].description ||
    cve.containers.cna.problemTypes[0].descriptions[0].description;

  const version_dates = getChromiumReleaseDate(version_fixed);

  return {
    id: cve.cveMetadata.cveId.replace('CVE-', ''),
    cweId,
    problem: cve.containers.cna.problemTypes[0].descriptions[0].description,
    bug,
    description,
    published: cve.cveMetadata.datePublished,
    version_fixed,
    version_dates,
    severity: chromiumSeverity(description),
  };
}

const retrieveCveList = async (database) => {
  await fetchCveRepository()

  const cves = {}
  for (const cve of iterateCVE()) {
    if (!cveIsPublished(cve)) {
      continue;
    }

    if (!cveIsChromium(cve)) {
      continue;
    }

    const transformed = transformCve(cve)

    // Skip entries that have already been processed.
    if (database.find(entry => entry.id == transformed.id)) {
      continue;
    }

    console.log("Adding CVE", transformed.id)
    database.push(transformed)
  }
}

const fetchBugganizer = async (cve, page) => {
  const url = cve.bug
  console.log("Fetching", url)

  await page.goto(url)

  await page.waitForFunction(() => {
    labels = Array.from(document.querySelectorAll('label')).map(el => el.textContent.trim());
    return labels.includes('vrp-reward');
  }, { timeout: 3000 });

  // Search for the cve value to confirm.
  const extracted = await page.evaluate(() => {
    const out = {
      cve: null,
      vrp_reward: null,
      components: [],
      found_in: null,
      security_release: null,
      oses: [],
      errors: [],
      chromium_labels: [],
      bug_date: null,
      severity: null,
    }

    for(const el of document.querySelectorAll('label')) {
      if (!el.textContent) {
        continue
      }

      try {
        // CVE
        if (el.textContent == ' CVE ') {
          out.cve = el.parentElement.parentElement.querySelector('span').textContent;
        }

        // vrp-reward
        if (el.textContent == ' vrp-reward ') {
          out.vrp_reward = el.parentElement.parentElement.querySelector('span').textContent;
        }

        // Component Tags
        if (el.textContent == ' Component Tags ') {
          out.components = Array.from(el.parentElement.parentElement.querySelectorAll('a')).map(el => el.textContent.trim());
        }

        // Found In
        if (el.textContent == ' Found In ') {
          out.found_in = el.parentElement.parentElement.querySelector('span').textContent;
        }

        // Security Release
        if (el.textContent == ' Security_Release ') {
          out.security_release = el.parentElement.parentElement.querySelector('span').textContent;
        }

        // OS
        if (el.textContent == ' OS ') {
          //out.os = el.parentElement.parentElement.querySelector('span').textContent;
          out.oses = Array.from(el.parentElement.parentElement.querySelectorAll('span'))
            .map(el => el.textContent)
            .filter(el => el.length > 0)
            .filter(el => !el.startsWith('Add'))
            .filter(el => !el.startsWith('Remove'))
            .filter(el => !el.startsWith('Edit'))
            .filter(el => !el.includes('('));
        }

        // Chromium Labels
        if (el.textContent == ' Chromium Labels ') {
          out.chromium_labels = Array
            .from(el.parentElement.parentElement.querySelectorAll('span'))
            .map(el => el.textContent)
            .filter(el => el.length > 0)
            .filter(el => !el.startsWith('Add'))
            .filter(el => !el.startsWith('Remove'))
            .filter(el => !el.startsWith('Edit'))
            .filter(el => !el.includes('('));
        }

        // Severity
        if (el.textContent == ' Severity ') {
          const severity = el.parentElement.parentElement.querySelector('span').textContent;
          switch(severity) {
            case 'S0': out.severity = "Critical"; break;
            case 'S1': out.severity = "High"; break;
            case 'S2': out.severity = "Medium"; break;
            case 'S3': out.severity = "Low"; break;
            case 'S4': out.severity = "None"; break;
          }
        }

      } catch (e) {
        out.errors.push("Error reading " + el.textContent);
      }
    }

    // Extract the bug open date.
    const bug_date = document.querySelector('time').getAttribute('datetime');
    out.bug_date = bug_date;

    return out;
  })

  console.log("Extracted:")
  console.log(extracted)
  if (extracted.cve && extracted.cve != cve.id) {
    console.log("CVE mismatch", extracted.cve, cve.id);
    return;
  }

  cve.id = extracted.cve;
  if (parseInt(extracted.vrp_reward) > 0) {
    cve.vrp_reward = extracted.vrp_reward;
  }
  cve.components = extracted.components;
  cve.found_in = extracted.found_in;
  cve.security_release = extracted.security_release;
  cve.oses = extracted.oses;
  cve.chromium_labels = extracted.chromium_labels;
  cve.bug_date = extracted.bug_date;
  cve.severity = extracted.severity;

  // Read the issues descriptions.
  const issues = await page.evaluate(() => {
    const issues = []
    for (const el of document.querySelectorAll('.child')) {
      issues.push(el.textContent)
    }
    return issues
  })

  // Iterate over the issues, extract the commit hash.
  // Example:
  // commit 62d76556fcf250ecb0f63874be8cdd3db51f2a64
  const commits = issues.map(issue => {
    const match = issue.match(/commit ([0-9a-f]{40})/)
    return match ? match[1] : null
  }).filter(Boolean)

  cve.commits = commits;

  console.log("Finished");
  console.log(cve);
}

const main = async () => {
  fs.mkdirSync('../data/cve', { recursive: true });
  await fetchVersionHistory()
  const database = loadDatabase();
  await retrieveCveList(database);
  saveDatabase(database);
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  const page = await browser.newPage()

  let index = 0;
  for(const cve of database) {
    console.log("Processing", cve.id);
    if (cve.bug == undefined) {
      continue;
    }

    if (cve.vrp_reward == "--") {
      delete cve.vrp_reward;
    }

    if (cve.import_stage != undefined) {
      delete cve.import_stage;
    }

    if (cve.vrp_reward != undefined) {
      console.log("Skipping", cve.bug, " vrp reward", cve.vrp_reward);
      continue;
    }

    // The bug has not been fetched yet, but it might still be private. Load
    // them randomly based on the number number of weeks since the CVE was
    // published. This is to avoid hitting the same bugs over and over again.
    // Below 14 weeks, the probability is 20%, because the bugs are likely
    // private. After 14 weeks, the probability is 100%, and it decreases to
    // 5% after 28 weeks.
    const published = new Date(cve.published);
    const today = new Date();
    const weeks = (today - published) / (1000 * 60 * 60 * 24 * 7);
    let probability = 0.2;
    if (weeks > 14) {
      probability = Math.max(0.05, 1 - (weeks - 14) * 0.067);
    }
    console.log("Weeks", weeks, "Probability", probability);

    if (Math.random() > probability) {
      console.log("Skipping", cve.id, "probability", probability);
      continue;
    }

    try {
      try {
        await fetchBugganizer(cve, page);
      } catch (e) {
        console.log("Error fetching", cve.bug, e);
      }

      if (index % 10 == 0) {
        saveDatabase(database);
      }
      index++;
    } catch (e) {
      console.log("Error fetching", cve.bug, e);
    }
  }
  console.log("Done fetching all CVEs");
  saveDatabase(database);
  console.log("Saved to file");
  await browser.close()
}
main();
