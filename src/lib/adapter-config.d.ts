// This file extends the AdapterConfig type from "@iobroker/types"
// using the actual properties present in io-package.json
// in order to provide typings for adapter.config properties

import { native } from '../../io-package.json';

// The empty default array of `calendars` is inferred as never[], so its row type is given by hand.
type _AdapterConfig = Omit<typeof native, 'calendars'> & {
    calendars: { name: string; calendarId: string; type: string; color: string; writable: boolean }[];
};

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
    namespace ioBroker {
        interface AdapterConfig extends _AdapterConfig {
            // Do not enter anything here!
        }
    }
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};
