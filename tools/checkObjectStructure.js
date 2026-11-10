'use strict';

// Runs @iobroker/repochecker's object structure check, the same check the ioBroker.repositories
// bot runs against a live instance dump.
//
//   npm run pr:objects             # dump written by the integration test
//   npm run pr:objects dump.json   # dump exported from a real instance

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ioPackage = require('../io-package.json');

function loadChecker() {
    const library = '@iobroker/repochecker/lib/objectStructure.js';
    try {
        return require(library).checkObjectStructure;
    } catch {
        for (const entry of (process.env.PATH || '').split(path.delimiter)) {
            if (!entry.endsWith(path.join('node_modules', '.bin'))) {
                continue;
            }
            const candidate = path.join(entry, '..', ...library.split('/'));
            if (fs.existsSync(candidate)) {
                return require(candidate).checkObjectStructure;
            }
        }
    }
    throw new Error('@iobroker/repochecker not found, run: npm run pr:objects');
}

const file = process.argv[2] || path.join(os.tmpdir(), 'google-calendar.0.json');
const dump = JSON.parse(fs.readFileSync(file, 'utf8'));
const result = loadChecker()(dump, ioPackage.common.name);

console.log(
    `Checked ${result.objectCount} objects: ${result.errors.length} errors, ${result.warnings.length} warnings`,
);
for (const warning of result.warnings) {
    console.log(`WARNING ${warning.code} ${warning.message}`);
}
for (const error of result.errors) {
    console.log(`ERROR ${error.code} ${error.message}`);
}
// The repositories bot fails the `objects` label on warnings too.
process.exit(result.errors.length + result.warnings.length ? 1 : 0);
