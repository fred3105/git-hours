#!/usr/bin/env node

const _ = require('lodash');
const fs = require('fs');
const git = require('isomorphic-git');
const { execSync } = require('child_process');
const moment = require('moment');
const { Command } = require('commander');

const program = new Command();

const DATE_FORMAT = 'YYYY-MM-DD';

let config = {
  // Maximum time diff between 2 subsequent commits in minutes which are
  // counted to be in the same coding "session"
  maxCommitDiffInMinutes: 2 * 60,

  // How many minutes should be added for the first commit of coding session
  firstCommitAdditionInMinutes: 2 * 60,

  // Include commits since time x
  since: 'always',
  until: 'always',

  // Include merge requests
  mergeRequest: true,

  // Git repo
  gitPath: '.',

  // Aliases of emails for grouping the same activity as one person
  emailAliases: {
    'linus@torvalds.com': 'linus@linux.com',
  },
  branch: null,
};

// Estimates spent working hours based on commit dates
function estimateHours(dates) {
  if (dates.length < 2) {
    return 0;
  }

  // Oldest commit first, newest last
  const sortedDates = dates.sort((a, b) => a - b);
  const allButLast = _.take(sortedDates, sortedDates.length - 1);

  const totalHours = _.reduce(allButLast, (hours, date, index) => {
    const nextDate = sortedDates[index + 1];
    const diffInMinutes = (nextDate - date) / 1000 / 60;

    // Check if commits are counted to be in same coding session
    if (diffInMinutes < config.maxCommitDiffInMinutes) {
      return hours + diffInMinutes / 60;
    }

    // The date difference is too big to be inside single coding session
    // The work of first commit of a session cannot be seen in git history,
    // so we make a blunt estimate of it
    return hours + config.firstCommitAdditionInMinutes / 60;
  }, 0);

  return Math.round(totalHours);
}


// Fallback function using git command line
function getCommitsWithGitCLI(gitPath, branch) {
  try {
    const branchArg = branch ? branch : '--all';
    const mergeFlag = config.mergeRequest ? '' : '--no-merges';
    const gitCmd = `git -C "${gitPath}" log ${branchArg} --pretty=format:"%H|%an|%ae|%ct|%s" ${mergeFlag}`;
    const output = execSync(gitCmd, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });

    const commits = [];
    const lines = output.trim().split('\n');

    lines.forEach((line) => {
      if (!line) return;

      const parts = line.split('|');
      if (parts.length >= 5) {
        const commitDate = new Date(parseInt(parts[3], 10) * 1000);

        let isValidSince = true;
        const sinceAlways = config.since === 'always' || !config.since;
        if (!sinceAlways && !moment(commitDate.toISOString()).isAfter(config.since)) {
          isValidSince = false;
        }

        let isValidUntil = true;
        const untilAlways = config.until === 'always' || !config.until;
        if (!untilAlways && !moment(commitDate.toISOString()).isBefore(config.until)) {
          isValidUntil = false;
        }

        if (isValidSince && isValidUntil) {
          const commitData = {
            sha: parts[0],
            date: commitDate,
            message: parts.slice(4).join('|'), // Rejoin in case message contained |
            author: {
              name: parts[1],
              email: parts[2],
            },
          };
          commits.push(commitData);
        }
      }
    });

    return commits;
  } catch (error) {
    console.error('Error getting commits with git CLI:', error);
    throw error;
  }
}

