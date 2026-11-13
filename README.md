![Logo](admin/google-calendar.png)
# ioBroker.google-calendar

[![NPM version](https://img.shields.io/npm/v/iobroker.google-calendar.svg)](https://www.npmjs.com/package/iobroker.google-calendar)
[![Downloads](https://img.shields.io/npm/dm/iobroker.google-calendar.svg)](https://www.npmjs.com/package/iobroker.google-calendar)
![Number of Installations](https://iobroker.live/badges/google-calendar-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/google-calendar-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.google-calendar.png?downloads=true)](https://nodei.co/npm/iobroker.google-calendar/)

**Tests:** ![Test and Release](https://github.com/typhosj/ioBroker.google-calendar/workflows/Test%20and%20Release/badge.svg)

## google-calendar adapter for ioBroker

Reads events from one or more [Google Calendar](https://calendar.google.com) calendars with a service account and provides them as JSON states for visualisations (for example a calendar widget and a list of the next entries). The adapter only reads; it uses the [Google Calendar API](https://developers.google.com/calendar/api).

## Setup

1. In the [Google Cloud console](https://console.cloud.google.com/) create a project.
2. Enable the **Google Calendar API** for that project.
3. Create a **service account** in the project and add a **JSON key** to it. Download the JSON file.
4. In Google Calendar, share each calendar you want to read with the service account e-mail address (`client_email` in the JSON file). "See all event details" is enough for reading.
5. In the instance settings paste the content of the JSON file into the service account key field and add one row per calendar.

## Configuration

| Setting | Description | Default |
|---|---|---|
| Service account key | Content of the downloaded JSON key. Stored encrypted. | empty |
| Calendars | One row per calendar: name, calendar ID, entry type (appointment, reminder, birthday), colour, writable flag. | none |
| Poll interval (minutes) | Pause between two reads. After errors the pause grows up to one hour. | 5 |
| Days in the past | How far back events are read. | 30 |
| Days ahead | How far ahead events are read. | 150 |

## States

| State | Description |
|---|---|
| `info.connection` | true while at least one calendar could be read in the last cycle. |
| `table` | JSON array with all entries of all calendars, sorted by start. |
| `upcoming` | JSON array with the next entries, ready for a list widget. |
| `draft.request` | Write the vis-2 browser instance ID here to open that browser's form; the adapter empties it again. |
| `draft.edit` | Written by the vis calendar widget (option **object ID on event click**): JSON `{ "instance": "<id>", "event": <tapped row> }`. Opens that browser's form filled with the entry; the adapter empties it again. |
| `draft.view` | JSON object with `type`, `allDay`, `result`, `editing` and `confirmDelete` per browser, for vis bindings. |
| `draft.<id>.type` | Type of the new entry: `appointment`, `reminder` or `birthday`. |
| `draft.<id>.text` | Title or name of the new entry. |
| `draft.<id>.startDate` | Date, `YYYY-MM-DD`. |
| `draft.<id>.startTime` | Time, `HH:MM`. |
| `draft.<id>.endDate` | End date, `YYYY-MM-DD` (appointments). |
| `draft.<id>.endTime` | End time, `HH:MM` (appointments). |
| `draft.<id>.allDay` | All-day entry (appointments). |
| `draft.<id>.open` | true while the dialog of this browser is open; false again after a successful save. |
| `draft.<id>.save` | Button: creates the entry from the form, or changes the edited entry. |
| `draft.<id>.delete` | Button: the first press asks (`confirmDelete` in `draft.view`), the second deletes the edited entry. |
| `draft.<id>.target` | The entry being edited (JSON), empty for a new entry. |
| `draft.<id>.result` | `ok`, or the reason the last save failed (German, for the dialog). |

### Creating entries

Every vis-2 browser has its own form, so two people can create entries at the same time. `<id>` is the browser instance ID that vis-2 generates: eight characters, hex digits with usually one dot inside, such as `a.f1fa48` (the dot adds one level to the state IDs). In vis it is available as the binding `{instance}`, for example `google-calendar.0.draft.{instance}.text` as a widget object ID.

A button writes `{instance}` to `draft.request`. On the first request the adapter creates the states of that browser; every request fills the form with defaults (next full hour, one hour long) and sets `draft.<id>.open` to true. Edit the fields, then press `draft.<id>.save`. The entry is created in the writable calendar configured for its type and the calendars are read again right away. `draft.<id>.result` holds `ok` or the reason for a failure; after success the text is cleared and `open` is set to false. When a user changes the start and it passes the end, the end follows: an earlier end date takes the start date, a timed end that is not after the start becomes one hour after it.

To edit an entry, set the Calendar widget's **object ID on event click** (vis2-materialdesign) to `google-calendar.0.draft.edit`. A tap on an entry of a writable calendar opens the form of that browser filled with the entry; entries of read-only calendars open nothing. A birthday shows the real birth date of its series. **Save** changes title and times in Google; description, location and guests stay. A birthday changes as a series, every other entry alone, also one instance of a series created in Google. Changing the type moves the entry: it is created in the calendar of the new type and the old one is deleted; if that delete fails, `result` says so and the form goes on editing the new entry. `draft.<id>.delete` deletes the entry on the second press; any other change in between asks again. Use `editing` and `confirmDelete` from `draft.view` for the dialog title and the delete button.

vis bindings cannot contain `{instance}` inside an object ID. For those, read `draft.view` with `instance` as a variable, for example `{v:google-calendar.0.draft.view;i:instance;((v||[])[i]||[]).type}`.

The states of a browser stay until they are deleted by hand, for example after its browser data was cleared.

## Changelog
<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**
* (typhosj) initial version: read calendars with a service account and create entries from the draft states
* (typhosj) the end of a new entry follows its start when the start passes it
* (typhosj) every vis browser has its own form for new entries
* (typhosj) edit and delete entries from the vis calendar: a tap opens the form filled with the entry, delete asks once

## License
MIT License

Copyright (c) 2026 typhosj <typhosj@gmx.de>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.