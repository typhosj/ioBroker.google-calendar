const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { expect } = require('chai');
const { tests } = require('@iobroker/testing');

const DUMP = path.join(os.tmpdir(), 'google-calendar.0.json');

function call(fn, ...args) {
    return new Promise((resolve, reject) => fn(...args, (err, result) => (err ? reject(err) : resolve(result))));
}

tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('starts without configuration', getHarness => {
            it('stays disconnected, keeps empty tables and writes an object dump', async function () {
                this.timeout(60_000);
                const harness = getHarness();
                await harness.startAdapterAndWait();
                await new Promise(resolve => setTimeout(resolve, 3000));

                const get = async id => (await call(harness.states.getState.bind(harness.states), id))?.val;
                expect(await get('google-calendar.0.info.connection')).to.equal(false);
                const table = await get('google-calendar.0.table');
                expect(table === null || table === undefined || table === '[]').to.equal(true);

                const list = await call(harness.objects.getObjectList.bind(harness.objects), {
                    startkey: 'google-calendar.0.',
                    endkey: 'google-calendar.0.香',
                });
                const dump = {};
                for (const row of list.rows) {
                    dump[row.id] = row.value;
                }
                expect(Object.keys(dump)).to.include.members([
                    'google-calendar.0.info.connection',
                    'google-calendar.0.table',
                    'google-calendar.0.upcoming',
                ]);
                fs.writeFileSync(DUMP, JSON.stringify(dump, null, 2));
            });
        });
    },
});