// Get commits using isomorphic-git API with CLI fallback
async function getCommits(gitPath, branch) {
  const commits = [];

  try {
    // Try to find a valid ref to use
    let ref = branch;
    if (!ref) {
      // Try different common refs
      const possibleRefs = ['HEAD', 'main', 'master', 'origin/main', 'origin/master'];
      for (const possibleRef of possibleRefs) {
        try {
          await git.resolveRef({ fs, dir: gitPath, ref: possibleRef });
          ref = possibleRef;
          break;
        } catch (e) {
          // Continue to next ref
        }
      }
    }

    if (!ref) {
      throw new Error('Could not find any valid git reference');
    }

    // Get the commit log
    const logs = await git.log({
      fs,
      dir: gitPath,
      ref,
      depth: undefined, // Get all commits
    });

    logs.forEach((log) => {
      // Check date filters
      const commitDate = new Date(log.commit.committer.timestamp * 1000);

      let isValidSince = true;
      const sinceAlways = config.since === 'always' || !config.since;
      if (!sinceAlways && !moment(commitDate.toISOString()).isAfter(config.since)) {
        isValidSince = false;
      }

      let isValidUntil = true;
      const untilAlways = config.until === 'always' || !config.until;
      if (!untilAlways && !moment(commitDate.toISOString()).isBefore(config.until)) {
        isValidUntil = false;
      }

      if (isValidSince && isValidUntil) {
        // Filter merge commits if requested
        if (!config.mergeRequest && log.commit.message.startsWith('Merge ')) {
          return;
        }

        const commitData = {
          sha: log.oid,
          date: commitDate,
          message: log.commit.message,
          author: {
            name: log.commit.author.name,
            email: log.commit.author.email,
          },
        };

        commits.push(commitData);
      }
    });

    return commits;
  } catch (error) {
    console.error('isomorphic-git failed, trying git CLI fallback:', error.message);
    // Fallback to git CLI
    return getCommitsWithGitCLI(gitPath, branch);
  }
}

function parseEmailAlias(value) {
  if (value.indexOf('=') > 0) {
    const email = value.substring(0, value.indexOf('=')).trim();
    const alias = value.substring(value.indexOf('=') + 1).trim();
    if (config.emailAliases === undefined) {
      config.emailAliases = {};
    }
    config.emailAliases[email] = alias;
  } else {
    console.error(`ERROR: Invalid alias: ${value}`);
  }
}

function mergeDefaultsWithArgs(conf) {
  const options = program.opts();
  return {
    range: options.range,
    maxCommitDiffInMinutes: options.maxCommitDiff || conf.maxCommitDiffInMinutes,
    firstCommitAdditionInMinutes: options.firstCommitAdd || conf.firstCommitAdditionInMinutes,
    since: options.since || conf.since,
    until: options.until || conf.until,
    gitPath: options.path || conf.gitPath,
    mergeRequest: options.mergeRequest !== undefined ? (options.mergeRequest === 'true') : conf.mergeRequest,
    branch: options.branch || conf.branch,
  };
}

function parseInputDate(inputDate) {
  switch (inputDate) {
    case 'today':
      return moment().startOf('day');
    case 'yesterday':
      return moment().startOf('day').subtract(1, 'day');
    case 'thisweek':
      return moment().startOf('week');
    case 'lastweek':
      return moment().startOf('week').subtract(1, 'week');
    case 'always':
      return 'always';
    default:
      // XXX: Moment tries to parse anything, results might be weird
      return moment(inputDate, DATE_FORMAT);
  }
}

function parseSinceDate(since) {
  return parseInputDate(since);
}

function parseUntilDate(until) {
  return parseInputDate(until);
}

function parseArgs() {
  function int(val) {
    return parseInt(val, 10);
  }

  program
    .version(require('../package.json').version, '-v, --version')
    .usage('[options]')
    .option(
      '-d, --max-commit-diff [max-commit-diff]',
      `maximum difference in minutes between commits counted to one session. Default: ${config.maxCommitDiffInMinutes}`,
      int,
    )
    .option(
      '-a, --first-commit-add [first-commit-add]',
      `how many minutes first commit of session should add to total. Default: ${config.firstCommitAdditionInMinutes}`,
      int,
    )
    .option(
      '-s, --since [since-certain-date]',
      `Analyze data since certain date. [always|yesterday|today|lastweek|thisweek|yyyy-mm-dd] Default: ${config.since}`,
      String,
    )
    .option(
      '-e, --email [emailOther=emailMain]',
      'Group person by email address. Default: none',
      String,
    )
    .option(
      '-u, --until [until-certain-date]',
      `Analyze data until certain date. [always|yesterday|today|lastweek|thisweek|yyyy-mm-dd] Default: ${config.until}`,
      String,
    )
    .option(
      '-m, --merge-request [false|true]',
      `Include merge requests into calculation. Default: ${config.mergeRequest}`,
      String,
    )
    .option(
      '-p, --path [git-repo]',
      `Git repository to analyze. Default: ${config.gitPath}`,
      String,
    )
    .option(
      '-b, --branch [branch-name]',
      `Analyze only data on the specified branch. Default: ${config.branch}`,
      String,
    );

  program.on('--help', () => {
    console.log([
      '  Examples:',
      '   - Estimate hours of project',
      '       $ git-hours',
      '   - Estimate hours in repository where developers commit more seldom: they might have 4h(240min) pause between commits',
      '       $ git-hours --max-commit-diff 240',
      '   - Estimate hours in repository where developer works 5 hours before first commit in day',
      '       $ git-hours --first-commit-add 300',
      '   - Estimate hours work in repository since yesterday',
      '       $ git-hours --since yesterday',
      '   - Estimate hours work in repository since 2015-01-31',
      '       $ git-hours --since 2015-01-31',
      '   - Estimate hours work in repository on the "master" branch',
      '       $ git-hours --branch master',
      '  For more details, visit https://github.com/kimmobrunfeldt/git-hours',
    ].join('\n\n'));
  });

  program.parse(process.argv);
}

function exitIfShallow() {
  if (fs.existsSync('.git/shallow')) {
    console.log('Cannot analyze shallow copies!');
    console.log('Please run git fetch --unshallow before continuing!');
    process.exit(1);
  }
}

async function main() {
  exitIfShallow();

  parseArgs();
  config = mergeDefaultsWithArgs(config);
  config.since = parseSinceDate(config.since);
  config.until = parseUntilDate(config.until);

  // Poor man`s multiple args support
  // https://github.com/tj/commander.js/issues/531
  for (let i = 0; i < process.argv.length; i += 1) {
    const k = process.argv[i];
    let n = i <= process.argv.length - 1 ? process.argv[i + 1] : undefined;
    if (k === '-e' || k === '--email') {
      parseEmailAlias(n);
    } else if (k.startsWith('--email=')) {
      n = k.substring(k.indexOf('=') + 1);
      parseEmailAlias(n);
    }
  }

  try {
    const commits = await getCommits(config.gitPath, config.branch);

    const commitsByEmail = _.groupBy(commits, (commit) => {
      let email = commit.author.email || 'unknown';
      if (config.emailAliases !== undefined && config.emailAliases[email] !== undefined) {
        email = config.emailAliases[email];
      }
      return email;
    });

    const authorWorks = _.map(commitsByEmail, (authorCommits, authorEmail) => ({
      email: authorEmail,
      name: authorCommits[0].author.name,
      hours: estimateHours(_.map(authorCommits, 'date')),
      commits: authorCommits.length,
    }));

    // XXX: This relies on the implementation detail that json is printed
    // in the same order as the keys were added. This is anyway just for
    // making the output easier to read, so it doesn't matter if it
    // isn't sorted in some cases.
    const sortedWork = {};

    _.each(_.sortBy(authorWorks, 'hours'), (authorWork) => {
      sortedWork[authorWork.email] = _.omit(authorWork, 'email');
    });

    const totalHours = _.reduce(sortedWork, (sum, authorWork) => sum + authorWork.hours, 0);

    sortedWork.total = {
      hours: totalHours,
      commits: commits.length,
    };

    console.log(JSON.stringify(sortedWork, undefined, 2));
  } catch (e) {
    console.error(e.stack);
  }
}

main();
